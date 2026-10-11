import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * Fixed names of the audit system's resources.
 *
 * Every stack that touches an audit resource derives its name or ARN from
 * here (with the account and region as CloudFormation pseudo-parameters), so
 * no stack imports another's export for them, and no synthesized template
 * carries an account id. The archive key's ARN is the one value that cannot be
 * derived, and JaleAuditStack imports it.
 */
export const AUDIT_NAMES = {
  /** The attempt-event fallback group. Its name is the AUDIT_FALLBACK_LOG_GROUP value. */
  fallbackLogGroup: '/jale/audit/fallback',
  /** Run Command output from the ops host. */
  opsCommandLogGroup: '/jale/audit/ops-command',
  trail: 'jale-audit-trail',
  alertTopic: 'jale-audit-alerts',
  keyAlias: 'alias/jale-audit',
  /** The alert topic's own key, so alerts never depend on the audit key. */
  alertKeyAlias: 'alias/jale-audit-alerts',
  readerRole: 'JaleAuditReader',
  adminRole: 'JaleAuditAdmin',
  /** The principal tag an identity carries to assume each role. */
  principalTag: 'jale-audit',
  workgroup: 'jale-audit',
  glueDatabase: 'jale_audit',
  /** Every audit EventBridge rule's name starts with this. */
  rulePrefix: 'jale-audit-',
  /** Every audit bucket's name starts with this. */
  bucketPrefix: 'jale-audit-',
} as const;

/** Object Lock default retention on the archive: three years. */
export const ARCHIVE_RETENTION_DAYS = 1096;
/** Lifecycle expiry, one day after the retention ends. */
export const ARCHIVE_EXPIRY_DAYS = 1097;

export type AuditBucket = 'archive' | 'query-results' | 'config';

/** An audit bucket's name: `jale-audit-<kind>-<account>-<region>`. */
export function auditBucketName(kind: AuditBucket): string {
  return `${AUDIT_NAMES.bucketPrefix}${kind}-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`;
}

/** A log group's ARN in the deploying account and region, by name. */
export function auditLogGroupArn(scope: Construct, logGroupName: string): string {
  return cdk.Stack.of(scope).formatArn({
    service: 'logs',
    resource: 'log-group',
    resourceName: logGroupName,
    arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    account: cdk.Aws.ACCOUNT_ID,
    region: cdk.Aws.REGION,
  });
}

/** The engine log groups RDS writes to, for any instance (window deploy 2). */
export function engineLogGroupArnPattern(scope: Construct): string {
  return auditLogGroupArn(scope, '/aws/rds/instance/*/postgresql');
}

/** An audit role's ARN, by its fixed name. */
export function auditRoleArn(roleName: string): string {
  return `arn:${cdk.Aws.PARTITION}:iam::${cdk.Aws.ACCOUNT_ID}:role/${roleName}`;
}

/**
 * The account root as a principal, built from the pseudo-parameter: the
 * default AccountRootPrincipal renders the deploying account literally.
 */
export function accountRootPrincipal(): iam.ArnPrincipal {
  return new iam.ArnPrincipal(`arn:${cdk.Aws.PARTITION}:iam::${cdk.Aws.ACCOUNT_ID}:root`);
}

/** The audit trail's ARN. The trail lives in the main region, with the archive. */
export function auditTrailArn(): string {
  return `arn:${cdk.Aws.PARTITION}:cloudtrail:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:trail/${AUDIT_NAMES.trail}`;
}

/** The actions only the audit-admin role may take on archived objects. */
export const PROTECTED_OBJECT_ACTIONS = [
  's3:DeleteObject',
  's3:DeleteObjectVersion',
  's3:PutObjectRetention',
  's3:PutObjectLegalHold',
  's3:BypassGovernanceRetention',
] as const;

/**
 * The prefixes whose objects are written once: the export batches and the
 * daily check's checkpoints. A write there must carry If-None-Match.
 */
export const WRITE_ONCE_PREFIXES = ['db/', 'checks/'] as const;

