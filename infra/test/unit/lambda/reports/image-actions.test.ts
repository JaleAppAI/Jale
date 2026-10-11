/**
 * upload and attach, on both doors. Both authenticate by the report's attach
 * token alone: the signed-in door sets no caller context for them, and the
 * signed-out door accepts the token of ANY report, verified or not (the web
 * client retries a signed-in report's image through the public routes once
 * its sign-in is gone).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { handler as signedInHandler } from '../../../../lambda/reports/intake';
import { handler as signedOutHandler } from '../../../../lambda/reports/public-intake';
import {
  JPEG_BYTES,
  PNG_BYTES,
  answerS3,
  captureConsole,
  fakeDb,
  parse,
  reportEvent,
  s3Error,
  sha256,
  type ConsoleCapture,
  type FakeDb,
  type FakeS3Answers,
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
const mockS3Send = (S3Client as unknown as jest.Mock).mock.results[0].value.send as jest.Mock;

const BUCKET = 'test-report-images';
const KMS_KEY = 'test-report-images-key';

type Handler = (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;
const DOORS: Array<[string, Handler, () => Record<string, unknown> | null]> = [
  ['signed in', signedInHandler, () => ({ sub: `fixture-sub-${randomUUID()}`, iss: 'https://issuer.example.invalid/pool' })],
  ['signed out', signedOutHandler, () => null],
];

let timeline: string[];
let db: FakeDb;
let out: ConsoleCapture;
let reportId: string;
let token: string;
let upload: string;
let pendingKey: string;
let finalKey: string;
let etag: string;

beforeEach(() => {
  jest.clearAllMocks();
  timeline = [];
  db = fakeDb(timeline);
  reportId = randomUUID();
  token = randomBytes(32).toString('base64url');
  upload = randomUUID();
  pendingKey = `incoming/${upload}`;
  finalKey = `images/${reportId}/${upload}.png`;
  etag = `"${randomBytes(16).toString('hex')}"`;
  mockGetDbPool.mockResolvedValue(db.pool);
  mockPresign.mockImplementation(async (_s3: unknown, input: { Key: string }) => {
    timeline.push('PRESIGN');
    return { url: 'https://uploads.example.invalid/', fields: { key: input.Key } };
  });
  process.env.REPORT_IMAGES_BUCKET = BUCKET;
  process.env.REPORT_IMAGES_KEY_ID = KMS_KEY;
  process.env.ALLOWED_ORIGIN = 'https://app.example.invalid';
  out = captureConsole();
});

afterEach(() => {
  out.restore();
});

const goodHead = () => ({
  ContentLength: 4096, ContentType: 'image/png', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: KMS_KEY, ETag: etag,
});

describe.each(DOORS)('POST upload (%s)', (_door, handler, claims) => {
  const call = async (bodyOverrides: Record<string, unknown> = {}) => parse(await handler(reportEvent({
    action: 'upload',
    claims: claims(),
    body: { report_id: reportId, attach_token: token, image: { content_type: 'image/png', byte_size: 4096 }, ...bodyOverrides },
  })));

  it('issues a new upload for the token and signs it after the commit, with no caller context', async () => {
    db.answers.problem_report_upload_grant = [{ outcome: 'ok', upload_key: pendingKey }];
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ upload: { url: 'https://uploads.example.invalid/', fields: { key: pendingKey }, expires_at: expect.any(String) } });
    expect(timeline).toEqual(['CONNECT', 'BEGIN', 'problem_report_upload_grant', 'COMMIT', 'RELEASE', 'PRESIGN']);
    expect(db.calls.problem_report_upload_grant[0]).toEqual([reportId, sha256(token), 'image/png']);
    expect(mockSetRls).not.toHaveBeenCalled();
  });

  it.each<[string, number, Record<string, unknown>]>([
    ['not_found', 404, { error: 'not_found' }],
    ['already_attached', 409, { error: 'already_attached' }],
    ['upload_expired', 410, { error: 'upload_expired' }],
    ['screenshots_paused', 503, { error: 'screenshots_paused' }],
    ['invalid_type', 400, { error: 'invalid_request', fields: ['image'] }],
  ])('maps %s to %i and signs nothing', async (outcome, status, expected) => {
    db.answers.problem_report_upload_grant = [{ outcome, upload_key: null }];
    const res = await call();
    expect(res).toMatchObject({ status, body: expected });
    expect(timeline).toContain('COMMIT');
    expect(mockPresign).not.toHaveBeenCalled();
  });

  it('validates the body before the database', async () => {
    expect(await call({ image: { content_type: 'image/svg+xml', byte_size: 10 } }))
      .toMatchObject({ status: 400, body: { error: 'invalid_request', fields: ['image'] } });
    expect(await call({ attach_token: 'short' })).toMatchObject({ status: 400, body: { fields: ['attach_token'] } });
    expect(db.pool.connect).not.toHaveBeenCalled();
  });
});

describe.each(DOORS)('POST attach (%s)', (_door, handler, claims) => {
  const call = async () => parse(await handler(reportEvent({
    action: 'attach',
    claims: claims(),
    body: { report_id: reportId, attach_token: token },
  })));

  function pending(outcome = 'ok') {
    db.answers.problem_report_pending_upload = outcome === 'ok'
      ? [{ outcome, pending_key: pendingKey, content_type: 'image/png' }]
      : [{ outcome, pending_key: null, content_type: null }];
  }

  function storage(answers: FakeS3Answers = {}) {
    return answerS3(mockS3Send, timeline, { head: goodHead(), range: PNG_BYTES, ...answers });
  }

  it('checks and pins the upload between two short transactions, then records it', async () => {
    pending();
    const calls = storage();
    db.answers.problem_report_attach = [{ outcome: 'ok' }];
    const res = await call();

    expect(res).toMatchObject({ status: 200, body: { attached: true } });
    expect(timeline).toEqual([
      'CONNECT',
      'BEGIN', 'problem_report_pending_upload', 'COMMIT',
      'S3:HeadObject', 'S3:GetObject', 'S3:CopyObject', 'S3:DeleteObject',
      'BEGIN', 'problem_report_attach', 'COMMIT',
      'RELEASE',
    ]);
    expect(db.calls.problem_report_pending_upload[0]).toEqual([reportId, sha256(token)]);
    expect(db.calls.problem_report_attach[0]).toEqual([reportId, sha256(token), pendingKey, finalKey, 'image/png', 4096]);
    const copy = calls.find((c) => c.command === 'CopyObjectCommand');
    expect(copy?.input).toMatchObject({ Key: finalKey, CopySource: `${BUCKET}/${pendingKey}`, CopySourceIfMatch: etag, SSEKMSKeyId: KMS_KEY });
    expect(mockSetRls).not.toHaveBeenCalled();
  });

  it.each<[string, number]>([
    ['not_found', 404],
    ['already_attached', 409],
    ['upload_expired', 410],
    ['screenshots_paused', 503],
  ])('answers the pre-check refusal %s with %i and touches no storage', async (outcome, status) => {
    pending(outcome);
    storage();
    const res = await call();
    expect(res).toMatchObject({ status, body: { error: outcome } });
    expect(timeline.filter((t) => t.startsWith('S3:'))).toEqual([]);
    expect(timeline).not.toContain('problem_report_attach');
  });

  it('answers 422 invalid_image for content that is not the declared type, deletes the upload and records nothing', async () => {
    pending();
    const calls = storage({ range: JPEG_BYTES });
    const res = await call();
    expect(res).toMatchObject({ status: 422, body: { error: 'invalid_image' } });
    expect(calls.map((c) => c.command)).toEqual(['HeadObjectCommand', 'GetObjectCommand', 'DeleteObjectCommand']);
    expect(calls[2].input).toEqual({ Bucket: BUCKET, Key: pendingKey });
    expect(timeline).not.toContain('problem_report_attach');
    expect(out.metrics()).toContainEqual({ name: 'ReportUploadRejected', value: 1, dimensions: { Reason: 'magic' } });
  });

  it('answers 410 upload_expired when the upload never arrived', async () => {
    pending();
    storage({ head: s3Error('Forbidden', 403) });
    const res = await call();
    expect(res).toMatchObject({ status: 410, body: { error: 'upload_expired' } });
    expect(out.metrics()).toContainEqual({ name: 'ReportUploadRejected', value: 1, dimensions: { Reason: 'missing' } });
  });

  it.each<[string, number]>([
    ['upload_expired', 410],
    ['invalid_image', 422],
    ['screenshots_paused', 503],
  ])('deletes its own copy when the attach is refused with %s, and answers %i', async (outcome, status) => {
    pending();
    const calls = storage();
    db.answers.problem_report_attach = [{ outcome }];
    const res = await call();
    expect(res).toMatchObject({ status, body: { error: outcome } });
    const deletes = calls.filter((c) => c.command === 'DeleteObjectCommand').map((c) => c.input.Key);
    expect(deletes).toEqual([pendingKey, finalKey]);
    expect(timeline.indexOf('S3:DeleteObject', timeline.indexOf('problem_report_attach'))).toBeGreaterThan(timeline.indexOf('COMMIT', timeline.indexOf('problem_report_attach')));
  });

  it('leaves the copy when the attach answers not_found: the key may be one another attempt attached', async () => {
    pending();
    const calls = storage();
    db.answers.problem_report_attach = [{ outcome: 'not_found' }];
    const res = await call();
    expect(res).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(calls.filter((c) => c.command === 'DeleteObjectCommand').map((c) => c.input.Key)).toEqual([pendingKey]);
  });

  it('never deletes the image a newer token attached when an attempt with the older token lands after it', async () => {
    // Two attempts on one upload: A holds the token the report had when A's
    // pre-check ran, B the token a replay of the create issued since. Both
    // pre-checks name the same upload, so both copies go to the same key.
    // B attaches; A's attach then answers not_found, its token being stale.
    const older = token;
    const newer = randomBytes(32).toString('base64url');
    db.answers.problem_report_pending_upload = [{ outcome: 'ok', pending_key: pendingKey, content_type: 'image/png' }];
    db.answers.problem_report_attach = (args) => [{ outcome: args[1] === sha256(newer) ? 'ok' : 'not_found' }];
    const calls = storage();
    const attempt = async (attachToken: string) => parse(await handler(reportEvent({
      action: 'attach',
      claims: claims(),
      body: { report_id: reportId, attach_token: attachToken },
    })));

    expect(await attempt(newer)).toMatchObject({ status: 200, body: { attached: true } });
    expect(await attempt(older)).toMatchObject({ status: 404, body: { error: 'not_found' } });

    expect(calls.filter((c) => c.command === 'CopyObjectCommand').map((c) => c.input.Key)).toEqual([finalKey, finalKey]);
    expect(calls.filter((c) => c.command === 'DeleteObjectCommand').map((c) => c.input.Key)).not.toContain(finalKey);
  });

  it('deletes nothing it attached when the attach answers already_attached', async () => {
    pending();
    const calls = storage();
    db.answers.problem_report_attach = [{ outcome: 'already_attached' }];
    const res = await call();
    expect(res).toMatchObject({ status: 409, body: { error: 'already_attached' } });
    expect(calls.filter((c) => c.command === 'DeleteObjectCommand').map((c) => c.input.Key)).toEqual([pendingKey]);
  });

  it('rolls back, removes its unrecorded copy and answers 500 when the attach call fails', async () => {
    pending();
    const calls = storage();
    db.answers.problem_report_attach = new Error('connection terminated');
    const res = await call();
    expect(res).toMatchObject({ status: 500, body: { error: 'internal' } });
    expect(timeline).toContain('ROLLBACK');
    expect(calls.filter((c) => c.command === 'DeleteObjectCommand').map((c) => c.input.Key)).toEqual([pendingKey, finalKey]);
    expect(out.metrics()).toContainEqual({ name: 'ReportIntakeErrors', value: 1, dimensions: {} });
  });

  it('keeps the copy when the commit itself fails: the attach may have been recorded', async () => {
    pending();
    const calls = storage();
    db.answers.problem_report_attach = [{ outcome: 'ok' }];
    let commits = 0;
    const baseQuery = db.query.getMockImplementation()!;
    db.query.mockImplementation(async (sql: string, args?: unknown[]) => {
      if (sql === 'COMMIT' && ++commits === 2) {
        timeline.push('COMMIT');
        throw new Error('connection terminated');
      }
      return baseQuery(sql, args);
    });
    const res = await call();
    expect(res.status).toBe(500);
    expect(calls.filter((c) => c.command === 'DeleteObjectCommand').map((c) => c.input.Key)).toEqual([pendingKey]);
  });

  it('answers 500 on a storage failure, and records nothing', async () => {
    pending();
    storage({ head: s3Error('InternalError', 500) });
    const res = await call();
    expect(res).toMatchObject({ status: 500, body: { error: 'internal' } });
    expect(timeline).not.toContain('problem_report_attach');
  });

  it('never logs a key, a token or its hash', async () => {
    pending();
    storage({ range: JPEG_BYTES });
    await call();
    const everything = out.lines.join('\n');
    for (const value of [upload, reportId, token, sha256(token), etag]) expect(everything).not.toContain(value);
    expect(out.logs).toEqual([expect.objectContaining({ action: 'attach', outcome: 'invalid_image', reason: 'magic' })]);
  });
});

describe('the public routes accept any report token, verified or not', () => {
  it('upload and attach on the signed-out door pass a signed-in report token straight to the token checks', async () => {
    // The token below belongs to a report created through the signed-in
    // door. The signed-out door asks nothing about the report but its token.
    db.answers.problem_report_upload_grant = [{ outcome: 'ok', upload_key: pendingKey }];
    const uploaded = parse(await signedOutHandler(reportEvent({
      action: 'upload',
      body: { report_id: reportId, attach_token: token, image: { content_type: 'image/png', byte_size: 4096 } },
    })));
    expect(uploaded.status).toBe(200);

    db.answers.problem_report_pending_upload = [{ outcome: 'ok', pending_key: pendingKey, content_type: 'image/png' }];
    answerS3(mockS3Send, timeline, { head: goodHead(), range: PNG_BYTES });
    db.answers.problem_report_attach = [{ outcome: 'ok' }];
    const attached = parse(await signedOutHandler(reportEvent({ action: 'attach', body: { report_id: reportId, attach_token: token } })));
    expect(attached).toMatchObject({ status: 200, body: { attached: true } });

    expect(timeline.filter((t) => t.startsWith('problem_report_'))).toEqual([
      'problem_report_upload_grant', 'problem_report_pending_upload', 'problem_report_attach',
    ]);
  });
});
