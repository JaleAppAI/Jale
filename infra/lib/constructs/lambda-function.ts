import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as os from 'os';
import * as path from 'path';

export interface JaleLambdaFunctionProps {
  /** Path to the Lambda entry file */
  entry: string;
  /** Export name of the handler function */
  handler?: string;
  /** Environment variables */
  environment?: Record<string, string>;
  /** VPC to deploy into */
  vpc: ec2.IVpc;
  /** Security groups to attach */
  securityGroups: ec2.ISecurityGroup[];
  /** Timeout in seconds (default 30) */
  timeout?: number;
  /** Description of the function */
  description?: string;
  /** Dead letter queue for failed invocations */
  deadLetterQueue?: sqs.IQueue;
  /** Max retry attempts (default 2) */
  retryAttempts?: number;
  /** Max event age */
  maxEventAge?: cdk.Duration;
}

export class JaleLambdaFunction extends Construct {
  public readonly function: NodejsFunction;
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: JaleLambdaFunctionProps) {
    super(scope, id);

    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.function = new NodejsFunction(this, 'Function', {
      entry: props.entry,
      handler: props.handler ?? 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(props.timeout ?? 30),
      description: props.description,
      environment: props.environment,
      tracing: lambda.Tracing.ACTIVE,
      vpc: props.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: props.securityGroups,
      logGroup: this.logGroup,
      deadLetterQueue: props.deadLetterQueue,
      retryAttempts: props.retryAttempts,
      maxEventAge: props.maxEventAge,
      bundling: {
        externalModules: ['pg-native', '@aws-sdk/*'],
        commandHooks: {
          afterBundling: (inputDir: string, outputDir: string) => {
            const src = path.join(inputDir, 'lambda', 'lib', 'rds-ca-bundle.pem');
            const dst = path.join(outputDir, 'rds-ca-bundle.pem');
            if (os.platform() === 'win32') {
              return [`copy "${src}" "${dst}"`];
            }
            return [`cp "${src}" "${dst}"`];
          },
          beforeBundling: () => [],
          beforeInstall: () => [],
        },
      },
    });
  }
}