/** The archive configuration only the audit-admin role may change. */
export const PROTECTED_BUCKET_ACTIONS = [
  's3:PutBucketPolicy',
  's3:DeleteBucketPolicy',
  's3:PutLifecycleConfiguration',
  's3:PutBucketVersioning',
  's3:PutBucketObjectLockConfiguration',
  's3:PutEncryptionConfiguration',
  's3:PutReplicationConfiguration',
  's3:PutBucketPublicAccessBlock',
  's3:PutBucketAcl',
  's3:PutBucketOwnershipControls',
] as const;

/**
 * The key actions that would make the archive unreadable. Only the
 * audit-admin role may take them. PutKeyPolicy is deliberately not among
 * them: the account root keeps it, so the key stays recoverable if the
 * audit-admin role is ever lost.
 */
export const PROTECTED_KEY_ACTIONS = ['kms:DisableKey', 'kms:ScheduleKeyDeletion'] as const;

/** Key administration, which the audit-admin role holds alongside the account root. */
export const KEY_ADMIN_ACTIONS = [
  'kms:Create*', 'kms:Describe*', 'kms:Enable*', 'kms:List*', 'kms:Put*', 'kms:Update*', 'kms:Revoke*',
  'kms:Disable*', 'kms:Get*', 'kms:Delete*', 'kms:TagResource', 'kms:UntagResource',
  'kms:ScheduleKeyDeletion', 'kms:CancelKeyDeletion',
] as const;

/**
 * JaleAuditArchiveStack: the audit KMS key and the archive
 * bucket. Deployed rarely; the bucket policy and the lock configuration are
 * pinned by its stack test.
 *
 * THE ARCHIVE holds the database export batches (`db/`), the audit log groups
 * (`logs/`), the sentinel's findings (`findings/`) and the trail
 * (`cloudtrail/`). Object Lock in GOVERNANCE mode keeps every object version
 * for 1096 days; the lifecycle expires it the day after. The bucket policy
 * denies deleting objects, changing their retention or legal hold, bypassing
 * governance, and changing the bucket's policy, lifecycle, versioning or lock
 * configuration to every principal except the audit-admin role. Under `db/`
 * and `checks/` a write only ever creates a key, for every principal.
 *
 * That includes the deploy role. Once the bucket exists, a change to any of
 * those settings cannot be deployed by the pipeline: it is an audit-admin
 * procedure (an operator runbook), and the sentinel alerts on it.
 *
 * THE KEY (rotation on) encrypts the archive, the audit log groups and the
 * trail. Its policy keeps the account root (required, so the key can never
 * become unmanageable) and names the audit-admin role as key administrator;
 * only that role may disable the key or schedule its deletion. CloudTrail and
 * CloudWatch Logs (the audit groups only, by encryption context) use it
 * through the key policy; the audit functions and the audit-reader role
 * through their IAM policies. The alert topic has a key of its own
 * (JaleAuditStack), so alerts go out whatever state this key is in.
 *
 * The audit roles live in JaleAuditStack. This stack names them by their
 * fixed ARNs in policy conditions, never as principals, so it deploys before
 * the roles exist.
 */
