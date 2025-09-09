#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DemoSelfManagedGitlabStack } from '../lib/demo-self-managed-gitlab-stack';
import { parameters } from '../parameters';

const app = new cdk.App();

// Get parameters from: 1) CDK context, 2) Environment variables, 3) parameters.ts
const domainName = app.node.tryGetContext('domainName') || process.env.GITLAB_DOMAIN || parameters.domainName;
const email = app.node.tryGetContext('email') || process.env.GITLAB_EMAIL || parameters.email;
const skipRoute53 = app.node.tryGetContext('skipRoute53') === 'true' || process.env.SKIP_ROUTE53 === 'true';

// Check if parameters are still default values
const isDefaultDomain = domainName === 'gitlab.example.com';
const isDefaultEmail = email === 'admin@example.com';

if (!domainName || !email || isDefaultDomain || isDefaultEmail) {
  console.error('❌ Required parameters missing or using default values:');
  if (!domainName || isDefaultDomain) {
    console.error('  - domainName: GitLab domain name (e.g., gitlab.example.com)');
  }
  if (!email || isDefaultEmail) {
    console.error('  - email: Email for Let\'s Encrypt certificate');
  }
  console.error('');
  console.error('🛠️  How to set parameters:');
  console.error('');
  console.error('1. Edit parameters.ts file:');
  console.error('   export const parameters = {');
  console.error('     domainName: "gitlab.yourdomain.com",');
  console.error('     email: "admin@yourdomain.com",');
  console.error('   };');
  console.error('');
  console.error('2. Or use CDK context:');
  console.error('   npx cdk deploy -c domainName=gitlab.yourdomain.com -c email=admin@yourdomain.com');
  console.error('');
  console.error('3. Or set environment variables:');
  console.error('   export GITLAB_DOMAIN=gitlab.yourdomain.com');
  console.error('   export GITLAB_EMAIL=admin@yourdomain.com');
  process.exit(1);
}

new DemoSelfManagedGitlabStack(app, 'DemoSelfManagedGitlabStack', {
  domainName,
  email,
  skipRoute53,
  env: { 
    account: process.env.CDK_DEFAULT_ACCOUNT, 
    region: process.env.CDK_DEFAULT_REGION 
  },
});