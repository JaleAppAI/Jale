/**
 * r-paths-upload-tokens.integration.test.ts
 *
 * The tokenized document upload, end to end on its real logins:
 *   - POST /employer/upload-token (lambda/api/employer-upload-token.ts) on
 *     jale_api issues the link;
 *   - POST /worker/documents/{upload-url|confirm|submit}
 *     (lambda/api/worker-documents-dispatch.ts) on jale_api_public, an
 *     EXECUTE-only login, uploads through it.
 *
 * S3 is an in-memory stand-in (presign and HeadObject); the database is real.
 * The checks are behaviour parity: the statuses and bodies of today's flow,
 * and the durable rows it leaves behind.
 */
import type { Pool } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { createCheckedPool } from '../../../lambda/lib/db';
import { apiEvent, FIXTURE_TOS_VERSION, parseResponse, World } from './r-paths-world';
import { describeInProfiles, loginUrl } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

let currentPool: Pool | undefined;
jest.mock('../../../lambda/lib/db', () => {
  const actual = jest.requireActual('../../../lambda/lib/db');
  return { ...actual, getDbPool: async () => currentPool };
});

/** The stand-in bucket: what a browser PUT would have stored, by key. */
const objects = new Map<string, { size: number; type: string; encrypted: boolean; version: string }>();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({
    send: async (command: { kind: string; input: { Key: string } }) => {
      const object = objects.get(command.input.Key);
      if (command.kind !== 'head' || !object) throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
      return {
        ContentLength: object.size,
        ContentType: object.type,
        ServerSideEncryption: object.encrypted ? 'aws:kms' : undefined,
        VersionId: object.version,
      };
    },
  })),
  HeadObjectCommand: jest.fn().mockImplementation((input) => ({ kind: 'head', input })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ kind: 'put', input })),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: async (_client: unknown, command: { input: { Key: string } }) =>
    `https://fixture.invalid/put/${command.input.Key}`,
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const { handler: issueHandler } = require('../../../lambda/api/employer-upload-token');
const { handler: documentsHandler } = require('../../../lambda/api/worker-documents-dispatch');
/* eslint-enable @typescript-eslint/no-var-requires */

