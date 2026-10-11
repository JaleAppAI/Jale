import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { handler } from '../../../../lambda/reports/intake';
import {
  captureConsole,
  createdRow,
  fakeDb,
  parse,
  refusedRow,
  reportEvent,
  sha256,
  storingLikePostgres,
  type ConsoleCapture,
  type FakeDb,
} from './harness';

jest.mock('../../../../lambda/lib/db', () => ({ getDbPool: jest.fn(), setRlsContext: jest.fn() }));
jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  return { ...actual, S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })) };
});
jest.mock('@aws-sdk/s3-presigned-post', () => ({ createPresignedPost: jest.fn() }));

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRls = setRlsContext as jest.Mock;
const mockPresign = createPresignedPost as jest.Mock;

const WORKER_POOL = `test-region-1_${randomBytes(5).toString('hex')}`;
const EMPLOYER_POOL = `test-region-1_${randomBytes(5).toString('hex')}`;
const issuer = (pool: string) => `https://cognito-idp.test-region-1.example.invalid/${pool}`;
const DESCRIPTION = 'Fixture words: the apply button does nothing.';

let timeline: string[];
let db: FakeDb;
let out: ConsoleCapture;
let sub: string;

const claims = (pool: string | null = WORKER_POOL): Record<string, unknown> =>
  pool === null ? { sub } : { sub, iss: issuer(pool), token_use: 'id' };

const body = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  client_key: randomUUID(),
  category: 'applying',
  description: `  ${DESCRIPTION}  `,
  stops_work: null,
  locale: 'es',
  include_technical: true,
  context: {
    v: 1,
    screen: { pattern: '/worker/jobs/:id', refs: {} },
    app: { build: 'abcdef123456', locale: 'es', theme: 'dark' },
    capture: { outcome: 'ok', ms: 820 },
  },
  image: null,
  ...overrides,
});

async function create(overrides: Record<string, unknown> = {}, pool: string | null = WORKER_POOL) {
  return parse(await handler(reportEvent({ action: 'create', body: body(overrides), claims: claims(pool) })));
}

beforeEach(() => {
  jest.clearAllMocks();
  timeline = [];
  db = fakeDb(timeline);
  sub = `fixture-sub-${randomUUID()}`;
  mockGetDbPool.mockResolvedValue(db.pool);
  mockSetRls.mockImplementation(async (_client: unknown, value: string) => {
    timeline.push(`RLS:${value}`);
  });
  mockPresign.mockImplementation(async (_s3: unknown, input: { Key: string }) => {
    timeline.push('PRESIGN');
    return { url: 'https://uploads.example.invalid/', fields: { key: input.Key, Policy: 'fixture-policy' } };
  });
  process.env.REPORT_IMAGES_BUCKET = 'test-report-images';
  process.env.REPORT_IMAGES_KEY_ID = 'test-report-images-key';
  process.env.WORKER_USER_POOL_ID = WORKER_POOL;
  process.env.EMPLOYER_USER_POOL_ID = EMPLOYER_POOL;
  process.env.ALLOWED_ORIGIN = 'https://app.example.invalid';
  out = captureConsole();
});

afterEach(() => {
  out.restore();
});

