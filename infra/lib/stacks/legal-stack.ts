import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { JaleLambdaFunction } from '../constructs/lambda-function';
import { lambdaIntegration, addPathOnlyResource } from '../api-integration';

export interface LegalStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  readonly privateSubnets: ec2.ISubnet[];
  readonly lambdaSg: ec2.ISecurityGroup;
  readonly dbSecret: secretsmanager.ISecret;
  readonly api: apigateway.RestApi;
  readonly dualAuthorizer: apigateway.CognitoUserPoolsAuthorizer;
}

export class LegalStack extends cdk.Stack {
  public readonly legalBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: LegalStackProps) {
    super(scope, id, props);

    // ── Context values ──
    const tosVersion = this.node.tryGetContext('requiredTosVersion') ?? '1.0';
    const allowedOrigin = this.node.tryGetContext('allowedOrigin') ?? 'https://jaleapp.ai';
    const envName = this.node.tryGetContext('environment') ?? 'dev';
    const isDev = envName === 'dev';

    // ── S3 Bucket for legal documents (ToS, privacy policy) ──
    // Dev: DESTROY + autoDelete so `cdk destroy` is ergonomic. Non-dev: RETAIN
    // + disable autoDelete so a mistaken `cdk destroy` cannot wipe the legal
    // audit trail (versioned ToS + privacy docs are the source of truth for
    // user consent).
    this.legalBucket = new s3.Bucket(this, 'LegalDocsBucket', {
      bucketName: `jale-legal-docs-${cdk.Stack.of(this).account}`,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: isDev ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: isDev,
    });

    // ── get-tos Lambda ──
    const getTosFn = new JaleLambdaFunction(this, 'GetTosLambda', {
      entry: path.join(__dirname, '../../lambda/legal/get-tos.ts'),
      description: 'Returns presigned URLs for ToS and privacy policy documents',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        LEGAL_BUCKET_NAME: this.legalBucket.bucketName,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    this.legalBucket.grantRead(getTosFn.function);

    // ── accept-tos Lambda ──
    const acceptTosFn = new JaleLambdaFunction(this, 'AcceptTosLambda', {
      entry: path.join(__dirname, '../../lambda/legal/accept-tos.ts'),
      description: 'Records user acceptance of ToS and privacy policy',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
      },
    });
    props.dbSecret.grantRead(acceptTosFn.function);

    // ── API Gateway routes ──
    // Path-only: nothing on /legal itself, only /legal/tos and /legal/accept.
    const legalResource = addPathOnlyResource(props.api.root, 'legal');

    // GET /legal/tos — public, no auth, rate-limited via method throttling
    const tosResource = legalResource.addResource('tos');
    tosResource.addMethod('GET', lambdaIntegration(getTosFn.function), {
      methodResponses: [{ statusCode: '200' }],
    });

    // NOTE: GET /legal/tos throttle (10 rps / 20 burst) lives in ApiStack's
    // centralized MethodSettings block.  LegalStack must NOT call
    // addPropertyOverride('MethodSettings') — doing so would overwrite the
    // merged list and drop billing throttles.

    // POST /legal/accept — protected by dual Cognito authorizer (created in ApiStack)
    const acceptResource = legalResource.addResource('accept');
    acceptResource.addMethod('POST', lambdaIntegration(acceptTosFn.function), {
      authorizer: props.dualAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
  }
}
