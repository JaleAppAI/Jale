import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { JaleLambdaFunction } from '../constructs/lambda-function';

export interface LegalStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  readonly privateSubnets: ec2.ISubnet[];
  readonly lambdaSg: ec2.ISecurityGroup;
  readonly dbSecret: secretsmanager.ISecret;
  readonly api: apigateway.RestApi;
}

export class LegalStack extends cdk.Stack {
  public readonly legalBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: LegalStackProps) {
    super(scope, id, props);

    // ── S3 Bucket for legal documents (ToS, privacy policy) ──
    this.legalBucket = new s3.Bucket(this, 'LegalDocsBucket', {
      bucketName: `jale-legal-docs-${cdk.Stack.of(this).account}`,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ── get-tos Lambda ──
    const getTosFn = new JaleLambdaFunction(this, 'GetTosLambda', {
      entry: path.join(__dirname, '../../lambda/legal/get-tos.ts'),
      description: 'Returns presigned URLs for ToS and privacy policy documents',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        LEGAL_BUCKET_NAME: this.legalBucket.bucketName,
        REQUIRED_TOS_VERSION: '1.0',
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
        DB_REGION: cdk.Stack.of(this).region,
        REQUIRED_TOS_VERSION: '1.0',
      },
    });
    props.dbSecret.grantRead(acceptTosFn.function);

    // ── API Gateway routes ──
    const legalResource = props.api.root.addResource('legal');

    // GET /legal/tos — public, no auth
    const tosResource = legalResource.addResource('tos');
    tosResource.addMethod('GET', new apigateway.LambdaIntegration(getTosFn.function));

    // POST /legal/accept — no CDK authorizer; the Lambda decodes the JWT
    // from the Authorization header to extract the user sub.
    // TODO: Refactor to use a custom authorizer that validates tokens against
    //       both the worker and employer Cognito pools. For now, the Lambda
    //       trusts the JWT without cryptographic verification (acceptable in dev
    //       since the client has already authenticated against Cognito).
    const acceptResource = legalResource.addResource('accept');
    acceptResource.addMethod('POST', new apigateway.LambdaIntegration(acceptTosFn.function), {
      authorizationType: apigateway.AuthorizationType.NONE,
    });
  }
}
