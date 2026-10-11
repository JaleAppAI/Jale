import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AuditArchiveStack } from '../../../lib/stacks/audit-archive-stack';
import { explicitlyDenied, onlyResource, statements } from './audit-template-helpers';

/**
 * JaleAuditArchiveStack. The key policy, the bucket policy and
 * the Object Lock configuration are pinned here in full: a change to any of
 * them is a deliberate edit of this file, reviewed as such.
 */

const PLACEHOLDER_ACCOUNT = '111111111111';

function synth(): { template: any } {
  const app = new cdk.App();
  const stack = new AuditArchiveStack(app, 'JaleAuditArchiveStack', {
    env: { account: PLACEHOLDER_ACCOUNT, region: 'us-east-2' },
  });
  return { template: Template.fromStack(stack).toJSON() };
}

const ADMIN_ROLE = 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/JaleAuditAdmin';
const ROOT = 'arn:${AWS::Partition}:iam::${AWS::AccountId}:root';
const TRAIL = 'arn:${AWS::Partition}:cloudtrail:${AWS::Region}:${AWS::AccountId}:trail/jale-audit-trail';

describe('JaleAuditArchiveStack', () => {
  const { template } = synth();

  it('carries no account id: every ARN and name is built from pseudo-parameters', () => {
    expect(JSON.stringify(template)).not.toContain(PLACEHOLDER_ACCOUNT);
  });

  describe('the audit key', () => {
    it('rotates, is kept on deletion, and has the fixed alias', () => {
      const key = onlyResource(template, 'AWS::KMS::Key');
      expect(key.Properties.EnableKeyRotation).toBe(true);
      expect(key.DeletionPolicy).toBe('Retain');
      expect(key.UpdateReplacePolicy).toBe('Retain');
      expect(onlyResource(template, 'AWS::KMS::Alias').Properties.AliasName).toBe('alias/jale-audit');
    });

    it('has exactly the pinned key policy: root, the audit admin, and the services that use it', () => {
      const key = onlyResource(template, 'AWS::KMS::Key');
      expect(statements(key.Properties.KeyPolicy)).toEqual([
        { Action: 'kms:*', Effect: 'Allow', Principal: { AWS: ROOT }, Resource: '*' },
        {
          Sid: 'AuditAdminKeyAdministration',
          Action: [
            'kms:Create*', 'kms:Describe*', 'kms:Enable*', 'kms:List*', 'kms:Put*', 'kms:Update*', 'kms:Revoke*',
            'kms:Disable*', 'kms:Get*', 'kms:Delete*', 'kms:TagResource', 'kms:UntagResource',
            'kms:ScheduleKeyDeletion', 'kms:CancelKeyDeletion',
          ],
          Condition: { ArnEquals: { 'aws:PrincipalArn': ADMIN_ROLE } },
          Effect: 'Allow',
          Principal: { AWS: ROOT },
          Resource: '*',
        },
        {
          Sid: 'CloudTrailEncryptsTheAuditTrail',
          Action: 'kms:GenerateDataKey*',
          Condition: {
            StringEquals: { 'aws:SourceArn': TRAIL },
            StringLike: { 'kms:EncryptionContext:aws:cloudtrail:arn': 'arn:${AWS::Partition}:cloudtrail:*:${AWS::AccountId}:trail/*' },
          },
          Effect: 'Allow',
          Principal: { Service: 'cloudtrail.amazonaws.com' },
          Resource: '*',
        },
        {
          Sid: 'CloudTrailDescribesTheKey',
          Action: 'kms:DescribeKey',
          Condition: { StringEquals: { 'aws:SourceArn': TRAIL } },
          Effect: 'Allow',
          Principal: { Service: 'cloudtrail.amazonaws.com' },
          Resource: '*',
        },
        {
          Sid: 'CloudWatchLogsEncryptsTheAuditGroups',
          Action: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
          Condition: {
            ArnLike: {
              'kms:EncryptionContext:aws:logs:arn': [
                'arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/jale/audit/fallback',
                'arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/jale/audit/ops-command',
                'arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/rds/instance/*/postgresql',
              ],
            },
          },
          Effect: 'Allow',
          Principal: { Service: 'logs.${AWS::Region}.amazonaws.com' },
          Resource: '*',
        },
        {
          Sid: 'OnlyTheAuditAdminDisablesOrDeletesTheKey',
          Action: ['kms:DisableKey', 'kms:ScheduleKeyDeletion'],
          Condition: { ArnNotEquals: { 'aws:PrincipalArn': ADMIN_ROLE } },
          Effect: 'Deny',
          Principal: { AWS: '*' },
          Resource: '*',
        },
      ]);
    });

    it('carries no alerts: the alert topic and the alarms use a key of their own', () => {
      const key = onlyResource(template, 'AWS::KMS::Key');
      const services = statements(key.Properties.KeyPolicy).flatMap((s: any) => [s.Principal?.Service ?? []].flat());
      expect(services).not.toContain('cloudwatch.amazonaws.com');
      expect(services).not.toContain('events.amazonaws.com');
      expect(key.Properties.Description).not.toMatch(/alert/i);
    });

    it('never denies a key policy change, so the account root can always recover the key', () => {
      const key = onlyResource(template, 'AWS::KMS::Key');
      const denied = statements(key.Properties.KeyPolicy).filter((s: any) => s.Effect === 'Deny').flatMap((s: any) => [s.Action].flat());
      expect(denied).not.toContain('kms:PutKeyPolicy');
      expect(denied.some((a: string) => a === 'kms:*' || a === '*')).toBe(false);
    });
  });

  describe('the archive bucket', () => {
    const bucket = onlyResource(template, 'AWS::S3::Bucket');

    it('is named by account and region, versioned, kept on deletion, and private', () => {
      expect(bucket.Properties.BucketName).toBe('jale-audit-archive-${AWS::AccountId}-${AWS::Region}');
      expect(bucket.Properties.VersioningConfiguration).toEqual({ Status: 'Enabled' });
      expect(bucket.DeletionPolicy).toBe('Retain');
      expect(bucket.UpdateReplacePolicy).toBe('Retain');
      expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
      });
      expect(bucket.Properties.OwnershipControls).toEqual({ Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] });
    });

    it('locks every object in GOVERNANCE mode for 1096 days', () => {
      expect(bucket.Properties.ObjectLockEnabled).toBe(true);
      expect(bucket.Properties.ObjectLockConfiguration).toEqual({
        ObjectLockEnabled: 'Enabled',
        Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 1096 } },
      });
    });

    it('expires objects the day after their retention ends', () => {
      expect(bucket.Properties.LifecycleConfiguration).toEqual({
        Rules: [{
          Id: 'expire-after-retention',
          Status: 'Enabled',
          ExpirationInDays: 1097,
          NoncurrentVersionExpiration: { NoncurrentDays: 1 },
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
        }],
      });
    });

    it('encrypts with the audit key and a bucket key', () => {
      const keyId = Object.keys(template.Resources).find((id) => template.Resources[id].Type === 'AWS::KMS::Key');
      expect(bucket.Properties.BucketEncryption).toEqual({
        ServerSideEncryptionConfiguration: [{
          BucketKeyEnabled: true,
          ServerSideEncryptionByDefault: { KMSMasterKeyID: `\${${keyId}.Arn}`, SSEAlgorithm: 'aws:kms' },
        }],
      });
    });

    it('has exactly the pinned bucket policy', () => {
      const policy = onlyResource(template, 'AWS::S3::BucketPolicy');
      const bucketId = Object.keys(template.Resources).find((id) => template.Resources[id].Type === 'AWS::S3::Bucket');
      const bucketArn = `\${${bucketId}.Arn}`;
      expect(statements(policy.Properties.PolicyDocument)).toEqual([
        {
          Action: 's3:*',
          Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          Effect: 'Deny',
          Principal: { AWS: '*' },
          Resource: [bucketArn, `${bucketArn}/*`],
        },
        {
          Sid: 'OnlyTheAuditAdminChangesArchivedObjects',
          Action: ['s3:DeleteObject', 's3:DeleteObjectVersion', 's3:PutObjectRetention', 's3:PutObjectLegalHold', 's3:BypassGovernanceRetention'],
          Condition: { ArnNotEquals: { 'aws:PrincipalArn': ADMIN_ROLE } },
          Effect: 'Deny',
          Principal: { AWS: '*' },
          Resource: `${bucketArn}/*`,
        },
        {
          Sid: 'OnlyTheAuditAdminChangesTheArchiveConfiguration',
          Action: [
            's3:PutBucketPolicy', 's3:DeleteBucketPolicy', 's3:PutLifecycleConfiguration', 's3:PutBucketVersioning',
            's3:PutBucketObjectLockConfiguration', 's3:PutEncryptionConfiguration', 's3:PutReplicationConfiguration',
            's3:PutBucketPublicAccessBlock', 's3:PutBucketAcl', 's3:PutBucketOwnershipControls',
          ],
          Condition: { ArnNotEquals: { 'aws:PrincipalArn': ADMIN_ROLE } },
          Effect: 'Deny',
          Principal: { AWS: '*' },
          Resource: bucketArn,
        },
        {
          Sid: 'BatchesAndCheckpointsAreWrittenOnce',
          Action: 's3:PutObject',
          Condition: { Null: { 's3:if-none-match': 'true' } },
          Effect: 'Deny',
          Principal: { AWS: '*' },
          Resource: [`${bucketArn}/db/*`, `${bucketArn}/checks/*`],
        },
        {
          Sid: 'CloudTrailAclCheck',
          Action: 's3:GetBucketAcl',
          Condition: { StringEquals: { 'aws:SourceArn': TRAIL } },
          Effect: 'Allow',
          Principal: { Service: 'cloudtrail.amazonaws.com' },
          Resource: bucketArn,
        },
        {
          Sid: 'CloudTrailWrite',
          Action: 's3:PutObject',
          Condition: { StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control', 'aws:SourceArn': TRAIL } },
          Effect: 'Allow',
          Principal: { Service: 'cloudtrail.amazonaws.com' },
          Resource: `${bucketArn}/cloudtrail/AWSLogs/\${AWS::AccountId}/*`,
        },
      ]);
    });

    describe('writes under db/ and checks/, which only ever create a key', () => {
      const policy = onlyResource(template, 'AWS::S3::BucketPolicy');
      const bucketId = Object.keys(template.Resources).find((id) => template.Resources[id].Type === 'AWS::S3::Bucket');
      const objects = `\${${bucketId}.Arn}`;
      const role = (name: string) => `arn:\${AWS::Partition}:iam::\${AWS::AccountId}:role/${name}`;
      const keys = ['db/events/dt=2026-10-07/example-window.jsonl.gz', 'checks/events/2026-10-07.json.gz'];
      const writers: Array<[string, string | undefined]> = [
        ['the export job', role('JaleAuditStack-AuditExportFunctionServiceRole-AbC123dEf456')],
        ['the audit admin', ADMIN_ROLE],
        ['the deploy execution role', role('cdk-hnb659fds-cfn-exec-role-${AWS::AccountId}-${AWS::Region}')],
        ['an administrator', role('Administrator')],
        ['the account root', ROOT],
        ['a service, which carries no principal ARN', undefined],
      ];

      it.each(writers)('refuses a write without If-None-Match by %s, whatever its identity policy allows', (_who, principalArn) => {
        for (const key of keys) {
          expect([key, explicitlyDenied(policy, { principalArn, action: 's3:PutObject', resource: `${objects}/${key}` })]).toEqual([key, true]);
        }
      });

      it.each(writers)('leaves a create-if-absent write by %s to its identity policy', (_who, principalArn) => {
        for (const key of keys) {
          expect([key, explicitlyDenied(policy, { principalArn, action: 's3:PutObject', resource: `${objects}/${key}`, ifNoneMatch: true })])
            .toEqual([key, false]);
        }
      });

      it("leaves the other prefixes as they were: the trail's delivery and the sentinel's archive", () => {
        for (const key of [
          'cloudtrail/AWSLogs/${AWS::AccountId}/CloudTrail/us-east-2/2026/10/07/example.json.gz',
          'logs/fallback/dt=2026-10-07/1-2.jsonl.gz',
          'findings/cloudtrail/dt=2026-10-07/example.json.gz',
        ]) {
          expect([key, explicitlyDenied(policy, { principalArn: undefined, action: 's3:PutObject', resource: `${objects}/${key}` })]).toEqual([key, false]);
        }
      });
    });
  });

  it('exports nothing but the key ARN JaleAuditStack imports', () => {
    const outputs = Object.values(template.Outputs ?? {}) as any[];
    expect(outputs.every((o) => !o.Export || /AuditKey/.test(JSON.stringify(o.Value)))).toBe(true);
  });
});
