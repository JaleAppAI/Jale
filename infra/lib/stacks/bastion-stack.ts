import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

/**
 * BastionStack - throwaway EC2 host for SSM access to the private RDS.
 *
 * The instance lives in a private subnet and only receives inbound access
 * through Session Manager. The RDS ingress rule is created inside this stack
 * to avoid a cross-stack dependency cycle.
 */
export interface BastionStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  rdsSg: ec2.ISecurityGroup;
}

export class BastionStack extends cdk.Stack {
  public readonly bastionHost: ec2.BastionHostLinux;

  constructor(scope: Construct, id: string, props: BastionStackProps) {
    super(scope, id, props);

    this.bastionHost = new ec2.BastionHostLinux(this, 'Bastion', {
      vpc: props.vpc,
      subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        ec2.InstanceSize.NANO,
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
    });

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
