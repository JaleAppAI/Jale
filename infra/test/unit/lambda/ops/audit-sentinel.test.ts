import * as zlib from 'zlib';
import { ListUserPoolClientsCommand, ListUserPoolsCommand } from '@aws-sdk/client-cognito-identity-provider';
import * as sentinel from '../../../../lambda/ops/audit-sentinel';
import {
  createAdminPoolResolver,
  createSentinelHandler,
  type EdgeInspector,
  s3ArchiveStore,
  edgeCheckConfigFromEnv,
  sdkEdgeInspector,
  sentinelConfigFromEnv,
  snsAlertPublisher,
  type AlertPublisher,
  type ArchiveStore,
  type SentinelDependencies,
} from '../../../../lambda/ops/audit-sentinel';
import type { SentinelConfig } from '../../../../lambda/ops/audit-sentinel-rules';
import {
  ADMIN_CLIENT_ID,
  ADMIN_POOL_ID,
  ALERT_KEY_ALIAS,
  ALERT_KEY_ARN,
  ALERT_TOPIC_ARN,
  APP_STACKS,
  AUDIT_KEY_ARN,
  EVENTS,
  EXPORT_ROLE,
  EXPORT_ROLE_ARN,
  MAIN_BUS_ARN,
  MASTER_SECRET_ARN,
  OTHER_SECURITY_HUB_FINDING_ID,
  REGION,
  SECURITY_HUB_FINDING_ID,
  SENTINEL_DEAD_LETTER_ARN,
  SENTINEL_DEAD_LETTER_NAME,
  SENTINEL_DEAD_LETTER_URL,
  SENTINEL_FUNCTION_ARN,
  SIGN_IN_SUB,
  EXAMPLE_DEVICE_KEY,
  WORKER_CLIENT_ID,
  WORKER_POOL_ID,
  apiCall,
  assumedRole,
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
  auditFunctionNames: ['JaleAuditStack-AuditSentinelFunction-AbC123'],
  exportRoleName: EXPORT_ROLE,
  masterSecretArn: MASTER_SECRET_ARN,
  appStacks: APP_STACKS,
  opsHostStack: 'JaleBastionStack',
  deployPolicyNames: ['JaleDbPostureGate'],
  fixedFunctions: [{ stack: 'JaleAdminStack', functionName: 'jale-admin-nextjs' }],
  auditAlarmPrefix: 'JaleAudit',
  auditQueueNames: ['jale-audit-edge-dead-letters', SENTINEL_DEAD_LETTER_NAME],
};

class MemoryArchive implements ArchiveStore {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  readonly calls: string[] = [];
  failPut = false;

  async exists(key: string): Promise<boolean> {
    this.calls.push(`exists ${key}`);
    return this.objects.has(key);
  }

  async putIfAbsent(key: string, body: Buffer, contentType: string): Promise<'created' | 'exists'> {
    this.calls.push(`put ${key}`);
    if (this.failPut) throw new Error('put failed');
    if (this.objects.has(key)) return 'exists';
    this.objects.set(key, { body, contentType });
    return 'created';
  }

  json(key: string): any {
    return JSON.parse(zlib.gunzipSync(this.objects.get(key)!.body).toString('utf8'));
  }

  lines(key: string): any[] {
    return zlib.gunzipSync(this.objects.get(key)!.body).toString('utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
  }
}

class MemoryPublisher implements AlertPublisher {
  readonly sent: Array<{ subject: string; message: string }> = [];
  fail = false;