export class AuditArchiveStack extends cdk.Stack {
  public readonly key: kms.Key;
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: cdk.StackProps = {}) {
    super(scope, id, props);

    const adminRole = auditRoleArn(AUDIT_NAMES.adminRole);
    const trail = auditTrailArn();
    const root = accountRootPrincipal();

    // The whole key policy is written here. The first statement is the one
    // KMS requires: the account root keeps full access, so IAM policies can
    // grant use of the key and the key can never become unmanageable.
    this.key = new kms.Key(this, 'AuditKey', {
      alias: AUDIT_NAMES.keyAlias,
      description: 'Audit archive, audit log groups and audit trail',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      policy: new iam.PolicyDocument({
        statements: [new iam.PolicyStatement({ principals: [root], actions: ['kms:*'], resources: ['*'] })],
      }),
    });

    this.key.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AuditAdminKeyAdministration',
      principals: [root],
      actions: [...KEY_ADMIN_ACTIONS],
      resources: ['*'],
      conditions: { ArnEquals: { 'aws:PrincipalArn': adminRole } },
    }));
    this.key.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'CloudTrailEncryptsTheAuditTrail',
      principals: [new iam.ServicePrincipal('cloudtrail.amazonaws.com')],
      actions: ['kms:GenerateDataKey*'],
      resources: ['*'],
      conditions: {
        StringEquals: { 'aws:SourceArn': trail },
        StringLike: { 'kms:EncryptionContext:aws:cloudtrail:arn': `arn:${cdk.Aws.PARTITION}:cloudtrail:*:${cdk.Aws.ACCOUNT_ID}:trail/*` },
      },
    }));
    this.key.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'CloudTrailDescribesTheKey',
      principals: [new iam.ServicePrincipal('cloudtrail.amazonaws.com')],
      actions: ['kms:DescribeKey'],
      resources: ['*'],
      conditions: { StringEquals: { 'aws:SourceArn': trail } },
    }));
    this.key.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'CloudWatchLogsEncryptsTheAuditGroups',
      principals: [new iam.ServicePrincipal(`logs.${cdk.Aws.REGION}.amazonaws.com`)],
      actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
      resources: ['*'],
      conditions: {
        ArnLike: {
          'kms:EncryptionContext:aws:logs:arn': [
            auditLogGroupArn(this, AUDIT_NAMES.fallbackLogGroup),
            auditLogGroupArn(this, AUDIT_NAMES.opsCommandLogGroup),
            engineLogGroupArnPattern(this),
          ],
        },
      },
    }));
    this.key.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'OnlyTheAuditAdminDisablesOrDeletesTheKey',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: [...PROTECTED_KEY_ACTIONS],
      resources: ['*'],
      conditions: { ArnNotEquals: { 'aws:PrincipalArn': adminRole } },
    }));

    this.bucket = new s3.Bucket(this, 'ArchiveBucket', {
      bucketName: auditBucketName('archive'),
      versioned: true,
      objectLockEnabled: true,
      objectLockDefaultRetention: s3.ObjectLockRetention.governance(cdk.Duration.days(ARCHIVE_RETENTION_DAYS)),
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.key,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      lifecycleRules: [{
        id: 'expire-after-retention',
        expiration: cdk.Duration.days(ARCHIVE_EXPIRY_DAYS),
        noncurrentVersionExpiration: cdk.Duration.days(1),
        abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
      }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const exceptTheAuditAdmin = { ArnNotEquals: { 'aws:PrincipalArn': adminRole } };
    this.bucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'OnlyTheAuditAdminChangesArchivedObjects',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: [...PROTECTED_OBJECT_ACTIONS],
      resources: [this.bucket.arnForObjects('*')],
      conditions: exceptTheAuditAdmin,
    }));
    this.bucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'OnlyTheAuditAdminChangesTheArchiveConfiguration',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: [...PROTECTED_BUCKET_ACTIONS],
      resources: [this.bucket.bucketArn],
      conditions: exceptTheAuditAdmin,
    }));
    // Under db/ and checks/ a write only ever creates a key: without
    // If-None-Match it is refused, for every principal, whatever its identity
    // policy allows. The export job writes each object with one conditional
    // PutObject, so multipart uploads and copies, which cannot carry the
    // header, are refused there too.
    this.bucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'BatchesAndCheckpointsAreWrittenOnce',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:PutObject'],
      resources: WRITE_ONCE_PREFIXES.map((prefix) => this.bucket.arnForObjects(`${prefix}*`)),
      conditions: { Null: { 's3:if-none-match': 'true' } },
    }));
    this.bucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'CloudTrailAclCheck',
      principals: [new iam.ServicePrincipal('cloudtrail.amazonaws.com')],
      actions: ['s3:GetBucketAcl'],
      resources: [this.bucket.bucketArn],
      conditions: { StringEquals: { 'aws:SourceArn': trail } },
    }));
    this.bucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'CloudTrailWrite',
      principals: [new iam.ServicePrincipal('cloudtrail.amazonaws.com')],
      actions: ['s3:PutObject'],
      resources: [this.bucket.arnForObjects(`cloudtrail/AWSLogs/${cdk.Aws.ACCOUNT_ID}/*`)],
      conditions: {
        StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control', 'aws:SourceArn': trail },
      },
    }));
  }
}
