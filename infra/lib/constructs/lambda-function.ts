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
  /** VPC to deploy into. Omit ONLY for a Lambda that talks to no in-VPC
   *  resource at all — a VPC-attached function pays ENI cold-start cost on
   *  every invocation, so "no database, no cache, no private endpoint" is
   *  the whole bar. Every Jale Lambda that touches Postgres must pass it.
   *  (First omitter: the worker pool's VerifyAuthChallenge trigger, which
   *  is a pure OTP string comparison plus one Cognito attribute write.) */
  vpc?: ec2.IVpc;
  /** Security groups to attach. Required alongside `vpc`; meaningless
   *  without it. */
  securityGroups?: ec2.ISecurityGroup[];
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
  /** Memory in MB (default 256). Raise it for Lambdas whose work is
   *  bundle-heavy or latency-sensitive (a larger memory setting also buys
   *  proportionally more CPU). */
  memorySize?: number;
  /** Reserved concurrent executions. Use to cap a Lambda to N concurrent
   *  invocations (e.g. 1, to serialize a scheduled drain against itself
   *  instead of relying on an invocation-frequency assumption). Omit for the
   *  AWS default (unreserved, shared account concurrency pool). */
  reservedConcurrentExecutions?: number;
}

export class JaleLambdaFunction extends Construct {
  public readonly function: NodejsFunction;
  public readonly logGroup: logs.LogGroup;
  /**
   * Absolute path to the handler source this function bundles. NodejsFunction
   * keeps `entry` private and the synthesized template only carries the asset
   * hash, so nothing downstream can otherwise tell which source file a log
   * group belongs to. test/unit/stacks/metric-filter-patterns.test.ts uses it
   * to check each MetricFilter against the code that writes to ITS log group,
   * rather than against the whole lambda/ tree.
   */
  public readonly entry: string;

  constructor(scope: Construct, id: string, props: JaleLambdaFunctionProps) {
    super(scope, id);

    this.entry = props.entry;

    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.function = new NodejsFunction(this, 'Function', {
      entry: props.entry,
      handler: props.handler ?? 'handler',
      // Node 20 is EOL upstream and deprecated on Lambda (CDK itself warns
      // that creation is disabled from 2027-02-01); 24 is the Active LTS.
      // This is the only runtime pin in infra/lib — every backend Lambda is
      // a JaleLambdaFunction — so the whole fleet moves together and no call
      // site can drift back onto a deprecated runtime on its own.
      runtime: lambda.Runtime.NODEJS_24_X,
      memorySize: props.memorySize ?? 256,
      timeout: cdk.Duration.seconds(props.timeout ?? 30),
      description: props.description,
      environment: props.environment,
      tracing: lambda.Tracing.ACTIVE,
      vpc: props.vpc,
      // CDK rejects `vpcSubnets` when there is no VPC ("Cannot configure
      // 'vpcSubnets' without configuring a VPC"), so both travel together.
      vpcSubnets: props.vpc
        ? { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }
        : undefined,
      securityGroups: props.securityGroups,
      logGroup: this.logGroup,
      deadLetterQueue: props.deadLetterQueue,
      retryAttempts: props.retryAttempts,
      maxEventAge: props.maxEventAge,
      reservedConcurrentExecutions: props.reservedConcurrentExecutions,
      bundling: {
        // ONLY pg-native: it is pg's optional native binding, is never
        // installed here, and the driver already falls back to the pure-JS
        // implementation. Bundling it would just fail to resolve.
        //
        // '@aws-sdk/*' is deliberately absent. Externalizing the SDK bets
        // that the managed runtime ships the exact client every handler
        // imports, and nodejs20.x did not ship six of the twelve we use.
        // That bet cost 21 stack call sites a `nodeModules` override, each
        // of which made CDK shell out to `npm install` inside the bundle
        // directory; miss one and the artifact keeps a bare require() that
        // throws "Cannot find module" at cold start, failing EVERY
        // invocation of that Lambda rather than only the SDK-calling ones.
        // Review caught that twice, once per deploy that added an SDK
        // import to a shared module.
        //
        // esbuild now inlines the SDK instead, so each artifact pins the SDK
        // version it was built against and stops depending on what the
        // runtime provides — which is also what makes a runtime upgrade a
        // one-line change instead of an SDK migration. The cost is a larger
        // bundle. test/unit/stacks/email-outbox-sdk-bundling.test.ts keeps
        // this and its two corollaries (no nodeModules overrides, every
        // imported SDK package a real dependency) from drifting apart.
        externalModules: ['pg-native'],
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
