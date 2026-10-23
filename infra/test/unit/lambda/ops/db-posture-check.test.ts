import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mockSend = jest.fn();
const mockClientConnect = jest.fn();
const mockClientEnd = jest.fn();
const mockClientConfigs: unknown[] = [];

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSend })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ __type: 'GetSecretValue', input })),
}));

jest.mock('pg', () => ({
  Client: jest.fn((config: unknown) => {
    mockClientConfigs.push(config);
    return { connect: mockClientConnect, end: mockClientEnd, query: jest.fn() };
  }),
}));

import { loadManifest, manifestDigest, parseManifest, type AccessManifest } from '../../../../db/access/access-manifest';
import {
  POSTURE_EXTENSIONS,
  type PostureExtension,
  type PostureQueryable,
  type PostureResult,
} from '../../../../db/access/posture';
import { changeLogDigest, loadChangeLog, parseChangeLog, type ChangeLog } from '../../../../db/access/posture-audit';
import {
  BUNDLED_MANIFEST_FILE,
  connectAsPostureLogin,
  createPostureCheckHandler,
  readBundledManifest,
  readPostureSecret,
  type PostureCheckDependencies,
  type PostureConnection,
  type PostureLoginSecret,
} from '../../../../lambda/ops/db-posture-check';

/**
 * The scheduled and deploy-time database posture check.
 *
 * The handler is built from its dependencies, so every path is driven here
 * without a database: the catalog evaluation itself is the posture module
 * (infra/db/access/posture.ts), proven on a real test bed by its own suites. What these tests pin is this
 * Lambda's contract: the metrics it publishes for the deploy gate and the
 * alarms, the report it returns, that it fails closed (a not-clean run, never
 * a silent pass), and that nothing sensitive leaves it.
 */

const MANIFEST: AccessManifest = loadManifest();
const DIGEST = manifestDigest(MANIFEST);
const CHANGE_LOG: ChangeLog = loadChangeLog();
const CHANGE_LOG_DIGEST = changeLogDigest(CHANGE_LOG);

/**
 * The incoming release's expectation, as the deploy gate sends it in a
 * pre-deploy run: the bundled manifest and change log, each with one entry's
 * reason edited, so both differ from (and digest differently to) what the
 * function bundles. The marker must never reach a log line.
 */
const INCOMING_MARKER = 'incoming-release-marker';
function edited<T extends { tables: Record<string, { reason: string }> }>(value: T): T {
  const copy = JSON.parse(JSON.stringify(value)) as T;
  const [first] = Object.keys(copy.tables).sort();
  copy.tables[first].reason = `${copy.tables[first].reason} (${INCOMING_MARKER})`;
  return copy;
}
const INCOMING_MANIFEST: AccessManifest = parseManifest(edited(MANIFEST));
const INCOMING_DIGEST = manifestDigest(INCOMING_MANIFEST);
const INCOMING_CHANGE_LOG: ChangeLog = parseChangeLog(edited(CHANGE_LOG));
const INCOMING_CHANGE_LOG_DIGEST = changeLogDigest(INCOMING_CHANGE_LOG);

/** The pre-deploy event, through JSON as the invoke delivers it. */
function preDeployEvent(expected: unknown = { manifest: INCOMING_MANIFEST, change_log: INCOMING_CHANGE_LOG }): unknown {
  return JSON.parse(JSON.stringify({ trigger: 'deploy', phase: 'pre', expected }));
}

/** A report field by name, so these tests read fields the report type may not declare. */
function field(report: unknown, name: string): unknown {
  return (report as Record<string, unknown>)[name];
}

const SECRET: PostureLoginSecret = {
  host: 'posture-db.internal.example',
  port: 5432,
  dbname: 'jale',
  username: 'jale_posture',
  password: 'Sup3r-Secret-Pw-For-Tests',
};

const CLEAN: PostureResult = { complete: true, violations: [], serverVersion: '16.4', manifestDigest: DIGEST };
const TWO_VIOLATIONS: PostureResult = {
  complete: true,
  violations: [
    { check: 'login_attributes', object: 'jale_example', detail: 'carries a forbidden attribute' },
    { check: 'table_rls', object: 'public.example', detail: 'FORCE differs from the manifest' },
  ],
  serverVersion: '16.4',
  manifestDigest: DIGEST,
};

