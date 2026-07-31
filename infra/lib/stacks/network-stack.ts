import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly privateSubnets: ec2.ISubnet[];
  public readonly isolatedSubnets: ec2.ISubnet[];
  public readonly lambdaSg: ec2.SecurityGroup;
  public readonly rdsSg: ec2.SecurityGroup;
  public readonly billingLambdaSg: ec2.SecurityGroup;
  public readonly referralsLambdaSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const maxAzs = this.node.tryGetContext('vpcMaxAzs') ?? 2;

    // VPC with three subnet tiers and 1 NAT gateway.
    // NAT gateway (~$32/mo) enables internet egress from PRIVATE_WITH_EGRESS
    // subnets. Required for Lambdas that call external APIs (Twilio for WhatsApp).
    //
    // Subnet tiers (2 AZs × 3 tiers = 6 subnets):
    //   - Public (cidrMask 28): hosts the NAT gateway. Small because only the
    //     NAT sits here — no application traffic lives in public subnets.
    //   - Private (cidrMask 24): PRIVATE_WITH_EGRESS. Routes outbound through
    //     the NAT gateway. All Lambdas run here.
    //   - Isolated (cidrMask 24): PRIVATE_ISOLATED. No internet egress. RDS lives here.
    //
    // KNOWN RISK — NAT blast radius: all PRIVATE_WITH_EGRESS Lambdas share the
    // NAT, so any Lambda in the VPC gains internet egress, not just WhatsApp.
    // Accepted for V1 (no untrusted Lambdas). Tighten with per-Lambda SG egress
    // rules in V2.
    //
    // For AWS services we still prefer VPC endpoints (cheaper + private):
    // SecretsManager, SNS, Cognito-IDP, STS, CloudWatch Logs, SQS, S3 (gateway).
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 28,
        },
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

    // Billing Lambdas get their own SG instead of the shared allow-all lambdaSg
    // (spec S4.3). Outbound: 443 only (Stripe via NAT) + Postgres to RDS.
    this.billingLambdaSg = new ec2.SecurityGroup(this, 'BillingLambdaSg', {
      vpc: this.vpc,
      description: 'Security group for billing Lambdas (DB + HTTPS egress only)',
      allowAllOutbound: false,
    });
    this.billingLambdaSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS egress (Stripe, AWS APIs) via NAT');
    this.billingLambdaSg.addEgressRule(this.rdsSg, ec2.Port.tcp(5432), 'PostgreSQL to RDS');
    this.rdsSg.addIngressRule(this.billingLambdaSg, ec2.Port.tcp(5432), 'Allow PostgreSQL access from billing Lambdas');

    // Referrals Lambdas (public job read/apply-intent + worker share/referrals)
    // get their own SG, same shape as billingLambdaSg: no allow-all outbound,
    // just HTTPS (Secrets Manager/AWS APIs via NAT) + Postgres to RDS.
    this.referralsLambdaSg = new ec2.SecurityGroup(this, 'ReferralsLambdaSg', {
      vpc: this.vpc,
      description: 'Security group for referrals Lambdas (DB + HTTPS egress only)',
      allowAllOutbound: false,
    });
    this.referralsLambdaSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS egress (AWS APIs) via NAT');
    this.referralsLambdaSg.addEgressRule(this.rdsSg, ec2.Port.tcp(5432), 'PostgreSQL to RDS');
    this.rdsSg.addIngressRule(this.referralsLambdaSg, ec2.Port.tcp(5432), 'Allow PostgreSQL access from referrals Lambdas');

    // ---------- VPC Interface Endpoints ----------
    //
    // Interface endpoints for services we call FREQUENTLY or where the
    // security posture benefits from private routing. Other AWS services
    // (Cognito-IDP, SNS, STS, SQS) route via the NAT Gateway — cheaper
    // at current scale per the 2026-04-20 audit cost analysis
    // (docs/Audit.md, Status Log "Aggressive VPC endpoint pruning").
    //
    // Re-evaluate at ~100k DAU: Cognito-IDP traffic approaches the
    // endpoint break-even (~417 GB/mo) around that threshold.
    const interfaceEndpoints: Record<string, ec2.InterfaceVpcEndpointAwsService> = {
      SecretsManager: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      CloudWatchLogs: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
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