describe('POST /reports/create (signed in)', () => {
  it('creates the report in one transaction under the caller and answers 201 with a one-time token', async () => {
    const row = createdRow();
    db.answers.problem_report_create_verified = row;
    const key = randomUUID();
    const res = await create({ client_key: key });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      number: 'JR-1042',
      report_id: row[0].report_id,
      attach_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      upload: null,
      replayed: false,
    });
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://app.example.invalid');
    expect(timeline).toEqual(['CONNECT', 'BEGIN', `RLS:${sub}`, 'problem_report_create_verified', 'COMMIT', 'RELEASE']);

    const [args] = db.calls.problem_report_create_verified;
    expect(args).toEqual([
      key, 'worker', 'applying', DESCRIPTION, null, 'es', true, expect.any(String), sha256(res.body.attach_token),
    ]);
    expect(JSON.parse(args[7] as string)).toEqual({
      v: 1,
      screen: { pattern: '/worker/jobs/:id', refs: {} },
      app: { build: 'abcdef123456', locale: 'es', theme: 'dark' },
      capture: { outcome: 'ok', ms: 820 },
    });
  });

  it('emits ReportsCreated with no dimensions and by role and verified, plus the capture outcome', async () => {
    db.answers.problem_report_create_verified = createdRow();
    await create();
    expect(out.metrics()).toEqual(expect.arrayContaining([
      { name: 'ReportsCreated', value: 1, dimensions: {} },
      { name: 'ReportsCreated', value: 1, dimensions: { Role: 'worker', Verified: 'true' } },
      { name: 'ReportCapture', value: 1, dimensions: { Outcome: 'ok' } },
    ]));
    expect(out.metrics().filter((m) => m.name === 'ReportEmailSkipped')).toHaveLength(0);
  });

  it('derives the role from the issuer: employer, and unknown when the claim is missing', async () => {
    db.answers.problem_report_create_verified = createdRow();
    await create({ category: 'billing', stops_work: true }, EMPLOYER_POOL);
    expect(db.calls.problem_report_create_verified[0].slice(1, 3)).toEqual(['employer', 'billing']);
    expect(db.calls.problem_report_create_verified[0][4]).toBe(true);

    await create({ category: 'billing' }, null);
    expect(db.calls.problem_report_create_verified[1][1]).toBe('unknown');
  });

  it('never takes the role from the body', async () => {
    db.answers.problem_report_create_verified = createdRow();
    await create({ role_claimed: 'employer', role: 'employer' });
    expect(db.calls.problem_report_create_verified[0][1]).toBe('worker');
  });

  it('issues the upload in the same transaction and signs it only after the commit', async () => {
    const row = createdRow();
    const uploadKey = `incoming/${randomUUID()}`;
    db.answers.problem_report_create_verified = row;
    db.answers.problem_report_upload_grant = [{ outcome: 'ok', upload_key: uploadKey }];
    const res = await create({ image: { content_type: 'image/png', byte_size: 2048 } });

    expect(res.status).toBe(201);
    expect(timeline).toEqual([
      'CONNECT', 'BEGIN', `RLS:${sub}`, 'problem_report_create_verified', 'problem_report_upload_grant', 'COMMIT',
      'RELEASE', 'PRESIGN',
    ]);
    expect(db.calls.problem_report_upload_grant[0]).toEqual([row[0].report_id, sha256(res.body.attach_token), 'image/png']);
    expect(res.body.upload).toEqual({
      url: 'https://uploads.example.invalid/',
      fields: { key: uploadKey, Policy: 'fixture-policy' },
      expires_at: expect.any(String),
    });
    expect(mockPresign.mock.calls[0][1]).toMatchObject({ Bucket: 'test-report-images', Key: uploadKey, Expires: 600 });
  });

  it('answers 201 with no upload when screenshots are paused: the report is saved', async () => {
    db.answers.problem_report_create_verified = createdRow();
    db.answers.problem_report_upload_grant = [{ outcome: 'screenshots_paused', upload_key: null }];
    const res = await create({ image: { content_type: 'image/png', byte_size: 2048 } });
    expect(res.status).toBe(201);
    expect(res.body.upload).toBeNull();
    expect(mockPresign).not.toHaveBeenCalled();
  });

  it('answers 201 with no upload when signing fails after the commit, and counts it as an intake error', async () => {
    db.answers.problem_report_create_verified = createdRow();
    db.answers.problem_report_upload_grant = [{ outcome: 'ok', upload_key: `incoming/${randomUUID()}` }];
    mockPresign.mockRejectedValueOnce(new Error('CredentialsProviderError'));
    const res = await create({ image: { content_type: 'image/png', byte_size: 2048 } });
    expect(res.status).toBe(201);
    expect(res.body.upload).toBeNull();
    expect(out.metrics()).toContainEqual({ name: 'ReportIntakeErrors', value: 1, dimensions: {} });
  });

  it('answers a replay with the same number and a fresh token, counting no new report', async () => {
    const row = createdRow({ replayed: true, email_queued: null });
    db.answers.problem_report_create_verified = row;
    const res = await create();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ number: 'JR-1042', report_id: row[0].report_id, replayed: true });
    expect(out.metrics().filter((m) => m.name === 'ReportsCreated' || m.name === 'ReportCapture')).toEqual([]);
  });

  it('emits ReportEmailSkipped only when no email was queued with the switch on', async () => {
    db.answers.problem_report_create_verified = createdRow({ email_queued: false });
    await create();
    expect(out.metrics()).toContainEqual({ name: 'ReportEmailSkipped', value: 1, dimensions: {} });

    out.lines.length = 0;
    db.answers.problem_report_create_verified = createdRow({ email_queued: null });
    await create();
    expect(out.metrics().filter((m) => m.name === 'ReportEmailSkipped')).toEqual([]);
  });

  it.each<[string, number, Record<string, unknown>]>([
    ['reporting_paused', 503, { error: 'reporting_paused' }],
    ['rate_limited', 429, { error: 'rate_limited' }],
    ['invalid_category', 400, { error: 'invalid_request', fields: ['category'] }],
    ['invalid_request', 400, { error: 'invalid_request', fields: ['client_key'] }],
    ['role_unknown', 400, { error: 'invalid_request' }],
  ])('maps %s to %i, and commits the refusal', async (outcome, status, expected) => {
    db.answers.problem_report_create_verified = refusedRow(outcome);
    const res = await create({ image: { content_type: 'image/png', byte_size: 2048 } });
    expect(res.status).toBe(status);
    expect(res.body).toEqual(expected);
    expect(timeline).toContain('COMMIT');
    expect(timeline).not.toContain('ROLLBACK');
    expect(timeline).not.toContain('problem_report_upload_grant');
    expect(out.metrics().filter((m) => m.name === 'ReportsCreated')).toEqual([]);
  });

  it('counts a rate limit against the account', async () => {
    db.answers.problem_report_create_verified = refusedRow('rate_limited');
    await create();
    expect(out.metrics()).toContainEqual({ name: 'ReportRateLimited', value: 1, dimensions: { Scope: 'account' } });
  });

  it('makes an unknown role visible with ReportRoleUnknown, without a 500', async () => {
    db.answers.problem_report_create_verified = refusedRow('role_unknown');
    const res = await create({}, null);
    expect(res.status).toBe(400);
    expect(out.metrics()).toContainEqual({ name: 'ReportRoleUnknown', value: 1, dimensions: {} });
    expect(out.metrics().filter((m) => m.name === 'ReportIntakeErrors')).toEqual([]);
  });

  it('rolls back and answers 500 on a database error, counting an intake error', async () => {
    const err = Object.assign(new Error('problem_report_create_verified: malformed argument'), { code: '22023' });
    db.answers.problem_report_create_verified = err;
    const res = await create();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal' });
    expect(timeline).toEqual(['CONNECT', 'BEGIN', `RLS:${sub}`, 'problem_report_create_verified', 'ROLLBACK', 'RELEASE']);
    expect(out.metrics()).toContainEqual({ name: 'ReportIntakeErrors', value: 1, dimensions: {} });
  });

  it('rolls back on an unexpected outcome code', async () => {
    db.answers.problem_report_create_verified = refusedRow('something_new');
    const res = await create();
    expect(res.status).toBe(500);
    expect(timeline).toContain('ROLLBACK');
  });

  it('answers 500, never 401, when the authorizer passed no caller', async () => {
    const res = parse(await handler(reportEvent({ action: 'create', body: body(), claims: null })));
    expect(res.status).toBe(500);
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  it('validates before the database: 400 with field names, 413 over 64 KB', async () => {
    const invalid = await create({ client_key: 'nope', locale: 'fr' });
    expect(invalid).toMatchObject({ status: 400, body: { error: 'invalid_request', fields: ['client_key', 'locale'] } });

    const big = parse(await handler(reportEvent({
      action: 'create',
      rawBody: JSON.stringify(body({ description: 'x'.repeat(70 * 1024) })),
      claims: claims(),
    })));
    expect(big).toMatchObject({ status: 413, body: { error: 'payload_too_large' } });

    const notJson = parse(await handler(reportEvent({ action: 'create', rawBody: '{', claims: claims() })));
    expect(notJson).toMatchObject({ status: 400, body: { error: 'invalid_request', fields: ['body'] } });
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  it('reduces a malformed context field and never refuses the report for it', async () => {
    db.answers.problem_report_create_verified = createdRow();
    const res = await create({
      context: {
        v: 1,
        errors: [{ k: 'error', msg: `${'m'.repeat(500)}`, at: '2026-10-05T10:00:00Z' }],
        requests: [{ m: 'GET', p: '/x', s: 200, ms: 1, rid: 'not a request id!' }],
        device: { browser: 'Some Future Browser' },
      },
    });
    expect(res.status).toBe(201);
    const context = JSON.parse(db.calls.problem_report_create_verified[0][7] as string);
    expect(context.errors[0].msg).toHaveLength(200);
    expect(context.requests[0]).toEqual({ m: 'GET', p: '/x', s: 200, ms: 1 });
    expect(context.device).toEqual({ browser: 'Some Future Browser' });
  });
});

describe('text the database cannot store (signed in)', () => {
  const NUL = String.fromCharCode(0);
  const LONE = String.fromCharCode(0xdc00);

  it.each<[string, string]>([
    ['a NUL', `${DESCRIPTION}${NUL}`],
    ['half a surrogate pair', `${LONE}${DESCRIPTION}`],
  ])('answers 400 for %s in the description, before any database call', async (_label, description) => {
    db.answers.problem_report_create_verified = storingLikePostgres(createdRow());
    const res = await create({ description });
    expect(res).toMatchObject({ status: 400, body: { error: 'invalid_request', fields: ['description'] } });
    expect(db.pool.connect).not.toHaveBeenCalled();
    expect(out.metrics().filter((m) => m.name === 'ReportIntakeErrors')).toEqual([]);
  });

  it('saves the report when only the context carries such text, cleaned', async () => {
    db.answers.problem_report_create_verified = storingLikePostgres(createdRow());
    const res = await create({
      context: { v: 1, requests: [{ m: 'GET', p: `/x${NUL}`, s: 500, ms: 1 }], errors: [{ k: 'error', msg: `a${LONE}b${NUL}`, at: '2026-10-05T10:00:00Z' }] },
    });
    expect(res.status).toBe(201);
    const context = JSON.parse(db.calls.problem_report_create_verified[0][7] as string);
    expect(context).toMatchObject({ requests: [{ p: '/x' }], errors: [{ msg: 'a\uFFFDb' }] });
    expect(out.metrics().filter((m) => m.name === 'ReportIntakeErrors')).toEqual([]);
  });
});

describe('routing and logging (signed in)', () => {
  it('answers 404 for an unknown action or method, with CORS headers', async () => {
    for (const event of [
      reportEvent({ action: 'config', method: 'GET', claims: claims() }),
      reportEvent({ action: 'delete', body: {}, claims: claims() }),
      reportEvent({ action: '__proto__', body: {}, claims: claims() }),
      reportEvent({ action: 'create', method: 'GET', claims: claims() }),
    ]) {
      const res = parse(await handler(event));
      expect(res).toMatchObject({ status: 404, body: { error: 'not_found' } });
      expect(res.headers['Access-Control-Allow-Origin']).toBe('https://app.example.invalid');
    }
  });

  it('logs one line per request with the tag, action, outcome and request id, and never the body', async () => {
    db.answers.problem_report_create_verified = createdRow();
    const event = reportEvent({ action: 'create', body: body(), claims: claims() });
    const res = parse(await handler(event));
    expect(out.logs).toEqual([{
      tag: 'report_intake',
      action: 'create',
      outcome: 'ok',
      requestId: event.requestContext.requestId,
    }]);
    const everything = out.lines.join('\n');
    expect(everything).not.toContain('Fixture words');
    expect(everything).not.toContain(res.body.attach_token);
    expect(everything).not.toContain(sha256(res.body.attach_token));
    expect(everything).not.toContain(sub);
    expect(everything).not.toContain('/worker/jobs/:id');
  });

  it('logs the error code only, never its message, on a 500', async () => {
    db.answers.problem_report_create_verified = new Error(`value ${DESCRIPTION}`);
    await create();
    expect(out.logs).toHaveLength(1);
    expect(out.logs[0]).toMatchObject({ tag: 'report_intake', action: 'create', outcome: 'internal' });
    expect(out.lines.join('\n')).not.toContain('Fixture words');
  });

  it('logs with no request id when the event carries none', async () => {
    db.answers.problem_report_create_verified = createdRow();
    const event = reportEvent({ action: 'create', body: body(), claims: claims() });
    (event as unknown as { requestContext: Record<string, unknown> }).requestContext = { authorizer: { claims: claims() } };
    expect(parse(await handler(event)).status).toBe(201);
    expect(out.logs[0]).toMatchObject({ outcome: 'ok' });
  });
});

describe('the signed-in intake source', () => {
  const sources = ['intake.ts', 'lib/actions.ts'].map((file) =>
    fs.readFileSync(path.join(__dirname, '../../../../lambda/reports', file), 'utf8'));

  it('never checks compliance and never answers 401, 403 or 409 user_not_provisioned', () => {
    for (const source of sources) {
      expect(source).not.toMatch(/checkCompliance|legal_required|user_not_provisioned/);
      expect(source).not.toMatch(/\b40[13]\b/);
    }
  });
});
