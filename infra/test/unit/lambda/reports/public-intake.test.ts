import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { hashVisitor } from '../../../../lambda/lib/referral-codes';
import { clearAddressSaltCache } from '../../../../lambda/reports/lib/address';
import { handler } from '../../../../lambda/reports/public-intake';
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
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  GetSecretValueCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRls = setRlsContext as jest.Mock;
const mockPresign = createPresignedPost as jest.Mock;
const mockSecretSend = (SecretsManagerClient as jest.Mock).mock.results[0].value.send as jest.Mock;

// Documentation range (RFC 5737), assembled at runtime.
const ADDRESS = ['198', '51', '100', '7'].join('.');
const CONTACT = ['reporter', ['example', 'invalid'].join('.')].join('@');
const DESCRIPTION = 'Fixture words: the code never arrived.';

let timeline: string[];
let db: FakeDb;
let out: ConsoleCapture;
let salt: string;

const body = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  client_key: randomUUID(),
  category: 'sign_in',
  description: DESCRIPTION,
  stops_work: null,
  locale: 'en',
  include_technical: false,
  context: { v: 1, screen: { pattern: '/auth/worker', refs: {} }, capture: { outcome: 'failed', ms: 3000 } },
  image: null,
  role_claimed: 'worker',
  contact: `  ${CONTACT} `,
  ...overrides,
});

const viewer = { 'X-Jale-Viewer-Address': ADDRESS };

async function create(overrides: Record<string, unknown> = {}, headers: Record<string, string> = viewer) {
  return parse(await handler(reportEvent({ action: 'create', body: body(overrides), headers })));
}

beforeEach(() => {
  jest.clearAllMocks();
  clearAddressSaltCache();
  timeline = [];
  db = fakeDb(timeline);
  salt = randomBytes(24).toString('hex');
  mockGetDbPool.mockResolvedValue(db.pool);
  mockSecretSend.mockImplementation(async () => {
    timeline.push('SALT');
    return { SecretString: salt };
  });
  mockPresign.mockImplementation(async (_s3: unknown, input: { Key: string }) => {
    timeline.push('PRESIGN');
    return { url: 'https://uploads.example.invalid/', fields: { key: input.Key } };
  });
  process.env.REPORT_IMAGES_BUCKET = 'test-report-images';
  process.env.REPORT_IMAGES_KEY_ID = 'test-report-images-key';
  process.env.REPORT_ADDRESS_SALT_SECRET_ARN = 'test-address-salt-secret';
  process.env.ALLOWED_ORIGIN = 'https://app.example.invalid';
  out = captureConsole();
});

afterEach(() => {
  out.restore();
});

describe('GET /public/reports/config', () => {
  it('answers the effective switches with a one-minute public cache', async () => {
    db.answers.problem_report_config = [{ reporting: true, signed_out: false, screenshots: true }];
    const res = parse(await handler(reportEvent({ action: 'config', method: 'GET' })));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reporting: true, signed_out: false, screenshots: true });
    expect(res.headers['Cache-Control']).toBe('public, max-age=60');
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://app.example.invalid');
    expect(timeline).toEqual(['CONNECT', 'problem_report_config', 'RELEASE']);
  });

  it('answers 500, uncached, when the switches cannot be read', async () => {
    db.answers.problem_report_config = new Error('connection reset');
    const res = parse(await handler(reportEvent({ action: 'config', method: 'GET' })));
    expect(res).toMatchObject({ status: 500, body: { error: 'internal' } });
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(out.metrics()).toContainEqual({ name: 'ReportIntakeErrors', value: 1, dimensions: {} });
  });

  it('answers 404 to a POST on config and a GET on create', async () => {
    expect(parse(await handler(reportEvent({ action: 'config', body: {} }))).status).toBe(404);
    expect(parse(await handler(reportEvent({ action: 'create', method: 'GET' }))).status).toBe(404);
  });
});