/** Every EMF line written through console.log, parsed. */
function emfLines(log: jest.SpyInstance): Array<Record<string, any>> {
  return log.mock.calls
    .map(([line]) => {
      try {
        return JSON.parse(String(line));
      } catch {
        return null;
      }
    })
    .filter((entry): entry is Record<string, any> => entry !== null && entry._aws !== undefined);
}

/** The posture metric lines, keyed by their dimension set. */
function postureLines(log: jest.SpyInstance): Record<string, Record<string, any>> {
  const out: Record<string, Record<string, any>> = {};
  for (const line of emfLines(log)) {
    const block = line._aws.CloudWatchMetrics[0];
    if (block.Namespace !== 'Jale/Database') continue;
    if (!block.Metrics.some((m: { Name: string }) => m.Name === 'DbPostureRunClean')) continue;
    out[JSON.stringify(block.Dimensions)] = line;
  }
  return out;
}

function identityLines(log: jest.SpyInstance): Array<Record<string, any>> {
  return emfLines(log).filter((line) =>
    line._aws.CloudWatchMetrics[0].Namespace === 'Jale/Database'
    && line._aws.CloudWatchMetrics[0].Metrics.some((m: { Name: string }) => m.Name === 'DbIdentityCheckFailed'));
}

function allOutput(...spies: jest.SpyInstance[]): string {
  return spies.flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(' '))).join('\n');
}

interface Harness {
  deps: PostureCheckDependencies;
  connection: { query: jest.Mock; end: jest.Mock };
}

/** `login` is the session's current role, `sessionLogin` the login it signed in as. */
function harness(overrides: Partial<PostureCheckDependencies> = {}, login = 'jale_posture', sessionLogin = login): Harness {
  const connection = {
    query: jest.fn(async (text: string) => (/current_user/.test(text)
      ? { rows: [{ session_login: sessionLogin, login }] }
      : { rows: [] })),
    end: jest.fn(async () => undefined),
  };
  const deps = {
    readManifest: jest.fn(() => MANIFEST),
    readChangeLog: jest.fn(() => CHANGE_LOG),
    readSecret: jest.fn(async () => SECRET),
    connect: jest.fn(async () => connection as unknown as PostureConnection),
    checkPosture: jest.fn(async () => CLEAN),
    ...overrides,
  } as unknown as PostureCheckDependencies;
  return { deps, connection };
}

