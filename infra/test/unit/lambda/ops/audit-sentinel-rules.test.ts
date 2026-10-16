import { AuthFlowType, ChallengeNameType } from '@aws-sdk/client-cognito-identity-provider';
import * as sentinelRules from '../../../../lambda/ops/audit-sentinel-rules';
import {
  AUDIT_SYSTEM_EVENTS,
  FUNCTION_ROLE_EVENTS,
  FUNCTION_VERSION_EVENTS,
  classifyCognitoFailure,
  classifyEvent,
  cognitoPoolIdOf,
  type Classification,
  type SentinelConfig,
} from '../../../../lambda/ops/audit-sentinel-rules';
import {
  ACCOUNT,
  ADMIN_CLIENT_ID,
  ADMIN_POOL_ID,
  ALERT_KEY_ALIAS,
  ALERT_KEY_ARN,
  ALERT_TOPIC_ARN,
  APP_QUEUE_URL,
  APP_STACKS,
  AUDIT_ALARM_ARN,
  CFN_EXEC_ROLE,
  EDGE_DEAD_LETTER_URL,
  EXPORT_FUNCTION,
  EXPORT_ROLE,
  EXPORT_ROLE_ARN,
  LAMBDA_ROLE,
  LAMBDA_SESSION,
  MASTER_SECRET_ARN,
  OPS_HOST_ROLE,
  OPS_HOST_SESSION,
  PERSON_ROLE,
  REGION,
  SENTINEL_DEAD_LETTER_ARN,
  SENTINEL_DEAD_LETTER_NAME,
  SENTINEL_DEAD_LETTER_URL,
  SECURITY_HUB_FINDING_ID,
  SIGN_IN_SUB,
  WORKER_CLIENT_ID,
  WORKER_POOL_ID,
  apiCall,
  assumedRole,
  AUDIT_KEY_ARN,
  EVENTS,
} from './fixtures/audit-sentinel-events';

const CONFIG: SentinelConfig = {
  alertTopicArn: ALERT_TOPIC_ARN,
  auditKeyArn: AUDIT_KEY_ARN,
  auditKeyAlias: 'alias/jale-audit',
  alertKeyArn: ALERT_KEY_ARN,
  alertKeyAlias: ALERT_KEY_ALIAS,
  auditBucketPrefix: 'jale-audit-',
  auditLogGroups: ['/jale/audit/fallback', '/jale/audit/ops-command'],
  auditRulePrefix: 'jale-audit-',
  auditRoleNames: ['JaleAuditReader', 'JaleAuditAdmin'],
  auditFunctionNames: ['JaleAuditStack-AuditSentinelFunction-AbC123', EXPORT_FUNCTION],
  exportRoleName: EXPORT_ROLE,
  masterSecretArn: MASTER_SECRET_ARN,
  appStacks: APP_STACKS,
  opsHostStack: 'JaleBastionStack',
  deployPolicyNames: ['JaleDbPostureGate'],
  fixedFunctions: [{ stack: 'JaleAdminStack', functionName: 'jale-admin-nextjs' }],
  auditAlarmPrefix: 'JaleAudit',
  auditQueueNames: ['jale-audit-edge-dead-letters', SENTINEL_DEAD_LETTER_NAME],
};

type Name = keyof typeof EVENTS;

function classify(name: Name): Classification {
  return classifyEvent(EVENTS[name] as unknown as Record<string, unknown>, CONFIG);
}

function alertOf(name: Name) {
  const result = classify(name);
  if (result.action !== 'alert') throw new Error(`${name}: expected an alert, got ${result.action}`);
  return result;
}

