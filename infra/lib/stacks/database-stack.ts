import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';
import { NetworkStack } from './network-stack';

export interface DatabaseStackProps extends cdk.StackProps {
  /** Reference to the network stack */
  network: NetworkStack;
}

export class DatabaseStack extends cdk.Stack {
  public readonly dbInstance: rds.DatabaseInstance;
  public readonly dbSecret: cdk.aws_secretsmanager.ISecret;
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
    this.dbEndpoint = this.dbInstance.dbInstanceEndpointAddress;
    this.dbPort = this.dbInstance.dbInstanceEndpointPort;
  }
}
