import {
  canonicalPattern,
  edgeDeadLetterQueue,
  edgeRoutes,
  mainRoutes,
  ruleState,
  samePattern,
  type AuditRoute,
  type RouteNames,
} from '../../../../lambda/ops/audit-sentinel-routes';
import {
  AUDIT_SYSTEM_EVENTS,
  COGNITO_SIGN_IN_EVENTS,
  FUNCTION_ROLE_EVENTS,
  ROLE_ASSUMPTION_EVENTS,
  SECRET_READ_EVENTS,
} from '../../../../lambda/ops/audit-sentinel-rules';

/**
 * The audit rules as data: the patterns the stacks deploy, and the
 * comparison the sentinel's daily check makes against each deployed rule.
 */

const NAMES: RouteNames = { rulePrefix: 'jale-audit-', roleNames: ['JaleAuditReader', 'JaleAuditAdmin'], bucketPrefix: 'jale-audit-' };

describe('audit rule patterns', () => {
  describe('the comparison the daily check makes', () => {
    const pattern = {
      source: ['aws.sts'],
      'detail-type': ['AWS API Call via CloudTrail'],
      detail: { eventName: ['AssumeRole', 'AssumeRoleWithSAML'], requestParameters: { roleArn: [{ suffix: ':role/A' }, { suffix: ':role/B' }] } },
    };

    it('reads a pattern the same whatever the order of its keys and of its values', () => {
      const reordered = {
        detail: { requestParameters: { roleArn: [{ suffix: ':role/B' }, { suffix: ':role/A' }] }, eventName: ['AssumeRoleWithSAML', 'AssumeRole'] },
        'detail-type': ['AWS API Call via CloudTrail'],
        source: ['aws.sts'],
      };
      expect(canonicalPattern(reordered)).toBe(canonicalPattern(pattern));
      expect(samePattern(JSON.stringify(reordered), pattern)).toBe(true);
      expect(samePattern(JSON.stringify(reordered, null, 2), pattern)).toBe(true);
    });

    it.each([
      ['a changed value', { ...pattern, source: ['aws.example'] }],
      ['a value dropped', { ...pattern, detail: { ...pattern.detail, eventName: ['AssumeRole'] } }],
      ['a value added', { ...pattern, detail: { ...pattern.detail, eventName: ['AssumeRole', 'AssumeRoleWithSAML', 'GetCallerIdentity'] } }],
      ['a field dropped', { source: pattern.source, 'detail-type': pattern['detail-type'] }],
      ['a field added', { ...pattern, account: ['example-account'] }],
      ['a matcher of another kind', { ...pattern, detail: { ...pattern.detail, requestParameters: { roleArn: [{ prefix: ':role/A' }, { suffix: ':role/B' }] } } }],
      ['a string where a list was', { ...pattern, source: 'aws.sts' }],
    ])('tells apart %s', (_label, changed) => {
      expect(samePattern(JSON.stringify(changed), pattern)).toBe(false);
    });

    it('keeps the order of a numeric matcher, whose list is a sequence of operators and operands', () => {
      const ranged = { detail: { size: [{ numeric: ['>', 0, '<=', 5] }] } };
      expect(samePattern(JSON.stringify(ranged), ranged)).toBe(true);
      expect(samePattern(JSON.stringify({ detail: { size: [{ numeric: ['<=', 0, '>', 5] }] } }), ranged)).toBe(false);
    });

    it('refuses a pattern that is missing or is not JSON', () => {
      expect(samePattern(undefined, pattern)).toBe(false);
      expect(samePattern('', pattern)).toBe(false);
      expect(samePattern('{"source":', pattern)).toBe(false);
      expect(samePattern('null', pattern)).toBe(false);
      expect(samePattern('[]', pattern)).toBe(false);
    });

    it('names a rule state by whether it matches read-only management events', () => {
      expect(ruleState(true)).toBe('ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS');
      expect(ruleState(false)).toBe('ENABLED');
    });
  });

  describe('the edge rules', () => {
    const rules = edgeRoutes(NAMES);
    const byName = Object.fromEntries(rules.map((r) => [r.name, r]));

    it('names each rule under the audit prefix, once, with its construct id', () => {
      expect(rules.map((r) => [r.id, r.name])).toEqual([
        ['IdentityRule', 'jale-audit-edge-identity'],
        ['SignInRule', 'jale-audit-edge-sign-in'],
        ['RootUseRule', 'jale-audit-edge-root'],
        ['AuditRoleAssumptionsRule', 'jale-audit-edge-role-assumptions'],
        ['RuleChangesRuleA', 'jale-audit-edge-rule-changes-a'],
        ['RuleChangesRuleB', 'jale-audit-edge-rule-changes-b'],
        ['FunctionRolesRule', 'jale-audit-edge-function-roles'],
        ['AlarmsAndQueuesRule', 'jale-audit-edge-alarms-and-queues'],
      ]);
    });

    it("forwards changes to alarms and queues, for the sentinel to find the edge region's own", () => {
      const monitoring = (AUDIT_SYSTEM_EVENTS as Record<string, readonly string[]>)['monitoring.amazonaws.com'];
      const queues = (AUDIT_SYSTEM_EVENTS as Record<string, readonly string[]>)['sqs.amazonaws.com'];
      expect(byName['jale-audit-edge-alarms-and-queues'].pattern).toEqual({
        source: ['aws.monitoring', 'aws.sqs'],
        'detail-type': ['AWS API Call via CloudTrail'],
        detail: { eventName: [...monitoring, ...queues] },
      });
      expect(byName['jale-audit-edge-alarms-and-queues'].allManagementEvents).toBe(false);
    });

    it('names the queue that keeps what an edge region could not forward', () => {
      expect(edgeDeadLetterQueue(NAMES)).toBe('jale-audit-edge-dead-letters');
    });

    it('matches read-only management events where it forwards reads: root use and audit-role assumptions', () => {
      expect(rules.filter((r) => r.allManagementEvents).map((r) => r.name)).toEqual(['jale-audit-edge-root', 'jale-audit-edge-role-assumptions']);
    });

    it('forwards the audit roles the configuration names, and the event names the sentinel classifies', () => {
      expect(byName['jale-audit-edge-role-assumptions'].pattern).toEqual({
        source: ['aws.sts'],
        'detail-type': ['AWS API Call via CloudTrail'],
        detail: { eventName: [...ROLE_ASSUMPTION_EVENTS], requestParameters: { roleArn: [{ suffix: ':role/JaleAuditReader' }, { suffix: ':role/JaleAuditAdmin' }] } },
      });
      expect(byName['jale-audit-edge-function-roles'].pattern).toEqual({
        source: ['aws.lambda'], 'detail-type': ['AWS API Call via CloudTrail'], detail: { eventName: [...FUNCTION_ROLE_EVENTS] },
      });
    });

    it('forwards changes to the audit rules twice, by two rules with the same pattern', () => {
      const a = byName['jale-audit-edge-rule-changes-a'].pattern;
      expect(a).toEqual({ source: ['aws.events'], 'detail-type': ['AWS API Call via CloudTrail'], detail: { eventName: [...AUDIT_SYSTEM_EVENTS['events.amazonaws.com']] } });
      expect(byName['jale-audit-edge-rule-changes-b'].pattern).toEqual(a);
    });

    it('hands out a fresh copy each time, so no caller can change another one', () => {
      const first = edgeRoutes(NAMES);
      (first[0].pattern.source as string[]).push('aws.example');
      expect(edgeRoutes(NAMES)[0].pattern.source).toEqual(['aws.iam']);
    });
  });

  describe("the main region's rules, to the sentinel", () => {
    const main = (findings = { guardDutyFindings: true, securityHubFindings: true }): AuditRoute[] => mainRoutes(NAMES, findings);
    const named = (rules: AuditRoute[], name: string) => rules.find((r) => r.name === name)!;

    it('names each rule under the audit prefix, with the construct id each has in the stack', () => {
      expect(main().map((r) => [r.id, r.name])).toEqual([
        ['SecretReadsRule', 'jale-audit-secret-reads'],
        ['SecretChangesRule', 'jale-audit-secret-changes'],
        ['DatabaseRule', 'jale-audit-database'],
        ['IdentityRule', 'jale-audit-identity'],
        ['ParametersRule', 'jale-audit-parameters'],
        ['AuditRoleAssumptionsRule', 'jale-audit-role-assumptions'],
        ['RootUseRule', 'jale-audit-root'],
        ['SignInRule', 'jale-audit-sign-in'],
        ['AdminSignInFailuresRule', 'jale-audit-admin-sign-in-failures'],
        ['AuditSystemCloudtrailRule', 'jale-audit-system-cloudtrail'],
        ['AuditSystemS3Rule', 'jale-audit-system-s3'],
        ['AuditSystemKmsRule', 'jale-audit-system-kms'],
        ['AuditSystemLogsRule', 'jale-audit-system-logs'],
        ['AuditSystemEventsRule', 'jale-audit-system-events'],
        ['AuditSystemEventsRuleB', 'jale-audit-system-events-b'],
        ['AuditSystemGuarddutyRule', 'jale-audit-system-guardduty'],
        ['AuditSystemSecurityhubRule', 'jale-audit-system-securityhub'],
        ['AuditSystemConfigRule', 'jale-audit-system-config'],
        ['AuditSystemSnsRule', 'jale-audit-system-sns'],
        ['AuditSystemMonitoringRule', 'jale-audit-system-monitoring'],
        ['AuditSystemSqsRule', 'jale-audit-system-sqs'],
        ['AuditSystemLambdaRule', 'jale-audit-system-lambda'],
        ['GuardDutyFindingsRule', 'jale-audit-guardduty-findings'],
        ['SecurityHubFindingsRule', 'jale-audit-securityhub-findings'],
      ]);
    });

    it('routes changes to the audit rules twice, by two rules with the same pattern', () => {
      const rules = main();
      const a = named(rules, 'jale-audit-system-events');
      expect(a.pattern).toEqual({ source: ['aws.events'], 'detail-type': ['AWS API Call via CloudTrail'], detail: { eventName: [...AUDIT_SYSTEM_EVENTS['events.amazonaws.com']] } });
      expect(named(rules, 'jale-audit-system-events-b').pattern).toEqual(a.pattern);
      expect(named(rules, 'jale-audit-system-events-b').allManagementEvents).toBe(false);
    });

    it('matches read-only management events where it routes reads: secret reads, role assumptions, root use and failed sign-ins', () => {
      expect(main().filter((r) => r.allManagementEvents).map((r) => r.name)).toEqual([
        'jale-audit-secret-reads', 'jale-audit-role-assumptions', 'jale-audit-root', 'jale-audit-admin-sign-in-failures',
      ]);
      expect(named(main(), 'jale-audit-secret-reads').pattern.detail).toEqual({ eventName: [...SECRET_READ_EVENTS] });
      expect(named(main(), 'jale-audit-admin-sign-in-failures').pattern.detail).toEqual({ eventName: [...COGNITO_SIGN_IN_EVENTS], errorCode: [{ exists: true }] });
    });

    it('builds the names it routes on from the configuration: the audit roles and the audit buckets', () => {
      const rules = main();
      expect(named(rules, 'jale-audit-role-assumptions').pattern).toEqual(edgeRoutes(NAMES).find((r) => r.id === 'AuditRoleAssumptionsRule')!.pattern);
      expect(named(rules, 'jale-audit-system-s3').pattern.detail).toEqual({
        eventName: [...AUDIT_SYSTEM_EVENTS['s3.amazonaws.com']],
        requestParameters: { bucketName: [{ prefix: 'jale-audit-' }] },
      });
    });

    it('routes findings only from the detection services that are on', () => {
      const findings = (g: boolean, s: boolean) => main({ guardDutyFindings: g, securityHubFindings: s }).map((r) => r.name).filter((n) => n.endsWith('-findings'));
      expect(findings(false, false)).toEqual([]);
      expect(findings(true, false)).toEqual(['jale-audit-guardduty-findings']);
      expect(findings(false, true)).toEqual(['jale-audit-securityhub-findings']);
      // The audit-system routers for those services stay either way.
      expect(main({ guardDutyFindings: false, securityHubFindings: false }).map((r) => r.name)).toContain('jale-audit-system-guardduty');
    });

    it('hands out a fresh copy each time', () => {
      const first = main();
      (first[0].pattern.source as string[]).push('aws.example');
      expect(main()[0].pattern.source).toEqual(['aws.secretsmanager']);
    });
  });
});
