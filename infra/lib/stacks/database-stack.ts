import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { NetworkStack } from './network-stack';

export interface DatabaseStackProps extends cdk.StackProps {
  /** Reference to the network stack */
  network: NetworkStack;
}

export class DatabaseStack extends cdk.Stack {
  public readonly dbInstance: rds.DatabaseInstance;
  public readonly dbSecret: secretsmanager.ISecret;
  public readonly matchingDbSecret: secretsmanager.ISecret;
  public readonly aiDbSecret: secretsmanager.ISecret;
  public readonly adminConsoleDbSecret: secretsmanager.ISecret;
  public readonly billingDbSecret: secretsmanager.ISecret;
  public readonly referralsDbSecret: secretsmanager.ISecret;
  public readonly dbEndpoint: string;
  public readonly dbPort: string;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    const { vpc, isolatedSubnets, rdsSg } = props.network;

    const env = this.node.tryGetContext('environment') ?? 'dev';
    const deletionProtection = this.node.tryGetContext('deletionProtection') !== false;
    const multiAz = this.node.tryGetContext('multiAz') ?? false;
    const removalPolicy =
      env === 'dev' ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;

    // Subnet group for RDS in isolated subnets
    const subnetGroup = new rds.SubnetGroup(this, 'SubnetGroup', {
      description: 'Subnet group for Jale RDS instance',
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    });

    // Database credentials stored in Secrets Manager
    const credentials = rds.Credentials.fromGeneratedSecret('jale_admin');

    this.dbInstance = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        ec2.InstanceSize.MICRO,
      ),
      vpc,
      subnetGroup,
      securityGroups: [rdsSg],
      credentials,
      databaseName: 'jale',
      backupRetention: cdk.Duration.days(7),
      deletionProtection,
      multiAz,
      removalPolicy,
      storageEncrypted: true,
    });

    this.dbSecret = this.dbInstance.secret!;
    this.matchingDbSecret = new secretsmanager.Secret(this, 'MatchingDbSecret', {
      secretName: 'jale/matching/db',
      description: 'jale_matching role DB credentials for matching engine reads/writes',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'jale_matching' }),
        generateStringKey: 'password',
        excludePunctuation: true,
      },
    });
    this.aiDbSecret = new secretsmanager.Secret(this, 'AiDbSecret', {
      secretName: 'jale/ai/db',
      description: 'jale_ai role DB credentials for AI trust assessment service writes',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: 'jale_ai',
          host: this.dbInstance.dbInstanceEndpointAddress,
          port: 5432,
          dbname: 'jale',
        }),
        generateStringKey: 'password',
        excludePunctuation: true,
      },
    });
    this.adminConsoleDbSecret = new secretsmanager.Secret(this, 'AdminConsoleDbSecret', {
      secretName: 'jale/admin-console/db',
      description: 'jale_admin_console role DB credentials for the admin Next.js Lambda',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: 'jale_admin_console',
          host: this.dbInstance.dbInstanceEndpointAddress,
          port: 5432,
          dbname: 'jale',
        }),
        generateStringKey: 'password',
        excludePunctuation: true,
      },
    });
    this.adminConsoleDbSecret.applyRemovalPolicy(removalPolicy);

    // Generated credential for the jale_billing service role (webhook processor).
    // Password is set on the role during the 034 migration bastion session.
    this.billingDbSecret = new secretsmanager.Secret(this, 'BillingDbSecret', {
      secretName: 'jale/billing/db',
      description: 'jale_billing service role credentials',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: 'jale_billing',
          host: this.dbInstance.dbInstanceEndpointAddress,
          port: 5432,
          dbname: 'jale',
        }),
        generateStringKey: 'password',
        excludePunctuation: true,
      },
    });
    this.billingDbSecret.applyRemovalPolicy(removalPolicy);

    // Generated credential for the jale_public_jobs role (unauthenticated public
    // job read + apply-intent). The role itself is created by migration 055
    // (infra/db/migrations/055_job_referrals.sql) — this secret only provisions
    // the CDK-managed password half. Its password must still be SET on the
    // jale_public_jobs role by the migration runners (same bastion-session
    // pattern used for jale_billing/034), not invented as a new migration here.
    this.referralsDbSecret = new secretsmanager.Secret(this, 'ReferralsDbSecret', {
      secretName: 'jale/referrals/db',
      description: 'jale_public_jobs role DB credentials for the unauthenticated public job/apply-intent Lambdas',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: 'jale_public_jobs',
          host: this.dbInstance.dbInstanceEndpointAddress,
          port: 5432,
          dbname: 'jale',
        }),
        generateStringKey: 'password',
        excludePunctuation: true,
      },
    });
    this.referralsDbSecret.applyRemovalPolicy(removalPolicy);

    this.dbEndpoint = this.dbInstance.dbInstanceEndpointAddress;
    this.dbPort = this.dbInstance.dbInstanceEndpointPort;
  }
}
