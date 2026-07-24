import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
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
      encryption: sqs.QueueEncryption.KMS_MANAGED,
    });

    // ── Post-Confirmation Lambda ──
    const postConfirmationLambda = new JaleLambdaFunction(this, 'PostConfirmationLambda', {
      entry: path.join(__dirname, '../../lambda/post-confirmation/index.ts'),
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        DLQ_URL: dlq.queueUrl,
      },
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      deadLetterQueue: dlq,
      retryAttempts: 0,
      maxEventAge: cdk.Duration.hours(1),
    });

    props.dbSecret.grantRead(postConfirmationLambda.function);
    dlq.grantSendMessages(postConfirmationLambda.function);
    this.postConfirmationLambda = postConfirmationLambda;

    // ── Custom Auth Challenge Lambdas (Worker Pool — passwordless OTP) ──
    // DefineAuthChallenge: routes the challenge flow (first attempt, success, retry, fail).
    const defineAuthChallengeLambda = new JaleLambdaFunction(this, 'DefineAuthChallengeLambda', {
      entry: path.join(__dirname, '../../lambda/auth/define-auth-challenge.ts'),
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      description: 'Worker pool DefineAuthChallenge — session routing',
    });

    // CreateAuthChallenge: generates 6-digit OTP and sends via Twilio SMS.
    //
    // Credentials are read from Secrets Manager at runtime (`jale/whatsapp/otp-twilio`),
    // kept separate from `jale/whatsapp/twilio` (WhatsApp processor) for least-privilege
    // isolation — a compromised OTP Lambda cannot access the WhatsApp templates account.
    // The Lambda throws on any missing field rather than silently sending to empty creds.
    const otpTwilioSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'OtpTwilioSecret',
      'jale/whatsapp/otp-twilio',
    );
    const otpSmsFromNumber = String(this.node.tryGetContext('otpSmsFromNumber') ?? '');
    const otpSmsRequestTimeoutMs = Number(
      this.node.tryGetContext('otpSmsRequestTimeoutMs') ?? 3500,
    );
    const otpSmsValidityPeriodSeconds = Number(
      this.node.tryGetContext('otpSmsValidityPeriodSeconds') ?? 180,
    );
    const otpRateLimitTable = new dynamodb.Table(this, 'OtpRateLimitTable', {
      partitionKey: { name: 'subject', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'window', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const otpDeliveryStatusTable = new dynamodb.Table(this, 'OtpDeliveryStatusTable', {
      partitionKey: { name: 'twilioMessageSid', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    if (!/^\+[1-9]\d{7,14}$/.test(otpSmsFromNumber)) {
      throw new Error('otpSmsFromNumber must be a valid E.164 phone number');
    }
    if (
      !Number.isInteger(otpSmsRequestTimeoutMs)
      || otpSmsRequestTimeoutMs < 500
      || otpSmsRequestTimeoutMs > 4000
    ) {
      throw new Error('otpSmsRequestTimeoutMs must be between 500 and 4000');
    }
    if (
      !Number.isInteger(otpSmsValidityPeriodSeconds)
      || otpSmsValidityPeriodSeconds < 6
      || otpSmsValidityPeriodSeconds > 36000
    ) {
      throw new Error('otpSmsValidityPeriodSeconds must be between 6 and 36000');
    }

    const otpStatusCallbackLambda = new JaleLambdaFunction(this, 'OtpStatusCallbackLambda', {
      entry: path.join(__dirname, '../../lambda/auth/otp-status-callback.ts'),
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      description: 'Twilio SMS OTP delivery status callback receiver',
      environment: {
        TWILIO_SECRET_ARN: otpTwilioSecret.secretName,
        OTP_DELIVERY_STATUS_TABLE_NAME: otpDeliveryStatusTable.tableName,
      },
    });
    const otpStatusCallbackUrl = otpStatusCallbackLambda.function.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });
    // Do NOT inject otpStatusCallbackUrl.url back into this same Lambda's environment:
    // the Function URL targets this function, so referencing its URL here creates a
    // CloudFormation cycle (function → env → function-url → function). The callback
    // handler reconstructs the exact signed URL from its Function URL request context
    // (domainName + path), which matches what Twilio signed. The *sender* Lambda
    // (CreateAuthChallenge) gets the URL via env below and passes it to Twilio as
    // StatusCallback, so Twilio signs precisely that URL.

    const createAuthChallengeLambda = new JaleLambdaFunction(this, 'CreateAuthChallengeLambda', {
      entry: path.join(__dirname, '../../lambda/auth/create-auth-challenge.ts'),
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      description: 'Worker pool CreateAuthChallenge — OTP gen + Twilio SMS via Secrets Manager',
      environment: {
        // Pass the stable name as SecretId. Imported-by-name secrets expose a
        // partial ARN as secretArn; Secrets Manager's runtime auth path has
        // denied that partial ARN even when IAM simulation says allowed.
        TWILIO_SECRET_ARN: otpTwilioSecret.secretName,
        TWILIO_FROM_NUMBER: otpSmsFromNumber,
        TWILIO_REQUEST_TIMEOUT_MS: String(otpSmsRequestTimeoutMs),
        TWILIO_VALIDITY_PERIOD_SECONDS: String(otpSmsValidityPeriodSeconds),
        OTP_RATE_LIMIT_TABLE_NAME: otpRateLimitTable.tableName,
        OTP_DELIVERY_STATUS_TABLE_NAME: otpDeliveryStatusTable.tableName,
        TWILIO_STATUS_CALLBACK_URL: otpStatusCallbackUrl.url,
      },
    });
    otpRateLimitTable.grantReadWriteData(createAuthChallengeLambda.function);
    otpDeliveryStatusTable.grantWriteData(createAuthChallengeLambda.function);
    otpDeliveryStatusTable.grantReadWriteData(otpStatusCallbackLambda.function);
    otpTwilioSecret.grantRead(otpStatusCallbackLambda.function);
    createAuthChallengeLambda.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:TransactWriteItems'],
      resources: [otpRateLimitTable.tableArn],
    }));
    otpTwilioSecret.grantRead(createAuthChallengeLambda.function);
    // Keep an explicit partial-ARN allow for compatibility with any deployed
    // code/config that still passes the imported secretArn as SecretId.
    // grantRead() covers the real full ARN pattern ending in "-??????".
    createAuthChallengeLambda.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
      resources: [otpTwilioSecret.secretArn],
    }));
    new cloudwatch.Alarm(this, 'WorkerOtpSendErrorAlarm', {
      alarmName: 'WorkerOtpSendErrors',
      alarmDescription: 'Worker OTP CreateAuthChallenge Lambda reported an error',
      metric: createAuthChallengeLambda.function.metricErrors({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, 'WorkerOtpThrottleAlarm', {
      alarmName: 'WorkerOtpSendThrottled',
      metric: new cloudwatch.Metric({
        namespace: 'Jale/OTP',
        metricName: 'WorkerOtpSendThrottled',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 20,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, 'WorkerOtpTwilioFailureAlarm', {
      alarmName: 'WorkerOtpTwilioFailures',
      metric: new cloudwatch.Metric({
        namespace: 'Jale/OTP',
        metricName: 'WorkerOtpTwilioFailure',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // VerifyAuthChallenge: compares user answer to stored OTP. Stateless.
    const verifyAuthChallengeLambda = new JaleLambdaFunction(this, 'VerifyAuthChallengeLambda', {
      entry: path.join(__dirname, '../../lambda/auth/verify-auth-challenge.ts'),
      vpc: props.vpc,
      securityGroups: [props.lambdaSg],
      description: 'Worker pool VerifyAuthChallengeResponse — OTP comparison',
    });

    // ── Worker Cognito Pool ──
    const isProd = this.node.tryGetContext('environment') === 'production';
    this.workerPool = new JaleCognitoPool(this, 'WorkerPool', {
      poolName: 'jale-worker-pool',
      signInAliases: { phone: true },
      mfa: cognito.Mfa.OFF,
      adminUserPassword: !isProd,
      passwordPolicy: {
        minLength: 12,
        requireLowercase: false,
        requireUppercase: false,
        requireDigits: true,
        requireSymbols: false,
      },
      customAttributes: {
        user_type: new cognito.StringAttribute({ mutable: false }),
      },
      selfSignUp: false,
      lambdaTriggers: {
        postConfirmation: postConfirmationLambda.function,
        defineAuthChallenge: defineAuthChallengeLambda.function,
        createAuthChallenge: createAuthChallengeLambda.function,
        // CDK key is `verifyAuthChallengeResponse`, NOT `verifyAuthChallenge`
        verifyAuthChallengeResponse: verifyAuthChallengeLambda.function,
      },
    });

    // ── Employer Cognito Pool — SES email configuration ──
    // Read optional SES context. When sesEmailFromAddress is absent the pool
    // falls back to Cognito's default shared email service (COGNITO_DEFAULT).
    //
    // Operator pre-requisites before deploying SES config (NOT done by CDK):
    //   1. Verify SES domain identity for the sender domain (e.g. jaleapp.ai).
    //   2. Enable Easy DKIM in SES; add the 3 CNAME records in Squarespace DNS.
    //   3. Configure SES custom MAIL FROM (e.g. mail.jaleapp.ai); add MX + SPF
    //      TXT records in Squarespace DNS.
    //   4. Add/merge DMARC TXT at _dmarc.jaleapp.ai in Squarespace DNS.
    //   5. Add SES identity resource policy granting cognito-idp.amazonaws.com
    //      ses:SendEmail / ses:SendRawEmail, scoped to the user pool ARN.
    //   6. Request SES production access if the account is still sandboxed.
    //   7. Deploy this stack (cdk deploy JaleAuthStack) with the context vars.
    //   8. Test delivery to Gmail / Outlook; verify SPF/DKIM/DMARC pass.
    const sesEmailFromAddress = this.node.tryGetContext('sesEmailFromAddress') as string | undefined;
    const sesEmailFromName = (this.node.tryGetContext('sesEmailFromName') as string | undefined) ?? 'Jale';
    const sesEmailRegion = this.node.tryGetContext('sesEmailRegion') as string | undefined;
    // sesVerifiedDomain controls the SES identity referenced in SourceArn.
    // Defaults to the domain part of sesEmailFromAddress (e.g. 'jaleapp.ai'),
    // which matches domain-level SES identity verification (recommended over
    // email-address verification). Override via context if you use a subdomain
    // identity like 'mail.jaleapp.ai' with a from-address on 'jaleapp.ai'.
    const sesVerifiedDomain = (this.node.tryGetContext('sesVerifiedDomain') as string | undefined)
      ?? sesEmailFromAddress?.split('@')[1];

    if (sesEmailFromAddress !== undefined) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sesEmailFromAddress)) {
        throw new Error('sesEmailFromAddress must be a valid email address');
      }
      // SES + Cognito is only supported in specific regions. Require an
      // explicit sesEmailRegion so the SourceArn is unambiguous.
      const COGNITO_SES_REGIONS = ['us-east-1', 'us-west-2', 'eu-west-1'];
      if (!sesEmailRegion || !COGNITO_SES_REGIONS.includes(sesEmailRegion)) {
        throw new Error(
          `sesEmailRegion must be one of ${COGNITO_SES_REGIONS.join(', ')} when sesEmailFromAddress is set`,
        );
      }
    }

    const employerPoolEmail = sesEmailFromAddress !== undefined
      ? cognito.UserPoolEmail.withSES({
          fromEmail: sesEmailFromAddress,
          fromName: sesEmailFromName,
          sesRegion: sesEmailRegion!,
          sesVerifiedDomain,
        })
      : undefined;

    // ── Employer Cognito Pool ──
    this.employerPool = new JaleCognitoPool(this, 'EmployerPool', {
      poolName: 'jale-employer-pool',
      signInAliases: { email: true },
      adminUserPassword: !isProd,
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      customAttributes: {
        user_type: new cognito.StringAttribute({ mutable: false }),
        company_name: new cognito.StringAttribute({ mutable: true }),
      },
      selfSignUp: true,
      autoVerify: { email: true },
      lambdaTriggers: {
        postConfirmation: postConfirmationLambda.function,
      },
      email: employerPoolEmail,
    });

    // ── Cognito User Groups ──
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
    // Scoping to pool ARNs creates a CDK circular dependency:
    //   Lambda Policy → Fn::GetAtt(Pool.Arn) → Pool → Lambda trigger → Policy
    // Instead, scope to all Cognito pools in this account/region. This is tighter
    // than '*' (no cross-account access) while avoiding the circular dependency.
    // The real authorization boundary is the Cognito trigger itself — Cognito only
    // calls this Lambda for the two pools it's registered on.
    postConfirmationLambda.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:AdminAddUserToGroup'],
      resources: [
        `arn:aws:cognito-idp:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:userpool/*`,
      ],
    }));

    // Note: pool IDs are NOT injected as env vars — doing so would create a CDK circular
    // dependency (Lambda env var Ref: UserPool ↔ UserPool LambdaConfig: Lambda ARN).
    // The Lambda determines the group from the custom:user_type attribute in the event instead.
  }
}
