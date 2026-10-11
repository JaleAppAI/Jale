/**
 * problem-reports-handlers.integration.test.ts -- the report-a-problem
 * Lambdas end to end on a real PostgreSQL bed, each on its own login:
 *
 *   lambda/reports/intake.ts         jale_api                  (signed in)
 *   lambda/reports/public-intake.ts  jale_api_public_reports   (signed out)
 *   lambda/reports/cleanup.ts        jale_job_report_cleanup   (daily job)
 *
 * The pools are built by the real boot path (createCheckedPool), which runs
 * the login's identity and posture check before serving anything.
 * Storage, the presigned POST signer and the salt secret are in-process
 * stand-ins; the database is real, and every durable effect is read back
 * through the superuser.
 *
 * Covers: signed-in create with and without an account (and with a sign-in
 * whose role neither the issuer nor an account can tell); signed-out create
 * with the per-address limits, where a refused over-limit attempt still
 * counts; the switches; upload and attach, including a signed-in report's
 * image retried through the public routes; replays; and the clean-up
 * deleting exactly the keys SQL returned.
 *
 * Applies to the request and owner-unrestricted profiles: code under test
 * signs in as its real login. In owner-unrestricted the functions' own caller
 * checks are exercised without depending on row policies.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { Client, type Pool } from 'pg';
import { createCheckedPool } from '../../../lambda/lib/db';
import { hashVisitor } from '../../../lambda/lib/referral-codes';
import { clearAddressSaltCache } from '../../../lambda/reports/lib/address';
import { describeInProfiles, loginUrl } from './helpers/login-pool';
import { World } from './r-paths-world';
import { PNG_BYTES, answerS3, captureConsole, sha256, type ConsoleCapture } from '../lambda/reports/harness';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

let mockPool: Pool | undefined;
jest.mock('../../../lambda/lib/db', () => {
  const actual = jest.requireActual('../../../lambda/lib/db');
  return { ...actual, getDbPool: async () => mockPool };
});
jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  const send = jest.fn();
  return { ...actual, mockSharedSend: send, S3Client: jest.fn().mockImplementation(() => ({ send })) };
});
jest.mock('@aws-sdk/s3-presigned-post', () => ({ createPresignedPost: jest.fn() }));
jest.mock('@aws-sdk/client-secrets-manager', () => {
  const actual = jest.requireActual('@aws-sdk/client-secrets-manager');
  const send = jest.fn();
  return { ...actual, mockSharedSend: send, SecretsManagerClient: jest.fn().mockImplementation(() => ({ send })) };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler: signedIn } = require('../../../lambda/reports/intake');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler: signedOut } = require('../../../lambda/reports/public-intake');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler: cleanup } = require('../../../lambda/reports/cleanup');
const mockS3Send = (jest.requireMock('@aws-sdk/client-s3') as { mockSharedSend: jest.Mock }).mockSharedSend;
const mockSecretSend = (jest.requireMock('@aws-sdk/client-secrets-manager') as { mockSharedSend: jest.Mock }).mockSharedSend;
const mockPresign = (jest.requireMock('@aws-sdk/s3-presigned-post') as { createPresignedPost: jest.Mock }).createPresignedPost;

if (!databaseUrl) {
  test('CONCERN: the report handlers DB suite was not run (JALE_TEST_DATABASE_URL unset)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}

type Handler = (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;

const WORKER_POOL = `test-region-1_${randomBytes(5).toString('hex')}`;
const EMPLOYER_POOL = `test-region-1_${randomBytes(5).toString('hex')}`;
const issuer = (pool: string): string => `https://cognito-idp.test-region-1.example.invalid/${pool}`;
const KMS_KEY = 'test-report-images-key';
// Reserved test names, assembled at runtime.
const TEST_DOMAIN = ['example', 'invalid'].join('.');
const TEAM_RECIPIENT = ['report-team', TEST_DOMAIN].join('@');
const ADMIN_BASE_URL = ['https:', '', `dashboard.${TEST_DOMAIN}`].join('/');

/** A random documentation-range address (RFC 5737 TEST-NET-3), one per caller. */
const testAddress = (): string => ['203', '0', '113', String(1 + Math.floor(Math.random() * 254))].join('.');

