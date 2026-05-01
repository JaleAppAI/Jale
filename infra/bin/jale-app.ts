#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NetworkStack } from '../lib/stacks/network-stack';
import { DatabaseStack } from '../lib/stacks/database-stack';
import { AuthStack } from '../lib/stacks/auth-stack';
import { ApiStack } from '../lib/stacks/api-stack';
import { BastionStack } from '../lib/stacks/bastion-stack';
import { LegalStack } from '../lib/stacks/legal-stack';
import { WhatsAppStack } from '../lib/stacks/whatsapp-stack';
import { BastionStack } from '../lib/stacks/bastion-stack';
import { DocumentsStack } from '../lib/stacks/documents-stack';

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

const bastion = new BastionStack(app, 'JaleBastionStack', {
  env,
  vpc: network.vpc,
  rdsSg: network.rdsSg,
});

database.dbSecret.grantRead(bastion.bastionHost.instance.role);

new LegalStack(app, 'JaleLegalStack', {
  env,
  vpc: network.vpc,
  privateSubnets: network.privateSubnets,
  lambdaSg: network.lambdaSg,
  dbSecret: database.dbSecret,
  api: api.api,
  dualAuthorizer: api.dualAuthorizer,
});

new WhatsAppStack(app, 'JaleWhatsAppStack', {
  env,
  vpc: network.vpc,
  privateSubnets: network.privateSubnets,
  lambdaSg: network.lambdaSg,
  dbSecret: database.dbSecret,
  workerPool: auth.workerPool,
  api: api.api,
});

// BastionStack — throwaway host for DB migrations & ad-hoc psql. Synthesized
// every `cdk synth` but only deployed when named: `cdk deploy JaleBastionStack`.
// Do NOT `cdk deploy --all` this cycle — it would bring the bastion up
// permanently. Use step 8 of the deploy runbook to `cdk destroy` when done.
const bastion = new BastionStack(app, 'JaleBastionStack', {
  env,
  vpc: network.vpc,
  // rdsSg is passed in so the ingress rule can be created INSIDE
  // BastionStack, avoiding a cyclic NetworkStack ↔ BastionStack dependency.
  rdsSg: network.rdsSg,
});

// Grant the bastion's instance role read on the jale_admin DB secret.
// grantRead adds an IAM policy statement to the bastion role (which lives
// in BastionStack), referencing the secret ARN via cross-stack import —
// no cycle: BastionStack → DatabaseStack is a valid forward edge.
database.dbSecret.grantRead(bastion.bastionHost.instance.role);

// Bastion needs to create/update the jale/whatsapp/db secret after the
// migration script sets the jale_whatsapp role password. Scoped to that
// secret name prefix so the bastion can't touch unrelated secrets.
bastion.bastionHost.instance.role.addToPrincipalPolicy(
  new iam.PolicyStatement({
    actions: [
      'secretsmanager:CreateSecret',
      'secretsmanager:PutSecretValue',
      'secretsmanager:DescribeSecret',
      'secretsmanager:TagResource',
    ],
    resources: [
      `arn:aws:secretsmanager:${env.region ?? '*'}:${env.account ?? '*'}:secret:jale/whatsapp/db*`,
    ],
  }),
);

new DocumentsStack(app, 'JaleDocumentsStack', {
  env,
  network,
  api,
  dbSecret: database.dbSecret,
  allowedOrigin: app.node.tryGetContext('allowedOrigin') ?? 'https://jaleapp.ai',
  requiredTosVersion: app.node.tryGetContext('requiredTosVersion') ?? 'v1.0',
});
