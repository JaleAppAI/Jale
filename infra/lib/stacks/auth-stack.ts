import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { JaleCognitoPool, CognitoPoolProps } from '../constructs/cognito-pool';
import { JaleLambdaFunction } from '../constructs/lambda-function';

export interface AuthStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  readonly privateSubnets: ec2.ISubnet[];
  readonly lambdaSg: ec2.ISecurityGroup;
  readonly dbSecret: secretsmanager.ISecret;
}

export class AuthStack extends cdk.Stack {
  public readonly workerPool: JaleCognitoPool;
  public readonly employerPool: JaleCognitoPool;
  public readonly postConfirmationLambda: JaleLambdaFunction;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    // ── Dead-letter queue for post-confirmation Lambda ──
    const dlq = new sqs.Queue(this, 'PostConfirmationDlq', {
      queueName: 'jale-post-confirmation-dlq',
    });

    // ── Post-Confirmation Lambda ──
    const postConfirmationLambda = new JaleLambdaFunction(this, 'PostConfirmationLambda', {
      entry: path.join(__dirname, '../../lambda/post-confirmation/index.ts'),
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        DB_REGION: cdk.Stack.of(this).region,
      },
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      deadLetterQueue: dlq,
      retryAttempts: 0,
      maxEventAge: cdk.Duration.hours(1),
    });

    props.dbSecret.grantRead(postConfirmationLambda.function);
    this.postConfirmationLambda = postConfirmationLambda;

    // ── SMS IAM Role for Worker Pool MFA ──
    const smsRole = new iam.Role(this, 'WorkerPoolSmsRole', {
      assumedBy: new iam.ServicePrincipal('cognito-idp.amazonaws.com', {
        conditions: {
          StringEquals: {
            'sts:ExternalId': 'jale-worker-sms',
          },
        },
      }),
    });
    smsRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sns:Publish'],
        resources: ['*'],
      }),
    );

    // ── Worker Cognito Pool ──
    this.workerPool = new JaleCognitoPool(this, 'WorkerPool', {
      poolName: 'jale-worker-pool',
      signInAliases: { phone: true },
      mfa: cognito.Mfa.REQUIRED,
      smsRole,
      smsExternalId: 'jale-worker-sms',
      passwordPolicy: {
        minLength: 8,
        requireLowercase: false,
        requireUppercase: false,
        requireDigits: false,
        requireSymbols: false,
      },
      customAttributes: {
        user_type: new cognito.StringAttribute({ mutable: false }),
      },
      selfSignUp: true,
      autoVerify: { phone: true },
      lambdaTriggers: {
        postConfirmation: postConfirmationLambda.function,
      },
    });

    // ── Employer Cognito Pool ──
    this.employerPool = new JaleCognitoPool(this, 'EmployerPool', {
      poolName: 'jale-employer-pool',
      signInAliases: { email: true },
      mfa: cognito.Mfa.OFF,
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      customAttributes: {
        user_type: new cognito.StringAttribute({ mutable: true }),
        company_name: new cognito.StringAttribute({ mutable: true }),
      },
      selfSignUp: true,
      autoVerify: { email: true },
      lambdaTriggers: {
        postConfirmation: postConfirmationLambda.function,
      },
    });

    // ── Cognito User Groups (Task 2.1) ──
    new cognito.CfnUserPoolGroup(this, 'WorkerGroup', {
      userPoolId: this.workerPool.userPool.userPoolId,
      groupName: 'Workers',
      description: 'Blue-collar workers authenticated via phone/OTP',
      precedence: 1,
    });

    new cognito.CfnUserPoolGroup(this, 'EmployerGroup', {
      userPoolId: this.employerPool.userPool.userPoolId,
      groupName: 'Employers',
      description: 'Employers authenticated via email/password',
      precedence: 1,
    });

    // ── Grant post-confirmation Lambda permission to assign groups ──
    // Using addToRolePolicy with resource:'*' instead of userPool.grant() to avoid a CDK
    // circular dependency: userPool.grant() references the pool ARN (Fn::GetAtt), and the
    // pool already references the Lambda ARN (via the trigger), so CDK detects a cycle.
    // The real authorization boundary is the Cognito trigger itself — Cognito only calls
    // this Lambda for the two pools it's registered on.
    postConfirmationLambda.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:AdminAddUserToGroup'],
      resources: ['*'],
    }));

    // Note: pool IDs are NOT injected as env vars — doing so would create a CDK circular
    // dependency (Lambda env var Ref: UserPool ↔ UserPool LambdaConfig: Lambda ARN).
    // The Lambda determines the group from the custom:user_type attribute in the event instead.
  }
}