interface Parsed {
  status: number;
  body: any;
}

function event(input: { method?: string; action: string; body?: unknown; claims?: Record<string, unknown>; address?: string }): APIGatewayProxyEvent {
  return {
    resource: '/reports/{action}',
    path: `/reports/${input.action}`,
    httpMethod: input.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      ...(input.address ? { 'x-jale-viewer-address': input.address } : {}),
    },
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: { action: input.action },
    stageVariables: null,
    body: input.body === undefined ? null : JSON.stringify(input.body),
    isBase64Encoded: false,
    requestContext: {
      requestId: `fixture-request-${randomUUID()}`,
      authorizer: input.claims ? { claims: input.claims } : undefined,
    },
  } as unknown as APIGatewayProxyEvent;
}

async function call(handler: Handler, input: Parameters<typeof event>[0]): Promise<Parsed> {
  const res = await handler(event(input));
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

const reportBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  client_key: randomUUID(),
  category: 'applying',
  description: 'Fixture words: the apply button does nothing.',
  stops_work: null,
  locale: 'es',
  include_technical: true,
  context: { v: 1, screen: { pattern: '/worker/jobs/:id', refs: {} }, capture: { outcome: 'ok', ms: 700 } },
  image: null,
  ...overrides,
});

describeInProfiles(['request', 'owner-unrestricted'], 'report-a-problem handlers on their real logins', () => {
  let su: Client;
  let world: World;
  let pools: { api: Pool; publicReports: Pool; cleanup: Pool };
  let salt: string;
  let out: ConsoleCapture;
  let storage: string[];

  const as = (pool: Pool): void => {
    mockPool = pool;
  };

  async function resetReports(): Promise<void> {
    await su.query('DELETE FROM public.problem_reports');
    await su.query('DELETE FROM public.problem_report_rate_buckets');
    await su.query("DELETE FROM public.email_outbox WHERE source_type = 'problem_report'");
    await su.query(
      `UPDATE public.problem_report_settings
          SET reporting_enabled = true, signed_out_enabled = true, screenshots_enabled = true,
              team_email_enabled = true, signed_out_daily_cap = 200, team_recipient = $1,
              admin_base_url = $2, updated_by_admin = NULL, updated_at = now()`,
      [TEAM_RECIPIENT, ADMIN_BASE_URL],
    );
  }

  /** Waits out the last seconds of the current UTC hour, so a limit test never straddles two windows. */
  async function awayFromHourBoundary(): Promise<void> {
    const { rows } = await su.query<{ left: number }>(
      `SELECT extract(epoch FROM date_trunc('hour', now(), 'UTC') + interval '1 hour' - now())::float8 AS left`,
    );
    if (rows[0].left < 15) await new Promise((resolve) => setTimeout(resolve, (rows[0].left + 1) * 1000));
  }

  const header = async (id: string) => (await su.query('SELECT * FROM public.problem_reports WHERE id = $1', [id])).rows[0];
  const contents = async (id: string) =>
    (await su.query('SELECT * FROM public.problem_report_contents WHERE report_id = $1', [id])).rows[0];
  const reportCount = async () => (await su.query<{ n: number }>('SELECT count(*)::int AS n FROM public.problem_reports')).rows[0].n;

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
    pools = {
      api: await createCheckedPool({ connectionString: loginUrl('jale_api'), max: 1 }, 'jale_api', 'test'),
      publicReports: await createCheckedPool(
        { connectionString: loginUrl('jale_api_public_reports'), max: 1 }, 'jale_api_public_reports', 'test'),
      cleanup: await createCheckedPool(
        { connectionString: loginUrl('jale_job_report_cleanup'), max: 1 }, 'jale_job_report_cleanup', 'test'),
    };
    process.env.WORKER_USER_POOL_ID = WORKER_POOL;
    process.env.EMPLOYER_USER_POOL_ID = EMPLOYER_POOL;
    process.env.REPORT_IMAGES_BUCKET = 'test-report-images';
    process.env.REPORT_IMAGES_KEY_ID = KMS_KEY;
    process.env.REPORT_ADDRESS_SALT_SECRET_ARN = 'test-address-salt-secret';
    process.env.ALLOWED_ORIGIN = 'https://app.example.invalid';
  });

  afterAll(async () => {
    await resetReports();
    await Promise.all([pools.api.end(), pools.publicReports.end(), pools.cleanup.end()]);
    mockPool = undefined;
    await su.end();
  });

  beforeEach(async () => {
    await resetReports();
    world = new World(databaseUrl!);
    await world.connect();
    clearAddressSaltCache();
    salt = randomBytes(24).toString('hex');
    mockSecretSend.mockReset();
    mockSecretSend.mockResolvedValue({ SecretString: salt });
    mockPresign.mockReset();
    mockPresign.mockImplementation(async (_s3: unknown, input: { Key: string }) => ({
      url: 'https://uploads.example.invalid/',
      fields: { key: input.Key },
    }));
    mockS3Send.mockReset();
    storage = [];
    out = captureConsole();
  });

  afterEach(async () => {
    out.restore();
    await world.cleanup();
    await world.end();
  });

  describe('signed in, on jale_api', () => {
    beforeEach(() => as(pools.api));

    it('saves a report for a worker with an account, queues the team email and returns a working token', async () => {
      const worker = await world.worker();
      const res = await call(signedIn, {
        action: 'create', body: reportBody(), claims: { sub: worker.sub, iss: issuer(WORKER_POOL) },
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ number: expect.stringMatching(/^JR-\d+$/), replayed: false, upload: null });

      expect(await header(res.body.report_id)).toMatchObject({ role: 'worker', verified: true, category: 'applying', has_image: false });
      expect(await contents(res.body.report_id)).toMatchObject({
        reporter_user_id: worker.id,
        reporter_sub: null,
        description: 'Fixture words: the apply button does nothing.',
        attach_token_hash: sha256(res.body.attach_token),
      });
      const mail = await su.query("SELECT source_id FROM public.email_outbox WHERE source_type = 'problem_report'");
      expect(mail.rows).toEqual([{ source_id: res.body.report_id }]);
      expect(Number(res.body.number.slice(3))).toBe(Number((await header(res.body.report_id)).report_number));
      expect(out.metrics()).toContainEqual({ name: 'ReportsCreated', value: 1, dimensions: { Role: 'worker', Verified: 'true' } });
    });

    it('saves a report for a sign-in with no account yet, with the role from the issuer', async () => {
      const sub = `fixture-sub-${randomUUID()}`;
      const res = await call(signedIn, {
        action: 'create',
        body: reportBody({ category: 'billing', stops_work: true }),
        claims: { sub, iss: issuer(EMPLOYER_POOL) },
      });
      expect(res.status).toBe(201);
      expect(await header(res.body.report_id)).toMatchObject({ role: 'employer', verified: true, stops_work: true });
      expect(await contents(res.body.report_id)).toMatchObject({ reporter_user_id: null, reporter_sub: sub });
    });

    it('lets the account decide the role when the issuer names no pool', async () => {
      const employer = await world.employer();
      const res = await call(signedIn, {
        action: 'create', body: reportBody({ category: 'job_posting' }), claims: { sub: employer.sub },
      });
      expect(res.status).toBe(201);
      expect(await header(res.body.report_id)).toMatchObject({ role: 'employer' });
    });

    it('answers 400 and saves nothing when neither the issuer nor an account names the role', async () => {
      const res = await call(signedIn, {
        action: 'create', body: reportBody(), claims: { sub: `fixture-sub-${randomUUID()}` },
      });
      expect(res).toEqual({ status: 400, body: { error: 'invalid_request' } });
      expect(await reportCount()).toBe(0);
      expect(out.metrics()).toContainEqual({ name: 'ReportRoleUnknown', value: 1, dimensions: {} });
      expect(out.metrics().filter((m) => m.name === 'ReportIntakeErrors')).toEqual([]);
    });

    it('replays a double send as the same report with a new token', async () => {
      const worker = await world.worker();
      const body = reportBody();
      const claims = { sub: worker.sub, iss: issuer(WORKER_POOL) };
      const first = await call(signedIn, { action: 'create', body, claims });
      const second = await call(signedIn, { action: 'create', body, claims });
      expect(second.status).toBe(201);
      expect(second.body).toMatchObject({ number: first.body.number, report_id: first.body.report_id, replayed: true });
      expect(second.body.attach_token).not.toBe(first.body.attach_token);
      expect((await contents(first.body.report_id)).attach_token_hash).toBe(sha256(second.body.attach_token));
      expect(await reportCount()).toBe(1);
    });

    it('refuses another reporter replaying the same key, and saves nothing new', async () => {
      const [a, b] = [await world.worker(), await world.worker()];
      const body = reportBody();
      await call(signedIn, { action: 'create', body, claims: { sub: a.sub, iss: issuer(WORKER_POOL) } });
      const res = await call(signedIn, { action: 'create', body, claims: { sub: b.sub, iss: issuer(WORKER_POOL) } });
      expect(res).toEqual({ status: 400, body: { error: 'invalid_request', fields: ['client_key'] } });
      expect(await reportCount()).toBe(1);
    });

    it('answers 201 with ReportEmailSkipped when no team mailbox is set, and none when the email is switched off', async () => {
      const worker = await world.worker();
      const claims = { sub: worker.sub, iss: issuer(WORKER_POOL) };
      await su.query('UPDATE public.problem_report_settings SET team_recipient = NULL');
      expect((await call(signedIn, { action: 'create', body: reportBody(), claims })).status).toBe(201);
      expect(out.metrics()).toContainEqual({ name: 'ReportEmailSkipped', value: 1, dimensions: {} });

      out.lines.length = 0;
      await su.query('UPDATE public.problem_report_settings SET team_email_enabled = false');
      expect((await call(signedIn, { action: 'create', body: reportBody(), claims })).status).toBe(201);
      expect(out.metrics().filter((m) => m.name === 'ReportEmailSkipped')).toEqual([]);
    });

    it('answers 503 while reporting is paused, and the refusal writes nothing', async () => {
      const worker = await world.worker();
      await su.query('UPDATE public.problem_report_settings SET reporting_enabled = false');
      const res = await call(signedIn, { action: 'create', body: reportBody(), claims: { sub: worker.sub, iss: issuer(WORKER_POOL) } });
      expect(res).toEqual({ status: 503, body: { error: 'reporting_paused' } });
      expect(await reportCount()).toBe(0);
    });
  });

  describe('signed out, on jale_api_public_reports', () => {
    beforeEach(() => as(pools.publicReports));

    const publicBody = (overrides: Record<string, unknown> = {}) =>
      reportBody({ category: 'sign_in', role_claimed: 'worker', contact: '  call after five  ', ...overrides });

    it('serves the effective switches', async () => {
      expect(await call(signedOut, { method: 'GET', action: 'config' }))
        .toEqual({ status: 200, body: { reporting: true, signed_out: true, screenshots: true } });
      await su.query('UPDATE public.problem_report_settings SET reporting_enabled = false');
      expect(await call(signedOut, { method: 'GET', action: 'config' }))
        .toEqual({ status: 200, body: { reporting: false, signed_out: false, screenshots: false } });
    });

    it('saves an unverified report with the typed contact and the hashed address', async () => {
      const address = testAddress();
      const res = await call(signedOut, { action: 'create', body: publicBody(), address });
      expect(res.status).toBe(201);
      expect(await header(res.body.report_id)).toMatchObject({ role: 'worker', verified: false });
      expect(await contents(res.body.report_id)).toMatchObject({
        reporter_user_id: null, reporter_sub: null, typed_contact: 'call after five',
      });
      const buckets = await su.query('SELECT window_kind, request_count FROM public.problem_report_rate_buckets WHERE address_hash = $1 ORDER BY window_kind',
        [hashVisitor(salt, address, 'reports')]);
      expect(buckets.rows).toEqual([{ window_kind: 'day', request_count: 1 }, { window_kind: 'hour', request_count: 1 }]);
    });

    it('limits an address to 5 an hour, and a refused attempt still counts', async () => {
      await awayFromHourBoundary();
      const address = testAddress();
      const hash = hashVisitor(salt, address, 'reports');
      for (let i = 0; i < 5; i += 1) {
        expect((await call(signedOut, { action: 'create', body: publicBody(), address })).status).toBe(201);
      }
      const refused = await call(signedOut, { action: 'create', body: publicBody(), address });
      expect(refused).toEqual({ status: 429, body: { error: 'rate_limited' } });
      expect(out.metrics()).toContainEqual({ name: 'ReportRateLimited', value: 1, dimensions: { Scope: 'address' } });
      await call(signedOut, { action: 'create', body: publicBody(), address });

      const buckets = await su.query<{ window_kind: string; request_count: number }>(
        'SELECT window_kind, request_count FROM public.problem_report_rate_buckets WHERE address_hash = $1 ORDER BY window_kind',
        [hash],
      );
      expect(buckets.rows).toEqual([{ window_kind: 'day', request_count: 7 }, { window_kind: 'hour', request_count: 7 }]);
      expect(await reportCount()).toBe(5);

      // Another address is not affected.
      let other = testAddress();
      while (other === address) other = testAddress();
      expect((await call(signedOut, { action: 'create', body: publicBody(), address: other })).status).toBe(201);
    });

    it('counts IPv6 viewers by their /64: addresses in one /64 share one limit', async () => {
      await awayFromHourBoundary();
      // A random /64 inside the documentation prefix (RFC 3849).
      const [a, b] = [randomBytes(2).toString('hex'), randomBytes(2).toString('hex')];
      const prefix = `2001:db8:${a}:${b}`;
      const key = `2001:db8:${parseInt(a, 16).toString(16)}:${parseInt(b, 16).toString(16)}::/64`;
      const hash = hashVisitor(salt, key, 'reports');
      const inPrefix = (i: number) => `${prefix}:${randomBytes(2).toString('hex')}:0:0:${(i + 1).toString(16)}`;

      for (let i = 0; i < 5; i += 1) {
        expect((await call(signedOut, { action: 'create', body: publicBody(), address: inPrefix(i) })).status).toBe(201);
      }
      expect(await call(signedOut, { action: 'create', body: publicBody(), address: inPrefix(5).toUpperCase() }))
        .toEqual({ status: 429, body: { error: 'rate_limited' } });

      const buckets = await su.query<{ window_kind: string; request_count: number }>(
        'SELECT window_kind, request_count FROM public.problem_report_rate_buckets WHERE address_hash = $1 ORDER BY window_kind',
        [hash],
      );
      expect(buckets.rows).toEqual([{ window_kind: 'day', request_count: 6 }, { window_kind: 'hour', request_count: 6 }]);
      expect((await su.query<{ n: number }>('SELECT count(*)::int AS n FROM public.problem_report_rate_buckets')).rows[0].n).toBe(2);

      // The neighbouring /64 has its own limit.
      const neighbour = `2001:db8:${a}:${((parseInt(b, 16) + 1) % 0x10000).toString(16)}::1`;
      expect((await call(signedOut, { action: 'create', body: publicBody(), address: neighbour })).status).toBe(201);
    });

    it('answers 429 with Scope=global once the daily cap is reached', async () => {
      await su.query('UPDATE public.problem_report_settings SET signed_out_daily_cap = 0');
      const res = await call(signedOut, { action: 'create', body: publicBody(), address: testAddress() });
      expect(res).toEqual({ status: 429, body: { error: 'rate_limited' } });
      expect(out.metrics()).toContainEqual({ name: 'ReportRateLimited', value: 1, dimensions: { Scope: 'global' } });
    });

    it('answers 503 signed_out_paused, and 400 without the viewer address', async () => {
      expect((await call(signedOut, { action: 'create', body: publicBody() })).status).toBe(400);
      await su.query('UPDATE public.problem_report_settings SET signed_out_enabled = false');
      expect(await call(signedOut, { action: 'create', body: publicBody(), address: testAddress() }))
        .toEqual({ status: 503, body: { error: 'signed_out_paused' } });
      expect(await reportCount()).toBe(0);
    });
  });

  describe('upload and attach', () => {
    const imageBody = { image: { content_type: 'image/png', byte_size: 4096 } };

    function storageFor() {
      return answerS3(mockS3Send, storage, {
        head: { ContentLength: 4096, ContentType: 'image/png', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: KMS_KEY, ETag: '"fixture-etag"' },
        range: PNG_BYTES,
      });
    }

    it('issues the upload with the report, then pins and records the image', async () => {
      as(pools.publicReports);
      const created = await call(signedOut, {
        action: 'create', body: reportBody({ category: 'uploads', role_claimed: 'unknown', contact: null, ...imageBody }), address: testAddress(),
      });
      expect(created.status).toBe(201);
      const pendingKey: string = created.body.upload.fields.key;
      expect(pendingKey).toMatch(/^incoming\/[0-9a-f-]{36}$/);
      expect(await contents(created.body.report_id)).toMatchObject({ pending_upload_key: pendingKey, pending_content_type: 'image/png' });

      const calls = storageFor();
      const attached = await call(signedOut, {
        action: 'attach', body: { report_id: created.body.report_id, attach_token: created.body.attach_token },
      });
      expect(attached).toEqual({ status: 200, body: { attached: true } });
      const finalKey = `images/${created.body.report_id}/${pendingKey.slice('incoming/'.length)}.png`;
      expect(calls.find((c) => c.command === 'CopyObjectCommand')?.input.Key).toBe(finalKey);
      expect(await contents(created.body.report_id)).toMatchObject({ image_key: finalKey, pending_upload_key: null });
      expect(await header(created.body.report_id)).toMatchObject({ has_image: true });

      // A retry of the same attach is told it already landed, and touches no storage.
      storage.length = 0;
      const retry = await call(signedOut, {
        action: 'attach', body: { report_id: created.body.report_id, attach_token: created.body.attach_token },
      });
      expect(retry).toEqual({ status: 409, body: { error: 'already_attached' } });
      expect(storage).toEqual([]);
    });

    it("accepts a signed-in report's token on the public upload and attach routes", async () => {
      as(pools.api);
      const worker = await world.worker();
      const created = await call(signedIn, {
        action: 'create', body: reportBody(), claims: { sub: worker.sub, iss: issuer(WORKER_POOL) },
      });
      expect(created.status).toBe(201);

      as(pools.publicReports);
      const uploaded = await call(signedOut, {
        action: 'upload', body: { report_id: created.body.report_id, attach_token: created.body.attach_token, ...imageBody },
      });
      expect(uploaded.status).toBe(200);
      storageFor();
      const attached = await call(signedOut, {
        action: 'attach', body: { report_id: created.body.report_id, attach_token: created.body.attach_token },
      });
      expect(attached).toEqual({ status: 200, body: { attached: true } });
      expect(await header(created.body.report_id)).toMatchObject({ verified: true, has_image: true });
    });

    it('answers 404 for another report, and a wrong token reads the same as an unknown report', async () => {
      as(pools.api);
      const worker = await world.worker();
      const created = await call(signedIn, {
        action: 'create', body: reportBody(), claims: { sub: worker.sub, iss: issuer(WORKER_POOL) },
      });
      const wrongToken = randomBytes(32).toString('base64url');
      for (const body of [
        { report_id: created.body.report_id, attach_token: wrongToken, ...imageBody },
        { report_id: randomUUID(), attach_token: created.body.attach_token, ...imageBody },
      ]) {
        expect(await call(signedIn, { action: 'upload', body, claims: { sub: worker.sub } }))
          .toEqual({ status: 404, body: { error: 'not_found' } });
      }
      expect((await contents(created.body.report_id)).pending_upload_key).toBeNull();
    });

    it('rejects content that is not the declared type, deletes the upload and records nothing', async () => {
      as(pools.publicReports);
      const created = await call(signedOut, {
        action: 'create', body: reportBody({ category: 'uploads', role_claimed: 'worker', contact: null, ...imageBody }), address: testAddress(),
      });
      const pendingKey: string = created.body.upload.fields.key;
      const calls = answerS3(mockS3Send, storage, {
        head: { ContentLength: 4096, ContentType: 'image/png', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: KMS_KEY, ETag: '"e"' },
        range: Array.from(Buffer.from('<svg xmlns="http')),
      });
      const res = await call(signedOut, {
        action: 'attach', body: { report_id: created.body.report_id, attach_token: created.body.attach_token },
      });
      expect(res).toEqual({ status: 422, body: { error: 'invalid_image' } });
      expect(calls.filter((c) => c.command === 'DeleteObjectCommand').map((c) => c.input.Key)).toEqual([pendingKey]);
      expect(await contents(created.body.report_id)).toMatchObject({ image_key: null, pending_upload_key: pendingKey });
    });
  });

  describe('clean-up, on jale_job_report_cleanup', () => {
    async function seedOld(age: string, opts: { image?: boolean; pendingIssued?: string }): Promise<{ id: string; imageKey: string | null; pendingKey: string | null }> {
      const id = randomUUID();
      const imageKey = opts.image ? `images/${id}/${randomUUID()}.png` : null;
      const pendingKey = opts.pendingIssued ? `incoming/${randomUUID()}` : null;
      await su.query(
        `WITH h AS (
           INSERT INTO public.problem_reports (id, client_key, role, verified, category, locale, include_technical, has_image, created_at, updated_at)
           VALUES ($1, $2, 'worker', false, 'other', 'en', true, $3, now() - $4::interval, now() - $4::interval)
           RETURNING id, created_at)
         INSERT INTO public.problem_report_contents
           (report_id, created_at, description, context, image_key, pending_upload_key, pending_content_type, upload_issued_at)
         SELECT h.id, h.created_at, 'Fixture words.', '{"v":1}'::jsonb, $5, $6::text,
                CASE WHEN $6::text IS NULL THEN NULL ELSE 'image/png' END, now() - $7::interval
           FROM h`,
        [id, randomUUID(), imageKey !== null, age, imageKey, pendingKey, opts.pendingIssued ?? null],
      );
      return { id, imageKey, pendingKey };
    }

    it('deletes exactly the keys SQL returns, after the commit, and reports the run', async () => {
      as(pools.cleanup);
      const oldImage = await seedOld('91 days', { image: true });
      const freshImage = await seedOld('10 days', { image: true });
      const stalePending = await seedOld('3 days', { pendingIssued: '2 days' });
      const oldContent = await seedOld('13 months', {});
      const calls = answerS3(mockS3Send, storage, {});

      await cleanup();

      const deleted = calls.flatMap((c) => c.input.Delete.Objects.map((o: { Key: string }) => o.Key));
      expect(deleted).toEqual([oldImage.imageKey, stalePending.pendingKey]);
      expect(await contents(oldImage.id)).toMatchObject({ image_key: null });
      expect((await header(oldImage.id)).image_deleted_at).not.toBeNull();
      expect(await contents(freshImage.id)).toMatchObject({ image_key: freshImage.imageKey });
      expect(await contents(stalePending.id)).toMatchObject({ pending_upload_key: null });
      expect(await contents(oldContent.id)).toBeUndefined();
      expect((await header(oldContent.id)).content_erased_at).not.toBeNull();

      expect(out.metrics()).toEqual(expect.arrayContaining([
        { name: 'ReportCleanupDeleted', value: 1, dimensions: { Kind: 'images_expired' } },
        { name: 'ReportCleanupDeleted', value: 1, dimensions: { Kind: 'pending_cleared' } },
        { name: 'ReportCleanupDeleted', value: 1, dimensions: { Kind: 'contents_erased' } },
      ]));
      expect(out.metrics()).toContainEqual({ name: 'ReportCleanupDeleted', value: 3, dimensions: {} });

      // A second run finds nothing and deletes nothing, and still reports a zero run.
      out.lines.length = 0;
      calls.length = 0;
      await cleanup();
      expect(calls).toEqual([]);
      expect(out.metrics()).toContainEqual({ name: 'ReportCleanupDeleted', value: 0, dimensions: {} });
    });
  });
});
