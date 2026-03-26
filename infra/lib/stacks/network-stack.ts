import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly privateSubnets: ec2.ISubnet[];
  public readonly isolatedSubnets: ec2.ISubnet[];
  public readonly lambdaSg: ec2.SecurityGroup;
  public readonly rdsSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const maxAzs = this.node.tryGetContext('vpcMaxAzs') ?? 2;

    // VPC with two private subnet tiers and no NAT gateways.
    // WARNING: natGateways: 0 means PRIVATE_WITH_EGRESS subnets have NO actual
    // internet egress. Lambdas can ONLY reach AWS services via VPC Endpoints.
    // Current endpoints: SecretsManager, SNS, Cognito-IDP, STS, CloudWatch Logs, SQS, S3 (gateway)
    // Adding a Lambda that calls any service without an endpoint will silently timeout.
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    this.privateSubnets = this.vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    }).subnets;

    this.isolatedSubnets = this.vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
    }).subnets;

    // ---------- Security Groups ----------

    this.lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: this.vpc,
      description: 'Security group for Lambda functions',
      allowAllOutbound: true,
    });

    this.rdsSg = new ec2.SecurityGroup(this, 'RdsSg', {
      vpc: this.vpc,
      description: 'Security group for RDS PostgreSQL',
      allowAllOutbound: false,
    });

    this.rdsSg.addIngressRule(
      this.lambdaSg,
      ec2.Port.tcp(5432),
      'Allow PostgreSQL access from Lambda functions',
    );

    // ---------- VPC Interface Endpoints ----------

    const interfaceEndpoints: Record<string, ec2.InterfaceVpcEndpointAwsService> = {
      SecretsManager: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      Sns: ec2.InterfaceVpcEndpointAwsService.SNS,
      CognitoIdp: ec2.InterfaceVpcEndpointAwsService.COGNITO_IDP,
      Sts: ec2.InterfaceVpcEndpointAwsService.STS,
      CloudWatchLogs: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      Sqs: ec2.InterfaceVpcEndpointAwsService.SQS,
    };

    for (const [name, service] of Object.entries(interfaceEndpoints)) {
      this.vpc.addInterfaceEndpoint(`${name}Endpoint`, {
        service,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [this.lambdaSg],
      });
    }

    // ---------- VPC Gateway Endpoint ----------

    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });
  }
}