  async publish(subject: string, message: string): Promise<void> {
    if (this.fail) throw new Error('publish failed');
    this.sent.push({ subject, message });
  }
}

/** A fake ListUserPools: pages of pools, and a count of calls. */
function poolPages(pages: Array<Array<{ Id: string; Name: string }>>) {
  const calls: Array<string | undefined> = [];
  const listPage = async (nextToken?: string) => {
    calls.push(nextToken);
    const index = nextToken === undefined ? 0 : Number(nextToken);
    return { pools: pages[index] ?? [], nextToken: index + 1 < pages.length ? String(index + 1) : undefined };
  };
  return { calls, listPage };
}

type ClientsPage = Array<{ ClientId: string }>;

/** A fake ListUserPoolClients: pages of the pool's app clients (read at each call), and the calls made. */
function clientPages(pages: () => ClientsPage[]) {
  const calls: Array<{ poolId: string; nextToken?: string }> = [];
  const listClientsPage = async (poolId: string, nextToken?: string) => {
    calls.push({ poolId, nextToken });
    const current = pages();
    const index = nextToken === undefined ? 0 : Number(nextToken);
    return { clients: current[index] ?? [], nextToken: index + 1 < current.length ? String(index + 1) : undefined };
  };
  return { calls, listClientsPage };
}

type ResolverOptions = Parameters<typeof createAdminPoolResolver>[0];

/** The resolver, given a pool lister, and an app-client lister that lists none unless one is passed. */
function resolverWith(options: Omit<ResolverOptions, 'listClientsPage'> & { listClientsPage?: (poolId: string, nextToken?: string) => Promise<{ clients: ClientsPage; nextToken?: string }> }) {
  return createAdminPoolResolver({ listClientsPage: async () => ({ clients: [] }), ...options } as ResolverOptions);
}

interface SetupOptions {
  /** The admin pool's app clients, page by page (default: the admin client). */
  clients?: () => ClientsPage[];
  listClientsPage?: (poolId: string, nextToken?: string) => Promise<{ clients: ClientsPage; nextToken?: string }>;
  now?: () => number;
}

function setup(
  resolverPages: Array<Array<{ Id: string; Name: string }>> = [[{ Id: ADMIN_POOL_ID, Name: 'jale-admin-pool' }]],
  options: SetupOptions = {},
) {
  const archive = new MemoryArchive();
  const publisher = new MemoryPublisher();
  const pools = poolPages(resolverPages);
  const clients = clientPages(options.clients ?? (() => [[{ ClientId: ADMIN_CLIENT_ID }]]));
  const deps: SentinelDependencies = {
    config: CONFIG,
    archive,
    publisher,
    logSources: { '/jale/audit/fallback': 'fallback', '/jale/audit/ops-command': 'ops-command' },
    adminPool: resolverWith({
      listPage: pools.listPage,
      listClientsPage: options.listClientsPage ?? clients.listClientsPage,
      poolName: 'jale-admin-pool',
      ...(options.now ? { now: options.now } : {}),
    }),
  };
  return { archive, publisher, pools, clients, handler: createSentinelHandler(deps) };
}

/** The EMF metric names emitted, from console.log. */
function metricsEmitted(log: jest.SpyInstance): string[] {
  return log.mock.calls
    .map(([line]) => { try { return JSON.parse(String(line)); } catch { return null; } })
    .filter((o: any) => o?._aws)
    .flatMap((o: any) => o._aws.CloudWatchMetrics[0].Metrics.map((m: any) => m.Name));
}

function subscription(logGroup: string, logEvents: Array<{ id: string; timestamp: number; message: string }>, messageType = 'DATA_MESSAGE') {
  const payload = { messageType, owner: '111122223333', logGroup, logStream: 'api/5f2b8c1e-0d4a-4e6b-9c3f-7a1d2e3f4b5c', subscriptionFilters: ['x'], logEvents };
  return { awslogs: { data: zlib.gzipSync(Buffer.from(JSON.stringify(payload))).toString('base64') } };
}

const T = Date.parse('2026-10-04T23:59:59.000Z');

describe('audit sentinel handler', () => {
  let log: jest.SpyInstance;
  beforeEach(() => { log = jest.spyOn(console, 'log').mockImplementation(() => undefined); });
  afterEach(() => log.mockRestore());

  describe('log subscriptions', () => {
    it('archives a batch as gzip JSON lines under logs/<source>/dt=<day of its first event>/', async () => {
      const { archive, handler } = setup();
      await handler(subscription('/jale/audit/fallback', [
        { id: '37000000000000000000000000000000000000000000000000000001', timestamp: T, message: '{"kind":"attempt"}' },
        { id: '37000000000000000000000000000000000000000000000000000002', timestamp: T + 2000, message: '{"kind":"session"}' },
      ]));
      const key = 'logs/fallback/dt=2026-10-04/37000000000000000000000000000000000000000000000000000001-37000000000000000000000000000000000000000000000000000002.jsonl.gz';
      expect([...archive.objects.keys()]).toEqual([key]);
      expect(archive.lines(key)).toEqual([
        { id: '37000000000000000000000000000000000000000000000000000001', timestamp: T, logGroup: '/jale/audit/fallback', logStream: 'api/5f2b8c1e-0d4a-4e6b-9c3f-7a1d2e3f4b5c', message: '{"kind":"attempt"}' },
        { id: '37000000000000000000000000000000000000000000000000000002', timestamp: T + 2000, logGroup: '/jale/audit/fallback', logStream: 'api/5f2b8c1e-0d4a-4e6b-9c3f-7a1d2e3f4b5c', message: '{"kind":"session"}' },
      ]);
    });

    it('names the engine log group as the engine source', async () => {
      const { archive, handler } = setup();
      await handler(subscription('/aws/rds/instance/example-instance/postgresql', [{ id: '1', timestamp: T, message: 'line' }]));
      expect([...archive.objects.keys()]).toEqual(['logs/engine/dt=2026-10-04/1-1.jsonl.gz']);
    });

    it('treats a redelivered batch as already archived', async () => {
      const { archive, handler } = setup();
      const event = subscription('/jale/audit/ops-command', [{ id: '9', timestamp: T, message: 'x' }]);
      await handler(event);
      await expect(handler(event)).resolves.toBeDefined();
      expect(archive.objects.size).toBe(1);
    });

    it('ignores the control message CloudWatch sends when a subscription is created', async () => {
      const { archive, handler } = setup();
      await handler(subscription('/jale/audit/fallback', [{ id: '1', timestamp: T, message: 'CWL CONTROL MESSAGE' }], 'CONTROL_MESSAGE'));
      expect(archive.calls).toEqual([]);
    });

    it('refuses a log group it was not set up for, so the batch is retried and kept', async () => {
      const { archive, handler } = setup();
      await expect(handler(subscription('/aws/lambda/other', [{ id: '1', timestamp: T, message: 'x' }])))
        .rejects.toThrow('AUDIT_SENTINEL_UNKNOWN_LOG_GROUP');
      expect(archive.calls).toEqual([]);
    });

    it('fails, to be retried, when the archive write fails', async () => {
      const { archive, handler } = setup();
      archive.failPut = true;
      await expect(handler(subscription('/jale/audit/fallback', [{ id: '1', timestamp: T, message: 'x' }]))).rejects.toThrow('put failed');
    });
  });

  describe('EventBridge events', () => {
    it('publishes an alert, then archives the alert record under findings/', async () => {
      const { archive, publisher, handler } = setup();
      await handler(EVENTS.personReadsRuntimeSecret);
      expect(publisher.sent).toHaveLength(1);
      expect(publisher.sent[0].subject).toBe('Jale audit alert: secret_read');
      const message = JSON.parse(publisher.sent[0].message);
      expect(message).toMatchObject({ rule: 'secret_read', eventName: 'GetSecretValue', principalType: 'AssumedRole' });
      const keys = [...archive.objects.keys()];
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatch(/^findings\/cloudtrail\/dt=2026-10-04\/[A-Za-z0-9-]+\.json\.gz$/);
      expect(archive.json(keys[0])).toEqual({ alert: message });
      // Checked before publishing, written after.
      expect(archive.calls.map((c) => c.split(' ')[0])).toEqual(['exists', 'put']);
    });

    it('sends one alert for one CloudTrail event, however many rules delivered it', async () => {
      const { publisher, handler } = setup();
      await handler(EVENTS.rootUse);
      await handler({ ...EVENTS.rootUse, id: 'another-delivery-id' });
      expect(publisher.sent).toHaveLength(1);
    });

    it('archives nothing when publishing fails, so the retry alerts again', async () => {
      const { archive, publisher, handler } = setup();
      publisher.fail = true;
      await expect(handler(EVENTS.auditRoleAssumed)).rejects.toThrow('publish failed');
      expect(archive.objects.size).toBe(0);
      publisher.fail = false;
      await handler(EVENTS.auditRoleAssumed);
      expect(publisher.sent).toHaveLength(1);
    });

    it('alerts once per Security Hub finding state, however often the finding is imported', async () => {
      const { archive, publisher, handler } = setup();
      await handler(EVENTS.securityHubCritical);
      await handler(EVENTS.securityHubCriticalLater);
      expect(publisher.sent).toHaveLength(1);
      await handler(EVENTS.securityHubCriticalPassed);
      expect(publisher.sent).toHaveLength(1);
      await handler(EVENTS.securityHubCriticalOther);
      expect(publisher.sent).toHaveLength(2);
      const stateKeys = [...archive.objects.keys()].filter((key) => key.startsWith('findings/securityhub-state/'));
      expect(stateKeys).toHaveLength(2);
      for (const key of stateKeys) expect(key).toMatch(/^findings\/securityhub-state\/[0-9a-f]{64}\.json\.gz$/);
      // The passed finding is archived under its event, as any finding that does not alert.
      expect([...archive.objects.keys()].filter((key) => !stateKeys.includes(key)))
        .toEqual([expect.stringMatching(/^findings\/securityhub\/dt=2026-10-06\//)]);
      const kept = [
        ...publisher.sent.flatMap((m) => [m.subject, m.message]),
        ...stateKeys.flatMap((key) => [key, JSON.stringify(archive.json(key))]),
        ...log.mock.calls.map(([line]) => String(line)),
      ].join('\n');
      for (const id of [SECURITY_HUB_FINDING_ID, OTHER_SECURITY_HUB_FINDING_ID]) expect(kept).not.toContain(id);
    });

    it('alerts on nothing for a finding once it is archived or suppressed, and archives each such import under its event', async () => {
      const { archive, publisher, handler } = setup();
      const base = EVENTS.securityHubCritical;
      const finding = base.detail.findings[0];
      await handler({ ...base, id: '9a0b0000-0000-4000-8000-0000000000a1', detail: { findings: [{ ...finding, RecordState: 'ARCHIVED' }] } });
      await handler({ ...base, id: '9a0b0000-0000-4000-8000-0000000000a2', detail: { findings: [{ ...finding, Workflow: { Status: 'SUPPRESSED' } }] } });
      expect(publisher.sent).toEqual([]);
      expect([...archive.objects.keys()]).toEqual([
        expect.stringMatching(/^findings\/securityhub\/dt=2026-10-04\/9a0b0000-0000-4000-8000-0000000000a1\.json\.gz$/),
        expect.stringMatching(/^findings\/securityhub\/dt=2026-10-04\/9a0b0000-0000-4000-8000-0000000000a2\.json\.gz$/),
      ]);
    });

    it('archives a finding that does not alert, and publishes nothing', async () => {
      const { archive, publisher, handler } = setup();
      await handler(EVENTS.guardDutyLow);
      expect(publisher.sent).toEqual([]);
      const keys = [...archive.objects.keys()];
      expect(keys).toEqual([expect.stringMatching(/^findings\/guardduty\/dt=2026-10-04\//)]);
      expect(archive.json(keys[0])).toMatchObject({ classification: 'archive', finding: { id: 'example-finding-2' } });
    });

    it('does nothing for an expected or ignored event', async () => {
      const { archive, publisher, handler } = setup();
      await handler(EVENTS.cfnResolvesMasterPassword);
      await handler(EVENTS.lambdaReadsOwnSecret);
      await handler(EVENTS.agentHeartbeat);
      expect(publisher.sent).toEqual([]);
      expect(archive.calls).toEqual([]);
    });

    it('logs codes only, never the event', async () => {
      const { handler } = setup();
      await handler(EVENTS.personReadsMasterSecret);
      const logged = log.mock.calls.map(([line]) => String(line)).join('\n');
      expect(logged).not.toContain('arn:aws');
      expect(logged).not.toContain('198.51.100.');
      expect(logged).not.toContain('example-operator');
    });

    it("alerts on a function given the export job's role, and archives the alert record", async () => {
      const { archive, publisher, handler } = setup();
      await handler(EVENTS.functionCreatedWithExportRole);
      expect(publisher.sent).toHaveLength(1);
      expect(publisher.sent[0].subject).toBe('Jale audit alert: audit_system_change');
      const message = JSON.parse(publisher.sent[0].message);
      expect(message).toMatchObject({
        rule: 'audit_system_change',
        eventSource: 'lambda.amazonaws.com',
        eventName: 'CreateFunction20150331',
        principalType: 'AssumedRole',
        target: EXPORT_ROLE_ARN,
      });
      const keys = [...archive.objects.keys()];
      expect(keys).toEqual([expect.stringMatching(/^findings\/cloudtrail\/dt=2026-10-04\/[A-Za-z0-9-]+\.json\.gz$/)]);
      expect(archive.json(keys[0])).toEqual({ alert: message });
    });

    it.each([
      ["an audit alarm's actions disabled", 'monitoring.amazonaws.com', 'DisableAlarmActions', { alarmNames: ['JaleAuditDailyCompareMismatch'] }, 'JaleAuditDailyCompareMismatch'],
      ["the sentinel's own dead-letter queue purged", 'sqs.amazonaws.com', 'PurgeQueue', { queueUrl: SENTINEL_DEAD_LETTER_URL }, SENTINEL_DEAD_LETTER_NAME],
    ])('alerts on %s, and archives the alert record', async (_label, eventSource, eventName, requestParameters, target) => {
      const { archive, publisher, handler } = setup();
      await handler(apiCall({ eventSource, eventName, userIdentity: assumedRole('SomeAdmin'), requestParameters }));
      expect(publisher.sent.map((m) => m.subject)).toEqual(['Jale audit alert: audit_system_change']);
      expect(JSON.parse(publisher.sent[0].message)).toMatchObject({ rule: 'audit_system_change', eventSource, eventName, target });
      expect([...archive.objects.keys()]).toEqual([expect.stringMatching(/^findings\/cloudtrail\//)]);
    });

    it('rejects an event that is neither a log batch nor an EventBridge event', async () => {
      const { handler } = setup();
      await expect(handler({ hello: 'world' })).rejects.toThrow('AUDIT_SENTINEL_UNKNOWN_EVENT');
    });
  });

  describe('configuration from the environment', () => {
    const env = process.env;
    afterEach(() => { process.env = env; });

    it('reads every setting, and adds its own function name to the audit functions', () => {
      process.env = {
        ...env,
        AUDIT_ALERT_TOPIC_ARN: ALERT_TOPIC_ARN,
        AUDIT_KEY_ARN,
        AUDIT_KEY_ALIAS: 'alias/jale-audit',
        AUDIT_ALERT_KEY_ARN: ALERT_KEY_ARN,
        AUDIT_ALERT_KEY_ALIAS: ALERT_KEY_ALIAS,
        AUDIT_BUCKET_PREFIX: 'jale-audit-',
        AUDIT_LOG_SOURCES: JSON.stringify({ '/jale/audit/fallback': 'fallback', '/jale/audit/ops-command': 'ops-command' }),
        AUDIT_RULE_PREFIX: 'jale-audit-',
        AUDIT_ROLE_NAMES: 'JaleAuditReader,JaleAuditAdmin',
        AUDIT_FUNCTION_NAMES: 'JaleAuditStack-AuditExportFunction-XyZ789',
        AUDIT_EXPORT_ROLE_NAME: EXPORT_ROLE,
        AUDIT_ADMIN_POOL_NAME: 'jale-admin-pool',
        AUDIT_MASTER_SECRET_ARN: MASTER_SECRET_ARN,
        AUDIT_APP_STACKS: APP_STACKS.join(','),
        AUDIT_OPS_HOST_STACK: 'JaleBastionStack',
        AUDIT_DEPLOY_POLICIES: 'JaleDbPostureGate',
        AUDIT_FIXED_FUNCTIONS: 'JaleAdminStack/jale-admin-nextjs',
        AUDIT_ALARM_PREFIX: 'JaleAudit',
        AUDIT_SENTINEL_DEAD_LETTER_ARN: SENTINEL_DEAD_LETTER_ARN,
        AWS_LAMBDA_FUNCTION_NAME: 'JaleAuditStack-AuditSentinelFunction-AbC123',
      };
      const { config, logSources, adminPoolName } = sentinelConfigFromEnv();
      expect(adminPoolName).toBe('jale-admin-pool');
      expect(config).toEqual({
        ...CONFIG,
        auditFunctionNames: ['JaleAuditStack-AuditExportFunction-XyZ789', 'JaleAuditStack-AuditSentinelFunction-AbC123'],
      });
      expect(logSources).toEqual({ '/jale/audit/fallback': 'fallback', '/jale/audit/ops-command': 'ops-command' });
    });

    const settings = {
      AUDIT_EDGE_REGIONS: 'us-east-1,us-west-2',
      AUDIT_RULE_PREFIX: 'jale-audit-',
      AUDIT_ROLE_NAMES: 'JaleAuditReader,JaleAuditAdmin',
      AUDIT_BUCKET_PREFIX: 'jale-audit-',
      AUDIT_MAIN_BUS_ARN: MAIN_BUS_ARN,
      AUDIT_EDGE_DLQ_ARNS: JSON.stringify({ 'us-east-1': 'q1', 'us-west-2': 'q2' }),
      AWS_REGION: REGION,
      AUDIT_SENTINEL_DEAD_LETTER_ARN: SENTINEL_DEAD_LETTER_ARN,
      AUDIT_ROUTED_FINDINGS: 'guardduty,securityhub',
    };

    it('reads the edge check settings, and builds the rules it expects from the same table the edge stacks deploy', () => {
      process.env = { ...env, ...settings };
      const config = edgeCheckConfigFromEnv();
      expect(config).toMatchObject({
        regions: ['us-east-1', 'us-west-2'],
        mainBusArn: MAIN_BUS_ARN,
        deadLetterArns: { 'us-east-1': 'q1', 'us-west-2': 'q2' },
      });
      expect(config.rules.map((r) => [r.name, r.state])).toEqual([
        ['jale-audit-edge-identity', 'ENABLED'],
        ['jale-audit-edge-sign-in', 'ENABLED'],
        ['jale-audit-edge-root', 'ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS'],
        ['jale-audit-edge-role-assumptions', 'ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS'],
        ['jale-audit-edge-rule-changes-a', 'ENABLED'],
        ['jale-audit-edge-rule-changes-b', 'ENABLED'],
        ['jale-audit-edge-function-roles', 'ENABLED'],
        ['jale-audit-edge-alarms-and-queues', 'ENABLED'],
      ]);
      // The patterns come from the configured names: the audit roles here.
      const assumptions = config.rules.find((r) => r.name === 'jale-audit-edge-role-assumptions')!;
      expect(assumptions.pattern).toEqual({
        source: ['aws.sts'],
        'detail-type': ['AWS API Call via CloudTrail'],
        detail: {
          eventName: ['AssumeRole', 'AssumeRoleWithSAML', 'AssumeRoleWithWebIdentity'],
          requestParameters: { roleArn: [{ suffix: ':role/JaleAuditReader' }, { suffix: ':role/JaleAuditAdmin' }] },
        },
      });
      for (const missing of [
        'AUDIT_RULE_PREFIX', 'AUDIT_ROLE_NAMES', 'AUDIT_MAIN_BUS_ARN', 'AUDIT_EDGE_DLQ_ARNS',
        'AWS_REGION', 'AUDIT_SENTINEL_DEAD_LETTER_ARN', 'AUDIT_ROUTED_FINDINGS',
      ]) {
        process.env = { ...env, ...settings, [missing]: '' };
        expect(() => edgeCheckConfigFromEnv()).toThrow('AUDIT_SENTINEL_CONFIG');
      }
    });

    it("also expects the main region's routes to the sentinel, the rule-change route among them twice", () => {
      process.env = { ...env, ...settings };
      const { main } = edgeCheckConfigFromEnv();
      expect(main).toMatchObject({ region: REGION, deadLetterArn: SENTINEL_DEAD_LETTER_ARN });
      const names = main!.rules.map((r) => r.name);
      expect(names).toEqual(expect.arrayContaining(['jale-audit-system-events', 'jale-audit-system-events-b', 'jale-audit-role-assumptions']));
      expect(new Set(names).size).toBe(names.length);
      const [a, b] = ['jale-audit-system-events', 'jale-audit-system-events-b'].map((n) => main!.rules.find((r) => r.name === n)!);
      expect(b.pattern).toEqual(a.pattern);
      expect(b.state).toBe('ENABLED');
    });

    it('reads which findings the main region routes, and refuses a value it does not know', () => {
      const findingRules = (value: string) => {
        process.env = { ...env, ...settings, AUDIT_ROUTED_FINDINGS: value };
        return edgeCheckConfigFromEnv().main!.rules.map((r) => r.name).filter((n) => n.endsWith('-findings'));
      };
      expect(findingRules('none')).toEqual([]);
      expect(findingRules('guardduty')).toEqual(['jale-audit-guardduty-findings']);
      expect(findingRules('securityhub')).toEqual(['jale-audit-securityhub-findings']);
      expect(findingRules('guardduty,securityhub')).toEqual(['jale-audit-guardduty-findings', 'jale-audit-securityhub-findings']);
      for (const value of ['all', 'guardduty,inspector', 'none,guardduty']) {
        expect(() => findingRules(value)).toThrow('AUDIT_SENTINEL_CONFIG');
      }
    });

    it('refuses to start with a setting missing', () => {
      process.env = { ...env, AUDIT_ALERT_TOPIC_ARN: '' };
      expect(() => sentinelConfigFromEnv()).toThrow('AUDIT_SENTINEL_CONFIG');
    });

    it("refuses to start without the export job's role, rather than watch for nothing", () => {
      process.env = {
        ...env,
        AUDIT_ALERT_TOPIC_ARN: ALERT_TOPIC_ARN,
        AUDIT_KEY_ARN,
        AUDIT_KEY_ALIAS: 'alias/jale-audit',
        AUDIT_ALERT_KEY_ARN: ALERT_KEY_ARN,
        AUDIT_ALERT_KEY_ALIAS: ALERT_KEY_ALIAS,
        AUDIT_BUCKET_PREFIX: 'jale-audit-',
        AUDIT_LOG_SOURCES: JSON.stringify({ '/jale/audit/fallback': 'fallback' }),
        AUDIT_RULE_PREFIX: 'jale-audit-',
        AUDIT_ROLE_NAMES: 'JaleAuditReader,JaleAuditAdmin',
        AUDIT_FUNCTION_NAMES: 'JaleAuditStack-AuditExportFunction-XyZ789',
        AUDIT_EXPORT_ROLE_NAME: '',
        AUDIT_ADMIN_POOL_NAME: 'jale-admin-pool',
        AUDIT_MASTER_SECRET_ARN: MASTER_SECRET_ARN,
        AUDIT_APP_STACKS: APP_STACKS.join(','),
        AUDIT_OPS_HOST_STACK: 'JaleBastionStack',
        AUDIT_DEPLOY_POLICIES: 'JaleDbPostureGate',
      };
      expect(() => sentinelConfigFromEnv()).toThrow('AUDIT_SENTINEL_CONFIG: AUDIT_EXPORT_ROLE_NAME is not set');
    });

    it("refuses to start without the alert topic's key, rather than leave a change to it unwatched", () => {
      process.env = {
        ...env,
        AUDIT_ALERT_TOPIC_ARN: ALERT_TOPIC_ARN,
        AUDIT_KEY_ARN,
        AUDIT_KEY_ALIAS: 'alias/jale-audit',
        AUDIT_ALERT_KEY_ARN: '',
        AUDIT_ALERT_KEY_ALIAS: ALERT_KEY_ALIAS,
        AUDIT_BUCKET_PREFIX: 'jale-audit-',
        AUDIT_LOG_SOURCES: JSON.stringify({ '/jale/audit/fallback': 'fallback' }),
        AUDIT_RULE_PREFIX: 'jale-audit-',
        AUDIT_ROLE_NAMES: 'JaleAuditReader,JaleAuditAdmin',
        AUDIT_FUNCTION_NAMES: 'JaleAuditStack-AuditExportFunction-XyZ789',
        AUDIT_EXPORT_ROLE_NAME: EXPORT_ROLE,
        AUDIT_ADMIN_POOL_NAME: 'jale-admin-pool',
        AUDIT_MASTER_SECRET_ARN: MASTER_SECRET_ARN,
        AUDIT_APP_STACKS: APP_STACKS.join(','),
        AUDIT_OPS_HOST_STACK: 'JaleBastionStack',
        AUDIT_DEPLOY_POLICIES: 'JaleDbPostureGate',
      };
      expect(() => sentinelConfigFromEnv()).toThrow('AUDIT_SENTINEL_CONFIG: AUDIT_ALERT_KEY_ARN is not set');
    });

    it("refuses to start without the audit alarms' prefix or its own queue, rather than leave changes to them unwatched", () => {
      const complete = {
        ...env,
        AUDIT_ALERT_TOPIC_ARN: ALERT_TOPIC_ARN,
        AUDIT_KEY_ARN,
        AUDIT_KEY_ALIAS: 'alias/jale-audit',
        AUDIT_ALERT_KEY_ARN: ALERT_KEY_ARN,
        AUDIT_ALERT_KEY_ALIAS: ALERT_KEY_ALIAS,
        AUDIT_BUCKET_PREFIX: 'jale-audit-',
        AUDIT_LOG_SOURCES: JSON.stringify({ '/jale/audit/fallback': 'fallback' }),
        AUDIT_RULE_PREFIX: 'jale-audit-',
        AUDIT_ROLE_NAMES: 'JaleAuditReader,JaleAuditAdmin',
        AUDIT_FUNCTION_NAMES: 'JaleAuditStack-AuditExportFunction-XyZ789',
        AUDIT_EXPORT_ROLE_NAME: EXPORT_ROLE,
        AUDIT_ADMIN_POOL_NAME: 'jale-admin-pool',
        AUDIT_MASTER_SECRET_ARN: MASTER_SECRET_ARN,
        AUDIT_APP_STACKS: APP_STACKS.join(','),
        AUDIT_OPS_HOST_STACK: 'JaleBastionStack',
        AUDIT_DEPLOY_POLICIES: 'JaleDbPostureGate',
        AUDIT_ALARM_PREFIX: 'JaleAudit',
        AUDIT_SENTINEL_DEAD_LETTER_ARN: SENTINEL_DEAD_LETTER_ARN,
      };
      for (const missing of ['AUDIT_ALARM_PREFIX', 'AUDIT_SENTINEL_DEAD_LETTER_ARN']) {
        process.env = { ...complete, [missing]: '' };
        expect(() => sentinelConfigFromEnv()).toThrow(`AUDIT_SENTINEL_CONFIG: ${missing} is not set`);
      }
    });
  });

  describe('the S3 archive store and the SNS publisher', () => {
    function failure(status: number): Error {
      return Object.assign(new Error(`status ${status}`), { $metadata: { httpStatusCode: status } });
    }

    it('writes only when the key is absent, with a checksum, and reports an existing key', async () => {
      const send = jest.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(failure(412));
      const store = s3ArchiveStore({ send } as any, 'jale-audit-archive-example');
      await expect(store.putIfAbsent('logs/a', Buffer.from('x'), 'application/gzip')).resolves.toBe('created');
      await expect(store.putIfAbsent('logs/a', Buffer.from('x'), 'application/gzip')).resolves.toBe('exists');
      expect(send.mock.calls[0][0].input).toEqual({
        Bucket: 'jale-audit-archive-example',
        Key: 'logs/a',
        Body: Buffer.from('x'),
        ContentType: 'application/gzip',
        IfNoneMatch: '*',
        ChecksumAlgorithm: 'SHA256',
      });
    });

    it('fails on any other write error, including a conflicting concurrent write', async () => {
      const store = s3ArchiveStore({ send: jest.fn().mockRejectedValue(failure(409)) } as any, 'b');
      await expect(store.putIfAbsent('k', Buffer.from('x'), 't')).rejects.toThrow('status 409');
    });

    it('answers whether a key exists, and fails on anything but not-found', async () => {
      const send = jest.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(failure(404)).mockRejectedValueOnce(failure(403));
      const store = s3ArchiveStore({ send } as any, 'b');
      await expect(store.exists('k')).resolves.toBe(true);
      await expect(store.exists('k')).resolves.toBe(false);
      await expect(store.exists('k')).rejects.toThrow('status 403');
    });

    it('publishes to the topic with a subject SNS accepts', async () => {
      const send = jest.fn().mockResolvedValue({});
      await snsAlertPublisher({ send } as any, ALERT_TOPIC_ARN).publish('s'.repeat(150), 'm');
      expect(send.mock.calls[0][0].input).toEqual({ TopicArn: ALERT_TOPIC_ARN, Subject: 's'.repeat(100), Message: 'm' });
    });
  });

  describe('admin sign-in failures', () => {
    it('alerts on a failure in the admin pool with codes only, and archives the alert record', async () => {
      const { archive, publisher, handler } = setup();
      await handler(EVENTS.adminSignInFailed);
      expect(publisher.sent).toHaveLength(1);
      const message = JSON.parse(publisher.sent[0].message);
      expect(message).toEqual({
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
      const keys = [...archive.objects.keys()];
      expect(keys).toEqual([expect.stringMatching(/^findings\/cognito\/dt=2026-10-04\//)]);
      expect(archive.json(keys[0])).toEqual({ alert: message });
      expect(JSON.stringify(archive.json(keys[0]))).not.toMatch(/198\.51\.100\.|6a7b8c9d|Incorrect/);
    });

    it('alerts on a failed second factor in the admin pool', async () => {
      const { publisher, handler } = setup();
      await handler(EVENTS.adminSecondFactorFailed);
      expect(JSON.parse(publisher.sent[0].message)).toMatchObject({ eventName: 'RespondToAuthChallenge', errorCode: 'CodeMismatchException' });
    });

    it('drops a failure in another pool silently: no alert, no archive, no metric', async () => {
      const { archive, publisher, handler } = setup();
      await handler(EVENTS.workerSignInFailed);
      expect(publisher.sent).toEqual([]);
      expect(archive.calls).toEqual([]);
      expect(metricsEmitted(log)).toEqual([]);
    });

    it('counts a failure that names neither a pool nor a client, looks nothing up, and stores nothing of it anywhere', async () => {
      const { archive, publisher, pools, clients, handler } = setup();
      await handler(EVENTS.unattributedSignInFailed);
      expect(metricsEmitted(log)).toEqual(['AuditCognitoEventUnattributed']);
      expect(publisher.sent).toEqual([]);
      expect(archive.calls).toEqual([]);
      expect(pools.calls).toEqual([]);
      expect(clients.calls).toEqual([]);
      const logged = log.mock.calls.map(([line]) => String(line)).join('\n');
      expect(logged).not.toMatch(/198\.51\.100\.|8c9d0e1f/);
    });

    it.each([
      ['no pool has the name', [[{ Id: WORKER_POOL_ID, Name: 'jale-worker-pool' }]]],
      ['two pools have the name', [[{ Id: ADMIN_POOL_ID, Name: 'jale-admin-pool' }], [{ Id: 'us-east-2_Other', Name: 'jale-admin-pool' }]]],
    ])('counts the pool as unresolved and alerts on nothing when %s', async (_label, pages) => {
      const { archive, publisher, handler } = setup(pages);
      await handler(EVENTS.adminSignInFailed);
      expect(metricsEmitted(log)).toEqual(['AuditCognitoPoolUnresolved']);
      expect(publisher.sent).toEqual([]);
      expect(archive.calls).toEqual([]);
    });

    it('finds the admin pool on a later page', async () => {
      const { publisher, pools, handler } = setup([
        [{ Id: WORKER_POOL_ID, Name: 'jale-worker-pool' }],
        [{ Id: 'us-east-2_Employer', Name: 'jale-employer-pool' }],
        [{ Id: ADMIN_POOL_ID, Name: 'jale-admin-pool' }],
      ]);
      await handler(EVENTS.adminSignInFailed);
      expect(pools.calls).toEqual([undefined, '1', '2']);
      expect(publisher.sent).toHaveLength(1);
    });
  });

  describe('admin sign-in failures named by app client', () => {
    /** Everything the sentinel sent, stored or logged, as one text. */
    function everythingKept(archive: MemoryArchive, publisher: MemoryPublisher): string {
      return [
        ...publisher.sent.flatMap((m) => [m.subject, m.message]),
        ...[...archive.objects.keys()].flatMap((key) => [key, JSON.stringify(archive.json(key))]),
        ...log.mock.calls.map(([line]) => String(line)),
      ].join('\n');
    }

    it.each([
      ['a wrong password', 'adminSrpPasswordVerifierFailed', 'NotAuthorizedException', 'PASSWORD_VERIFIER'],
      ['a wrong authenticator code', 'adminMfaCodeFailedRealShape', 'CodeMismatchException', 'SOFTWARE_TOKEN_MFA'],
      ["a remembered browser's refused device secret", 'adminDeviceSrpFailedRealShape', 'NotAuthorizedException', 'DEVICE_PASSWORD_VERIFIER'],
    ] as const)('alerts on %s through an admin app client, with codes only', async (_label, name, errorCode, challengeName) => {
      const { archive, publisher, handler } = setup();
      await handler(EVENTS[name]);
      expect(publisher.sent).toHaveLength(1);
      expect(publisher.sent[0].subject).toBe('Jale audit alert: admin_sign_in_failed');
      const message = JSON.parse(publisher.sent[0].message);
      expect(message).toEqual({
        rule: 'admin_sign_in_failed',
        summary: expect.any(String),
        eventSource: 'cognito-idp.amazonaws.com',
        eventName: 'RespondToAuthChallenge',
        eventTime: '2026-10-04T12:00:00Z',
        awsRegion: 'us-east-2',
        eventId: expect.any(String),
        principalType: 'Unknown',
        errorCode,
        challengeName,
        poolMatch: true,
      });
      const keys = [...archive.objects.keys()];
      expect(keys).toEqual([expect.stringMatching(/^findings\/cognito\/dt=2026-10-04\/[A-Za-z0-9-]+\.json\.gz$/)]);
      expect(archive.json(keys[0])).toEqual({ alert: message });
      expect(metricsEmitted(log)).toEqual(['AuditSentinelAlerts']);
      const kept = everythingKept(archive, publisher);
      for (const value of [ADMIN_CLIENT_ID, SIGN_IN_SUB, 'HIDDEN_DUE_TO_SECURITY_REASONS', '198.51.100.', 'Incorrect', 'Invalid code']) {
        expect(kept).not.toContain(value);
      }
    });

    it('alerts on a refused refresh through an admin app client, naming its flow, so it reads apart from a wrong password', async () => {
      const { archive, publisher, handler } = setup();
      await handler(EVENTS.adminRefreshRevokedRealShape);
      expect(publisher.sent).toHaveLength(1);
      const message = JSON.parse(publisher.sent[0].message);
      expect(message).toEqual({
        rule: 'admin_sign_in_failed',
        summary: expect.any(String),
        eventSource: 'cognito-idp.amazonaws.com',
        eventName: 'InitiateAuth',
        eventTime: '2026-10-04T12:00:00Z',
        awsRegion: 'us-east-2',
        eventId: expect.any(String),
        principalType: 'Unknown',
        errorCode: 'NotAuthorizedException',
        authFlow: 'REFRESH_TOKEN_AUTH',
        poolMatch: true,
      });
      const kept = everythingKept(archive, publisher);
      for (const value of [ADMIN_CLIENT_ID, SIGN_IN_SUB, 'HIDDEN_DUE_TO_SECURITY_REASONS', '198.51.100.', 'Refresh Token has been revoked']) {
        expect(kept).not.toContain(value);
      }
    });

    it('keeps only codes from an admin failure that carries unknown values, a session or a device key', async () => {
      const { archive, publisher, handler } = setup();
      const base = EVENTS.adminDeviceSrpFailedRealShape;
      await handler({
        ...base,
        detail: {
          ...base.detail,
          requestParameters: {
            clientId: ADMIN_CLIENT_ID,
            authFlow: 'EXAMPLE_FUTURE_FLOW',
            challengeName: 'EXAMPLE_FUTURE_CHALLENGE',
            session: 'example-session-value',
            deviceKey: EXAMPLE_DEVICE_KEY,
          },
        },
      });
      expect(publisher.sent).toHaveLength(1);
      expect(JSON.parse(publisher.sent[0].message)).toMatchObject({ authFlow: 'other', challengeName: 'other' });
      const kept = everythingKept(archive, publisher);
      for (const value of [ADMIN_CLIENT_ID, SIGN_IN_SUB, EXAMPLE_DEVICE_KEY, 'example-session-value', 'EXAMPLE_FUTURE_FLOW', 'EXAMPLE_FUTURE_CHALLENGE', '198.51.100.']) {
        expect(kept).not.toContain(value);
      }
    });

    it("drops another app client's failure silently: no alert, no archive, no metric", async () => {
      const { archive, publisher, handler } = setup();
      await handler(EVENTS.workerSrpFailedRealShape);
      expect(publisher.sent).toEqual([]);
      expect(archive.calls).toEqual([]);
      expect(metricsEmitted(log)).toEqual([]);
      const kept = everythingKept(archive, publisher);
      for (const value of [WORKER_CLIENT_ID, SIGN_IN_SUB, '198.51.100.']) expect(kept).not.toContain(value);
    });

    it('drops a failure in another pool, even when it names an admin app client', async () => {
      const { archive, publisher, clients, handler } = setup();
      const named = EVENTS.workerSignInFailed;
      await handler({ ...named, detail: { ...named.detail, requestParameters: { clientId: ADMIN_CLIENT_ID, challengeName: 'PASSWORD_VERIFIER' } } });
      expect(publisher.sent).toEqual([]);
      expect(archive.calls).toEqual([]);
      expect(metricsEmitted(log)).toEqual([]);
      expect(clients.calls.every((call) => call.poolId === ADMIN_POOL_ID)).toBe(true);
    });

    it('keeps nothing of a sign-in that succeeded, and never logs the device key it carries', async () => {
      const { archive, publisher, pools, clients, handler } = setup();
      await handler(EVENTS.adminDeviceIssued);
      expect(publisher.sent).toEqual([]);
      expect(archive.calls).toEqual([]);
      expect(metricsEmitted(log)).toEqual([]);
      expect([pools.calls, clients.calls]).toEqual([[], []]);
      const kept = everythingKept(archive, publisher);
      for (const value of [EXAMPLE_DEVICE_KEY, ADMIN_CLIENT_ID, SIGN_IN_SUB]) expect(kept).not.toContain(value);
    });

    it("reads the admin pool's app clients after the pool, and keeps them for later events", async () => {
      let now = 0;
      const { publisher, pools, clients, handler } = setup(undefined, { now: () => now });
      await handler(EVENTS.adminSrpPasswordVerifierFailed);
      now += 1000;
      await handler(EVENTS.adminMfaCodeFailedRealShape);
      now += 1000;
      await handler(EVENTS.adminDeviceSrpFailedRealShape);
      expect(publisher.sent).toHaveLength(3);
      expect(pools.calls).toHaveLength(1);
      expect(clients.calls).toEqual([{ poolId: ADMIN_POOL_ID, nextToken: undefined }]);
    });

    it('finds an admin app client on a later page', async () => {
      const { publisher, clients, handler } = setup(undefined, {
        clients: () => [[{ ClientId: 'exampleotherclient00000000' }], [{ ClientId: ADMIN_CLIENT_ID }]],
      });
      await handler(EVENTS.adminSrpPasswordVerifierFailed);
      expect(clients.calls).toEqual([{ poolId: ADMIN_POOL_ID, nextToken: undefined }, { poolId: ADMIN_POOL_ID, nextToken: '1' }]);
      expect(publisher.sent).toHaveLength(1);
    });

    it('reads the clients again for an unknown client at most once every five minutes, so other clients cost no lookup each', async () => {
      let now = 0;
      const { publisher, clients, handler } = setup(undefined, { now: () => now });
      await handler(EVENTS.adminSrpPasswordVerifierFailed);
      expect(clients.calls).toHaveLength(1);
      for (let i = 0; i < 20; i += 1) {
        now += 1000;
        await handler(EVENTS.workerSrpFailedRealShape);
      }
      expect(clients.calls).toHaveLength(1);
      now = 6 * 60 * 1000;
      await handler(EVENTS.workerSrpFailedRealShape);
      expect(clients.calls).toHaveLength(2);
      now += 1000;
      await handler(EVENTS.workerSrpFailedRealShape);
      expect(clients.calls).toHaveLength(2);
      expect(publisher.sent).toHaveLength(1);
      expect(metricsEmitted(log).filter((name) => name !== 'AuditSentinelAlerts')).toEqual([]);
    });

    it('finds an admin app client added since the last read, once that read is five minutes old', async () => {
      let now = 0;
      let pages: ClientsPage[] = [[{ ClientId: 'exampleotherclient00000000' }]];
      const { publisher, clients, handler } = setup(undefined, { now: () => now, clients: () => pages });
      await handler(EVENTS.adminSrpPasswordVerifierFailed);
      expect(publisher.sent).toEqual([]);
      pages = [[{ ClientId: 'exampleotherclient00000000' }, { ClientId: ADMIN_CLIENT_ID }]];
      now = 60 * 1000;
      await handler(EVENTS.adminMfaCodeFailedRealShape);
      expect(publisher.sent).toEqual([]);
      now = 6 * 60 * 1000;
      await handler(EVENTS.adminDeviceSrpFailedRealShape);
      expect(publisher.sent).toHaveLength(1);
      expect(clients.calls).toHaveLength(2);
    });

    it('reads the pool and its clients again after an hour', async () => {
      let now = 0;
      const { pools, clients, handler } = setup(undefined, { now: () => now });
      await handler(EVENTS.adminSrpPasswordVerifierFailed);
      now = 60 * 60 * 1000 - 1;
      await handler(EVENTS.adminMfaCodeFailedRealShape);
      expect([pools.calls.length, clients.calls.length]).toEqual([1, 1]);
      now = 60 * 60 * 1000 + 1;
      await handler(EVENTS.adminDeviceSrpFailedRealShape);
      expect([pools.calls.length, clients.calls.length]).toEqual([2, 2]);
    });

    it('fails, so the event is retried, when listing the clients fails, and keeps no part of that lookup', async () => {
      let fail = true;
      const { publisher, pools, handler } = setup(undefined, {
        listClientsPage: async () => {
          if (fail) throw new Error('clients throttled');
          return { clients: [{ ClientId: ADMIN_CLIENT_ID }] };
        },
      });
      await expect(handler(EVENTS.adminSrpPasswordVerifierFailed)).rejects.toThrow('clients throttled');
      expect(publisher.sent).toEqual([]);
      fail = false;
      await handler(EVENTS.adminSrpPasswordVerifierFailed);
      expect(publisher.sent).toHaveLength(1);
      expect(pools.calls).toHaveLength(2);
    });

    it('counts the pool as unresolved, and alerts on nothing, when no pool has the name', async () => {
      const { archive, publisher, clients, handler } = setup([[{ Id: WORKER_POOL_ID, Name: 'jale-worker-pool' }]]);
      await handler(EVENTS.adminSrpPasswordVerifierFailed);
      expect(metricsEmitted(log)).toEqual(['AuditCognitoPoolUnresolved']);
      expect(publisher.sent).toEqual([]);
      expect(archive.calls).toEqual([]);
      expect(clients.calls).toEqual([]);
    });
  });

  describe('the user-pool listings through the SDK', () => {
    type Listers = Pick<ResolverOptions, 'listPage'> & {
      listClientsPage(poolId: string, nextToken?: string): Promise<{ clients: Array<{ ClientId?: string }>; nextToken?: string }>;
    };
    const sdkUserPoolListers = (sentinel as Record<string, unknown>).sdkUserPoolListers as (client: { send(command: unknown): Promise<unknown> }) => Listers;

    it('lists the pools, and a pool\'s app clients, 60 to a page, following each next token', async () => {
      expect(typeof sdkUserPoolListers).toBe('function');
      const sent: unknown[] = [];
      const client = {
        async send(command: unknown) {
          sent.push(command);
          if (command instanceof ListUserPoolsCommand) {
            return command.input.NextToken === undefined
              ? { UserPools: [{ Id: WORKER_POOL_ID, Name: 'jale-worker-pool' }], NextToken: 'pools-2' }
              : { UserPools: [{ Id: ADMIN_POOL_ID, Name: 'jale-admin-pool' }] };
          }
          if (command instanceof ListUserPoolClientsCommand) {
            return command.input.NextToken === undefined
              ? { UserPoolClients: [{ ClientId: 'exampleotherclient00000000', UserPoolId: ADMIN_POOL_ID }], NextToken: 'clients-2' }
              : { UserPoolClients: [{ ClientId: ADMIN_CLIENT_ID, UserPoolId: ADMIN_POOL_ID }] };
          }
          throw new Error('unexpected command');
        },
      };
      const resolver = createAdminPoolResolver({ ...sdkUserPoolListers(client), poolName: 'jale-admin-pool' } as ResolverOptions);
      await expect(resolver.resolve(ADMIN_POOL_ID)).resolves.toMatchObject({ status: 'resolved', adminPoolId: ADMIN_POOL_ID });
      expect(sent.map((command) => [(command as { constructor: { name: string } }).constructor.name, (command as { input: unknown }).input])).toEqual([
        ['ListUserPoolsCommand', { MaxResults: 60 }],
        ['ListUserPoolsCommand', { MaxResults: 60, NextToken: 'pools-2' }],
        ['ListUserPoolClientsCommand', { UserPoolId: ADMIN_POOL_ID, MaxResults: 60 }],
        ['ListUserPoolClientsCommand', { UserPoolId: ADMIN_POOL_ID, MaxResults: 60, NextToken: 'clients-2' }],
      ]);
    });
  });

  describe('the admin pool resolver', () => {
    const HOUR = 60 * 60 * 1000;

    it('caches the pool for an hour, then looks it up again', async () => {
      let now = 0;
      const pools = poolPages([[{ Id: ADMIN_POOL_ID, Name: 'jale-admin-pool' }]]);
      const resolver = resolverWith({ listPage: pools.listPage, poolName: 'jale-admin-pool', now: () => now });
      await expect(resolver.resolve(ADMIN_POOL_ID)).resolves.toEqual({ status: 'resolved', adminPoolId: ADMIN_POOL_ID });
      now = HOUR - 1;
      await resolver.resolve(ADMIN_POOL_ID);
      expect(pools.calls).toHaveLength(1);
      now = HOUR + 1;
      await resolver.resolve(ADMIN_POOL_ID);
      expect(pools.calls).toHaveLength(2);
    });

    it('looks the pool up again once when an event names another pool, so a recreated pool is found', async () => {
      let now = 0;
      let pages = [[{ Id: 'us-east-2_OldAdmin', Name: 'jale-admin-pool' }]];
      const calls: number[] = [];
      const resolver = resolverWith({
        listPage: async () => { calls.push(now); return { pools: pages[0] }; },
        poolName: 'jale-admin-pool',
        now: () => now,
      });
      await resolver.resolve('us-east-2_OldAdmin');
      pages = [[{ Id: ADMIN_POOL_ID, Name: 'jale-admin-pool' }]];
      now = 10 * 60 * 1000;
      await expect(resolver.resolve(ADMIN_POOL_ID)).resolves.toEqual({ status: 'resolved', adminPoolId: ADMIN_POOL_ID });
      expect(calls).toHaveLength(2);
    });

    it('does not look the pool up for every other-pool event: at most once every five minutes', async () => {
      let now = 0;
      const pools = poolPages([[{ Id: ADMIN_POOL_ID, Name: 'jale-admin-pool' }]]);
      const resolver = resolverWith({ listPage: pools.listPage, poolName: 'jale-admin-pool', now: () => now });
      await resolver.resolve(ADMIN_POOL_ID);
      for (let i = 0; i < 20; i += 1) {
        now += 1000;
        await expect(resolver.resolve(WORKER_POOL_ID)).resolves.toEqual({ status: 'resolved', adminPoolId: ADMIN_POOL_ID });
      }
      expect(pools.calls).toHaveLength(1);
      now = 6 * 60 * 1000;
      await resolver.resolve(WORKER_POOL_ID);
      expect(pools.calls).toHaveLength(2);
    });

    it('caches an unresolved answer too, so a missing pool is not looked up on every event', async () => {
      let now = 0;
      const pools = poolPages([[]]);
      const resolver = resolverWith({ listPage: pools.listPage, poolName: 'jale-admin-pool', now: () => now });
      await expect(resolver.resolve(ADMIN_POOL_ID)).resolves.toEqual({ status: 'unresolved' });
      now = 60 * 1000;
      await resolver.resolve(ADMIN_POOL_ID);
      expect(pools.calls).toHaveLength(1);
    });

    it('fails, so the event is retried, when the lookup itself fails', async () => {
      const resolver = resolverWith({
        listPage: async () => { throw new Error('throttled'); },
        poolName: 'jale-admin-pool',
      });
      await expect(resolver.resolve(ADMIN_POOL_ID)).rejects.toThrow('throttled');
    });
  });

  describe('the daily edge check', () => {
    const MAIN_BUS = 'arn:aws:events:us-east-2:111122223333:event-bus/default';
    const DLQ = (region: string) => `arn:aws:sqs:${region}:111122223333:jale-audit-edge-dead-letters`;
    const RULES = [
      { name: 'jale-audit-edge-identity', state: 'ENABLED', pattern: { source: ['aws.iam'], 'detail-type': ['AWS API Call via CloudTrail'] } },
      {
        name: 'jale-audit-edge-root',
        state: 'ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS',
        pattern: { 'detail-type': ['AWS API Call via CloudTrail'], detail: { userIdentity: { type: ['Root'] } } },
      },
    ];
    const ruleNamed = (name: string) => RULES.find((r) => r.name === name)!;
    // A deployed pattern reads back as JSON, its keys in whatever order the service keeps.
    const asDeployed = (pattern: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(pattern).reverse()), null, 1);

    function healthy(): EdgeInspector & { calls: string[] } {
      const calls: string[] = [];
      return {
        calls,
        async describeRule(region, name) {
          calls.push(`describe ${region} ${name}`);
          return { state: ruleNamed(name).state, eventPattern: asDeployed(ruleNamed(name).pattern) };
        },
        async listTargets(region, name) {
          calls.push(`targets ${region} ${name}`);
          return [{ arn: MAIN_BUS, deadLetterArn: DLQ(region), transformsInput: false }];
        },
        async queueDepth(region) {
          calls.push(`depth ${region}`);
          return 0;
        },
      };
    }

    function edgeSetup(inspector: EdgeInspector) {
      const archive = new MemoryArchive();
      const publisher = new MemoryPublisher();
      const handler = createSentinelHandler({
        config: CONFIG,
        archive,
        publisher,
        logSources: {},
        adminPool: resolverWith({ listPage: async () => ({ pools: [] }), poolName: 'jale-admin-pool' }),
        edge: {
          config: { regions: ['us-east-1', 'us-west-2'], rules: RULES, mainBusArn: MAIN_BUS, deadLetterArns: { 'us-east-1': DLQ('us-east-1'), 'us-west-2': DLQ('us-west-2') } },
          inspector,
        },
      });
      return { archive, publisher, handler };
    }

    it('reads every rule, its target and the queue in each edge region, and reports a healthy edge', async () => {
      const inspector = healthy();
      const { publisher, handler } = edgeSetup(inspector);
      await expect(handler({ check: 'edge' })).resolves.toEqual({ kind: 'edge', problems: 0 });
      expect(inspector.calls).toHaveLength(2 * (2 * 2 + 1));
      expect(publisher.sent).toEqual([]);
      expect(metricsEmitted(log)).toEqual(['AuditEdgeCheckFailed', 'AuditEdgeCheckCompleted']);
    });

    it.each([
      ['a missing rule', { describeRule: async () => null }],
      ['a disabled rule', { describeRule: async (_region: string, name: string) => ({ state: 'DISABLED', eventPattern: asDeployed(ruleNamed(name).pattern) }) }],
      ['an enabled rule with a changed pattern', {
        describeRule: async (_region: string, name: string) => ({ state: ruleNamed(name).state, eventPattern: JSON.stringify({ source: ['aws.example'] }) }),
      }],
      ['a rule whose pattern cannot be read', { describeRule: async (_region: string, name: string) => ({ state: ruleNamed(name).state }) }],
      ['a target that is not the main bus', { listTargets: async (region: string) => [{ arn: 'arn:aws:events:us-east-1:111122223333:event-bus/other', deadLetterArn: DLQ(region) }] }],
      ['a target without its dead-letter queue', { listTargets: async () => [{ arn: MAIN_BUS }] }],
      ['a target that rewrites the event', { listTargets: async (region: string) => [{ arn: MAIN_BUS, deadLetterArn: DLQ(region), transformsInput: true }] }],
      ['events waiting in a dead-letter queue', { queueDepth: async () => 3 }],
      ['an unreadable rule', { describeRule: async () => { throw new Error('AccessDenied'); } }],
    ])('alerts with codes only on %s', async (_label, override) => {
      const { publisher, handler } = edgeSetup({ ...healthy(), ...override } as EdgeInspector);
      const result = await handler({ check: 'edge' }) as { problems: number };
      expect(result.problems).toBeGreaterThan(0);
      expect(publisher.sent).toHaveLength(1);
      expect(publisher.sent[0].subject).toBe('Jale audit alert: audit_edge_unhealthy');
      const body = JSON.parse(publisher.sent[0].message);
      expect(body).toMatchObject({ rule: 'audit_edge_unhealthy', summary: expect.any(String) });
      for (const p of body.problems) {
        expect(Object.keys(p).sort()).toEqual(['item', 'problem', 'region']);
        expect(p.problem).toMatch(/^[a-z_]+$/);
      }
      expect(JSON.stringify(body)).not.toMatch(/AccessDenied|111122223333/);
    });

    it("reads each rule's pattern and each target's input: a changed pattern and a rewritten event are named problems", async () => {
      const inspector = healthy();
      const { publisher, handler } = edgeSetup({
        ...inspector,
        async describeRule(region, name) {
          const found = await inspector.describeRule(region, name);
          if (region !== 'us-east-1' || name !== 'jale-audit-edge-identity') return found;
          // Still enabled, now matching another source.
          return { ...found, eventPattern: JSON.stringify({ source: ['aws.example'], 'detail-type': ['AWS API Call via CloudTrail'] }) };
        },
        async listTargets(region, name) {
          const found = await inspector.listTargets(region, name);
          return region === 'us-west-2' && name === 'jale-audit-edge-root' ? [{ ...found[0], transformsInput: true }] : found;
        },
      });
      await expect(handler({ check: 'edge' })).resolves.toEqual({ kind: 'edge', problems: 2 });
      expect(JSON.parse(publisher.sent[0].message).problems).toEqual([
        { region: 'us-east-1', item: 'jale-audit-edge-identity', problem: 'rule_pattern' },
        { region: 'us-west-2', item: 'jale-audit-edge-root', problem: 'rule_input' },
      ]);
    });
  });

  describe("the daily check of the main region's routes", () => {
    const MAIN_RULES = [
      {
        name: 'jale-audit-system-events',
        state: 'ENABLED',
        pattern: { source: ['aws.events'], 'detail-type': ['AWS API Call via CloudTrail'], detail: { eventName: ['PutRule', 'DisableRule'] } },
      },
      {
        name: 'jale-audit-root',
        state: 'ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS',
        pattern: { 'detail-type': ['AWS API Call via CloudTrail'], detail: { userIdentity: { type: ['Root'] } } },
      },
    ];
    const ruleNamed = (name: string) => MAIN_RULES.find((r) => r.name === name)!;
    const CONTEXT = { invokedFunctionArn: SENTINEL_FUNCTION_ARN };

    function healthy(): EdgeInspector & { calls: string[] } {
      const calls: string[] = [];
      return {
        calls,
        async describeRule(region, name) {
          calls.push(`describe ${region} ${name}`);
          return { state: ruleNamed(name).state, eventPattern: JSON.stringify(ruleNamed(name).pattern) };
        },
        async listTargets(region, name) {
          calls.push(`targets ${region} ${name}`);
          return [{ arn: SENTINEL_FUNCTION_ARN, deadLetterArn: SENTINEL_DEAD_LETTER_ARN, transformsInput: false }];
        },
        async queueDepth(region) {
          calls.push(`depth ${region}`);
          return 0;
        },
      };
    }

    /** Only the main region: no edge region, so every problem is a main-region one. */
    function mainSetup(inspector: EdgeInspector) {
      const publisher = new MemoryPublisher();
      const handler = createSentinelHandler({
        config: CONFIG,
        archive: new MemoryArchive(),
        publisher,
        logSources: {},
        adminPool: resolverWith({ listPage: async () => ({ pools: [] }), poolName: 'jale-admin-pool' }),
        edge: {
          config: {
            regions: [],
            rules: [],
            mainBusArn: 'unused',
            deadLetterArns: {},
            main: { region: REGION, rules: MAIN_RULES, deadLetterArn: SENTINEL_DEAD_LETTER_ARN },
          },
          inspector,
        },
      });
      return { publisher, handler };
    }

    it("reads every route, its target and dead-letter queue in the main region, against the sentinel's own function", async () => {
      const inspector = healthy();
      const { publisher, handler } = mainSetup(inspector);
      await expect(handler({ check: 'edge' }, CONTEXT)).resolves.toEqual({ kind: 'edge', problems: 0 });
      expect(inspector.calls).toEqual(MAIN_RULES.flatMap((r) => [`describe ${REGION} ${r.name}`, `targets ${REGION} ${r.name}`]));
      expect(publisher.sent).toEqual([]);
    });

    it('takes its own function without the version or alias it was invoked by', async () => {
      const { handler } = mainSetup(healthy());
      await expect(handler({ check: 'edge' }, { invokedFunctionArn: `${SENTINEL_FUNCTION_ARN}:live` })).resolves.toEqual({ kind: 'edge', problems: 0 });
    });

    const first = MAIN_RULES[0];
    it.each([
      ['a missing route', 'rule_missing', { describeRule: async (_r: string, name: string) => (name === first.name ? null : { state: ruleNamed(name).state, eventPattern: JSON.stringify(ruleNamed(name).pattern) }) }],
      ['a disabled route', 'rule_state', { describeRule: async (_r: string, name: string) => ({ state: name === first.name ? 'DISABLED' : ruleNamed(name).state, eventPattern: JSON.stringify(ruleNamed(name).pattern) }) }],
      ['an enabled route with a changed pattern', 'rule_pattern', {
        describeRule: async (_r: string, name: string) => ({
          state: ruleNamed(name).state,
          eventPattern: JSON.stringify(name === first.name ? { source: ['aws.events'], 'detail-type': ['AWS API Call via CloudTrail'], detail: { eventName: ['TagResource'] } } : ruleNamed(name).pattern),
        }),
      }],
      ['a route to another function', 'rule_target', {
        listTargets: async (_r: string, name: string) => [{ arn: name === first.name ? `${SENTINEL_FUNCTION_ARN}-other` : SENTINEL_FUNCTION_ARN, deadLetterArn: SENTINEL_DEAD_LETTER_ARN, transformsInput: false }],
      }],
      ['a route without its dead-letter queue', 'rule_dead_letters', {
        listTargets: async (_r: string, name: string) => [{ arn: SENTINEL_FUNCTION_ARN, deadLetterArn: name === first.name ? undefined : SENTINEL_DEAD_LETTER_ARN, transformsInput: false }],
      }],
      ['a route that rewrites the event', 'rule_input', {
        listTargets: async (_r: string, name: string) => [{ arn: SENTINEL_FUNCTION_ARN, deadLetterArn: SENTINEL_DEAD_LETTER_ARN, transformsInput: name === first.name }],
      }],
      ['an unreadable route', 'rule_unreadable', {
        describeRule: async (_r: string, name: string) => {
          if (name === first.name) throw new Error('AccessDenied');
          return { state: ruleNamed(name).state, eventPattern: JSON.stringify(ruleNamed(name).pattern) };
        },
      }],
    ])('alerts audit_rules_unhealthy, with codes only, on %s', async (_label, code, override) => {
      const { publisher, handler } = mainSetup({ ...healthy(), ...override } as EdgeInspector);
      await expect(handler({ check: 'edge' }, CONTEXT)).resolves.toEqual({ kind: 'edge', problems: 1 });
      expect(publisher.sent.map((m) => m.subject)).toEqual(['Jale audit alert: audit_rules_unhealthy']);
      const body = JSON.parse(publisher.sent[0].message);
      expect(body).toEqual({ rule: 'audit_rules_unhealthy', summary: expect.any(String), problems: [{ region: REGION, item: first.name, problem: code }] });
      expect(JSON.stringify(body)).not.toMatch(/AccessDenied|function:/);
    });

    it('alerts once for the edge regions and once for the main region when both have problems, and counts both', async () => {
      const inspector = healthy();
      const publisher = new MemoryPublisher();
      const handler = createSentinelHandler({
        config: CONFIG,
        archive: new MemoryArchive(),
        publisher,
        logSources: {},
        adminPool: resolverWith({ listPage: async () => ({ pools: [] }), poolName: 'jale-admin-pool' }),
        edge: {
          config: {
            regions: ['us-west-2'],
            rules: [],
            mainBusArn: 'unused',
            deadLetterArns: { 'us-west-2': 'edge-queue' },
            main: { region: REGION, rules: MAIN_RULES, deadLetterArn: SENTINEL_DEAD_LETTER_ARN },
          },
          inspector: {
            ...inspector,
            queueDepth: async () => 2,
            describeRule: async (region, name) => ({ ...(await inspector.describeRule(region, name)), state: 'DISABLED' }),
          },
        },
      });
      await expect(handler({ check: 'edge' }, CONTEXT)).resolves.toEqual({ kind: 'edge', problems: 3 });
      expect(publisher.sent.map((m) => m.subject)).toEqual(['Jale audit alert: audit_edge_unhealthy', 'Jale audit alert: audit_rules_unhealthy']);
      expect(JSON.parse(publisher.sent[0].message).problems).toEqual([{ region: 'us-west-2', item: 'dead_letters', problem: 'events_waiting' }]);
      expect(JSON.parse(publisher.sent[1].message).problems.map((p: any) => p.problem)).toEqual(['rule_state', 'rule_state']);
      expect(metricsEmitted(log)).toEqual(['AuditEdgeCheckFailed', 'AuditEdgeCheckCompleted']);
    });

    it('reports, rather than guesses, when it cannot tell its own function, and still checks the edge regions', async () => {
      const inspector = healthy();
      const { publisher, handler } = mainSetup(inspector);
      await expect(handler({ check: 'edge' })).resolves.toEqual({ kind: 'edge', problems: 1 });
      expect(inspector.calls).toEqual([]);
      expect(JSON.parse(publisher.sent[0].message).problems).toEqual([{ region: REGION, item: 'sentinel', problem: 'own_function_unknown' }]);
      await expect(handler({ check: 'edge' }, { invokedFunctionArn: 'not-an-arn' })).resolves.toEqual({ kind: 'edge', problems: 1 });
    });
  });

  describe('the edge inspector through the SDK', () => {
    it('reads a rule and its pattern, answers null for a missing one, and maps targets and whether each rewrites the event', async () => {
      const send = jest.fn()
        .mockResolvedValueOnce({ State: 'ENABLED', EventPattern: '{"source":["aws.iam"]}' })
        .mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'ResourceNotFoundException' }))
        .mockResolvedValueOnce({
          Targets: [
            { Arn: 'bus', DeadLetterConfig: { Arn: 'dlq' } },
            { Arn: 'bus', Input: '{"check":"edge"}' },
            { Arn: 'bus', InputPath: '$.detail' },
            { Arn: 'bus', InputTransformer: { InputTemplate: '"<detail>"' } },
          ],
        });
      const regions: string[] = [];
      const inspector = sdkEdgeInspector((region) => { regions.push(region); return { send } as any; }, () => ({ send: jest.fn() }) as any);
      await expect(inspector.describeRule('us-west-2', 'r')).resolves.toEqual({ state: 'ENABLED', eventPattern: '{"source":["aws.iam"]}' });
      await expect(inspector.describeRule('us-west-2', 'r')).resolves.toBeNull();
      await expect(inspector.listTargets('us-west-2', 'r')).resolves.toEqual([
        { arn: 'bus', deadLetterArn: 'dlq', transformsInput: false },
        { arn: 'bus', deadLetterArn: undefined, transformsInput: true },
        { arn: 'bus', deadLetterArn: undefined, transformsInput: true },
        { arn: 'bus', deadLetterArn: undefined, transformsInput: true },
      ]);
      expect(regions).toEqual(['us-west-2']);
      expect(send.mock.calls[0][0].input).toEqual({ Name: 'r' });
      expect(send.mock.calls[2][0].input).toEqual({ Rule: 'r' });
    });

    it('reads the queue depth by the queue URL, and fails on a depth it cannot read', async () => {
      const send = jest.fn().mockResolvedValueOnce({ Attributes: { ApproximateNumberOfMessages: '2' } }).mockResolvedValueOnce({ Attributes: {} });
      const inspector = sdkEdgeInspector(() => ({ send: jest.fn() }) as any, () => ({ send }) as any);
      const arn = 'arn:aws:sqs:us-east-1:111122223333:jale-audit-edge-dead-letters';
      await expect(inspector.queueDepth('us-east-1', arn)).resolves.toBe(2);
      expect(send.mock.calls[0][0].input).toEqual({
        QueueUrl: 'https://sqs.us-east-1.amazonaws.com/111122223333/jale-audit-edge-dead-letters',
        AttributeNames: ['ApproximateNumberOfMessages'],
      });
      await expect(inspector.queueDepth('us-east-1', arn)).rejects.toThrow('AUDIT_SENTINEL_QUEUE_DEPTH');
    });
  });
});
