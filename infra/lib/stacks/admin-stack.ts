import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { Construct } from 'constructs';
import { resolveCognitoDeletionProtection } from '../constructs/cognito-pool';
import { resolveCognitoSesEmail } from '../constructs/cognito-ses-email';
import { ADMIN_INVITE_VALID_DAYS, renderAdminInviteEmail } from '../../lambda/lib/admin-invite-email-template';

export interface AdminStackProps extends cdk.StackProps {
  readonly domainName: string;
  readonly hostedZoneId: string;
  readonly vpc: ec2.IVpc;
  readonly privateSubnets: ec2.ISubnet[];
  readonly lambdaSg: ec2.ISecurityGroup;
  /**
   * Dedicated jale_admin_console role secret (NOT the shared jale_admin
   * secret). The internet-facing admin Lambda runs as a least-privilege
   * role with column-scoped cross-user read of `users` (migration 025).
   */
  readonly adminDbSecret: secretsmanager.ISecret;
  /** Report images (ReportsStack). The console opens attached images, and only those. */
  readonly reportImagesBucket: s3.IBucket;
  /** The report images bucket's key. */
  readonly reportImagesKey: kms.IKey;
  /** WhatsApp support media (WhatsAppStack). The console opens a case's attachments, and only those. */
  readonly supportMediaBucket: s3.IBucket;
  /** The support media bucket's key. */
  readonly supportMediaKey: kms.IKey;
  /** CloudFront certificate for admin.<domain>, created in us-east-1. */
  readonly certificate: acm.ICertificate;
  /** CloudFront-scoped WAF web ACL created in us-east-1. */
  readonly webAclArn: string;
  /**
   * The existing monitored ops topic (the shared `whatsappAlarmTopicArn`
   * context). Optional, like ReportsStack's: without it the alarms still
   * exist and are visible in the console, with no action.
   */
  readonly alarmTopicArn?: string;
}

/**
 * The dead-letter queues whose depth the Ops page shows (contract K3.3 #11),
 * by queue name, with the plain label the page prints. Only queues with a
 * producer: the candidate materialization and worker rerank queues have
 * none. The SES feedback queue (its name comes from deploy context) and the
 * audit edge queues (other regions) are not listed.
 */
export const ADMIN_DLQ_QUEUES: ReadonlyArray<{ name: string; label: string }> = [
  { name: 'whatsapp-inbound-v2-dlq.fifo', label: 'WhatsApp inbound' },
  { name: 'whatsapp-inbound-dlq', label: 'WhatsApp inbound (first version)' },
  { name: 'whatsapp-worker-intent-wake-dlq', label: 'Worker notifications' },
  { name: 'whatsapp-domain-outbox-wake-dlq', label: 'WhatsApp outbox' },
  { name: 'billing-webhook-dlq', label: 'Billing webhooks' },
  { name: 'jale-post-confirmation-dlq', label: 'Sign-up confirmations' },
  { name: 'jale-employer-candidate-rerank-dlq', label: 'Candidate ranking' },
  { name: 'trust-extraction-dlq', label: 'Trust answers' },
  { name: 'trust-assessment-dlq', label: 'Trust scores' },
  { name: 'jale-employer-digest-producer-dlq', label: 'Employer digest' },
];

export function getAdminDurability(environment: string) {
  const isDevelopment = environment === 'dev';
  return {
    removalPolicy: isDevelopment ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
    logRetention: isDevelopment ? logs.RetentionDays.ONE_WEEK : logs.RetentionDays.THREE_MONTHS,
    autoDeleteObjects: isDevelopment,
  };
}