describe('POST /public/reports/create (signed out)', () => {
  it('hashes the viewer address with the salt read before the transaction, and creates the report unverified', async () => {
    const row = createdRow();
    db.answers.problem_report_create_unverified = row;
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
    expect(timeline).toEqual(['SALT', 'CONNECT', 'BEGIN', 'problem_report_create_unverified', 'COMMIT', 'RELEASE']);
    expect(mockSetRls).not.toHaveBeenCalled();
    const [args] = db.calls.problem_report_create_unverified;
    expect(args).toEqual([
      key, 'worker', 'sign_in', DESCRIPTION, null, 'en', CONTACT, false, expect.any(String),
      sha256(res.body.attach_token), hashVisitor(salt, ADDRESS, 'reports'),
    ]);
    // Technical details off: only the screen pattern (and the build and locale) survive.
    expect(JSON.parse(args[8] as string)).toEqual({ v: 1, screen: { pattern: '/auth/worker' } });
  });

  it('emits ReportsCreated unverified with the claimed role, and no capture outcome when technical details are off', async () => {
    db.answers.problem_report_create_unverified = createdRow();
    await create({ role_claimed: 'unknown', category: 'uploads' });
    expect(out.metrics()).toEqual(expect.arrayContaining([
      { name: 'ReportsCreated', value: 1, dimensions: {} },
      { name: 'ReportsCreated', value: 1, dimensions: { Role: 'unknown', Verified: 'false' } },
    ]));
    expect(out.metrics().filter((m) => m.name === 'ReportCapture')).toEqual([]);
  });

  it('issues and signs an upload for a declared image', async () => {
    db.answers.problem_report_create_unverified = createdRow();
    db.answers.problem_report_upload_grant = [{ outcome: 'ok', upload_key: `incoming/${randomUUID()}` }];
    const res = await create({ image: { content_type: 'image/jpeg', byte_size: 1000 } });
    expect(res.status).toBe(201);
    expect(res.body.upload).toMatchObject({ url: 'https://uploads.example.invalid/' });
    expect(timeline.slice(-3)).toEqual(['COMMIT', 'RELEASE', 'PRESIGN']);
  });

  it('refuses a request without the viewer-address header with 400, before any secret or database call', async () => {
    for (const headers of [{}, { 'X-Jale-Viewer-Address': 'not-an-address' }] as Array<Record<string, string>>) {
      const res = await create({}, headers);
      expect(res).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
      expect(JSON.stringify(res.body)).not.toMatch(/viewer|address/i);
    }
    expect(mockSecretSend).not.toHaveBeenCalled();
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  it('hashes an IPv6 viewer by its /64, so two addresses in one /64 share a limit', async () => {
    db.answers.problem_report_create_unverified = createdRow();
    await create({}, { 'x-jale-viewer-address': '2001:db8:aa:bb::1' });
    await create({}, { 'x-jale-viewer-address': '2001:DB8:AA:BB:ffff:0:0:2' });
    const hashes = db.calls.problem_report_create_unverified.map((args) => args[10]);
    expect(hashes).toEqual([hashVisitor(salt, '2001:db8:aa:bb::/64', 'reports'), hashVisitor(salt, '2001:db8:aa:bb::/64', 'reports')]);
    expect(out.lines.join('\n')).not.toContain('2001:db8');
  });

  it('never reads X-Forwarded-For', async () => {
    const res = await create({}, { 'X-Forwarded-For': ADDRESS });
    expect(res.status).toBe(400);
  });

  it('fails closed with 500 when the salt cannot be read, and never touches the database', async () => {
    mockSecretSend.mockRejectedValue(new Error('AccessDeniedException'));
    const res = await create();
    expect(res).toMatchObject({ status: 500, body: { error: 'internal' } });
    expect(db.pool.connect).not.toHaveBeenCalled();
    expect(out.metrics()).toContainEqual({ name: 'ReportIntakeErrors', value: 1, dimensions: {} });
  });

  it.each<[string, number, Record<string, unknown>, string | undefined]>([
    ['reporting_paused', 503, { error: 'reporting_paused' }, undefined],
    ['signed_out_paused', 503, { error: 'signed_out_paused' }, undefined],
    ['rate_limited', 429, { error: 'rate_limited' }, 'address'],
    ['rate_limited_global', 429, { error: 'rate_limited' }, 'global'],
    ['invalid_category', 400, { error: 'invalid_request', fields: ['category'] }, undefined],
    ['invalid_request', 400, { error: 'invalid_request', fields: ['client_key'] }, undefined],
  ])('maps %s to %i and commits it, so a refused attempt still counts', async (outcome, status, expected, scope) => {
    db.answers.problem_report_create_unverified = refusedRow(outcome);
    const res = await create();
    expect(res.status).toBe(status);
    expect(res.body).toEqual(expected);
    expect(timeline).toContain('COMMIT');
    expect(timeline).not.toContain('ROLLBACK');
    const limited = out.metrics().filter((m) => m.name === 'ReportRateLimited');
    expect(limited).toEqual(scope ? [{ name: 'ReportRateLimited', value: 1, dimensions: { Scope: scope } }] : []);
  });

  it('validates the public fields', async () => {
    expect(await create({ role_claimed: 'admin' })).toMatchObject({ status: 400, body: { fields: ['role_claimed'] } });
    expect(await create({ contact: 'c'.repeat(201) })).toMatchObject({ status: 400, body: { fields: ['contact'] } });
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  it('logs one line per request and never the words, contact, address, hash or token', async () => {
    db.answers.problem_report_create_unverified = createdRow();
    const res = await create();
    expect(out.logs).toEqual([{ tag: 'report_public_intake', action: 'create', outcome: 'ok', requestId: expect.any(String) }]);
    const everything = out.lines.join('\n');
    for (const secretish of [
      'Fixture words', CONTACT, ADDRESS, salt, hashVisitor(salt, ADDRESS, 'reports'), res.body.attach_token,
    ]) {
      expect(everything).not.toContain(secretish);
    }
  });
});

describe('text the database cannot store (signed out)', () => {
  const NUL = String.fromCharCode(0);
  const LONE = String.fromCharCode(0xd800);

  it.each<[string, Record<string, unknown>, string]>([
    ['a NUL in the description', { description: `${DESCRIPTION}${NUL}` }, 'description'],
    ['half a surrogate pair in the description', { description: `${DESCRIPTION} ${LONE}` }, 'description'],
    ['a NUL in the contact', { contact: `${CONTACT}${NUL}` }, 'contact'],
    ['half a surrogate pair in the contact', { contact: `${LONE}${CONTACT}` }, 'contact'],
  ])('answers 400 for %s, before any database call, and counts no intake error', async (_label, overrides, field) => {
    db.answers.problem_report_create_unverified = storingLikePostgres(createdRow());
    const res = await create(overrides);
    expect(res).toMatchObject({ status: 400, body: { error: 'invalid_request', fields: [field] } });
    expect(db.pool.connect).not.toHaveBeenCalled();
    expect(out.metrics().filter((m) => m.name === 'ReportIntakeErrors')).toEqual([]);
  });

  it('saves the report when only the context carries such text, cleaned', async () => {
    db.answers.problem_report_create_unverified = storingLikePostgres(createdRow());
    const res = await create({
      include_technical: true,
      context: { v: 1, screen: { pattern: `/auth/worker${NUL}` }, errors: [{ k: 'error', msg: `a${NUL}b${LONE}`, at: '2026-10-05T10:00:00Z' }] },
    });
    expect(res.status).toBe(201);
    const context = JSON.parse(db.calls.problem_report_create_unverified[0][8] as string);
    expect(context).toMatchObject({ screen: { pattern: '/auth/worker' }, errors: [{ msg: 'ab\uFFFD' }] });
    expect(out.metrics().filter((m) => m.name === 'ReportIntakeErrors')).toEqual([]);
  });
});

describe('the signed-out intake source', () => {
  it('never answers 401 or 403, and never sets a caller context', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../../../lambda/reports/public-intake.ts'), 'utf8');
    expect(source).not.toMatch(/\b40[13]\b|checkCompliance|setRlsContext|X-Forwarded-For|sourceIp/i);
  });
});
