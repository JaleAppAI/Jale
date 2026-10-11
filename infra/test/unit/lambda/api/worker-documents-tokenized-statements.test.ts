/**
 * The tokenized document flow (POST /worker/documents/{action}: upload-url,
 * confirm, submit) runs on an EXECUTE-only login that holds no table rights.
 * So every statement the three delegates issue, through the real dispatcher
 * and their whole import closure, must be transaction control, one of the
 * jale_cap.upload_token_* capability calls, or the transaction-local audit
 * context statement (SET_AUDIT_CONTEXT_SQL, accepted by exact equality) --
 * on success paths and refusals alike. (The pool's own boot identity check
 * lives in lib/db's getters, which are mocked here.)
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-documents-dispatch';
import { getDbPool } from '../../../../lambda/lib/db';
import { SET_AUDIT_CONTEXT_SQL } from '../../../../lambda/lib/audit/context';

jest.mock('../../../../lambda/lib/db');
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({
      ContentLength: 2048, ContentType: 'application/pdf', ServerSideEncryption: 'aws:kms', VersionId: 'v1',
    }),
  })),
  HeadObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://s3.example.com/presigned-put'),
}));

const ALLOWED = /^(BEGIN|COMMIT|ROLLBACK)$|^SELECT outcome(, [a-z0-9_]+)? FROM jale_cap\.upload_token_(resolve|slot|confirm|submit)\(/;
/** The audit context statement, normalised the way the captured statements are. */
const AUDIT_CONTEXT = SET_AUDIT_CONTEXT_SQL.replace(/\s+/g, ' ').trim();
const KEY = 'documents/job-1/worker-1/resume/uuid.pdf';

const statements: string[] = [];
let outcome = 'ok';
const mockQuery = jest.fn((sql: string) => {
  statements.push(sql.replace(/\s+/g, ' ').trim());
  if (/upload_token_resolve/.test(sql)) return Promise.resolve({ rows: [{ outcome, s3_key: outcome === 'ok' ? KEY : null }] });
  if (/upload_token_slot/.test(sql)) return Promise.resolve({ rows: [{ outcome, max_file_size: 10 * 1024 * 1024 }] });
  if (/upload_token_confirm/.test(sql)) return Promise.resolve({ rows: [{ outcome, document_id: null }] });
  if (/upload_token_submit/.test(sql)) return Promise.resolve({ rows: [{ outcome }] });
  return Promise.resolve({ rows: [] });
});

function post(action: string, body: object): APIGatewayProxyEvent {
  return { pathParameters: { action }, body: JSON.stringify(body) } as unknown as APIGatewayProxyEvent;
}

const requests: Array<[string, object]> = [
  ['upload-url', { token: 't', doc_type: 'resume', mime_type: 'application/pdf' }],
  ['confirm', { token: 't', s3_key: KEY, doc_type: 'resume', file_name: 'r.pdf', file_size: 2048, mime_type: 'application/pdf' }],
  ['submit', { token: 't' }],
];

describe('the tokenized document flow issues only capability calls and transaction control', () => {
  beforeEach(() => {
    statements.length = 0;
    process.env.DOCUMENTS_BUCKET = 'test-bucket';
    process.env.ALLOWED_ORIGIN = 'https://jaleapp.ai';
    (getDbPool as jest.Mock).mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(['ok', 'invalid_token', 'invalid_or_confirmed_upload', 'document_already_confirmed', 'confirm_required'])(
    'with every call answering %s',
    async (answer) => {
      outcome = answer;
      for (const [action, body] of requests) {
        await handler(post(action, body));
      }
      expect(statements.length).toBeGreaterThan(0);
      expect(statements.filter((sql) => sql !== AUDIT_CONTEXT && !ALLOWED.test(sql))).toEqual([]);
    },
  );

  it('a full happy path calls resolve, slot, confirm and submit, in that order', async () => {
    outcome = 'ok';
    for (const [action, body] of requests) {
      expect((await handler(post(action, body))).statusCode).toBe(200);
    }
    const calls = statements.filter((sql) => /jale_cap\./.test(sql)).map((sql) => /upload_token_([a-z]+)/.exec(sql)![1]);
    expect(calls).toEqual(['resolve', 'slot', 'confirm', 'submit']);
  });
});
