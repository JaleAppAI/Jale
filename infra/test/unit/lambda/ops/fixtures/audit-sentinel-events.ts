/**
 * Fixture EventBridge events for the audit sentinel's rules, shaped like the
 * CloudTrail, sign-in, GuardDuty and Security Hub events EventBridge delivers.
 * Every account id, ARN, address and name here is a documentation placeholder.
 */

export const ACCOUNT = '111122223333';
export const REGION = 'us-east-2';

type Json = Record<string, any>;

let counter = 0;

/** One "AWS API Call via CloudTrail" event around `detail`. */
export function apiCall(detail: Json, overrides: Json = {}): Json {
  counter += 1;
  return {
    version: '0',
    id: `0d6f1e2a-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    'detail-type': 'AWS API Call via CloudTrail',
    source: `aws.${String(detail.eventSource ?? 'unknown').split('.')[0]}`,
    account: ACCOUNT,
    time: '2026-10-04T12:00:00Z',
    region: REGION,
    resources: [],
    detail: {
      eventVersion: '1.09',
      eventTime: '2026-10-04T12:00:00Z',
      awsRegion: REGION,
      eventID: `5b9c1d2e-0000-4000-8000-${String(counter).padStart(12, '0')}`,
      sourceIPAddress: '198.51.100.10',
      userAgent: 'aws-cli/2.0',
      eventType: 'AwsApiCall',
      managementEvent: true,
      recipientAccountId: ACCOUNT,
      ...detail,
    },
    ...overrides,
  };
}

/** An assumed-role identity whose role is `roleName`, in session `session`. */
export function assumedRole(roleName: string, extra: Json = {}, session = 'session'): Json {
  return {
    type: 'AssumedRole',
    principalId: `AROAEXAMPLEID:${session}`,
    arn: `arn:aws:sts::${ACCOUNT}:assumed-role/${roleName}/${session}`,
    accountId: ACCOUNT,
    sessionContext: {
      sessionIssuer: {
        type: 'Role',
        principalId: 'AROAEXAMPLEID',
        arn: `arn:aws:iam::${ACCOUNT}:role/${roleName}`,
        accountId: ACCOUNT,
        userName: roleName,
      },
      attributes: { mfaAuthenticated: 'false' },
    },
    ...extra,
  };
}

export const LAMBDA_ROLE = 'JaleApiStack-WorkerProfileLambdaFunctionServiceRo-AbC123dEf456';
/** A Lambda function's session: its function name, which CloudFormation prefixes with the stack name. */
export const LAMBDA_SESSION = 'JaleApiStack-WorkerProfileLambdaFunction-AbCdEfGh1234';
/** The ops host's sessions are named after its EC2 instance. */
export const OPS_HOST_SESSION = 'i-0123456789abcdef0';
export const APP_STACKS = [
  'JaleNetworkStack', 'JaleDatabaseStack', 'JaleAuditArchiveStack', 'JaleAuditStack', 'JaleBastionStack', 'JaleAuthStack',
  'JaleAiStack', 'JaleMatchingStack', 'JaleApiStack', 'JaleBillingStack', 'JaleReferralsStack', 'JaleNotificationsStack',
  'JaleLegalStack', 'JaleDocumentsStack', 'JaleWhatsAppStack', 'JaleMediaBoardStack', 'JaleAdminCertStack', 'JaleAdminStack',
];
export const OPS_HOST_ROLE = 'JaleBastionStack-BastionHostInstanceRoleDD3FA5F1-AbC123dEf456';
export const CFN_EXEC_ROLE = 'cdk-hnb659fds-cfn-exec-role-111122223333-us-east-2';
export const PERSON_ROLE = 'AWSReservedSSO_AdministratorAccess_0123456789abcdef';

/** The audit export job's function and execution role, named the way CloudFormation names them. */
export const EXPORT_FUNCTION = 'JaleAuditStack-AuditExportFunction-XyZ789';
export const EXPORT_ROLE = 'JaleAuditStack-AuditExportFunctionServiceRole-AbC123dEf456';
export const EXPORT_ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/${EXPORT_ROLE}`;
/** What a deploy uploads a function's code to: the bootstrap's asset bucket. */
const ASSET_CODE = { s3Bucket: `cdk-hnb659fds-assets-${ACCOUNT}-${REGION}`, s3Key: '0123456789abcdef.zip' };
const DEPLOY = assumedRole(CFN_EXEC_ROLE, { invokedBy: 'cloudformation.amazonaws.com' }, 'AWSCloudFormation');

/**
 * A Lambda management event, as CloudTrail records it: the versioned event
 * name, and requestParameters without `environment` or `zipFile`, which
 * CloudTrail omits (AWS Lambda Developer Guide, "Logging AWS Lambda API calls
 * using AWS CloudTrail").
 */
function lambdaCall(eventName: string, userIdentity: Json, requestParameters: Json, extra: Json = {}): Json {
  const viaCloudFormation = userIdentity.invokedBy === 'cloudformation.amazonaws.com';
  return apiCall({
    eventSource: 'lambda.amazonaws.com',
    eventName,
    userIdentity,
    ...(viaCloudFormation ? { sourceIPAddress: 'cloudformation.amazonaws.com', userAgent: 'cloudformation.amazonaws.com' } : {}),
    requestParameters,
    readOnly: false,
    eventCategory: 'Management',
    ...extra,
  });
}

export const MASTER_SECRET_ARN = `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:JaleDatabaseStackDatabaseS-AbCdEf123456-XyZ789`;
export const AUDIT_KEY_ARN = `arn:aws:kms:${REGION}:${ACCOUNT}:key/1234abcd-12ab-34cd-56ef-1234567890ab`;
/** The alert topic's own key. */
export const ALERT_KEY_ARN = `arn:aws:kms:${REGION}:${ACCOUNT}:key/5678cdef-56cd-78ef-90ab-5678cdef90ab`;
export const ALERT_KEY_ALIAS = 'alias/jale-audit-alerts';
export const ARCHIVE_BUCKET = `jale-audit-archive-${ACCOUNT}-${REGION}`;
export const ALERT_TOPIC_ARN = `arn:aws:sns:${REGION}:${ACCOUNT}:jale-audit-alerts`;
/** The sentinel itself, and its dead-letter queue, named the way CloudFormation names them. */
export const SENTINEL_FUNCTION_ARN = `arn:aws:lambda:${REGION}:${ACCOUNT}:function:JaleAuditStack-AuditSentinelFunction-AbC123`;
export const SENTINEL_DEAD_LETTER_NAME = 'JaleAuditStack-SentinelDeadLetters1A2B3C4D-AbCdEfGh1234';
export const SENTINEL_DEAD_LETTER_ARN = `arn:aws:sqs:${REGION}:${ACCOUNT}:${SENTINEL_DEAD_LETTER_NAME}`;
export const SENTINEL_DEAD_LETTER_URL = `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/${SENTINEL_DEAD_LETTER_NAME}`;
/** An edge region's dead-letter queue, by its fixed name, and an app queue. */
export const EDGE_DEAD_LETTER_URL = `https://sqs.us-west-2.amazonaws.com/${ACCOUNT}/jale-audit-edge-dead-letters`;
export const APP_QUEUE_URL = `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/JaleNotificationsStack-OutboxQueue-AbC123`;
/** An audit alarm by its ARN. */
export const AUDIT_ALARM_ARN = `arn:aws:cloudwatch:${REGION}:${ACCOUNT}:alarm:JaleAuditDailyCompareMismatch`;
/** The main region's default event bus, every edge forward's target. */
export const MAIN_BUS_ARN = `arn:aws:events:${REGION}:${ACCOUNT}:event-bus/default`;
export const ADMIN_POOL_ID = `${REGION}_AdminPool1`;
export const WORKER_POOL_ID = `${REGION}_WorkerPool1`;

/** The five reference events, plus the neighbours of each. */
export const EVENTS = {
  cfnResolvesMasterPassword: apiCall({
    eventSource: 'secretsmanager.amazonaws.com',
    eventName: 'GetSecretValue',
    userIdentity: assumedRole(CFN_EXEC_ROLE, { invokedBy: 'cloudformation.amazonaws.com' }, 'AWSCloudFormation'),
    sourceIPAddress: 'cloudformation.amazonaws.com',
    userAgent: 'cloudformation.amazonaws.com',
    requestParameters: { secretId: MASTER_SECRET_ARN },
    responseElements: null,
    readOnly: true,
  }),
  lambdaReadsOwnSecret: apiCall({
    eventSource: 'secretsmanager.amazonaws.com',
    eventName: 'GetSecretValue',
    userIdentity: assumedRole(LAMBDA_ROLE, {}, LAMBDA_SESSION),
    requestParameters: { secretId: 'jale/api/db' },
    responseElements: null,
    readOnly: true,
  }),
  personReadsRuntimeSecret: apiCall({
    eventSource: 'secretsmanager.amazonaws.com',
    eventName: 'GetSecretValue',
    userIdentity: assumedRole(PERSON_ROLE),
    requestParameters: { secretId: 'jale/api/db' },
    responseElements: null,
    readOnly: true,
  }),
  personReadsMasterSecret: apiCall({
    eventSource: 'secretsmanager.amazonaws.com',
    eventName: 'GetSecretValue',
    userIdentity: { type: 'IAMUser', arn: `arn:aws:iam::${ACCOUNT}:user/example-operator`, accountId: ACCOUNT, userName: 'example-operator' },
    requestParameters: { secretId: MASTER_SECRET_ARN },
    responseElements: null,
    readOnly: true,
  }),
  opsHostReadsMasterSecret: apiCall({
    eventSource: 'secretsmanager.amazonaws.com',
    eventName: 'GetSecretValue',
    userIdentity: assumedRole(OPS_HOST_ROLE, {}, OPS_HOST_SESSION),
    requestParameters: { secretId: MASTER_SECRET_ARN },
    responseElements: null,
    readOnly: true,
  }),
  lambdaDeniedOtherSecret: apiCall({
    eventSource: 'secretsmanager.amazonaws.com',
    eventName: 'GetSecretValue',
    userIdentity: assumedRole(LAMBDA_ROLE, {}, LAMBDA_SESSION),
    requestParameters: { secretId: 'jale/billing/db' },
    errorCode: 'AccessDenied',
    errorMessage: 'User is not authorized to perform this action',
    responseElements: null,
    readOnly: true,
  }),
  personReadsOwnPersonalSecret: apiCall({
    eventSource: 'secretsmanager.amazonaws.com',
    eventName: 'GetSecretValue',
    userIdentity: assumedRole(PERSON_ROLE),
    requestParameters: { secretId: 'jale/person-example/db' },
    responseElements: null,
    readOnly: true,
  }),
  secretValueChanged: apiCall({
    eventSource: 'secretsmanager.amazonaws.com',
    eventName: 'PutSecretValue',
    userIdentity: assumedRole(PERSON_ROLE),
    requestParameters: { secretId: 'jale/api/db', secretString: 'HIDDEN_DUE_TO_SECURITY_REASONS' },
    responseElements: { arn: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:jale/api/db-AbCdEf` },
  }),
  auditBucketPolicyChanged: apiCall({
    eventSource: 's3.amazonaws.com',
    eventName: 'PutBucketPolicy',
    userIdentity: assumedRole(PERSON_ROLE),
    requestParameters: { bucketName: ARCHIVE_BUCKET, bucketPolicy: { Statement: [] }, policy: '' },
  }),
  otherBucketPolicyChanged: apiCall({
    eventSource: 's3.amazonaws.com',
    eventName: 'PutBucketPolicy',
    userIdentity: assumedRole(PERSON_ROLE),
    requestParameters: { bucketName: `jale-worker-documents-${ACCOUNT}` },
  }),
  auditRoleAssumed: apiCall({
    eventSource: 'sts.amazonaws.com',
    eventName: 'AssumeRole',
    userIdentity: { type: 'IAMUser', arn: `arn:aws:iam::${ACCOUNT}:user/example-operator`, accountId: ACCOUNT },
    requestParameters: { roleArn: `arn:aws:iam::${ACCOUNT}:role/JaleAuditAdmin`, roleSessionName: 'review' },
    readOnly: true,
  }),
  otherRoleAssumed: apiCall({
    eventSource: 'sts.amazonaws.com',
    eventName: 'AssumeRole',
    userIdentity: { type: 'AWSService', invokedBy: 'lambda.amazonaws.com' },
    requestParameters: { roleArn: `arn:aws:iam::${ACCOUNT}:role/${LAMBDA_ROLE}`, roleSessionName: 'fn' },
    readOnly: true,
  }),
  databaseModified: apiCall({
    eventSource: 'rds.amazonaws.com',
    eventName: 'ModifyDBInstance',
    userIdentity: assumedRole(CFN_EXEC_ROLE, { invokedBy: 'cloudformation.amazonaws.com' }),
    requestParameters: { dBInstanceIdentifier: 'example-instance', cloudwatchLogsExportConfiguration: { enableLogTypes: ['postgresql'] } },
  }),
  databaseDescribed: apiCall({
    eventSource: 'rds.amazonaws.com',
    eventName: 'DescribeDBInstances',
    userIdentity: assumedRole(PERSON_ROLE),
    requestParameters: null,
    readOnly: true,
  }),
  snapshotShared: apiCall({
    eventSource: 'rds.amazonaws.com',
    eventName: 'ModifyDBSnapshotAttribute',
    userIdentity: assumedRole(PERSON_ROLE),
    requestParameters: { dBSnapshotIdentifier: 'example-snapshot', attributeName: 'restore' },
  }),
  deployChangesWorkloadRolePolicy: apiCall({
    eventSource: 'iam.amazonaws.com',
    eventName: 'PutRolePolicy',
    awsRegion: 'us-east-1',
    userIdentity: assumedRole(CFN_EXEC_ROLE, { invokedBy: 'cloudformation.amazonaws.com' }, 'AWSCloudFormation'),
    sourceIPAddress: 'cloudformation.amazonaws.com',
    requestParameters: { roleName: LAMBDA_ROLE, policyName: 'DefaultPolicy' },
  }, { region: 'us-east-1' }),
  deployChangesAuditRole: apiCall({
    eventSource: 'iam.amazonaws.com',
    eventName: 'UpdateAssumeRolePolicy',
    awsRegion: 'us-east-1',
    userIdentity: assumedRole(CFN_EXEC_ROLE, { invokedBy: 'cloudformation.amazonaws.com' }),
    sourceIPAddress: 'cloudformation.amazonaws.com',
    requestParameters: { roleName: 'JaleAuditReader' },
  }, { region: 'us-east-1' }),
  personAttachesPolicy: apiCall({
    eventSource: 'iam.amazonaws.com',
    eventName: 'AttachUserPolicy',
    awsRegion: 'us-east-1',
    userIdentity: assumedRole(PERSON_ROLE),
    requestParameters: { userName: 'example-operator', policyArn: 'arn:aws:iam::aws:policy/AdministratorAccess' },
  }, { region: 'us-east-1' }),
  accessKeyCreated: apiCall({
    eventSource: 'iam.amazonaws.com',
    eventName: 'CreateAccessKey',
    awsRegion: 'us-east-1',
    userIdentity: assumedRole(CFN_EXEC_ROLE, { invokedBy: 'cloudformation.amazonaws.com' }),
    sourceIPAddress: 'cloudformation.amazonaws.com',
    requestParameters: { userName: 'example-operator' },
  }, { region: 'us-east-1' }),
  iamRead: apiCall({
    eventSource: 'iam.amazonaws.com',
    eventName: 'GetRole',
    awsRegion: 'us-east-1',
    userIdentity: assumedRole(PERSON_ROLE),
    requestParameters: { roleName: 'JaleAuditReader' },
    readOnly: true,
  }, { region: 'us-east-1' }),
  rootUse: apiCall({
    eventSource: 's3.amazonaws.com',
    eventName: 'ListBuckets',
    userIdentity: { type: 'Root', arn: `arn:aws:iam::${ACCOUNT}:root`, accountId: ACCOUNT },
    readOnly: true,
  }),
  parameterChanged: apiCall({
    eventSource: 'ssm.amazonaws.com',
    eventName: 'PutParameter',
    userIdentity: assumedRole(PERSON_ROLE),
    requestParameters: { name: '/example/parameter', overwrite: true, value: 'HIDDEN_DUE_TO_SECURITY_REASONS' },
  }),
  agentHeartbeat: apiCall({
    eventSource: 'ssm.amazonaws.com',
    eventName: 'UpdateInstanceInformation',
    userIdentity: assumedRole(OPS_HOST_ROLE),
    requestParameters: { instanceId: 'example' },
  }),
  auditKeyPolicyChanged: apiCall({
    eventSource: 'kms.amazonaws.com',
    eventName: 'PutKeyPolicy',
    userIdentity: assumedRole(PERSON_ROLE),
    requestParameters: { keyId: AUDIT_KEY_ARN, policyName: 'default' },
    resources: [{ accountId: ACCOUNT, type: 'AWS::KMS::Key', ARN: AUDIT_KEY_ARN }],
  }),
  otherKeyPolicyChanged: apiCall({
    eventSource: 'kms.amazonaws.com',
    eventName: 'PutKeyPolicy',
    userIdentity: assumedRole(PERSON_ROLE),
    requestParameters: { keyId: `arn:aws:kms:${REGION}:${ACCOUNT}:key/ffffffff-12ab-34cd-56ef-1234567890ab`, policyName: 'default' },
    resources: [{ accountId: ACCOUNT, type: 'AWS::KMS::Key', ARN: `arn:aws:kms:${REGION}:${ACCOUNT}:key/ffffffff-12ab-34cd-56ef-1234567890ab` }],
  }),
  auditKeyDisabledById: apiCall({
    eventSource: 'kms.amazonaws.com',
    eventName: 'ScheduleKeyDeletion',
    userIdentity: assumedRole(PERSON_ROLE),
    requestParameters: { keyId: '1234abcd-12ab-34cd-56ef-1234567890ab', pendingWindowInDays: 7 },
  }),
  fallbackRetentionChanged: apiCall({
    eventSource: 'logs.amazonaws.com',
    eventName: 'PutRetentionPolicy',
    userIdentity: assumedRole(PERSON_ROLE),
    requestParameters: { logGroupName: '/jale/audit/fallback', retentionInDays: 1 },
  }),
  engineSubscriptionDeleted: apiCall({
    eventSource: 'logs.amazonaws.com',
    eventName: 'DeleteSubscriptionFilter',
    userIdentity: assumedRole(PERSON_ROLE),
    requestParameters: { logGroupName: '/aws/rds/instance/example-instance/postgresql', filterName: 'x' },
  }),
  otherLogGroupRetention: apiCall({
    eventSource: 'logs.amazonaws.com',
    eventName: 'PutRetentionPolicy',
    userIdentity: assumedRole(CFN_EXEC_ROLE, { invokedBy: 'cloudformation.amazonaws.com' }),
    requestParameters: { logGroupName: '/aws/lambda/example', retentionInDays: 30 },
  }),
  auditRuleDisabled: apiCall({
    eventSource: 'events.amazonaws.com',
    eventName: 'DisableRule',
    userIdentity: assumedRole(PERSON_ROLE),
    requestParameters: { name: 'jale-audit-secret-reads' },
  }),
  trailStopped: apiCall({
    eventSource: 'cloudtrail.amazonaws.com',
    eventName: 'StopLogging',
    userIdentity: assumedRole(PERSON_ROLE),
    requestParameters: { name: `arn:aws:cloudtrail:${REGION}:${ACCOUNT}:trail/jale-audit-trail` },
  }),
  guardDutyDisabled: apiCall({
    eventSource: 'guardduty.amazonaws.com',
    eventName: 'DeleteDetector',
    userIdentity: assumedRole(PERSON_ROLE),
    requestParameters: { detectorId: 'exampledetector' },
  }),
  securityHubDisabled: apiCall({
    eventSource: 'securityhub.amazonaws.com',
    eventName: 'DisableSecurityHub',
    userIdentity: assumedRole(PERSON_ROLE),
    requestParameters: {},
  }),
  recorderStopped: apiCall({
    eventSource: 'config.amazonaws.com',
    eventName: 'StopConfigurationRecorder',
    userIdentity: assumedRole(PERSON_ROLE),
    requestParameters: { configurationRecorderName: 'default' },
  }),
  sentinelCodeChanged: apiCall({
    eventSource: 'lambda.amazonaws.com',
    eventName: 'UpdateFunctionCode20150331v2',
    userIdentity: assumedRole(PERSON_ROLE),
    requestParameters: { functionName: 'JaleAuditStack-AuditSentinelFunction-AbC123' },
  }),
  // Code that runs as the export job's role: a function created with the
  // role, a function given it, and every change to what the export function runs.
  functionCreatedWithExportRole: lambdaCall('CreateFunction20150331', assumedRole(PERSON_ROLE), {
    functionName: 'example-function',
    runtime: 'nodejs24.x',
    role: EXPORT_ROLE_ARN,
    handler: 'index.handler',
    code: {},
    timeout: 60,
    memorySize: 128,
    publish: false,
    packageType: 'Zip',
  }, {
    responseElements: {
      functionName: 'example-function',
      functionArn: `arn:aws:lambda:${REGION}:${ACCOUNT}:function:example-function`,
      role: EXPORT_ROLE_ARN,
      version: '$LATEST',
      state: 'Pending',
    },
  }),
  functionGivenExportRole: lambdaCall('UpdateFunctionConfiguration20150331v2', assumedRole(PERSON_ROLE), {
    functionName: 'example-function',
    role: EXPORT_ROLE_ARN,
  }),
  exportCodeChanged: lambdaCall('UpdateFunctionCode20150331v2', assumedRole(PERSON_ROLE), {
    functionName: EXPORT_FUNCTION,
    publish: false,
    dryRun: false,
  }),
  exportLayersChanged: lambdaCall('UpdateFunctionConfiguration20150331v2', assumedRole(PERSON_ROLE), {
    functionName: EXPORT_FUNCTION,
    layers: [`arn:aws:lambda:${REGION}:${ACCOUNT}:layer:example-layer:1`],
  }),
  exportVersionPublished: lambdaCall('PublishVersion20150331', assumedRole(PERSON_ROLE), {
    functionName: EXPORT_FUNCTION,
    description: '',
  }),
  exportAliasCreated: lambdaCall('CreateAlias20150331', assumedRole(PERSON_ROLE), {
    functionName: EXPORT_FUNCTION,
    name: 'example',
    functionVersion: '1',
  }),
  exportAliasUpdated: lambdaCall('UpdateAlias20150331', assumedRole(PERSON_ROLE), {
    functionName: `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${EXPORT_FUNCTION}`,
    name: 'example',
    functionVersion: '2',
  }),
  exportAliasDeleted: lambdaCall('DeleteAlias20150331', assumedRole(PERSON_ROLE), {
    functionName: EXPORT_FUNCTION,
    name: 'example',
  }),
  // The pipeline's own deploy, through the deploy execution role. Its changes
  // to the export function alert like anyone's. A replacement would create
  // the function under a new generated name, with the same role.
  deployCreatesReplacementExportFunction: lambdaCall('CreateFunction20150331', DEPLOY, {
    functionName: 'JaleAuditStack-AuditExportFunction-NeW456',
    runtime: 'nodejs24.x',
    role: EXPORT_ROLE_ARN,
    handler: 'index.handler',
    code: ASSET_CODE,
    timeout: 600,
    memorySize: 1024,
    publish: false,
    tracingConfig: { mode: 'Active' },
  }),
  deployUpdatesExportCode: lambdaCall('UpdateFunctionCode20150331v2', DEPLOY, {
    functionName: EXPORT_FUNCTION,
    ...ASSET_CODE,
    publish: false,
  }),
  deployUpdatesExportConfiguration: lambdaCall('UpdateFunctionConfiguration20150331v2', DEPLOY, {
    functionName: EXPORT_FUNCTION,
    role: EXPORT_ROLE_ARN,
    handler: 'index.handler',
    runtime: 'nodejs24.x',
    timeout: 600,
    memorySize: 1024,
  }),
  alertTopicUnsubscribed: apiCall({
    eventSource: 'sns.amazonaws.com',
    eventName: 'Unsubscribe',
    userIdentity: assumedRole(PERSON_ROLE),
    requestParameters: { subscriptionArn: `${ALERT_TOPIC_ARN}:0b1c2d3e-0000-4000-8000-000000000001` },
  }),
  adminSignInFailed: apiCall({
    eventSource: 'cognito-idp.amazonaws.com',
    eventName: 'InitiateAuth',
    userIdentity: { type: 'Unknown', principalId: 'Anonymous' },
    errorCode: 'NotAuthorizedException',
    errorMessage: 'Incorrect username or password.',
    sourceIPAddress: '198.51.100.77',
    additionalEventData: { userPoolId: ADMIN_POOL_ID, sub: '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d' },
    requestParameters: { authFlow: 'USER_SRP_AUTH', clientId: 'exampleclientid', authParameters: 'HIDDEN_DUE_TO_SECURITY_REASONS' },
  }),
  adminSecondFactorFailed: apiCall({
    eventSource: 'cognito-idp.amazonaws.com',
    eventName: 'RespondToAuthChallenge',
    userIdentity: { type: 'Unknown', principalId: 'Anonymous' },
    errorCode: 'CodeMismatchException',
    sourceIPAddress: '198.51.100.77',
    requestParameters: { userPoolId: ADMIN_POOL_ID, challengeName: 'SOFTWARE_TOKEN_MFA' },
  }),
  workerSignInFailed: apiCall({
    eventSource: 'cognito-idp.amazonaws.com',
    eventName: 'RespondToAuthChallenge',
    userIdentity: { type: 'Unknown', principalId: 'Anonymous' },
    errorCode: 'NotAuthorizedException',
    sourceIPAddress: '198.51.100.88',
    additionalEventData: { userPoolId: WORKER_POOL_ID, sub: '7b8c9d0e-1f2a-4b3c-9d4e-5f6a7b8c9d0e' },
  }),
  unattributedSignInFailed: apiCall({
    eventSource: 'cognito-idp.amazonaws.com',
    eventName: 'InitiateAuth',
    userIdentity: { type: 'Unknown', principalId: 'Anonymous' },
    errorCode: 'NotAuthorizedException',
    sourceIPAddress: '198.51.100.99',
    additionalEventData: { sub: '8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f' },
    requestParameters: { clientId: 'exampleclientid' },
  }),
  rootSignIn: {
    version: '0',
    id: '7e1f0000-0000-4000-8000-000000000001',
    'detail-type': 'AWS Console Sign In via CloudTrail',
    source: 'aws.signin',
    account: ACCOUNT,
    time: '2026-10-04T12:00:00Z',
    region: 'us-east-1',
    resources: [],
    detail: {
      eventSource: 'signin.amazonaws.com',
      eventName: 'ConsoleLogin',
      eventTime: '2026-10-04T12:00:00Z',
      awsRegion: 'us-east-1',
      eventID: '7e1f0000-0000-4000-8000-0000000000aa',
      sourceIPAddress: '198.51.100.20',
      userIdentity: { type: 'Root', arn: `arn:aws:iam::${ACCOUNT}:root`, accountId: ACCOUNT },
      responseElements: { ConsoleLogin: 'Success' },
      additionalEventData: { MFAUsed: 'Yes' },
    },
  },
  personSignInFailed: {
    version: '0',
    id: '7e1f0000-0000-4000-8000-000000000002',
    'detail-type': 'AWS Console Sign In via CloudTrail',
    source: 'aws.signin',
    account: ACCOUNT,
    time: '2026-10-04T12:00:00Z',
    region: 'us-east-1',
    resources: [],
    detail: {
      eventSource: 'signin.amazonaws.com',
      eventName: 'ConsoleLogin',
      eventTime: '2026-10-04T12:00:00Z',
      awsRegion: 'us-east-1',
      eventID: '7e1f0000-0000-4000-8000-0000000000bb',
      sourceIPAddress: '198.51.100.21',
      userIdentity: { type: 'IAMUser', accountId: ACCOUNT, userName: 'HIDDEN_DUE_TO_SECURITY_REASONS' },
      errorMessage: 'Failed authentication',
      responseElements: { ConsoleLogin: 'Failure' },
    },
  },
  personSignedIn: {
    version: '0',
    id: '7e1f0000-0000-4000-8000-000000000003',
    'detail-type': 'AWS Console Sign In via CloudTrail',
    source: 'aws.signin',
    account: ACCOUNT,
    time: '2026-10-04T12:00:00Z',
    region: 'us-east-1',
    resources: [],
    detail: {
      eventSource: 'signin.amazonaws.com',
      eventName: 'ConsoleLogin',
      eventTime: '2026-10-04T12:00:00Z',
      awsRegion: 'us-east-1',
      eventID: '7e1f0000-0000-4000-8000-0000000000cc',
      sourceIPAddress: '198.51.100.22',
      userIdentity: { type: 'IAMUser', arn: `arn:aws:iam::${ACCOUNT}:user/example-operator`, accountId: ACCOUNT },
      responseElements: { ConsoleLogin: 'Success' },
    },
  },
  guardDutyHigh: {
    version: '0',
    id: '9a0b0000-0000-4000-8000-000000000001',
    'detail-type': 'GuardDuty Finding',
    source: 'aws.guardduty',
    account: ACCOUNT,
    time: '2026-10-04T12:00:00Z',
    region: REGION,
    resources: [],
    detail: {
      schemaVersion: '2.0',
      accountId: ACCOUNT,
      region: REGION,
      id: 'example-finding-1',
      type: 'CredentialAccess:RDS/AnomalousBehavior.SuccessfulLogin',
      severity: 8,
      title: 'Anomalous successful login',
      resource: { resourceType: 'RDSDBInstance' },
      updatedAt: '2026-10-04T12:00:00Z',
    },
  },
  guardDutyLow: {
    version: '0',
    id: '9a0b0000-0000-4000-8000-000000000002',
    'detail-type': 'GuardDuty Finding',
    source: 'aws.guardduty',
    account: ACCOUNT,
    time: '2026-10-04T12:00:00Z',
    region: REGION,
    resources: [],
    detail: {
      schemaVersion: '2.0',
      id: 'example-finding-2',
      type: 'Recon:EC2/PortProbeUnprotectedPort',
      severity: 2,
      resource: { resourceType: 'Instance' },
    },
  },
  securityHubCritical: {
    version: '0',
    id: '9a0b0000-0000-4000-8000-000000000003',
    'detail-type': 'Security Hub Findings - Imported',
    source: 'aws.securityhub',
    account: ACCOUNT,
    time: '2026-10-04T12:00:00Z',
    region: REGION,
    resources: [],
    detail: {
      findings: [{
        Id: 'example-control-finding',
        ProductName: 'Security Hub',
        Title: 'S3 general purpose buckets should block public access',
        Severity: { Label: 'CRITICAL' },
        Workflow: { Status: 'NEW' },
        RecordState: 'ACTIVE',
        Compliance: { Status: 'FAILED' },
        Resources: [{ Type: 'AwsS3Bucket' }],
      }],
    },
  },
  securityHubHigh: {
    version: '0',
    id: '9a0b0000-0000-4000-8000-000000000004',
    'detail-type': 'Security Hub Findings - Imported',
    source: 'aws.securityhub',
    account: ACCOUNT,
    time: '2026-10-04T12:00:00Z',
    region: REGION,
    resources: [],
    detail: {
      findings: [{
        Id: 'example-control-finding-2',
        ProductName: 'Security Hub',
        Title: 'Example control',
        Severity: { Label: 'HIGH' },
        Workflow: { Status: 'NEW' },
        RecordState: 'ACTIVE',
      }],
    },
  },
} as const;
