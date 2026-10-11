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

import { loadManifest, manifestDigest, type AccessManifest } from '../../../../db/access/access-manifest';
import type { PostureResult } from '../../../../db/access/posture';
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
  const deps: PostureCheckDependencies = {
    readManifest: jest.fn(() => MANIFEST),
    readSecret: jest.fn(async () => SECRET),
    connect: jest.fn(async () => connection as unknown as PostureConnection),
    checkPosture: jest.fn(async () => CLEAN),
    ...overrides,
  };
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

      expect(report).toEqual({ complete: true, violations: [], serverVersion: '16.4', manifest_sha256: DIGEST });
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

    it.each([[undefined], [{}], [{ trigger: 'weekly' }], [{ trigger: 7 }]])(
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

      expect(report).toEqual({ complete: false, violations: [], serverVersion: '16.4', manifest_sha256: DIGEST });
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
      expect(report).toEqual({ complete: false, violations: [], serverVersion: null, manifest_sha256: DIGEST });
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