describe('db-posture-check', () => {
  const env = process.env;
  let log: jest.SpyInstance;
  let errorLog: jest.SpyInstance;
  let workDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClientConfigs.length = 0;
    process.env = { ...env, DB_SECRET_ARN: 'posture-secret-name', DB_EXPECTED_LOGIN: 'jale_posture' };
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-posture-check-'));
  });

  afterEach(() => {
    log.mockRestore();
    errorLog.mockRestore();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  afterAll(() => {
    process.env = env;
  });

  describe('the metrics and the report', () => {
    it('publishes a clean run under its trigger and in the rollup the gate and alarms read', async () => {
      const { deps } = harness();
      const report = await createPostureCheckHandler(deps)({ trigger: 'daily' });

      expect(report).toEqual({
        complete: true,
        violations: [],
        serverVersion: '16.4',
        manifest_sha256: DIGEST,
        change_log_sha256: CHANGE_LOG_DIGEST,
        expected_source: 'bundled',
      });
      const lines = postureLines(log);
      expect(Object.keys(lines).sort()).toEqual(['[["Trigger"]]', '[[]]']);
      expect(lines['[["Trigger"]]'].Trigger).toBe('daily');
      for (const line of Object.values(lines)) {
        expect(line.DbPostureRunClean).toBe(1);
        expect(line.DbPostureRunNotClean).toBe(0);
        expect(line.DbPostureViolations).toBe(0);
      }
    });

    it('publishes violations as a not-clean run with their count, and returns their objects', async () => {
      const { deps } = harness({ checkPosture: jest.fn(async () => TWO_VIOLATIONS) });
      const report = await createPostureCheckHandler(deps)({ trigger: 'daily' });

      expect(report.complete).toBe(true);
      expect(report.violations).toEqual(TWO_VIOLATIONS.violations);
      for (const line of Object.values(postureLines(log))) {
        expect(line.DbPostureRunClean).toBe(0);
        expect(line.DbPostureRunNotClean).toBe(1);
        expect(line.DbPostureViolations).toBe(2);
      }
    });

    it('labels a deploy-triggered run as such', async () => {
      const { deps } = harness();
      await createPostureCheckHandler(deps)({ trigger: 'deploy' });
      expect(postureLines(log)['[["Trigger"]]'].Trigger).toBe('deploy');
    });

    it.each([
      [undefined],
      [{}],
      [{ trigger: 'weekly' }],
      [{ trigger: 7 }],
      [{ trigger: 'deploy-pre' }],
      [{ trigger: 'deploy-pre', phase: 'pre', expected: {} }],
    ])(
      'counts an event of %j as a daily run',
      async (event) => {
        const { deps } = harness();
        await createPostureCheckHandler(deps)(event);
        expect(postureLines(log)['[["Trigger"]]'].Trigger).toBe('daily');
      },
    );

    it('treats an incomplete check as not clean', async () => {
      const incomplete: PostureResult = { complete: false, violations: [], serverVersion: '16.4', manifestDigest: DIGEST };
      const { deps } = harness({ checkPosture: jest.fn(async () => incomplete) });
      const report = await createPostureCheckHandler(deps)({ trigger: 'daily' });

      expect(report).toEqual({
        complete: false,
        violations: [],
        serverVersion: '16.4',
        manifest_sha256: DIGEST,
        change_log_sha256: CHANGE_LOG_DIGEST,
        expected_source: 'bundled',
      });
      for (const line of Object.values(postureLines(log))) {
        expect(line.DbPostureRunClean).toBe(0);
        expect(line.DbPostureRunNotClean).toBe(1);
      }
    });

    it('logs the findings for the operator, objects only', async () => {
      const { deps } = harness({ checkPosture: jest.fn(async () => TWO_VIOLATIONS) });
      await createPostureCheckHandler(deps)({ trigger: 'deploy' });

      const entries = log.mock.calls
        .map(([line]) => {
          try {
            return JSON.parse(String(line));
          } catch {
            return null;
          }
        })
        .filter((entry) => entry && entry.event === 'DbPostureCheck');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        trigger: 'deploy',
        complete: true,
        violationCount: 2,
        serverVersion: '16.4',
        manifest_sha256: DIGEST,
        violations: TWO_VIOLATIONS.violations,
      });
    });
  });

  describe('the daily and post-deploy runs, against the bundled expectation', () => {
    // These runs feed the deploy gate's history and the alarms; this lane
    // leaves them exactly as they were.
    const incoming = { manifest: INCOMING_MANIFEST, change_log: INCOMING_CHANGE_LOG };
    it.each([
      ['the daily run', 'daily', { trigger: 'daily' }],
      ['the post-deploy run', 'deploy', { trigger: 'deploy' }],
      ['a daily run that carries an expectation', 'daily', { trigger: 'daily', phase: 'pre', expected: incoming }],
      ['a deploy run with an expectation and no phase', 'deploy', { trigger: 'deploy', expected: incoming }],
      ['a post-deploy run that carries an expectation', 'deploy', { trigger: 'deploy', phase: 'post', expected: incoming }],
    ])('publishes %s under Trigger=%s and in the rollup, checked against the bundle', async (_what, trigger, event) => {
      const { deps } = harness({ checkPosture: jest.fn(async () => TWO_VIOLATIONS) });
      const report = await createPostureCheckHandler(deps)(JSON.parse(JSON.stringify(event)));

      const lines = postureLines(log);
      expect(Object.keys(lines).sort()).toEqual(['[["Trigger"]]', '[[]]']);
      expect(lines['[["Trigger"]]'].Trigger).toBe(trigger);
      expect(lines['[[]]'].Trigger).toBeUndefined();
      for (const line of Object.values(lines)) {
        expect(line._aws.CloudWatchMetrics[0].Metrics.map((m: { Name: string }) => m.Name).sort())
          .toEqual(['DbPostureRunClean', 'DbPostureRunNotClean', 'DbPostureViolations']);
        expect(line.DbPostureRunNotClean).toBe(1);
        expect(line.DbPostureViolations).toBe(2);
      }
      // The bundled manifest, and the registered extensions as they are.
      const calls = (deps.checkPosture as jest.Mock).mock.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0]).toHaveLength(2);
      expect(calls[0][1]).toBe(MANIFEST);
      expect(field(report, 'expected_source')).toBe('bundled');
      expect(report.manifest_sha256).toBe(DIGEST);
      expect(field(report, 'change_log_sha256')).toBe(CHANGE_LOG_DIGEST);
    });

    it('takes the change-log digest from the file the audit extension reads when no reader is given', async () => {
      const { deps } = harness();
      delete (deps as unknown as Record<string, unknown>).readChangeLog;
      const report = await createPostureCheckHandler(deps)({ trigger: 'daily' });
      expect(field(report, 'change_log_sha256')).toBe(CHANGE_LOG_DIGEST);
    });

    it('still runs the check when the bundled change log cannot be read for its digest', async () => {
      const { deps } = harness({ readChangeLog: jest.fn(() => { throw new Error('ENOENT'); }) } as unknown as Partial<PostureCheckDependencies>);
      const report = await createPostureCheckHandler(deps)({ trigger: 'daily' });

      expect(deps.checkPosture).toHaveBeenCalledTimes(1);
      expect(report.complete).toBe(true);
      expect(report.manifest_sha256).toBe(DIGEST);
      expect(field(report, 'change_log_sha256')).toBeNull();
      expect(Object.keys(postureLines(log)).sort()).toEqual(['[["Trigger"]]', '[[]]']);
    });
  });

  describe('a pre-deploy run with a supplied expectation', () => {
    /** The posture lines must be exactly the one Trigger=deploy-pre series. */
    function expectOnlyDeployPre(clean: boolean): void {
      const lines = postureLines(log);
      expect(Object.keys(lines)).toEqual(['[["Trigger"]]']);
      expect(lines['[["Trigger"]]'].Trigger).toBe('deploy-pre');
      expect(lines['[["Trigger"]]'].DbPostureRunClean).toBe(clean ? 1 : 0);
      expect(lines['[["Trigger"]]'].DbPostureRunNotClean).toBe(clean ? 0 : 1);
    }

    function failureLog(): Record<string, unknown> | undefined {
      return errorLog.mock.calls
        .map(([line]) => {
          try {
            return JSON.parse(String(line)) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .find((entry) => entry !== null && entry.event === 'DbPostureCheckFailed') ?? undefined;
    }

    it('checks the database against the supplied manifest and change log, and reports their digests', async () => {
      const { deps } = harness();
      const report = await createPostureCheckHandler(deps)(preDeployEvent());

      const calls = (deps.checkPosture as jest.Mock).mock.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toEqual(INCOMING_MANIFEST);
      // The same registered extensions, with the audit one reading the
      // supplied change log instead of the bundled file.
      const extensions = calls[0][2] as ReadonlyArray<PostureExtension<unknown>>;
      expect(extensions.map((ext) => ext.name)).toEqual(POSTURE_EXTENSIONS.map((ext) => ext.name));
      const audit = extensions.find((ext) => ext.name === 'audit') as PostureExtension<unknown>;
      const emptyCatalog: PostureQueryable = { query: async () => ({ rows: [] }) };
      const rows = (await audit.read(emptyCatalog)) as { changeLog: ChangeLog };
      expect(rows.changeLog).toEqual(INCOMING_CHANGE_LOG);
      expect(deps.readManifest).not.toHaveBeenCalled();

      expect(report).toEqual({
        complete: true,
        violations: [],
        serverVersion: '16.4',
        manifest_sha256: INCOMING_DIGEST,
        change_log_sha256: INCOMING_CHANGE_LOG_DIGEST,
        expected_source: 'supplied',
      });
      expect(INCOMING_DIGEST).not.toBe(DIGEST);
      expect(INCOMING_CHANGE_LOG_DIGEST).not.toBe(CHANGE_LOG_DIGEST);
    });

    it('publishes only under Trigger=deploy-pre: never the rollup, never Trigger=deploy', async () => {
      const { deps } = harness();
      await createPostureCheckHandler(deps)(preDeployEvent());
      expectOnlyDeployPre(true);
    });

    it('publishes a not-clean supplied run under Trigger=deploy-pre only, with its violations', async () => {
      const { deps } = harness({ checkPosture: jest.fn(async () => TWO_VIOLATIONS) });
      const report = await createPostureCheckHandler(deps)(preDeployEvent());

      expect(report.violations).toEqual(TWO_VIOLATIONS.violations);
      expectOnlyDeployPre(false);
      expect(postureLines(log)['[["Trigger"]]'].DbPostureViolations).toBe(2);
    });

    it.each([
      ['null', null],
      ['a string', 'manifest'],
      ['an empty object', {}],
      ['an unknown field', { manifest: MANIFEST, change_log: CHANGE_LOG, extra: true }],
      ['no change log', { manifest: MANIFEST }],
      ['an invalid manifest', { manifest: { version: 2 }, change_log: CHANGE_LOG }],
      ['an invalid change log', { manifest: MANIFEST, change_log: { version: 2 } }],
    ])('treats an expectation that is %s as not clean, without throwing or connecting', async (_what, expected) => {
      const { deps } = harness();
      const report = await createPostureCheckHandler(deps)(preDeployEvent(expected));

      expect(report).toEqual({
        complete: false,
        violations: [],
        serverVersion: null,
        manifest_sha256: null,
        change_log_sha256: null,
        expected_source: 'supplied',
      });
      expect(deps.checkPosture).not.toHaveBeenCalled();
      expect(deps.readSecret).not.toHaveBeenCalled();
      expect(failureLog()).toMatchObject({ trigger: 'deploy-pre', expected_source: 'supplied', stage: 'expected' });
      expectOnlyDeployPre(false);
    });

    it('treats an expectation over 2 MB as not clean before it validates it', async () => {
      const oversized = JSON.parse(JSON.stringify(MANIFEST)) as AccessManifest;
      const [first] = Object.keys(oversized.tables).sort();
      oversized.tables[first].reason = 'x'.repeat(2 * 1024 * 1024);
      const { deps } = harness();
      const report = await createPostureCheckHandler(deps)(preDeployEvent({ manifest: oversized, change_log: CHANGE_LOG }));

      expect(report.complete).toBe(false);
      expect(field(report, 'expected_source')).toBe('supplied');
      expect(deps.checkPosture).not.toHaveBeenCalled();
      expect(deps.readSecret).not.toHaveBeenCalled();
      expect(failureLog()).toMatchObject({ stage: 'expected', errorCode: 'ExpectedTooLarge' });
      expectOnlyDeployPre(false);
    });

    it('accepts a release-sized expectation', async () => {
      const { deps } = harness();
      const event = preDeployEvent();
      expect(Buffer.byteLength(JSON.stringify((event as { expected: unknown }).expected))).toBeGreaterThan(128 * 1024);
      const report = await createPostureCheckHandler(deps)(event);
      expect(report.complete).toBe(true);
    });

    it('refuses a supplied manifest whose master is the login the check runs as, without the identity metric', async () => {
      const masterIsCheckLogin = {
        version: 1, master: 'jale_posture', logins: {}, capability_owners: {}, groups: {}, helper_roles: {},
        platform_roles: {}, tables: {}, functions: {}, policies: {}, sequences: {}, schemas: {}, exceptions: [],
      };
      expect(() => parseManifest(masterIsCheckLogin)).not.toThrow();
      const { deps } = harness();
      const report = await createPostureCheckHandler(deps)(preDeployEvent({ manifest: masterIsCheckLogin, change_log: CHANGE_LOG }));

      expect(report.complete).toBe(false);
      expect(deps.readSecret).not.toHaveBeenCalled();
      expect(deps.checkPosture).not.toHaveBeenCalled();
      expect(failureLog()).toMatchObject({ stage: 'expected' });
      expect(identityLines(log)).toEqual([]);
      expectOnlyDeployPre(false);
    });

    it('still publishes the identity metric when the secret is for another login', async () => {
      const { deps } = harness({ readSecret: jest.fn(async () => ({ ...SECRET, username: 'jale_admin' })) });
      const report = await createPostureCheckHandler(deps)(preDeployEvent());

      expect(report.complete).toBe(false);
      expect(deps.connect).not.toHaveBeenCalled();
      const dimensionSets = identityLines(log).map((line) => JSON.stringify(line._aws.CloudWatchMetrics[0].Dimensions)).sort();
      expect(dimensionSets).toEqual(['[["Login"]]', '[[]]']);
      expectOnlyDeployPre(false);
    });

    it('reports the supplied digests on a run that fails after validating them', async () => {
      const { deps } = harness({ readSecret: jest.fn(async () => { throw new Error('AccessDeniedException'); }) });
      const report = await createPostureCheckHandler(deps)(preDeployEvent());

      expect(report).toEqual({
        complete: false,
        violations: [],
        serverVersion: null,
        manifest_sha256: INCOMING_DIGEST,
        change_log_sha256: INCOMING_CHANGE_LOG_DIGEST,
        expected_source: 'supplied',
      });
      expect(failureLog()).toMatchObject({ trigger: 'deploy-pre', expected_source: 'supplied', stage: 'secret' });
      expectOnlyDeployPre(false);
    });

    it('logs its trigger and the expectation source, and never the expectation itself', async () => {
      const { deps } = harness({ checkPosture: jest.fn(async () => TWO_VIOLATIONS) });
      await createPostureCheckHandler(deps)(preDeployEvent());

      const entries = log.mock.calls
        .map(([line]) => {
          try {
            return JSON.parse(String(line));
          } catch {
            return null;
          }
        })
        .filter((entry) => entry && entry.event === 'DbPostureCheck');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        trigger: 'deploy-pre',
        expected_source: 'supplied',
        manifest_sha256: INCOMING_DIGEST,
        change_log_sha256: INCOMING_CHANGE_LOG_DIGEST,
      });
      const everything = allOutput(log, errorLog);
      expect(everything).not.toContain(INCOMING_MARKER);
      expect(everything).not.toContain(INCOMING_CHANGE_LOG.description);
    });
  });

  describe('failing closed', () => {
    function expectNotClean(report: { complete: boolean; violations: unknown[] }): void {
      expect(report.complete).toBe(false);
      expect(report.violations).toEqual([]);
      for (const line of Object.values(postureLines(log))) {
        expect(line.DbPostureRunClean).toBe(0);
        expect(line.DbPostureRunNotClean).toBe(1);
      }
      expect(Object.keys(postureLines(log))).toHaveLength(2);
    }

    it('reports an incomplete check, without throwing, when it cannot connect', async () => {
      const refused = Object.assign(new Error(`connect ECONNREFUSED 10.1.2.3:5432 (${SECRET.host})`), { code: 'ECONNREFUSED' });
      const { deps } = harness({ connect: jest.fn(async () => { throw refused; }) });
      const report = await createPostureCheckHandler(deps)({ trigger: 'deploy' });

      expectNotClean(report);
      expect(report).toEqual({
        complete: false,
        violations: [],
        serverVersion: null,
        manifest_sha256: DIGEST,
        change_log_sha256: CHANGE_LOG_DIGEST,
        expected_source: 'bundled',
      });
      expect(allOutput(log, errorLog)).toContain('ECONNREFUSED');
      expect(allOutput(log, errorLog)).not.toContain('10.1.2.3');
    });

    it('reports an incomplete check when the secret cannot be read, and never connects', async () => {
      const { deps } = harness({ readSecret: jest.fn(async () => { throw new Error('AccessDeniedException'); }) });
      const report = await createPostureCheckHandler(deps)({ trigger: 'daily' });

      expectNotClean(report);
      expect(deps.connect).not.toHaveBeenCalled();
    });

    it('treats a missing bundled manifest as not clean, before touching the secret', async () => {
      const { deps } = harness({ readManifest: () => readBundledManifest(workDir) });
      const report = await createPostureCheckHandler(deps)({ trigger: 'daily' });

      expectNotClean(report);
      expect(report.manifest_sha256).toBeNull();
      expect(deps.readSecret).not.toHaveBeenCalled();
    });

    it('treats a bundled manifest that fails to parse as not clean', async () => {
      fs.writeFileSync(path.join(workDir, BUNDLED_MANIFEST_FILE), JSON.stringify({ version: 2 }));
      const { deps } = harness({ readManifest: () => readBundledManifest(workDir) });
      const report = await createPostureCheckHandler(deps)({ trigger: 'daily' });

      expectNotClean(report);
      expect(deps.readSecret).not.toHaveBeenCalled();
    });

    it('treats a check that throws as not clean, and still closes the connection', async () => {
      const { deps, connection } = harness({ checkPosture: jest.fn(async () => { throw new Error('boom'); }) });
      const report = await createPostureCheckHandler(deps)({ trigger: 'daily' });

      expectNotClean(report);
      expect(connection.end).toHaveBeenCalledTimes(1);
    });

    it('treats a malformed check result as not clean', async () => {
      const { deps } = harness({
        checkPosture: jest.fn(async () => ({ complete: true, violations: 'none' }) as unknown as PostureResult),
      });
      expectNotClean(await createPostureCheckHandler(deps)({ trigger: 'daily' }));
    });
  });

  describe('its own identity', () => {
    it('refuses to check the catalog as any login but the expected one', async () => {
      const { deps, connection } = harness({}, 'jale_admin');
      const report = await createPostureCheckHandler(deps)({ trigger: 'daily' });

      expect(report.complete).toBe(false);
      expect(deps.checkPosture).not.toHaveBeenCalled();
      expect(connection.end).toHaveBeenCalledTimes(1);
      const dimensionSets = identityLines(log).map((line) => JSON.stringify(line._aws.CloudWatchMetrics[0].Dimensions)).sort();
      expect(dimensionSets).toEqual(['[["Login"]]', '[[]]']);
      const withLogin = identityLines(log).find((line) => line.Login !== undefined);
      expect(withLogin?.Login).toBe('jale_posture');
      expect(identityLines(log).every((line) => line.DbIdentityCheckFailed === 1)).toBe(true);
    });

    it('publishes the identity metric when the identity query itself fails, and still closes the connection', async () => {
      const { deps, connection } = harness();
      connection.query.mockImplementation(async (text: string) => {
        if (/current_user/.test(text)) throw Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
        return { rows: [] };
      });
      const report = await createPostureCheckHandler(deps)({ trigger: 'daily' });

      expect(report.complete).toBe(false);
      expect(deps.checkPosture).not.toHaveBeenCalled();
      expect(connection.end).toHaveBeenCalledTimes(1);
      const dimensionSets = identityLines(log).map((line) => JSON.stringify(line._aws.CloudWatchMetrics[0].Dimensions)).sort();
      expect(dimensionSets).toEqual(['[["Login"]]', '[[]]']);
      expect(identityLines(log).find((line) => line.Login !== undefined)?.Login).toBe('jale_posture');
      expect(identityLines(log).every((line) => line.DbIdentityCheckFailed === 1)).toBe(true);
    });

    it('refuses a secret for another login before connecting, and publishes the identity metric', async () => {
      const { deps } = harness({ readSecret: jest.fn(async () => ({ ...SECRET, username: 'jale_admin' })) });
      const report = await createPostureCheckHandler(deps)({ trigger: 'daily' });

      expect(report.complete).toBe(false);
      expect(deps.connect).not.toHaveBeenCalled();
      const dimensionSets = identityLines(log).map((line) => JSON.stringify(line._aws.CloudWatchMetrics[0].Dimensions)).sort();
      expect(dimensionSets).toEqual(['[["Login"]]', '[[]]']);
      expect(identityLines(log).find((line) => line.Login !== undefined)?.Login).toBe('jale_posture');
    });

    it('refuses a session that signed in as another login, even when its current role is the posture login', async () => {
      const { deps, connection } = harness({}, 'jale_posture', 'jale_admin');
      const report = await createPostureCheckHandler(deps)({ trigger: 'daily' });

      expect(report.complete).toBe(false);
      expect(deps.checkPosture).not.toHaveBeenCalled();
      expect(connection.end).toHaveBeenCalledTimes(1);
      expect(identityLines(log)).toHaveLength(2);
      expect(connection.query.mock.calls.some(([text]: [string]) => /session_user/.test(text))).toBe(true);
    });

    it('fails closed when the expected login is not configured, before reading the secret', async () => {
      delete process.env.DB_EXPECTED_LOGIN;
      const { deps } = harness();
      const report = await createPostureCheckHandler(deps)({ trigger: 'daily' });

      expect(report.complete).toBe(false);
      expect(deps.readSecret).not.toHaveBeenCalled();
      expect(identityLines(log).find((line) => line.Login !== undefined)?.Login).toBe('unset');
    });

    it('never accepts the master as its expected login', async () => {
      process.env.DB_EXPECTED_LOGIN = MANIFEST.master;
      const { deps } = harness({}, MANIFEST.master);
      const report = await createPostureCheckHandler(deps)({ trigger: 'daily' });

      expect(report.complete).toBe(false);
      expect(deps.readSecret).not.toHaveBeenCalled();
      expect(identityLines(log)).toHaveLength(2);
    });

    it('closes the connection after a clean run', async () => {
      const { deps, connection } = harness();
      await createPostureCheckHandler(deps)({ trigger: 'daily' });
      expect(connection.end).toHaveBeenCalledTimes(1);
    });
  });

  describe('nothing sensitive leaves it', () => {
    it('never writes the secret, the host or an error message, on success or failure', async () => {
      const failing = harness({
        connect: jest.fn(async () => {
          throw new Error(`password authentication failed: ${SECRET.password} at ${SECRET.host}`);
        }),
      });
      const failedReport = await createPostureCheckHandler(failing.deps)({ trigger: 'daily' });
      const passing = harness();
      const passedReport = await createPostureCheckHandler(passing.deps)({ trigger: 'deploy' });

      const everything = [allOutput(log, errorLog), JSON.stringify(failedReport), JSON.stringify(passedReport)].join('\n');
      expect(everything).not.toContain(SECRET.password);
      expect(everything).not.toContain(SECRET.host);
      expect(everything).not.toContain('password authentication failed');
    });
  });

  describe('the bundled manifest', () => {
    it('reads and validates the manifest the bundle carries', () => {
      fs.writeFileSync(path.join(workDir, BUNDLED_MANIFEST_FILE), JSON.stringify(MANIFEST));
      const bundled = readBundledManifest(workDir);
      expect(bundled).toEqual(MANIFEST);
      expect(manifestDigest(bundled)).toBe(DIGEST);
    });

    it('throws when the bundle carries no manifest', () => {
      expect(() => readBundledManifest(workDir)).toThrow();
    });

    it('throws when the bundled manifest is not JSON', () => {
      fs.writeFileSync(path.join(workDir, BUNDLED_MANIFEST_FILE), '{not json');
      expect(() => readBundledManifest(workDir)).toThrow();
    });
  });

  describe('the connection', () => {
    it('reads its own login secret, by the name in DB_SECRET_ARN', async () => {
      mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify(SECRET) });
      await expect(readPostureSecret()).resolves.toEqual(SECRET);
      expect(mockSend.mock.calls[0][0]).toEqual({ __type: 'GetSecretValue', input: { SecretId: 'posture-secret-name' } });
    });

    it.each([
      [{ ...SECRET, password: '' }],
      [{ ...SECRET, host: undefined }],
      [{ ...SECRET, port: 'not-a-port' }],
    ])('refuses an incomplete secret', async (secret) => {
      mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify(secret) });
      await expect(readPostureSecret()).rejects.toThrow();
    });

    it('connects over verified TLS with bounded timeouts', async () => {
      mockClientConnect.mockResolvedValueOnce(undefined);
      await connectAsPostureLogin(SECRET);

      expect(mockClientConfigs).toHaveLength(1);
      const config = mockClientConfigs[0] as Record<string, any>;
      expect(config).toMatchObject({
        host: SECRET.host,
        port: 5432,
        user: SECRET.username,
        password: SECRET.password,
        database: SECRET.dbname,
      });
      expect(config.ssl.rejectUnauthorized).toBe(true);
      expect(config.ssl.ca).toContain('BEGIN CERTIFICATE');
      expect(config.connectionTimeoutMillis).toBeGreaterThan(0);
      expect(config.statement_timeout).toBeGreaterThan(0);
      expect(config.query_timeout).toBeGreaterThan(0);
    });

    it('closes a connection that fails to open, and passes the failure on', async () => {
      mockClientConnect.mockRejectedValueOnce(new Error('timeout expired'));
      mockClientEnd.mockResolvedValueOnce(undefined);
      await expect(connectAsPostureLogin(SECRET)).rejects.toThrow();
      expect(mockClientEnd).toHaveBeenCalledTimes(1);
    });
  });
});
