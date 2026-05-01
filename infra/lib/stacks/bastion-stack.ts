import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

/**
 * BastionStack — throwaway EC2 for running DB migrations + ad-hoc psql
 * against the RDS that lives in PRIVATE_ISOLATED subnets.
 *
 * Pattern: ec2.BastionHostLinux gives us a hardened Amazon Linux host with
 * the SSM agent preinstalled, IMDSv2 required, and an IAM role containing
 * AmazonSSMManagedInstanceCore. No SSH keys, no public ingress.
 *
 * Deploy on demand, destroy when done:
 *   npx cdk deploy JaleBastionStack     # ~3 min
 *   bash scripts/run-migrations.sh      # run migrations via aws ssm send-command
 *   npx cdk destroy JaleBastionStack    # ~2 min
 *
 * Cross-stack wiring (RDS ingress, secrets read permissions) is punched
 * from bin/jale-app.ts — this stack takes only the VPC as a prop.
 */
export interface BastionStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  /**
   * The RDS security group to allow bastion ingress on port 5432.
   * Passing it in (rather than having bin/jale-app.ts call
   * `database.dbInstance.connections.allowFrom(bastion)`) ensures the
   * CfnSecurityGroupIngress resource CDK emits lives IN BastionStack —
   * otherwise NetworkStack would gain a back-edge to BastionStack and
   * synth fails with a circular dependency error.
   */
  rdsSg: ec2.ISecurityGroup;
}

export class BastionStack extends cdk.Stack {
  public readonly bastionHost: ec2.BastionHostLinux;

  constructor(scope: Construct, id: string, props: BastionStackProps) {
    super(scope, id, props);

    this.bastionHost = new ec2.BastionHostLinux(this, 'Bastion', {
      vpc: props.vpc,
      // PRIVATE_WITH_EGRESS: the bastion needs outbound internet via the NAT
      // Gateway so `dnf install postgresql15` can pull from AL2023 repos.
      // Isolated subnets would work for reaching RDS but not for yum.
      subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        ec2.InstanceSize.NANO,
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
    });

    // UserData runs once at first boot. postgresql15-server is excluded —
    // we only need the client binary. jq lets the migration script parse
    // the jale_admin secret JSON without a Python dependency.
    this.bastionHost.instance.addUserData(
      'dnf install -y postgresql15 jq',
    );

    // Explicit CfnSecurityGroupIngress so the rule resource lands in this
    // stack (BastionStack), not the upstream NetworkStack. `addIngressRule`
    // on a cross-stack SG still mutates the upstream SG, which creates a
    // cycle (NetworkStack → BastionStack for the peer ID, BastionStack →
    // NetworkStack for the VPC ref). Using the L1 resource breaks that.
    new ec2.CfnSecurityGroupIngress(this, 'RdsIngressFromBastion', {
      groupId: props.rdsSg.securityGroupId,
      sourceSecurityGroupId:
        this.bastionHost.connections.securityGroups[0].securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      description: 'Bastion SSM-only DB access',
    });

    new cdk.CfnOutput(this, 'BastionInstanceId', {
      value: this.bastionHost.instanceId,
      description: 'SSM target for aws ssm start-session / send-command',
      exportName: 'JaleBastionInstanceId',
    });
  }
}
