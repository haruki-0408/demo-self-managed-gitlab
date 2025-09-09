import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface GitLabStackProps extends cdk.StackProps {
  domainName: string;
  instanceType?: ec2.InstanceType;
  keyPairName?: string;
  email: string;
  skipRoute53?: boolean;  // Route53設定をスキップするオプション
}

export class DemoSelfManagedGitlabStack extends cdk.Stack {
  public readonly instance: ec2.Instance;
  public readonly secret: secretsmanager.Secret;
  public readonly logGroup: logs.LogGroup;
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  public readonly certificate: certificatemanager.Certificate;

  constructor(scope: Construct, id: string, props: GitLabStackProps) {
    super(scope, id, props);

    // VPC - Public/Private Subnet構成
    const vpc = new ec2.Vpc(this, 'GitLabVPC', {
      maxAzs: 2,
      natGateways: 1, // 単一のNAT Gateway
      natGatewaySubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // Security Group for ALB
    const albSecurityGroup = new ec2.SecurityGroup(this, 'GitLabALBSecurityGroup', {
      vpc,
      description: 'Security group for GitLab ALB',
      allowAllOutbound: false,
    });

    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'HTTP access'
    );
    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'HTTPS access'
    );

    // Security Group for EC2 (Private)
    const ec2SecurityGroup = new ec2.SecurityGroup(this, 'GitLabEC2SecurityGroup', {
      vpc,
      description: 'Security group for GitLab EC2 instance',
      allowAllOutbound: true,
    });

    ec2SecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(80),
      'HTTP from ALB'
    );

    // Secrets Manager for GitLab root password
    this.secret = new secretsmanager.Secret(this, 'GitLabRootPassword', {
      secretName: 'gitlab-root-password',
      description: 'GitLab root user password',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'root' }),
        generateStringKey: 'password',
        excludeCharacters: '"@/\\\'',
        passwordLength: 32,
      },
    });

    // IAM Role for EC2
    const role = new iam.Role(this, 'GitLabInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    this.secret.grantWrite(role);
    this.secret.grantRead(role);

    // CloudWatch Log Groupの作成
    this.logGroup = new logs.LogGroup(this, 'GitLabLogGroup', {
      logGroupName: `/aws/ec2/gitlab/${props.domainName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // CloudWatch Logsへの書き込み権限を追加
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'logs:DescribeLogStreams',
        'logs:DescribeLogGroups',
      ],
      resources: [this.logGroup.logGroupArn + '*'],
    }));

    // SSL証明書の作成（Route53ドメイン検証）
    if (!props.skipRoute53) {
      // Route53でドメイン検証のためのHostedZone取得
      let hostedZone;
      try {
        hostedZone = route53.HostedZone.fromLookup(this, 'HostedZoneForCertificate', {
          domainName: props.domainName,
        });
      } catch (error) {
        console.warn('HostedZone not found for certificate. Manual certificate setup required.');
      }

      if (hostedZone) {
        this.certificate = new certificatemanager.Certificate(this, 'GitLabCertificate', {
          domainName: props.domainName,
          validation: certificatemanager.CertificateValidation.fromDns(hostedZone),
        });
      }
    }

    // UserData script - Log Group ARNも渡す
    const userDataScript = this.loadUserDataScript(props.domainName, props.email, this.secret.secretArn, this.logGroup.logGroupName);

    // EC2 Instance - Private Subnetに配置
    this.instance = new ec2.Instance(this, 'GitLabInstance', {
      instanceType: props.instanceType || ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
      machineImage: new ec2.AmazonLinuxImage({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023,
      }),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroup: ec2SecurityGroup,
      role,
      keyPair: props.keyPairName ? ec2.KeyPair.fromKeyPairName(this, 'GitLabKeyPair', props.keyPairName) : undefined,
      userData: ec2.UserData.custom(userDataScript),
      userDataCausesReplacement: true,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(30, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
    });

    // Application Load Balancer
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'GitLabALB', {
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
    });

    // Target Group
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'GitLabTargetGroup', {
      vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [new targets.InstanceTarget(this.instance)],
      healthCheck: {
        path: '/-/health',
        protocol: elbv2.Protocol.HTTP,
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5,
      },
    });

    // HTTP Listener (リダイレクト用)
    this.loadBalancer.addListener('HTTPListener', {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

    // HTTPS Listener
    if (this.certificate) {
      this.loadBalancer.addListener('HTTPSListener', {
        port: 443,
        certificates: [this.certificate],
        defaultTargetGroups: [targetGroup],
      });
    }

    // Route53 configuration - parameters.tsで指定されたドメインのHostedZoneのみを検索
    if (!props.skipRoute53) {
      try {
        const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
          domainName: props.domainName,
        });

        new route53.ARecord(this, 'GitLabDNSRecord', {
          zone: hostedZone,
          recordName: props.domainName,
          target: route53.RecordTarget.fromAlias(new route53targets.LoadBalancerTarget(this.loadBalancer)),
        });

        console.log(`✅ Route53 DNS A record created: ${props.domainName}`);
      } catch (error) {
        // HostedZoneが見つからない場合は警告を出力してスキップ
        console.warn(`⚠️  HostedZone not found for domain: ${props.domainName}. Manual DNS configuration required.`);
        console.warn(`   Please create an A record manually: ${props.domainName} -> EC2 Public IP`);
      }
    } else {
      console.log('📝 Route53 configuration skipped. Manual DNS setup required.');
    }

    // Outputs
    new cdk.CfnOutput(this, 'GitLabURL', {
      value: `https://${props.domainName}`,
      description: 'GitLab URL',
    });

    new cdk.CfnOutput(this, 'GitLabInstanceId', {
      value: this.instance.instanceId,
      description: 'GitLab EC2 Instance ID',
    });

    new cdk.CfnOutput(this, 'GitLabSecretArn', {
      value: this.secret.secretArn,
      description: 'GitLab root password secret ARN',
    });

    new cdk.CfnOutput(this, 'SSHCommand', {
      value: `aws ssm start-session --target ${this.instance.instanceId}`,
      description: 'SSH command via SSM',
    });

    new cdk.CfnOutput(this, 'GitLabLogGroupName', {
      value: this.logGroup.logGroupName,
      description: 'CloudWatch Log Group for GitLab logs',
    });
  }

  private loadUserDataScript(domain: string, email: string, secretArn: string, logGroupName: string): string {
    try {
      // scripts/gitlab-setup.sh を読み込み
      const scriptPath = join(__dirname, '..', 'scripts', 'gitlab-setup.sh');
      let script = readFileSync(scriptPath, 'utf8');
      
      // 変数置換のみ実行
      script = script.replace(/\$\{DOMAIN_NAME\}/g, domain);
      script = script.replace(/\$\{EMAIL\}/g, email);
      script = script.replace(/\$\{SECRET_ARN\}/g, secretArn);
      script = script.replace(/\$\{LOG_GROUP_NAME\}/g, logGroupName);
      
      return script;
    } catch (error) {
      throw new Error(`Failed to load GitLab setup script: ${error}`);
    }
  }
}