export class AdminStack extends cdk.Stack {
  public readonly adminPool: cognito.UserPool;
  public readonly adminClient: cognito.UserPoolClient;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: AdminStackProps) {
    super(scope, id, props);

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.domainName,
    });
    const adminDomain = `admin.${props.domainName}`;

    const certificate = props.certificate;

    const environment = this.node.tryGetContext('environment') ?? 'dev';
    const durability = getAdminDurability(environment);

    // Same app-global `deletionProtection` context flag the production deploy
    // workflow passes for RDS and the worker/employer pools: the admin pool
    // holds the internal operator accounts (with MFA enrolments that cannot be
    // recreated from a backup), so a replace/destroy must fail loudly. The
    // resolver is fail-safe — only an explicit false (cdk.json's dev value)
    // turns it off.
    //
    // STANDING CONSTRAINT once ACTIVE: CloudFormation replaces a user pool when
    // `UserPoolName`, the schema/custom attributes or the alias/username
    // configuration change, and the replacement's delete is exactly what
    // DeletionProtection blocks. Such an update fails mid-flight and can strand
    // the stack in UPDATE_ROLLBACK_FAILED / UPDATE_ROLLBACK_COMPLETE, which the
    // deploy workflow refuses to deploy over. Changing any of those three means
    // deploying with protection off first, on purpose.
    //
    // Sprint 28 (contract K1) adds only properties CloudFormation updates in
    // place: EmailConfiguration (the shared SES sender), DeviceConfiguration
    // (trusted browsers), AdminCreateUserConfig.InviteMessageTemplate (the
    // branded invitation, rendered at synth) and the temporary password's
    // validity, which the invitation's copy states.
    const invitation = renderAdminInviteEmail(`https://${adminDomain}`);
    this.adminPool = new cognito.UserPool(this, 'AdminUserPool', {
      userPoolName: 'jale-admin-pool',
      deletionProtection: resolveCognitoDeletionProtection(this),
      signInAliases: { email: true },
      selfSignUpEnabled: false,
      autoVerify: { email: true },
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { sms: false, otp: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy: {
        minLength: 14,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: cdk.Duration.days(ADMIN_INVITE_VALID_DAYS),
      },
      // Absent SES context (dev, CI) keeps Cognito's default sender.
      email: resolveCognitoSesEmail(this),
      // "Trust this browser for 7 days": a device is remembered only when the
      // server says so (the console's /api/session), and a remembered device
      // stands in for the authenticator code. The 7-day limit is the console's.
      deviceTracking: {
        challengeRequiredOnNewDevice: true,
        deviceOnlyRememberedOnUserPrompt: true,
      },
      userInvitation: {
        emailSubject: invitation.subject,
        emailBody: invitation.html,
      },
      removalPolicy: durability.removalPolicy,
    });

    this.adminClient = this.adminPool.addClient('AdminUserPoolClient', {
      generateSecret: false,
      authFlows: {
        userSrp: true,
      },
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    new cognito.CfnUserPoolGroup(this, 'AdminReadonlyGroup', {
      userPoolId: this.adminPool.userPoolId,
      groupName: 'admin_readonly',
      description: 'Read-only admin support staff',
      precedence: 3,
    });
    new cognito.CfnUserPoolGroup(this, 'AdminOpsGroup', {
      userPoolId: this.adminPool.userPoolId,
      groupName: 'admin_ops',
      description: 'Operators who can manage support cases and verifications',
      precedence: 2,
    });
    new cognito.CfnUserPoolGroup(this, 'AdminSuperadminGroup', {
      userPoolId: this.adminPool.userPoolId,
      groupName: 'admin_superadmin',
      description: 'Super-admin role for the smallest internal set',
      precedence: 1,
    });

    const adminLogGroup = new logs.LogGroup(this, 'AdminNextLogGroup', {
      logGroupName: '/aws/lambda/jale-admin-nextjs',
      retention: durability.logRetention,
      removalPolicy: durability.removalPolicy,
    });

    const accessLogsBucket = new s3.Bucket(this, 'AdminAccessLogsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
      removalPolicy: durability.removalPolicy,
      autoDeleteObjects: durability.autoDeleteObjects,
    });

    const adminDir = path.resolve(__dirname, '..', '..', '..', 'admin');
    const adminFunction = new lambda.DockerImageFunction(this, 'AdminNextjsFunction', {
      functionName: 'jale-admin-nextjs',
      code: lambda.DockerImageCode.fromImageAsset(adminDir, {
        platform: Platform.LINUX_AMD64,
      }),
      description: 'Jale admin Next.js server',
      memorySize: 1024,
      timeout: cdk.Duration.seconds(30),
      architecture: lambda.Architecture.X86_64,
      vpc: props.vpc,
      vpcSubnets: { subnets: props.privateSubnets },
      securityGroups: [props.lambdaSg],
      logGroup: adminLogGroup,
      environment: {
        NODE_ENV: 'production',
        PORT: '3000',
        HOSTNAME: '0.0.0.0',
        AWS_LAMBDA_EXEC_WRAPPER: '/opt/extensions/lambda-adapter',
        AWS_LWA_INVOKE_MODE: 'response_stream',
        DB_SECRET_ARN: props.adminDbSecret.secretArn,
        // Kept for parity with every other database workload; the admin app
        // pins its login in its own pool code (admin/src/lib/server/db.ts).
        DB_EXPECTED_LOGIN: 'jale_admin_console',
        NEXT_PUBLIC_ADMIN_USER_POOL_ID: this.adminPool.userPoolId,
        NEXT_PUBLIC_ADMIN_CLIENT_ID: this.adminClient.userPoolClientId,
        NEXT_PUBLIC_ADMIN_REGION: cdk.Stack.of(this).region,
        NEXT_PUBLIC_ADMIN_HOSTED_DOMAIN: adminDomain,
        REPORT_IMAGES_BUCKET: props.reportImagesBucket.bucketName,
        SUPPORT_MEDIA_BUCKET: props.supportMediaBucket.bucketName,
        // The dead-letter queues the Ops page reads, by label and address.
        // Built from the queue names in this region, so no other stack
        // exports anything to this one.
        ADMIN_DLQ_QUEUES: cdk.Stack.of(this).toJsonString(ADMIN_DLQ_QUEUES.map(({ name, label }) => ({
          label,
          url: `https://sqs.${cdk.Stack.of(this).region}.amazonaws.com/${cdk.Stack.of(this).account}/${name}`,
        }))),
      },
    });

    props.adminDbSecret.grantRead(adminFunction);

    // Report images: the console presigns a short-lived GET for an attached
    // image, so it needs read on `images/*` and decrypt on the bucket's key.
    // Nothing else: no listing, no writes, and no access to uploads that were
    // never attached (`incoming/*`).
    adminFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [props.reportImagesBucket.arnForObjects('images/*')],
    }));
    adminFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: [props.reportImagesKey.keyArn],
    }));
    // Support media: the console presigns a short-lived GET for a support
    // case's attachment, so it needs read on `support/*` and decrypt on the
    // bucket's key. Nothing else: no listing and no writes.
    adminFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [props.supportMediaBucket.arnForObjects('support/*')],
    }));
    adminFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: [props.supportMediaKey.keyArn],
    }));

    // Admins page (contract K1.5) and trusted browsers (K1.2): the console
    // manages admin accounts, their groups and their remembered devices in
    // this pool, and only this pool (its own ARN, never userpool/*).
    adminFunction.addToRolePolicy(new iam.PolicyStatement({
      sid: 'AdminPoolDirectory',
      actions: [
        'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminGetUser',
        'cognito-idp:AdminAddUserToGroup',
        'cognito-idp:AdminRemoveUserFromGroup',
        'cognito-idp:AdminListGroupsForUser',
        'cognito-idp:AdminDisableUser',
        'cognito-idp:AdminEnableUser',
        'cognito-idp:AdminUserGlobalSignOut',
        'cognito-idp:AdminListDevices',
        'cognito-idp:AdminGetDevice',
        'cognito-idp:AdminUpdateDeviceStatus',
        'cognito-idp:AdminForgetDevice',
      ],
      resources: [this.adminPool.userPoolArn],
    }));

    // Ops health (contract K3.3 #11): the depth of the listed dead-letter
    // queues, and nothing else on them. Reading queue attributes needs no
    // key, whatever the queue's encryption.
    adminFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['sqs:GetQueueAttributes'],
      resources: ADMIN_DLQ_QUEUES.map(({ name }) => cdk.Stack.of(this).formatArn({ service: 'sqs', resource: name })),
    }));
    // Home health (contract K3.4): email bounces from the account-level SES
    // metric. GetMetricData has no resource-level permission, so it can only
    // be granted on every resource.
    adminFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:GetMetricData'],
      resources: ['*'],
    }));

    const functionUrl = adminFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    });

    const oac = new cloudfront.FunctionUrlOriginAccessControl(this, 'AdminOac', {
      originAccessControlName: 'jale-admin-oac',
      signing: cloudfront.Signing.SIGV4_ALWAYS,
    });

    const lambdaOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(functionUrl, {
      originAccessControl: oac,
    });

    const stripAuthorization = new cloudfront.Function(this, 'StripAdminAuthorization', {
      functionName: 'jale-strip-admin-authorization',
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  delete request.headers.authorization;
  return request;
}
`),
    });

    const originRequestPolicy = new cloudfront.OriginRequestPolicy(this, 'AdminOriginRequestPolicy', {
      originRequestPolicyName: 'jale-admin-origin-request',
      comment: 'Forward SSR request data to the admin app without viewer auth headers.',
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.all(),
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.denyList('host', 'authorization'),
    });

    this.distribution = new cloudfront.Distribution(this, 'AdminDistribution', {
      defaultBehavior: {
        origin: lambdaOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        functionAssociations: [
          {
            function: stripAuthorization,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors: {
        '/_next/static/*': {
          origin: lambdaOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          compress: true,
          functionAssociations: [
            {
              function: stripAuthorization,
              eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            },
          ],
        },
      },
      domainNames: [adminDomain],
      certificate,
      webAclId: props.webAclArn,
      logBucket: accessLogsBucket,
      logFilePrefix: 'cloudfront/',
      logIncludesCookies: false,
      enableIpv6: true,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
    });

    new lambda.CfnPermission(this, 'AllowCloudFrontInvokeAdminFunction', {
      action: 'lambda:InvokeFunction',
      functionName: adminFunction.functionArn,
      principal: 'cloudfront.amazonaws.com',
      sourceArn: `arn:${cdk.Aws.PARTITION}:cloudfront::${cdk.Aws.ACCOUNT_ID}:distribution/${this.distribution.distributionId}`,
      invokedViaFunctionUrl: true,
    });

    new route53.ARecord(this, 'AdminAliasRecordA', {
      zone: hostedZone,
      recordName: adminDomain,
      target: route53.RecordTarget.fromAlias(new route53targets.CloudFrontTarget(this.distribution)),
    });
    new route53.AaaaRecord(this, 'AdminAliasRecordAAAA', {
      zone: hostedZone,
      recordName: adminDomain,
      target: route53.RecordTarget.fromAlias(new route53targets.CloudFrontTarget(this.distribution)),
    });

    // The ops topic, when given, is every alarm's ALARM-state action.
    const alarmAction = props.alarmTopicArn
      ? new cloudwatchActions.SnsAction(sns.Topic.fromTopicArn(this, 'AdminAlarmTopic', props.alarmTopicArn))
      : undefined;
    const notify = (alarm: cloudwatch.Alarm): void => {
      if (alarmAction) alarm.addAlarmAction(alarmAction);
    };

    notify(new cloudwatch.Alarm(this, 'AdminLambdaErrorsAlarm', {
      alarmName: 'jale-admin-lambda-errors',
      metric: adminFunction.metricErrors({
        period: cdk.Duration.minutes(5),
        statistic: 'sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    notify(new cloudwatch.Alarm(this, 'AdminLambdaThrottlesAlarm', {
      alarmName: 'jale-admin-lambda-throttles',
      metric: adminFunction.metricThrottles({
        period: cdk.Duration.minutes(5),
        statistic: 'sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // The distribution's 5xx alarm is FrontendStack's: CloudFront publishes
    // its metrics in us-east-1 only, and an alarm reads its own region's.

    new cdk.CfnOutput(this, 'AdminUrl', {
      value: `https://${adminDomain}`,
    });
    new cdk.CfnOutput(this, 'AdminUserPoolId', {
      value: this.adminPool.userPoolId,
    });
    new cdk.CfnOutput(this, 'AdminUserPoolClientId', {
      value: this.adminClient.userPoolClientId,
    });
  }
}