describe('audit sentinel rules', () => {
  describe('the reference events', () => {
    it("CloudFormation resolving the master password is expected, not an alert", () => {
      expect(classify('cfnResolvesMasterPassword')).toMatchObject({ action: 'expected' });
    });

    it('a Lambda role reading its own secret is expected', () => {
      expect(classify('lambdaReadsOwnSecret')).toMatchObject({ action: 'expected' });
    });

    it('a person reading a runtime secret alerts', () => {
      const { alert } = alertOf('personReadsRuntimeSecret');
      expect(alert).toMatchObject({
        rule: 'secret_read',
        eventName: 'GetSecretValue',
        principalType: 'AssumedRole',
        target: 'jale/api/db',
      });
    });

    it('a write to the audit system alerts', () => {
      const { alert } = alertOf('auditBucketPolicyChanged');
      expect(alert).toMatchObject({ rule: 'audit_system_change', eventName: 'PutBucketPolicy', principalType: 'AssumedRole' });
    });

    it('an audit-role assumption alerts', () => {
      const { alert } = alertOf('auditRoleAssumed');
      expect(alert).toMatchObject({ rule: 'audit_role_assumed', eventName: 'AssumeRole', principalType: 'IAMUser' });
      expect(alert.target).toMatch(/:role\/JaleAuditAdmin$/);
    });
  });

  describe('secrets', () => {
    it('a person reading the master secret alerts', () => {
      expect(alertOf('personReadsMasterSecret').alert).toMatchObject({ rule: 'secret_read', principalType: 'IAMUser' });
    });

    it('the ops host reading the master secret is expected', () => {
      expect(classify('opsHostReadsMasterSecret')).toMatchObject({ action: 'expected' });
    });

    it('a workload role refused a secret alerts', () => {
      expect(alertOf('lambdaDeniedOtherSecret').alert).toMatchObject({ rule: 'secret_read_denied', errorCode: 'AccessDenied' });
    });

    const read = (userIdentity: Record<string, unknown>, secretId: string, extra: Record<string, unknown> = {}) =>
      classifyEvent(apiCall({
        eventSource: 'secretsmanager.amazonaws.com',
        eventName: 'GetSecretValue',
        userIdentity,
        requestParameters: { secretId },
        responseElements: null,
        readOnly: true,
        ...extra,
      }), CONFIG);

    describe('the master secret: only the ops host, and CloudFormation resolving the master password', () => {
      const MASTER_NAME = 'JaleDatabaseStackDatabaseS-AbCdEf123456';
      it.each([
        ['its full ARN', MASTER_SECRET_ARN],
        ['its name', MASTER_NAME],
        ['its ARN without the suffix', `arn:aws:secretsmanager:us-east-2:${ACCOUNT}:secret:${MASTER_NAME}`],
      ])('recognises it by %s', (_label, secretId) => {
        expect(read(assumedRole(LAMBDA_ROLE, {}, LAMBDA_SESSION), secretId)).toMatchObject({ action: 'alert', alert: { rule: 'secret_read' } });
        expect(read(assumedRole(OPS_HOST_ROLE, {}, OPS_HOST_SESSION), secretId)).toMatchObject({ action: 'expected' });
      });

      it('a workload role reading the master secret alerts', () => {
        expect(read(assumedRole('JaleApiStack-SomeHandlerServiceRole-AbC123dEf456', {}, 'JaleApiStack-SomeHandler-AbC'), MASTER_SECRET_ARN))
          .toMatchObject({ action: 'alert', alert: { rule: 'secret_read' } });
      });

      it('a role from a stack outside the app reading the master secret alerts', () => {
        expect(read(assumedRole('JaleScratchStack-AnyRole-ZZZ999', {}, 'JaleScratchStack-Fn-ZZZ'), MASTER_SECRET_ARN))
          .toMatchObject({ action: 'alert' });
      });

      it('is expected from the deploy execution role resolving the master password', () => {
        expect(read(assumedRole(CFN_EXEC_ROLE, { invokedBy: 'cloudformation.amazonaws.com' }, 'AWSCloudFormation'), MASTER_SECRET_ARN, { sourceIPAddress: 'cloudformation.amazonaws.com' }))
          .toMatchObject({ action: 'expected', reason: 'cloudformation_master_password' });
      });

      it('alerts on the ops host role in a session that is not its instance', () => {
        expect(read(assumedRole(OPS_HOST_ROLE, {}, 'someone'), MASTER_SECRET_ARN)).toMatchObject({ action: 'alert' });
      });

      it('alerts on an AWS service reading it', () => {
        expect(read({ type: 'AWSService', invokedBy: 'rds.amazonaws.com' }, MASTER_SECRET_ARN)).toMatchObject({ action: 'alert' });
      });

      it('alerts when a batch read includes it', () => {
        const e = apiCall({
          eventSource: 'secretsmanager.amazonaws.com', eventName: 'BatchGetSecretValue',
          userIdentity: assumedRole(LAMBDA_ROLE, {}, LAMBDA_SESSION), requestParameters: { secretIdList: ['jale/api/db', MASTER_SECRET_ARN] },
        });
        expect(classifyEvent(e, CONFIG)).toMatchObject({ action: 'alert' });
      });
    });

    describe('runtime secrets: exact app roles in their own sessions only', () => {
      it('a person reading a runtime secret through CloudFormation alerts', () => {
        expect(read(
          { type: 'IAMUser', arn: `arn:aws:iam::${ACCOUNT}:user/example-operator`, accountId: ACCOUNT, userName: 'example-operator', invokedBy: 'cloudformation.amazonaws.com' },
          'jale/api/db',
          { sourceIPAddress: 'cloudformation.amazonaws.com' },
        )).toMatchObject({ action: 'alert', alert: { rule: 'secret_read' } });
      });

      it('the deploy execution role resolving a runtime secret alerts: only the master password is resolved by templates', () => {
        expect(read(assumedRole(CFN_EXEC_ROLE, { invokedBy: 'cloudformation.amazonaws.com' }, 'AWSCloudFormation'), 'jale/api/db'))
          .toMatchObject({ action: 'alert' });
      });

      it('a role named like an app stack in a session that is not one of its functions alerts', () => {
        expect(read(assumedRole(LAMBDA_ROLE, {}, 'someone'), 'jale/api/db')).toMatchObject({ action: 'alert' });
      });

      it('a role from a stack outside the app alerts, whatever its name looks like', () => {
        expect(read(assumedRole('JaleScratchStack-AnyRole-ZZZ999', {}, 'JaleScratchStack-Fn-ZZZ'), 'jale/api/db')).toMatchObject({ action: 'alert' });
      });

      describe('functions with a fixed name', () => {
        const ADMIN_ROLE = 'JaleAdminStack-AdminNextjsFunctionServiceRole1A2B3C-AbC123dEf456';

        it('the admin dashboard function reading its own secret is expected', () => {
          expect(read(assumedRole(ADMIN_ROLE, {}, 'jale-admin-nextjs'), 'jale/admin-console/db'))
            .toMatchObject({ action: 'expected', reason: 'app_function' });
        });

        it.each([
          ['a longer session name', ADMIN_ROLE, 'jale-admin-nextjs2'],
          ['a session name with a suffix', ADMIN_ROLE, 'jale-admin-nextjs-other'],
          ['a shorter session name', ADMIN_ROLE, 'jale-admin-next'],
          ['the right session under another stack', 'JaleApiStack-SomeRole-AbC123', 'jale-admin-nextjs'],
          ['the right session under a stack outside the app', 'JaleAdminStackX-SomeRole-AbC123', 'jale-admin-nextjs'],
        ])('a look-alike alerts: %s', (_label, role, session) => {
          expect(read(assumedRole(role, {}, session), 'jale/admin-console/db')).toMatchObject({ action: 'alert' });
        });

        it('never makes a fixed-name function a reader of the master secret', () => {
          expect(read(assumedRole(ADMIN_ROLE, {}, 'jale-admin-nextjs'), MASTER_SECRET_ARN)).toMatchObject({ action: 'alert' });
        });
      });

      it('the ops host reading a runtime secret is expected', () => {
        expect(read(assumedRole(OPS_HOST_ROLE, {}, OPS_HOST_SESSION), 'jale/api/db')).toMatchObject({ action: 'expected' });
      });
    });

    it("a person reading their own personal login's secret is expected", () => {
      expect(classify('personReadsOwnPersonalSecret')).toMatchObject({ action: 'expected' });
    });

    it('recognises a personal secret by its exact name, by name or by ARN, and nothing like it', () => {
      const read = (secretId: string) => classifyEvent({
        ...EVENTS.personReadsOwnPersonalSecret,
        detail: { ...EVENTS.personReadsOwnPersonalSecret.detail, requestParameters: { secretId } },
      } as unknown as Record<string, unknown>, CONFIG).action;
      expect(read('jale/person-example/db')).toBe('expected');
      expect(read('jale/person-first-last/db')).toBe('expected');
      expect(read('arn:aws:secretsmanager:us-east-2:111122223333:secret:jale/person-example/db-AbC123')).toBe('expected');
      for (const other of [
        'jale/person/db', 'jale/person-/db', 'jale/person-example/db2', 'jale/person-example/other/db',
        'jale/person-Example/db', 'jale/persons-example/db', 'jale/api/db', 'xjale/person-example/db',
        'arn:aws:secretsmanager:us-east-2:111122223333:secret:jale/person-example/db',
      ]) {
        expect([other, read(other)]).toEqual([other, 'alert']);
      }
    });

    it('any change to a secret alerts', () => {
      expect(alertOf('secretValueChanged').alert).toMatchObject({ rule: 'secret_change', eventName: 'PutSecretValue' });
    });
  });

  describe('database, identity and parameters', () => {
    it('an instance change alerts, even from a deploy', () => {
      expect(alertOf('databaseModified').alert).toMatchObject({ rule: 'database_change', eventName: 'ModifyDBInstance' });
    });

    it('a snapshot attribute change alerts', () => {
      expect(alertOf('snapshotShared').alert).toMatchObject({ rule: 'database_change' });
    });

    it('a read of the database configuration is ignored', () => {
      expect(classify('databaseDescribed')).toMatchObject({ action: 'ignore' });
    });

    it("a deploy changing an app stack role's policy is expected", () => {
      expect(classify('deployChangesWorkloadRolePolicy')).toMatchObject({ action: 'expected' });
    });

    const iam = (eventName: string, userIdentity: Record<string, unknown>, requestParameters: Record<string, unknown>) => classifyEvent(apiCall({
      eventSource: 'iam.amazonaws.com', eventName, awsRegion: 'us-east-1', userIdentity, requestParameters,
      sourceIPAddress: 'cloudformation.amazonaws.com',
    }, { region: 'us-east-1' }), CONFIG);
    const deploy = assumedRole(CFN_EXEC_ROLE, { invokedBy: 'cloudformation.amazonaws.com' }, 'AWSCloudFormation');
    const person = { type: 'IAMUser', arn: `arn:aws:iam::${ACCOUNT}:user/example-operator`, accountId: ACCOUNT, userName: 'example-operator', invokedBy: 'cloudformation.amazonaws.com' };

    it('a person creating a console user through a stack alerts', () => {
      expect(iam('CreateLoginProfile', person, { userName: 'shadow-user' })).toMatchObject({ action: 'alert', alert: { rule: 'identity_change' } });
    });

    it('a person creating a role through a stack alerts', () => {
      expect(iam('CreateRole', person, { roleName: 'JaleApiStack-Anything-AbC' })).toMatchObject({ action: 'alert' });
    });

    it('a deploy creating a role outside the app stacks alerts', () => {
      expect(iam('CreateRole', deploy, { roleName: 'JaleScratchStack-AnyRole-ZZZ999' })).toMatchObject({ action: 'alert' });
    });

    it('a deploy touching users, groups or login profiles alerts', () => {
      for (const [eventName, p] of [
        ['CreateUser', { userName: 'u' }], ['CreateLoginProfile', { userName: 'u' }], ['AddUserToGroup', { groupName: 'g', userName: 'u' }],
        ['AttachUserPolicy', { userName: 'u', policyArn: 'arn:aws:iam::aws:policy/AdministratorAccess' }],
      ] as Array<[string, Record<string, unknown>]>) {
        expect([eventName, iam(eventName, deploy, p).action]).toEqual([eventName, 'alert']);
      }
    });

    it("a deploy managing the app's own managed policies is expected, and any other policy alerts", () => {
      expect(iam('CreatePolicyVersion', deploy, { policyArn: `arn:aws:iam::${ACCOUNT}:policy/JaleDbPostureGate` })).toMatchObject({ action: 'expected' });
      expect(iam('CreatePolicy', deploy, { policyName: 'JaleApiStack-SomePolicy-AbC' })).toMatchObject({ action: 'expected' });
      expect(iam('CreatePolicyVersion', deploy, { policyArn: `arn:aws:iam::${ACCOUNT}:policy/SomethingElse` })).toMatchObject({ action: 'alert' });
    });

    it('a deploy changing an audit role alerts', () => {
      expect(alertOf('deployChangesAuditRole').alert).toMatchObject({ rule: 'audit_system_change' });
    });

    it('a person changing identity alerts', () => {
      expect(alertOf('personAttachesPolicy').alert).toMatchObject({ rule: 'identity_change' });
    });

    it('an access key alerts whoever creates it', () => {
      expect(alertOf('accessKeyCreated').alert).toMatchObject({ rule: 'identity_change', eventName: 'CreateAccessKey' });
    });

    it('an identity read is ignored', () => {
      expect(classify('iamRead')).toMatchObject({ action: 'ignore' });
    });

    it('any root use alerts', () => {
      expect(alertOf('rootUse').alert).toMatchObject({ rule: 'root_use', principalType: 'Root' });
    });

    it('a parameter change alerts', () => {
      expect(alertOf('parameterChanged').alert).toMatchObject({ rule: 'parameter_change', target: '/example/parameter' });
    });

    it("the ops host agent's heartbeat is ignored", () => {
      expect(classify('agentHeartbeat')).toMatchObject({ action: 'ignore' });
    });
  });

  describe('the audit system itself', () => {
    it.each([
      ['auditKeyPolicyChanged'],
      ['auditKeyDisabledById'],
      ['fallbackRetentionChanged'],
      ['engineSubscriptionDeleted'],
      ['auditRuleDisabled'],
      ['trailStopped'],
      ['guardDutyDisabled'],
      ['securityHubDisabled'],
      ['recorderStopped'],
      ['sentinelCodeChanged'],
      ['alertTopicUnsubscribed'],
    ] as Array<[Name]>)('%s alerts', (name) => {
      expect(alertOf(name).alert.rule).toBe('audit_system_change');
    });

    it.each([
      ['otherKeyPolicyChanged'],
      ['otherLogGroupRetention'],
      ['otherBucketPolicyChanged'],
      ['otherRoleAssumed'],
    ] as Array<[Name]>)("%s, outside the audit system, is ignored", (name) => {
      expect(classify(name)).toMatchObject({ action: 'ignore' });
    });
  });

  describe('the query-results bucket, which holds the full verification progress', () => {
    const RESULTS_BUCKET = `jale-audit-query-results-${ACCOUNT}-us-east-2`;
    const deploy = assumedRole(CFN_EXEC_ROLE, { invokedBy: 'cloudformation.amazonaws.com' }, 'AWSCloudFormation');
    it.each([
      ['PutBucketPolicy', 'a person', assumedRole('SomeAdmin')],
      ['DeleteBucketPolicy', 'a person', assumedRole('SomeAdmin')],
      ['PutBucketPolicy', 'a deploy', deploy],
      ['DeleteBucketPolicy', 'a deploy', deploy],
      ['PutBucketPolicy', 'the audit admin', assumedRole('JaleAuditAdmin')],
    ])('%s by %s alerts', (eventName, _who, userIdentity) => {
      const e = apiCall({ eventSource: 's3.amazonaws.com', eventName, userIdentity, requestParameters: { bucketName: RESULTS_BUCKET, policy: '' } });
      expect(classifyEvent(e, CONFIG)).toMatchObject({
        action: 'alert',
        alert: { rule: 'audit_system_change', eventName, target: RESULTS_BUCKET },
      });
    });

    it('is routed: both events are in the routed bucket-event list', () => {
      expect(AUDIT_SYSTEM_EVENTS['s3.amazonaws.com']).toEqual(expect.arrayContaining(['PutBucketPolicy', 'DeleteBucketPolicy']));
    });
  });

  describe("code that can run as the export job's role, the one role that may write that progress", () => {
    it("names Lambda's calls by the versioned CloudTrail event names AWS documents", () => {
      // AWS Lambda Developer Guide, "Logging AWS Lambda API calls using AWS CloudTrail".
      expect([...FUNCTION_ROLE_EVENTS]).toEqual(['CreateFunction20150331', 'UpdateFunctionConfiguration20150331v2']);
      expect([...FUNCTION_VERSION_EVENTS]).toEqual(['PublishVersion20150331', 'CreateAlias20150331', 'UpdateAlias20150331', 'DeleteAlias20150331']);
    });

    it.each([
      ['functionCreatedWithExportRole', 'CreateFunction20150331', EXPORT_ROLE_ARN],
      ['functionGivenExportRole', 'UpdateFunctionConfiguration20150331v2', EXPORT_ROLE_ARN],
      ['exportCodeChanged', 'UpdateFunctionCode20150331v2', EXPORT_FUNCTION],
      ['exportLayersChanged', 'UpdateFunctionConfiguration20150331v2', EXPORT_FUNCTION],
      ['exportVersionPublished', 'PublishVersion20150331', EXPORT_FUNCTION],
      ['exportAliasCreated', 'CreateAlias20150331', EXPORT_FUNCTION],
      ['exportAliasUpdated', 'UpdateAlias20150331', EXPORT_FUNCTION],
      ['exportAliasDeleted', 'DeleteAlias20150331', EXPORT_FUNCTION],
    ] as Array<[Name, string, string]>)('%s alerts', (name, eventName, target) => {
      expect(alertOf(name).alert).toMatchObject({ rule: 'audit_system_change', eventSource: 'lambda.amazonaws.com', eventName, target });
    });

    it.each([
      ['deployUpdatesExportCode'],
      ['deployUpdatesExportConfiguration'],
    ] as Array<[Name]>)("the pipeline's own deploy alerts on %s, as on every change to the export function", (name) => {
      expect(alertOf(name).alert).toMatchObject({ rule: 'audit_system_change', target: EXPORT_FUNCTION, invokedBy: 'cloudformation.amazonaws.com' });
    });

    it('a deploy creating the export function under a new name alerts: a replacement raises an alert to expect, never a silence', () => {
      expect(alertOf('deployCreatesReplacementExportFunction').alert).toMatchObject({
        rule: 'audit_system_change',
        eventName: 'CreateFunction20150331',
        target: EXPORT_ROLE_ARN,
        invokedBy: 'cloudformation.amazonaws.com',
      });
    });

    const lambda = (eventName: string, userIdentity: Record<string, unknown>, requestParameters: Record<string, unknown>, region = REGION) =>
      classifyEvent(apiCall({ eventSource: 'lambda.amazonaws.com', eventName, awsRegion: region, userIdentity, requestParameters }, { region }), CONFIG);
    const deploy = assumedRole(CFN_EXEC_ROLE, { invokedBy: 'cloudformation.amazonaws.com' }, 'AWSCloudFormation');

    it.each([
      ['a person', assumedRole(PERSON_ROLE)],
      ['the deploy execution role through CloudFormation', deploy],
      ['the deploy execution role outside CloudFormation', assumedRole(CFN_EXEC_ROLE, {}, 'someone')],
      ['a role named like the deploy execution role', assumedRole(`cdk-hnb659fds-cfn-exec-role-${ACCOUNT}`, { invokedBy: 'cloudformation.amazonaws.com' }, 'AWSCloudFormation')],
      ['a person through their own CloudFormation stack', {
        type: 'IAMUser', arn: `arn:aws:iam::${ACCOUNT}:user/example-operator`, accountId: ACCOUNT, userName: 'example-operator', invokedBy: 'cloudformation.amazonaws.com',
      }],
      ['an app function in its own session', assumedRole(LAMBDA_ROLE, {}, LAMBDA_SESSION)],
      ['the export function itself', assumedRole(EXPORT_ROLE, {}, EXPORT_FUNCTION)],
      ['the ops host', assumedRole(OPS_HOST_ROLE, {}, OPS_HOST_SESSION)],
      ['an AWS service', { type: 'AWSService', invokedBy: 'cloudformation.amazonaws.com' }],
    ])('a function given the role alerts whoever gives it, the deploy included: %s', (_who, userIdentity) => {
      for (const eventName of FUNCTION_ROLE_EVENTS) {
        expect([eventName, lambda(eventName, userIdentity, { functionName: 'example-function', role: EXPORT_ROLE_ARN })]).toEqual([
          eventName,
          expect.objectContaining({ action: 'alert', alert: expect.objectContaining({ rule: 'audit_system_change', target: EXPORT_ROLE_ARN }) }),
        ]);
      }
    });

    it('alerts wherever the function is, since a role serves every region', () => {
      for (const region of [REGION, 'us-east-1', 'us-west-2']) {
        expect([region, lambda('CreateFunction20150331', assumedRole(PERSON_ROLE), { functionName: 'example-function', role: EXPORT_ROLE_ARN }, region).action])
          .toEqual([region, 'alert']);
      }
    });

    it("recognises the role by its name, whatever the ARN's path or case", () => {
      for (const role of [
        `arn:aws:iam::${ACCOUNT}:role/service-role/${EXPORT_ROLE}`,
        `arn:aws:iam::${ACCOUNT}:role/${EXPORT_ROLE.toUpperCase()}`,
        `arn:aws:iam::${ACCOUNT}:role/${EXPORT_ROLE.toLowerCase()}`,
      ]) {
        expect([role, lambda('CreateFunction20150331', assumedRole(PERSON_ROLE), { functionName: 'example-function', role }).action]).toEqual([role, 'alert']);
      }
    });

    it('leaves a function with any other role, or no role in the call, alone', () => {
      for (const role of [
        `arn:aws:iam::${ACCOUNT}:role/${LAMBDA_ROLE}`,
        `arn:aws:iam::${ACCOUNT}:role/${EXPORT_ROLE}-other`,
        `arn:aws:iam::${ACCOUNT}:role/x${EXPORT_ROLE}`,
      ]) {
        for (const eventName of FUNCTION_ROLE_EVENTS) {
          expect([eventName, role, lambda(eventName, assumedRole(PERSON_ROLE), { functionName: 'example-function', role }).action])
            .toEqual([eventName, role, 'ignore']);
        }
      }
      expect(lambda('UpdateFunctionConfiguration20150331v2', assumedRole(PERSON_ROLE), { functionName: 'example-function', timeout: 30 }).action).toBe('ignore');
    });

    it("leaves another function's versions and aliases alone", () => {
      for (const eventName of FUNCTION_VERSION_EVENTS) {
        expect([eventName, lambda(eventName, assumedRole(PERSON_ROLE), { functionName: 'example-function', name: 'live' }).action]).toEqual([eventName, 'ignore']);
      }
    });

    it('never lets the role check stand in for the audit-function check: a change to the export function that names its role reports the function', () => {
      for (const userIdentity of [assumedRole(PERSON_ROLE), deploy]) {
        expect(lambda('UpdateFunctionConfiguration20150331v2', userIdentity, { functionName: EXPORT_FUNCTION, role: EXPORT_ROLE_ARN }))
          .toMatchObject({ action: 'alert', alert: { rule: 'audit_system_change', target: EXPORT_FUNCTION } });
      }
    });

    it("keeps every change to an audit function alerting, the deploy's included, and adds versions and aliases", () => {
      for (const fn of ['JaleAuditStack-AuditSentinelFunction-AbC123', EXPORT_FUNCTION]) {
        for (const eventName of [
          'UpdateFunctionCode20150331v2', 'UpdateFunctionConfiguration20150331v2', 'DeleteFunction20150331', 'AddPermission20150331v2',
          'PutFunctionConcurrency20171031', ...FUNCTION_VERSION_EVENTS,
        ]) {
          expect([fn, eventName, lambda(eventName, deploy, { functionName: fn })]).toEqual([
            fn, eventName, expect.objectContaining({ action: 'alert', alert: expect.objectContaining({ rule: 'audit_system_change', target: fn }) }),
          ]);
        }
      }
    });
  });

  describe('the audit key', () => {
    const KEY_ID = AUDIT_KEY_ARN.split('/').pop()!;
    it.each([
      ['DisableKey', { keyId: 'alias/jale-audit' }],
      ['ScheduleKeyDeletion', { keyId: KEY_ID, pendingWindowInDays: 7 }],
      ['CancelKeyDeletion', { keyId: AUDIT_KEY_ARN }],
      ['PutKeyPolicy', { keyId: AUDIT_KEY_ARN, policyName: 'default' }],
      ['CreateGrant', { keyId: AUDIT_KEY_ARN, granteePrincipal: 'arn:aws:iam::111122223333:role/x', operations: ['Decrypt'] }],
    ])('%s on the audit key alerts', (eventName, requestParameters) => {
      const e = apiCall({ eventSource: 'kms.amazonaws.com', eventName, userIdentity: assumedRole('SomeAdmin'), requestParameters });
      expect(classifyEvent(e, CONFIG)).toMatchObject({ action: 'alert', alert: { rule: 'audit_system_change', eventName } });
    });

    it('is routed: each of these events is in the routed key-event list', () => {
      for (const name of ['DisableKey', 'ScheduleKeyDeletion', 'CancelKeyDeletion', 'PutKeyPolicy', 'CreateGrant']) {
        expect(AUDIT_SYSTEM_EVENTS['kms.amazonaws.com']).toContain(name);
      }
    });
  });

  describe("the alert topic's own key", () => {
    const KEY_ID = ALERT_KEY_ARN.split('/').pop()!;
    const kms = (eventName: string, requestParameters: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      classifyEvent(apiCall({ eventSource: 'kms.amazonaws.com', eventName, userIdentity: assumedRole('SomeAdmin'), requestParameters, ...extra }), CONFIG);

    it.each([
      ['DisableKey', { keyId: ALERT_KEY_ALIAS }],
      ['DisableKey', { keyId: `arn:aws:kms:${REGION}:${ACCOUNT}:${ALERT_KEY_ALIAS}` }],
      ['ScheduleKeyDeletion', { keyId: KEY_ID, pendingWindowInDays: 7 }],
      ['PutKeyPolicy', { keyId: ALERT_KEY_ARN, policyName: 'default' }],
      ['CreateGrant', { keyId: ALERT_KEY_ARN, granteePrincipal: `arn:aws:iam::${ACCOUNT}:role/x`, operations: ['Decrypt'] }],
      ['DeleteAlias', { aliasName: ALERT_KEY_ALIAS }],
    ])('%s on it alerts, naming that key', (eventName, requestParameters) => {
      expect(kms(eventName, requestParameters)).toMatchObject({ action: 'alert', alert: { rule: 'audit_system_change', eventName, target: ALERT_KEY_ARN } });
    });

    it('is recognised by the ARN in the event resources too', () => {
      expect(kms('PutKeyPolicy', { keyId: KEY_ID, policyName: 'default' }, { resources: [{ accountId: ACCOUNT, type: 'AWS::KMS::Key', ARN: ALERT_KEY_ARN }] }))
        .toMatchObject({ action: 'alert', alert: { target: ALERT_KEY_ARN } });
    });

    it('still names the audit key for a change to the audit key', () => {
      expect(kms('DisableKey', { keyId: AUDIT_KEY_ARN })).toMatchObject({ action: 'alert', alert: { target: AUDIT_KEY_ARN } });
    });

    it('ignores a key whose alias only starts like either of them', () => {
      for (const keyId of [`${ALERT_KEY_ALIAS}-old`, 'alias/jale-audit-other']) {
        expect([keyId, kms('DisableKey', { keyId }).action]).toEqual([keyId, 'ignore']);
      }
    });
  });

  describe('the audit alarms and queues', () => {
    const call = (eventSource: string) => (eventName: string, requestParameters: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      classifyEvent(apiCall({ eventSource, eventName, userIdentity: assumedRole('SomeAdmin'), requestParameters, ...extra }), CONFIG);
    const cloudwatch = call('monitoring.amazonaws.com');
    const sqs = call('sqs.amazonaws.com');

    it('routes the alarm and queue changes it classifies', () => {
      expect([...(AUDIT_SYSTEM_EVENTS as Record<string, readonly string[]>)['monitoring.amazonaws.com']]).toEqual([
        'PutMetricAlarm', 'PutCompositeAlarm', 'DeleteAlarms', 'DisableAlarmActions', 'EnableAlarmActions', 'SetAlarmState', 'PutAlarmMuteRule',
      ]);
      expect([...(AUDIT_SYSTEM_EVENTS as Record<string, readonly string[]>)['sqs.amazonaws.com']]).toEqual([
        'SetQueueAttributes', 'PurgeQueue', 'DeleteQueue', 'AddPermission', 'RemovePermission', 'StartMessageMoveTask',
      ]);
    });

    it.each([
      ['DisableAlarmActions', { alarmNames: ['JaleAuditDailyCompareMismatch'] }, 'JaleAuditDailyCompareMismatch'],
      ['DeleteAlarms', { alarmNames: ['JaleApiErrors', 'JaleAuditEdgeCheckMissing'] }, 'JaleAuditEdgeCheckMissing'],
      ['PutMetricAlarm', { alarmName: 'JaleAuditWriteFailed', actionsEnabled: false, alarmActions: [] }, 'JaleAuditWriteFailed'],
      ['PutCompositeAlarm', { alarmName: 'JaleAuditCombined', alarmRule: 'ALARM(JaleApiErrors)' }, 'JaleAuditCombined'],
      ['SetAlarmState', { alarmName: 'JaleAuditSentinelDeadLetters', stateValue: 'OK', stateReason: 'manual' }, 'JaleAuditSentinelDeadLetters'],
      ['EnableAlarmActions', { alarmNames: ['JaleAuditPurgeMissing'] }, 'JaleAuditPurgeMissing'],
      ['PutAlarmMuteRule', { name: 'quiet-hours', muteTargets: { alarmNames: ['JaleApiErrors', 'JaleAuditTrailCheckMissing'] } }, 'JaleAuditTrailCheckMissing'],
      ['DisableAlarmActions', { alarmNames: [AUDIT_ALARM_ARN] }, 'JaleAuditDailyCompareMismatch'],
    ])('%s on an audit alarm alerts, naming the alarm', (eventName, requestParameters, target) => {
      expect(cloudwatch(eventName, requestParameters)).toMatchObject({ action: 'alert', alert: { rule: 'audit_system_change', eventName, target } });
    });

    it('an audit alarm named only in the event resources alerts', () => {
      expect(cloudwatch('DisableAlarmActions', {}, { resources: [{ accountId: ACCOUNT, type: 'AWS::CloudWatch::Alarm', ARN: AUDIT_ALARM_ARN }] }))
        .toMatchObject({ action: 'alert', alert: { target: 'JaleAuditDailyCompareMismatch' } });
    });

    it('a mute rule whose targets it cannot read alerts, as it may cover the audit alarms', () => {
      for (const requestParameters of [{ name: 'quiet-hours' }, { name: 'quiet-hours', muteTargets: {} }, { name: 'quiet-hours', muteTargets: { alarmNames: [] } }]) {
        expect(cloudwatch('PutAlarmMuteRule', requestParameters)).toMatchObject({ action: 'alert', alert: { rule: 'audit_system_change', target: 'JaleAudit*' } });
      }
    });

    it('a deploy changing an audit alarm alerts like anyone else', () => {
      const deploy = assumedRole(CFN_EXEC_ROLE, { invokedBy: 'cloudformation.amazonaws.com' }, 'AWSCloudFormation');
      expect(classifyEvent(apiCall({
        eventSource: 'monitoring.amazonaws.com', eventName: 'PutMetricAlarm', userIdentity: deploy, requestParameters: { alarmName: 'JaleAuditExportLag' },
      }), CONFIG)).toMatchObject({ action: 'alert', alert: { target: 'JaleAuditExportLag', invokedBy: 'cloudformation.amazonaws.com' } });
    });

    it.each([
      ['DisableAlarmActions', { alarmNames: ['JaleApiErrors'] }],
      ['PutMetricAlarm', { alarmName: 'JaleWhatsAppDeliveryFailures' }],
      ['DeleteAlarms', { alarmNames: ['jaleaudit-lower-case', 'Jale-Audit'] }],
      ['PutAlarmMuteRule', { name: 'app-quiet', muteTargets: { alarmNames: ['JaleApiErrors'] } }],
    ])('%s on alarms outside the audit system is ignored', (eventName, requestParameters) => {
      expect(cloudwatch(eventName, requestParameters)).toMatchObject({ action: 'ignore', reason: 'outside_audit_system' });
    });

    it.each([
      ['PurgeQueue', { queueUrl: SENTINEL_DEAD_LETTER_URL }, SENTINEL_DEAD_LETTER_NAME],
      ['SetQueueAttributes', { queueUrl: SENTINEL_DEAD_LETTER_URL, attributes: { MessageRetentionPeriod: '60' } }, SENTINEL_DEAD_LETTER_NAME],
      ['DeleteQueue', { queueUrl: EDGE_DEAD_LETTER_URL }, 'jale-audit-edge-dead-letters'],
      ['AddPermission', { queueUrl: EDGE_DEAD_LETTER_URL, label: 'share', actions: ['ReceiveMessage'] }, 'jale-audit-edge-dead-letters'],
      ['RemovePermission', { queueUrl: EDGE_DEAD_LETTER_URL, label: 'share' }, 'jale-audit-edge-dead-letters'],
      ['StartMessageMoveTask', { sourceArn: SENTINEL_DEAD_LETTER_ARN }, SENTINEL_DEAD_LETTER_NAME],
    ])('%s on an audit queue alerts, naming the queue', (eventName, requestParameters, target) => {
      expect(sqs(eventName, requestParameters)).toMatchObject({ action: 'alert', alert: { rule: 'audit_system_change', eventName, target } });
    });

    it('an audit queue named only in the event resources alerts', () => {
      expect(sqs('PurgeQueue', {}, { resources: [{ accountId: ACCOUNT, type: 'AWS::SQS::Queue', ARN: SENTINEL_DEAD_LETTER_ARN }] }))
        .toMatchObject({ action: 'alert', alert: { target: SENTINEL_DEAD_LETTER_NAME } });
    });

    it.each([
      ['PurgeQueue', { queueUrl: APP_QUEUE_URL }],
      ['SetQueueAttributes', { queueUrl: `${EDGE_DEAD_LETTER_URL}-copy`, attributes: {} }],
      ['DeleteQueue', { queueUrl: SENTINEL_DEAD_LETTER_URL.replace(SENTINEL_DEAD_LETTER_NAME, 'JaleAuditStack-OtherQueue') }],
    ])('%s on queues outside the audit system is ignored', (eventName, requestParameters) => {
      expect(sqs(eventName, requestParameters)).toMatchObject({ action: 'ignore', reason: 'outside_audit_system' });
    });
  });

  describe('sign-in', () => {
    it('a root sign-in alerts', () => {
      expect(alertOf('rootSignIn').alert).toMatchObject({ rule: 'root_use', eventName: 'ConsoleLogin', principalType: 'Root' });
    });

    it('a failed console sign-in alerts', () => {
      expect(alertOf('personSignInFailed').alert).toMatchObject({ rule: 'console_sign_in_failed', principalType: 'IAMUser' });
    });

    it('a successful console sign-in is expected', () => {
      expect(classify('personSignedIn')).toMatchObject({ action: 'expected' });
    });
  });

  describe('findings', () => {
    it('a medium-or-higher GuardDuty finding alerts and keeps the finding', () => {
      const result = alertOf('guardDutyHigh');
      expect(result.alert).toMatchObject({ rule: 'guardduty_finding', principalType: 'finding' });
      expect(result.archive.category).toBe('guardduty');
      expect(result.archive.body).toMatchObject({ finding: { id: 'example-finding-1' } });
    });

    it('a low GuardDuty finding is archived without an alert', () => {
      expect(classify('guardDutyLow')).toMatchObject({ action: 'archive', archive: { category: 'guardduty' } });
    });

    it('a critical Security Hub finding alerts', () => {
      expect(alertOf('securityHubCritical').alert).toMatchObject({ rule: 'securityhub_finding' });
    });

    describe('Security Hub: one alert per finding state', () => {
      const STATE_KEY = /^findings\/securityhub-state\/[0-9a-f]{64}\.json\.gz$/;
      /** The critical fixture with its one finding changed. */
      const withFinding = (change: (finding: Record<string, any>) => Record<string, any>) => {
        const base = EVENTS.securityHubCritical;
        return { ...base, detail: { findings: [change({ ...base.detail.findings[0] })] } } as unknown as Record<string, unknown>;
      };
      const alertFor = (event: Record<string, unknown>) => {
        const result = classifyEvent(event, CONFIG);
        if (result.action !== 'alert') throw new Error(`expected an alert, got ${result.action}`);
        return result;
      };

      it("keys a failed critical finding's alert by its state, the same for every import of it", () => {
        const first = alertOf('securityHubCritical');
        const later = alertOf('securityHubCriticalLater');
        expect(first.archive.key).toMatch(STATE_KEY);
        expect(EVENTS.securityHubCriticalLater.id).not.toBe(EVENTS.securityHubCritical.id);
        expect(later.archive.key).toBe(first.archive.key);
      });

      it('keys another finding, another status or another severity apart', () => {
        const key = alertOf('securityHubCritical').archive.key;
        expect(alertOf('securityHubCriticalOther').archive.key).not.toBe(key);
        const noStatus = alertFor(withFinding(({ Compliance: _c, ...rest }) => rest));
        expect(noStatus.archive.key).toMatch(STATE_KEY);
        expect(noStatus.archive.key).not.toBe(key);
      });

      it('archives a critical finding that passed, without an alert, under its event', () => {
        expect(classify('securityHubCriticalPassed')).toMatchObject({
          action: 'archive',
          archive: { category: 'securityhub', key: expect.stringMatching(/^findings\/securityhub\/dt=2026-10-06\//), body: { classification: 'archive' } },
        });
        for (const status of ['WARNING', 'NOT_AVAILABLE']) {
          expect(classifyEvent(withFinding((f) => ({ ...f, Compliance: { Status: status } })), CONFIG)).toMatchObject({ action: 'archive' });
        }
      });

      it.each([
        ['archived', (f: Record<string, any>) => ({ ...f, RecordState: 'ARCHIVED' })],
        ['suppressed', (f: Record<string, any>) => ({ ...f, Workflow: { Status: 'SUPPRESSED' } })],
      ])('archives a failed critical finding that is %s under its event, without an alert', (_label, change) => {
        expect(classifyEvent(withFinding(change), CONFIG)).toMatchObject({
          action: 'archive',
          archive: { category: 'securityhub', key: expect.stringMatching(/^findings\/securityhub\/dt=2026-10-04\//), body: { classification: 'archive' } },
        });
      });

      it('alerts on the active, unsuppressed finding of an event whose first critical finding is suppressed', () => {
        const base = EVENTS.securityHubCritical;
        const suppressed = { ...base.detail.findings[0], Workflow: { Status: 'SUPPRESSED' } };
        const other = EVENTS.securityHubCriticalOther.detail.findings[0];
        const event = { ...base, detail: { findings: [suppressed, other] } } as unknown as Record<string, unknown>;
        expect(alertFor(event).archive.key).toBe(alertOf('securityHubCriticalOther').archive.key);
      });

      it('alerts on a critical finding with no compliance status, which is not a control finding', () => {
        expect(alertFor(withFinding(({ Compliance: _c, ...rest }) => rest)).alert).toMatchObject({ rule: 'securityhub_finding', severity: 'CRITICAL' });
      });

      it("never names the finding's Id: not in the key, the alert or its record", () => {
        const { alert, archive } = alertOf('securityHubCritical');
        const text = JSON.stringify({ key: archive.key, alert, body: archive.body });
        expect(text).not.toContain(SECURITY_HUB_FINDING_ID);
        expect(text).not.toContain(ACCOUNT);
        expect(alert).toMatchObject({ eventId: EVENTS.securityHubCritical.id, principalType: 'finding', target: 'AwsS3Bucket' });
        expect(archive.body).toEqual({ classification: 'alert', alert });
      });

      it('alerts on the first alerting finding of an event that carries several', () => {
        const base = EVENTS.securityHubCritical;
        const passed = { ...base.detail.findings[0], Compliance: { Status: 'PASSED' } };
        const other = EVENTS.securityHubCriticalOther.detail.findings[0];
        const several = { ...base, detail: { findings: [passed, other, base.detail.findings[0]] } } as unknown as Record<string, unknown>;
        expect(alertFor(several).archive.key).toBe(alertOf('securityHubCriticalOther').archive.key);
      });

      it("keys a finding with no Id by its event, so it never shares another finding's record", () => {
        const noId = alertFor(withFinding(({ Id: _id, ...rest }) => rest));
        expect(noId.archive.key).toMatch(/^findings\/securityhub\/dt=2026-10-04\//);
      });
    });

    it('a high Security Hub finding is archived without an alert', () => {
      expect(classify('securityHubHigh')).toMatchObject({ action: 'archive', archive: { category: 'securityhub' } });
    });
  });

  describe('every alert', () => {
    const alerting = (Object.keys(EVENTS) as Name[]).filter((name) => classify(name).action === 'alert');

    it('covers the fixtures it should', () => {
      expect(alerting.length).toBeGreaterThanOrEqual(25);
    });

    it.each(alerting.map((name) => [name]))('%s names the event and the principal type', (name) => {
      const { alert } = alertOf(name);
      expect(typeof alert.eventName === 'string' || typeof alert.findingType === 'string').toBe(true);
      expect(alert.principalType).toMatch(/^[A-Za-z]+$/);
    });

    it.each(alerting.map((name) => [name]))('%s carries no request body, response, address or message', (name) => {
      const { alert, archive } = alertOf(name);
      const text = JSON.stringify({ alert, archive: archive.category === 'cloudtrail' ? archive.body : {} });
      expect(text).not.toContain('HIDDEN_DUE_TO_SECURITY_REASONS');
      expect(text).not.toContain('198.51.100.');
      expect(text).not.toContain('not authorized');
      expect(text).not.toContain('Failed authentication');
      expect(text).not.toContain('responseElements');
      expect(text).not.toContain('requestParameters');
    });

    it('archives a CloudTrail alert as the alert record only', () => {
      const { archive, alert } = alertOf('personReadsRuntimeSecret');
      expect(archive).toEqual({ category: 'cloudtrail', key: expect.any(String), body: { alert } });
    });
  });

  describe('admin sign-in failures', () => {
    /** The rules module's client-id reader, read through the module object. */
    const cognitoClientIdOf = (sentinelRules as Record<string, unknown>).cognitoClientIdOf as (detail: unknown) => string | null;
    /** classifyCognitoFailure with the admin pool's app clients. */
    const classifyFailure = classifyCognitoFailure as unknown as (
      event: Record<string, unknown>,
      adminPoolId: string,
      adminClientIds: ReadonlySet<string>,
    ) => ReturnType<typeof classifyCognitoFailure>;
    const ADMIN_CLIENTS: ReadonlySet<string> = new Set([ADMIN_CLIENT_ID]);
    const NO_CLIENTS: ReadonlySet<string> = new Set();
    const REAL_SHAPE_ADMIN_FAILURES = ['adminSrpPasswordVerifierFailed', 'adminMfaCodeFailedRealShape', 'adminDeviceSrpFailedRealShape'] as const;
    const event = (name: Name) => EVENTS[name] as unknown as Record<string, unknown>;

    it('finds the pool id where CloudTrail puts it', () => {
      expect(cognitoPoolIdOf(EVENTS.adminSignInFailed.detail)).toBe(ADMIN_POOL_ID);
      expect(cognitoPoolIdOf(EVENTS.adminSecondFactorFailed.detail)).toBe(ADMIN_POOL_ID);
      expect(cognitoPoolIdOf(EVENTS.unattributedSignInFailed.detail)).toBeNull();
      expect(cognitoPoolIdOf({ resources: [{ ARN: `arn:aws:cognito-idp:us-east-2:111122223333:userpool/${ADMIN_POOL_ID}` }] }))
        .toBe(ADMIN_POOL_ID);
    });

    it('finds no pool id in a browser sign-in call, which names its app client instead', () => {
      for (const name of [...REAL_SHAPE_ADMIN_FAILURES, 'workerSrpFailedRealShape'] as const) {
        expect(cognitoPoolIdOf(EVENTS[name].detail)).toBeNull();
      }
    });

    it('reads the app client a sign-in call names, in the form Cognito gives client ids, and nothing else', () => {
      expect(typeof cognitoClientIdOf).toBe('function');
      for (const name of REAL_SHAPE_ADMIN_FAILURES) expect(cognitoClientIdOf(EVENTS[name].detail)).toBe(ADMIN_CLIENT_ID);
      expect(cognitoClientIdOf(EVENTS.workerSrpFailedRealShape.detail)).toBe(WORKER_CLIENT_ID);
      expect(cognitoClientIdOf(EVENTS.unattributedSignInFailed.detail)).toBeNull();
      for (const clientId of ['', 'Exampleclient', 'example-client', 'example client', 'a'.repeat(129), 42, null, ['x']]) {
        expect(cognitoClientIdOf({ requestParameters: { clientId } })).toBeNull();
      }
      expect(cognitoClientIdOf({})).toBeNull();
      expect(cognitoClientIdOf(null)).toBeNull();
    });

    it('routes a failed sign-in to the pool check', () => {
      expect(classify('adminSignInFailed')).toEqual({ action: 'cognito' });
      expect(classify('adminSecondFactorFailed')).toEqual({ action: 'cognito' });
      expect(classify('workerSignInFailed')).toEqual({ action: 'cognito' });
      expect(classify('unattributedSignInFailed')).toEqual({ action: 'cognito' });
      for (const name of [...REAL_SHAPE_ADMIN_FAILURES, 'workerSrpFailedRealShape'] as const) expect(classify(name)).toEqual({ action: 'cognito' });
    });

    it('ignores a sign-in call that succeeded, and every other user-pool call', () => {
      const ok = { ...EVENTS.adminSignInFailed, detail: { ...EVENTS.adminSignInFailed.detail, errorCode: undefined } };
      expect(classifyEvent(ok as unknown as Record<string, unknown>, CONFIG)).toMatchObject({ action: 'ignore' });
      const other = { ...EVENTS.adminSignInFailed, detail: { ...EVENTS.adminSignInFailed.detail, eventName: 'AdminGetUser' } };
      expect(classifyEvent(other as unknown as Record<string, unknown>, CONFIG)).toMatchObject({ action: 'ignore' });
      expect(classify('adminDeviceIssued')).toMatchObject({ action: 'ignore' });
    });

    it('alerts on a failure in the admin pool, with codes only', () => {
      const result = classifyFailure(event('adminSignInFailed'), ADMIN_POOL_ID, NO_CLIENTS);
      expect(result).toMatchObject({ action: 'alert' });
      if (result.action !== 'alert') throw new Error('unreachable');
      expect(result.alert).toEqual({
        rule: 'admin_sign_in_failed',
        summary: expect.any(String),
        eventSource: 'cognito-idp.amazonaws.com',
        eventName: 'InitiateAuth',
        eventTime: '2026-10-04T12:00:00Z',
        awsRegion: 'us-east-2',
        eventId: expect.any(String),
        principalType: 'Unknown',
        errorCode: 'NotAuthorizedException',
        authFlow: 'USER_SRP_AUTH',
        poolMatch: true,
      });
      const text = JSON.stringify(result);
      expect(text).not.toContain('198.51.100.');
      expect(text).not.toContain('6a7b8c9d');
      expect(text).not.toContain('Incorrect');
      expect(text).not.toContain(ADMIN_POOL_ID);
      expect(result.archive).toEqual({ category: 'cognito', key: expect.any(String), body: { alert: result.alert } });
    });

    it.each(REAL_SHAPE_ADMIN_FAILURES.map((name) => [name]))(
      '%s: alerts when the event names no pool and names an admin app client, with codes only',
      (name) => {
        const result = classifyFailure(event(name), ADMIN_POOL_ID, ADMIN_CLIENTS);
        expect(result).toMatchObject({
          action: 'alert',
          alert: { rule: 'admin_sign_in_failed', eventName: 'RespondToAuthChallenge', principalType: 'Unknown', poolMatch: true },
          archive: { category: 'cognito', key: expect.stringMatching(/^findings\/cognito\/dt=2026-10-04\/[A-Za-z0-9-]+\.json\.gz$/) },
        });
        if (result.action !== 'alert') throw new Error('unreachable');
        expect(result.alert.errorCode).toBe(EVENTS[name].detail.errorCode);
        // The challenge, as Cognito's own code; never any other request value.
        expect(result.alert).toMatchObject({ challengeName: EVENTS[name].detail.requestParameters.challengeName });
        expect(Object.keys(result.alert)).not.toContain('authFlow');
        expect(result.archive.body).toEqual({ alert: result.alert });
        const text = JSON.stringify(result);
        for (const value of [ADMIN_CLIENT_ID, SIGN_IN_SUB, 'HIDDEN_DUE_TO_SECURITY_REASONS', '198.51.100.', 'Incorrect', 'Invalid code']) {
          expect(text).not.toContain(value);
        }
      },
    );

    it('names the auth flow and the challenge as codes, so a refused refresh reads apart from a wrong password', () => {
      const refresh = classifyFailure(event('adminRefreshRevokedRealShape'), ADMIN_POOL_ID, ADMIN_CLIENTS);
      expect(refresh).toMatchObject({ action: 'alert', alert: { eventName: 'InitiateAuth', errorCode: 'NotAuthorizedException', authFlow: 'REFRESH_TOKEN_AUTH' } });
      if (refresh.action !== 'alert') throw new Error('unreachable');
      expect(Object.keys(refresh.alert)).not.toContain('challengeName');
      expect(JSON.stringify(refresh)).not.toMatch(/Refresh Token has been revoked|HIDDEN_DUE_TO_SECURITY_REASONS/);
      const password = classifyFailure(event('adminSrpPasswordVerifierFailed'), ADMIN_POOL_ID, ADMIN_CLIENTS);
      expect(password).toMatchObject({ action: 'alert', alert: { errorCode: 'NotAuthorizedException', challengeName: 'PASSWORD_VERIFIER' } });
      const device = classifyFailure(event('adminDeviceSrpFailedRealShape'), ADMIN_POOL_ID, ADMIN_CLIENTS);
      expect(device).toMatchObject({ action: 'alert', alert: { errorCode: 'NotAuthorizedException', challengeName: 'DEVICE_PASSWORD_VERIFIER' } });
    });

    it("reports any flow or challenge outside Cognito's own codes as other, and omits an absent one", () => {
      const base = EVENTS.adminSrpPasswordVerifierFailed;
      const odd = (requestParameters: Record<string, unknown>) => classifyFailure(
        { ...base, detail: { ...base.detail, requestParameters: { clientId: ADMIN_CLIENT_ID, ...requestParameters } } } as unknown as Record<string, unknown>,
        ADMIN_POOL_ID,
        ADMIN_CLIENTS,
      );
      for (const value of ['SOMETHING_NEW', 'password_verifier', 'PASSWORD_VERIFIER ', 'HIDDEN_DUE_TO_SECURITY_REASONS', '', 42, { nested: 'x' }]) {
        const result = odd({ authFlow: value, challengeName: value });
        expect(result).toMatchObject({ action: 'alert', alert: { authFlow: 'other', challengeName: 'other' } });
        if (typeof value === 'string' && value.length > 0) expect(JSON.stringify(result)).not.toContain(value);
      }
      const bare = odd({});
      expect(bare).toMatchObject({ action: 'alert' });
      if (bare.action !== 'alert') throw new Error('unreachable');
      expect(Object.keys(bare.alert).filter((key) => key === 'authFlow' || key === 'challengeName')).toEqual([]);
    });

    it("allows exactly Cognito's documented flows and challenges", () => {
      const lists = sentinelRules as Record<string, unknown>;
      expect(lists.COGNITO_AUTH_FLOWS).toBeDefined();
      expect(lists.COGNITO_CHALLENGE_NAMES).toBeDefined();
      expect([...(lists.COGNITO_AUTH_FLOWS as string[])].sort()).toEqual(Object.values(AuthFlowType).sort());
      expect([...(lists.COGNITO_CHALLENGE_NAMES as string[])].sort()).toEqual(Object.values(ChallengeNameType).sort());
    });

    it("drops another app client's failure", () => {
      expect(classifyFailure(event('workerSrpFailedRealShape'), ADMIN_POOL_ID, ADMIN_CLIENTS)).toEqual({ action: 'drop' });
    });

    it('drops a failure in another pool, even when it names an admin app client', () => {
      const named = EVENTS.workerSignInFailed;
      const withAdminClient = { ...named, detail: { ...named.detail, requestParameters: { clientId: ADMIN_CLIENT_ID, challengeName: 'PASSWORD_VERIFIER' } } };
      expect(cognitoPoolIdOf(withAdminClient.detail)).toBe(WORKER_POOL_ID);
      expect(classifyFailure(withAdminClient as unknown as Record<string, unknown>, ADMIN_POOL_ID, ADMIN_CLIENTS)).toEqual({ action: 'drop' });
    });

    it('drops a failure that names neither a pool nor a client', () => {
      expect(classifyFailure(event('unattributedSignInFailed'), ADMIN_POOL_ID, ADMIN_CLIENTS)).toEqual({ action: 'drop' });
    });

    it('drops a failure in another pool silently', () => {
      expect(classifyFailure(event('workerSignInFailed'), ADMIN_POOL_ID, NO_CLIENTS)).toEqual({ action: 'drop' });
    });

    it('a call that did not fail is not a failure', () => {
      const ok = { ...EVENTS.adminSignInFailed, detail: { ...EVENTS.adminSignInFailed.detail, errorCode: undefined } };
      expect(classifyFailure(ok as unknown as Record<string, unknown>, ADMIN_POOL_ID, NO_CLIENTS)).toEqual({ action: 'drop' });
      const okByClient = { ...EVENTS.adminSrpPasswordVerifierFailed, detail: { ...EVENTS.adminSrpPasswordVerifierFailed.detail, errorCode: undefined } };
      expect(classifyFailure(okByClient as unknown as Record<string, unknown>, ADMIN_POOL_ID, ADMIN_CLIENTS)).toEqual({ action: 'drop' });
    });
  });
});
