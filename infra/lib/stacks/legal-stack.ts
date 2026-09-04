import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
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
  constructor(scope: Construct, id: string, props: LegalStackProps) {
    super(scope, id, props);

    // ── Context values ──
    const tosVersion = this.node.tryGetContext('requiredTosVersion') ?? '1.0';
    const allowedOrigin = this.node.tryGetContext('allowedOrigin') ?? 'https://jaleapp.ai';

    // ── get-tos Lambda ──
    // ONE legal-document mechanism, deliberately.
    //
    // This stack used to own a `jale-legal-docs-<account>` bucket that get-tos
    // presigned `tos.md` and `privacy-policy.md` out of. Nothing ever uploaded
    // them: the bucket was EMPTY in production, so a signup that reached
    // `LegalWall` was handed a valid presigned URL to a missing key and shown
    // S3's `NoSuchKey` XML in place of the terms of service.
    //
    // The maintained documents are the versioned PDFs the Next.js routes
    // `/legal/terms` and `/legal/privacy` serve
    // (`frontend/src/lib/legal-documents.ts`), which the branded emails and the
    // WhatsApp flow already link to. So the Lambda now returns those URLs and
    // the bucket, the grant and LEGAL_BUCKET_NAME are gone.
    //
    // OPERATOR NOTE: the deleted bucket carried `RemovalPolicy.RETAIN` outside
    // dev, so this deploy ORPHANS `jale-legal-docs-<account>` rather than
    // deleting it — CloudFormation drops it from the stack and leaves it in the
    // account. It is empty; delete it by hand.
    //
    // FRONTEND_BASE_URL is `allowedOrigin`, the value this stack already reads
    // for CORS and already defaults to the production domain. Same origin the
    // browser is talking to, so a link built from it is a link back to the app
    // the user is standing in.
    const getTosFn = new JaleLambdaFunction(this, 'GetTosLambda', {
      entry: path.join(__dirname, '../../lambda/legal/get-tos.ts'),
      description: 'Returns the ToS and privacy policy document URLs',
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      environment: {
        REQUIRED_TOS_VERSION: tosVersion,
        ALLOWED_ORIGIN: allowedOrigin,
        FRONTEND_BASE_URL: allowedOrigin,
      },
    });

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
