#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/stacks/network-stack';
import { DatabaseStack } from '../lib/stacks/database-stack';
import { AuthStack } from '../lib/stacks/auth-stack';
import { ApiStack } from '../lib/stacks/api-stack';
import { LegalStack } from '../lib/stacks/legal-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const network = new NetworkStack(app, 'JaleNetworkStack', { env });

const database = new DatabaseStack(app, 'JaleDatabaseStack', {
  env,
  network,
});

const auth = new AuthStack(app, 'JaleAuthStack', {
  env,
  vpc: network.vpc,
  privateSubnets: network.privateSubnets,
  lambdaSg: network.lambdaSg,
  dbSecret: database.dbSecret,
  cognitoSmsRole: network.cognitoSmsRole,
});

const api = new ApiStack(app, 'JaleApiStack', {
  env,
  vpc: network.vpc,
  privateSubnets: network.privateSubnets,
  lambdaSg: network.lambdaSg,
  dbSecret: database.dbSecret,
  workerPool: auth.workerPool,
  employerPool: auth.employerPool,
});

new LegalStack(app, 'JaleLegalStack', {
  env,
  vpc: network.vpc,
  privateSubnets: network.privateSubnets,
  lambdaSg: network.lambdaSg,
  dbSecret: database.dbSecret,
  api: api.api,
  dualAuthorizer: api.dualAuthorizer,
});