if (!databaseUrl) {
  test('CONCERN: the upload token DB suite was not run (JALE_TEST_DATABASE_URL unset)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}

const hashOf = (raw: string) => createHash('sha256').update(raw).digest('hex');

interface Scene {
  world: World;
  employer: { id: string; sub: string };
  otherEmployer: { id: string; sub: string };
  jobId: string;
  applicant: string;
  nonApplicant: string;
  applicationId: string;
}

async function scene(): Promise<Scene> {
  const world = new World(databaseUrl!);
  await world.connect();
  const employer = await world.employer({ companyName: 'Fixture Upload Co' });
  const otherEmployer = await world.employer({ companyName: 'Other Fixture Co' });
  const job = await world.job(employer.id, { title: 'Fixture Upload Job' });
  const applicant = await world.worker({ fullName: 'Fixture Applicant' });
  const nonApplicant = await world.worker({ fullName: 'Fixture Bystander' });
  const applicationId = await world.application(job.id, applicant.id);
  return {
    world, employer, otherEmployer, jobId: job.id, applicant: applicant.id, nonApplicant: nonApplicant.id, applicationId,
  };
}

describeInProfiles(['standard', 'request', 'owner-unrestricted'], 'tokenized document upload on jale_api and jale_api_public', () => {
  let apiPool: Pool;
  let publicPool: Pool;
  let s: Scene;

  beforeAll(async () => {
    process.env.REQUIRED_TOS_VERSION = FIXTURE_TOS_VERSION;
    process.env.FRONTEND_BASE_URL = 'https://fixture.invalid';
    process.env.DOCUMENTS_BUCKET = 'fixture-bucket';
    apiPool = await createCheckedPool({ connectionString: loginUrl('jale_api'), max: 1 }, 'jale_api', 'test');
    publicPool = await createCheckedPool({ connectionString: loginUrl('jale_api_public'), max: 1 }, 'jale_api_public', 'test');
  });
  afterAll(async () => {
    await apiPool.end();
    await publicPool.end();
    currentPool = undefined;
  });
  beforeEach(async () => {
    objects.clear();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    s = await scene();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await s.world.cleanup();
    await s.world.end();
  });

  async function issue(sub: string, jobId: string, workerId: string) {
    currentPool = apiPool;
    return parseResponse(await issueHandler(apiEvent({
      sub, httpMethod: 'POST', resource: '/employer/upload-token', body: { job_id: jobId, worker_id: workerId },
    })));
  }

  async function documents(action: 'upload-url' | 'confirm' | 'submit', body: object) {
    currentPool = publicPool;
    return parseResponse(await documentsHandler({
      ...apiEvent({ httpMethod: 'POST', resource: '/worker/documents/{action}', body }),
      pathParameters: { action },
    }));
  }

  /** Issues a link for the applicant and returns its raw token. */
  async function issuedToken(): Promise<string> {
    const response = await issue(s.employer.sub, s.jobId, s.applicant);
    expect(response.statusCode).toBe(201);
    const token = /\/en\/upload\/([0-9a-f]{64})$/.exec(response.body.upload_url)?.[1];
    expect(token).toBeDefined();
    return token!;
  }

  /** Gets an upload URL and "uploads" the object the browser would PUT. */
  async function upload(token: string, docType = 'resume', size = 4096): Promise<string> {
    const response = await documents('upload-url', { token, doc_type: docType, mime_type: 'application/pdf' });
    expect(response.statusCode).toBe(200);
    const key: string = response.body.s3_key;
    objects.set(key, { size, type: 'application/pdf', encrypted: true, version: `fixture-version-${randomUUID()}` });
    return key;
  }

  function confirmBody(token: string, key: string, docType = 'resume', extra: object = {}) {
    return { token, s3_key: key, doc_type: docType, file_name: `${docType}.pdf`, file_size: 4096, mime_type: 'application/pdf', ...extra };
  }

  async function rows(sql: string, params: unknown[]) {
    return (await s.world.su.query(sql, params)).rows;
  }

  it('the employer issues a link for its own applicant: one hashed token with a 7-day expiry', async () => {
    const token = await issuedToken();
    const stored = await rows(
      `SELECT worker_id, job_id, used, expires_at > now() + interval '6 days 23 hours' AS seven_days
         FROM document_upload_tokens WHERE token_hash = $1`,
      [hashOf(token)],
    );
    expect(stored).toEqual([{ worker_id: s.applicant, job_id: s.jobId, used: false, seven_days: true }]);
    // Only the hash is stored.
    expect(await rows(`SELECT 1 FROM document_upload_tokens WHERE token_hash = $1`, [token])).toEqual([]);
  });

  it('no link for a worker who did not apply, or for another employer', async () => {
    const nonApplicant = await issue(s.employer.sub, s.jobId, s.nonApplicant);
    expect(nonApplicant.statusCode).toBe(403);
    expect(nonApplicant.body).toEqual({ error: 'forbidden' });
    const otherEmployer = await issue(s.otherEmployer.sub, s.jobId, s.applicant);
    expect(otherEmployer.statusCode).toBe(403);
    expect(await rows(`SELECT 1 FROM document_upload_tokens WHERE job_id = $1`, [s.jobId])).toEqual([]);
  });

  it('upload, confirm and submit through the link leave the job-scoped document and a used token', async () => {
    const token = await issuedToken();
    const key = await upload(token);
    expect(key).toMatch(new RegExp(`^documents/${s.jobId}/${s.applicant}/resume/[0-9a-f-]{36}\\.pdf$`));
    expect(await rows(
      `SELECT doc_type, expected_mime_type, confirmed_at IS NULL AS open FROM document_upload_token_slots WHERE token_hash = $1`,
      [hashOf(token)],
    )).toEqual([{ doc_type: 'resume', expected_mime_type: 'application/pdf', open: true }]);

    const confirmed = await documents('confirm', confirmBody(token, key, 'resume', { file_name: 'my/resume.pdf' }));
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.body).toEqual({ success: true });
    const docs = await rows(
      `SELECT worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type, s3_version_id
         FROM worker_documents WHERE job_id = $1`,
      [s.jobId],
    );
    expect(docs).toEqual([{
      worker_id: s.applicant, job_id: s.jobId, doc_type: 'resume', s3_key: key, file_name: 'my_resume.pdf',
      file_size: 4096, mime_type: 'application/pdf', s3_version_id: objects.get(key)!.version,
    }]);
    expect(await rows(
      `SELECT confirmed_at IS NOT NULL AS confirmed FROM document_upload_token_slots WHERE token_hash = $1`,
      [hashOf(token)],
    )).toEqual([{ confirmed: true }]);

    expect((await documents('submit', { token })).statusCode).toBe(200);
    expect((await documents('submit', { token })).statusCode).toBe(200);
    expect(await rows(
      `SELECT used, used_at IS NOT NULL AS stamped FROM document_upload_tokens WHERE token_hash = $1`, [hashOf(token)],
    )).toEqual([{ used: true, stamped: true }]);
  });

  it('a confirmed slot is never re-issued, and a re-issued slot binds the new key only', async () => {
    const token = await issuedToken();
    const first = await upload(token);
    const second = await upload(token);
    expect(second).not.toBe(first);
    // The slot now belongs to the second key.
    const stale = await documents('confirm', confirmBody(token, first));
    expect(stale.statusCode).toBe(409);
    expect(stale.body).toEqual({ error: 'invalid_or_confirmed_upload' });
    expect((await documents('confirm', confirmBody(token, second))).statusCode).toBe(200);

    const again = await documents('upload-url', { token, doc_type: 'resume', mime_type: 'application/pdf' });
    expect(again.statusCode).toBe(409);
    expect(again.body).toEqual({ error: 'document_already_confirmed' });
  });

  it('refusals answer exactly as before: unknown, expired and withdrawn tokens, missing and oversized objects', async () => {
    const unknown = await documents('upload-url', { token: randomUUID(), doc_type: 'resume', mime_type: 'application/pdf' });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.body).toEqual({ error: 'invalid_token' });

    const expired = await s.world.uploadToken({ jobId: s.jobId, workerId: s.applicant, expiresAt: new Date(Date.now() - 60_000) });
    expect((await documents('upload-url', { token: expired.raw, doc_type: 'resume', mime_type: 'application/pdf' })).statusCode).toBe(401);
    expect((await documents('submit', { token: expired.raw })).body).toEqual({ error: 'invalid_token' });

    const token = await issuedToken();
    expect((await documents('submit', { token })).body).toEqual({ error: 'confirm_required' });

    const key = await upload(token);
    objects.delete(key);
    const missing = await documents('confirm', confirmBody(token, key));
    expect(missing.statusCode).toBe(400);
    expect(missing.body).toEqual({ error: 'uploaded_object_not_found' });

    objects.set(key, { size: 11 * 1024 * 1024, type: 'application/pdf', encrypted: true, version: 'fixture-version-big' });
    const oversized = await documents('confirm', confirmBody(token, key));
    expect(oversized.statusCode).toBe(400);
    expect(oversized.body).toEqual({ error: 'invalid_file_size' });
    expect(await rows(`SELECT 1 FROM worker_documents WHERE job_id = $1`, [s.jobId])).toEqual([]);

    // A withdrawn application voids the link.
    await s.world.su.query(`DELETE FROM job_applications WHERE id = $1`, [s.applicationId]);
    expect((await documents('upload-url', { token, doc_type: 'resume', mime_type: 'application/pdf' })).statusCode).toBe(401);
  });

  it('certification documents append rather than replace (one link per upload, as each slot confirms once)', async () => {
    for (const label of ['Fixture cert A', 'Fixture cert B']) {
      const token = await issuedToken();
      const key = await upload(token, 'certification_doc');
      const response = await documents('confirm', confirmBody(token, key, 'certification_doc', { cert_name: label }));
      expect(response.statusCode).toBe(200);
    }
    expect(await rows(
      `SELECT cert_name FROM worker_documents WHERE job_id = $1 AND doc_type = 'certification_doc' ORDER BY cert_name`,
      [s.jobId],
    )).toEqual([{ cert_name: 'Fixture cert A' }, { cert_name: 'Fixture cert B' }]);
  });
});
