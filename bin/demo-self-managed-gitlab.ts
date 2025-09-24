#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DemoSelfManagedGitlabStack } from '../lib/demo-self-managed-gitlab-stack';
import { parameters } from '../parameters';

const app = new cdk.App();

new DemoSelfManagedGitlabStack(app, 'DemoSelfManagedGitlabStack', {
  domainName: parameters.domainName,
  email: parameters.email,
  certificateArn: parameters.certificateArn,
  env: { 
    account: process.env.CDK_DEFAULT_ACCOUNT, 
    region: process.env.CDK_DEFAULT_REGION 
  },
});