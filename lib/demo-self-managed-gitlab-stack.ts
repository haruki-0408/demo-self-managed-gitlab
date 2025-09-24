import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface GitLabStackProps extends cdk.StackProps {
  domainName: string;
  instanceType?: ec2.InstanceType;
  keyPairName?: string;
  certificateArn: string;  // 既存のSSL証明書ARN
}

export class DemoSelfManagedGitlabStack extends cdk.Stack {
  public readonly instance: ec2.Instance;
  public readonly secret: secretsmanager.Secret;
  public readonly logGroup: logs.LogGroup;
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  public readonly certificate: certificatemanager.ICertificate;

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
      allowAllOutbound: true,
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

    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'logs:DescribeLogStreams',
        'logs:DescribeLogGroups',
      ],
      resources: [this.logGroup.logGroupArn + '*'],
    }));

    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:DescribeVolumes',
        'ec2:DescribeTags',
      ],
      resources: ['*'],
    }));


    // 既存のSSL証明書を参照
    this.certificate = certificatemanager.Certificate.fromCertificateArn(
      this, 
      'GitLabCertificate', 
      props.certificateArn
    );

    // UserData script
    const userDataScript = this.loadUserDataScript(props.domainName, this.secret.secretArn);

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
        interval: cdk.Duration.seconds(60),
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 10,
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
    this.loadBalancer.addListener('HTTPSListener', {
      port: 443,
      certificates: [this.certificate],
      defaultTargetGroups: [targetGroup],
    });

    // Route53 Aレコード作成
    const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
      domainName: props.domainName,
    });

    new route53.ARecord(this, 'GitLabDNSRecord', {
      zone: hostedZone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(new route53targets.LoadBalancerTarget(this.loadBalancer)),
    });
  }

  private loadUserDataScript(domain: string, secretArn: string): string {
    try {
      // scripts/gitlab-setup.sh を読み込み
      const scriptPath = join(__dirname, '..', 'scripts', 'gitlab-setup.sh');
      let script = readFileSync(scriptPath, 'utf8');

      // 変数置換のみ実行
      script = script.replace(/\$\{DOMAIN_NAME\}/g, domain);
      script = script.replace(/\$\{SECRET_ARN\}/g, secretArn);

      return script;
    } catch (error) {
      throw new Error(`Failed to load GitLab setup script: ${error}`);
    }
  }
}
