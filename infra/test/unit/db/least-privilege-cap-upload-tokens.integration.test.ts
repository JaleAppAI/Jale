/**
 * least-privilege-cap-upload-tokens.integration.test.ts -- the tokenized
 * document upload, through its capability functions, on a real bed.
 *
 * The upload-token tables are closed to every runtime login. The employer
 * issues a token through jale_cap.upload_token_issue (jale_api); the worker's
 * public upload page resolves a slot, checks it, confirms the uploaded object
 * and submits through the four jale_api_public functions. This suite calls
 * each one over its caller's real login (never SET ROLE) and proves today's
 * observable behaviour of the four upload endpoints:
 *   - issue: only the employer who owns the job, only for a worker who applied
 *     to it; seven-day expiry;
 *   - resolve: the object key is built from the token's own job and worker
 *     (documents/<job>/<worker>/<type>/<uuid>.<ext>), an unconfirmed slot is
 *     re-issued, a confirmed one never is;
 *   - slot and confirm: the exact key and MIME type, the size limit, the
 *     certification caps, replace-within-the-job, and a refusal never burns
 *     the slot;
 *   - submit: at least one confirmed slot; a repeat keeps the first time.
 * The six token cases (expired, submitted, wrong slot, wrong type, replayed
 * confirm, wrong object key) and every capability flag set by the caller
 * unlock nothing.
 *
 * Connection: JALE_TEST_DATABASE_URL (the bed's superuser URL) for fixtures;
 * callers sign in through helpers/login-pool.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { setEveryCapabilityFlag, type FlagVictim } from './helpers/capability-flags';
import { loginClient, withLoginClient } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: least-privilege upload-token functions PostgreSQL gate was not run', () => {
    console.warn('[least-privilege-cap-upload-tokens] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const KEY_SHAPE = /^documents\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([a-z_]+)\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(pdf|jpg|png)$/;

const sha256 = (raw: string) => createHash('sha256').update(raw).digest('hex');
const newTokenHash = () => sha256(randomBytes(32).toString('hex'));

interface Context {
  /** app.current_internal_user_id for this call; omitted = never set. */
  internalUserId?: string;
  /** Sets every capability flag to open it for this victim first. */
  flagsFor?: FlagVictim;
}

/** Runs `sql` as `login` in its own transaction, the way a handler would, and commits. */
async function callAs<T extends object>(login: string, sql: string, params: unknown[], ctx: Context = {}): Promise<T[]> {
  return withLoginClient(login, async (client) => {
    await client.query('BEGIN');
    try {
      if (ctx.internalUserId !== undefined) {
        await client.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [ctx.internalUserId]);
      }
      if (ctx.flagsFor) await setEveryCapabilityFlag(client, ctx.flagsFor);
      const { rows } = await client.query<T>(sql, params);
      await client.query('COMMIT');
      return rows;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  });
}

async function sqlstate(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

const ISSUE = 'SELECT * FROM jale_cap.upload_token_issue($1, $2, $3)';
const RESOLVE = 'SELECT * FROM jale_cap.upload_token_resolve($1, $2, $3)';
const SLOT = 'SELECT * FROM jale_cap.upload_token_slot($1, $2, $3, $4)';
const CONFIRM = 'SELECT * FROM jale_cap.upload_token_confirm($1, $2, $3, $4, $5, $6, $7, $8)';
const SUBMIT = 'SELECT * FROM jale_cap.upload_token_submit($1)';

maybeDescribe('upload-token capability functions', () => {
  let su: Client;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const subs = {
    employerA: `lp-up-employer-a-${stamp}`,
    employerB: `lp-up-employer-b-${stamp}`,
    workerA: `lp-up-worker-a-${stamp}`,
    workerB: `lp-up-worker-b-${stamp}`,
  };
  const ids = { employerA: '', employerB: '', workerA: '', workerB: '', jobA: '', jobB: '' };
  let victimB: FlagVictim;

  async function seedToken(worker: string, job: string, opts: { expires?: string; used?: boolean } = {}): Promise<string> {
    const hash = newTokenHash();
    await su.query(
      `INSERT INTO public.document_upload_tokens (token_hash, worker_id, job_id, expires_at, used)
       VALUES ($1, $2, $3, now() + $4::interval, $5)`,
      [hash, worker, job, opts.expires ?? '1 day', opts.used ?? false],
    );
    return hash;
  }

  async function resolve(hash: string, docType = 'resume', mime = 'application/pdf', ctx: Context = {}) {
    return (await callAs<{ outcome: string; s3_key: string | null }>('jale_api_public', RESOLVE, [hash, docType, mime], ctx))[0];
  }

  async function confirm(hash: string, key: string | null, opts: {
    docType?: string; mime?: string; fileName?: string; size?: number; version?: string | null; certName?: string | null; ctx?: Context;
  } = {}) {
    return (await callAs<{ outcome: string; document_id: string | null }>('jale_api_public', CONFIRM, [
      hash, opts.docType ?? 'resume', key, opts.mime ?? 'application/pdf', opts.fileName ?? 'resume.pdf',
      opts.size ?? 2048, opts.version === undefined ? 'v1' : opts.version, opts.certName ?? null,
    ], opts.ctx ?? {}))[0];
  }

  async function slotRow(hash: string, docType: string) {
    const { rows } = await su.query(
      `SELECT issued_s3_key, expected_mime_type, max_file_size, confirmed_at, s3_version_id, requested_at
         FROM public.document_upload_token_slots WHERE token_hash = $1 AND doc_type = $2`,
      [hash, docType],
    );
    return rows[0] as {
      issued_s3_key: string; expected_mime_type: string; max_file_size: number;
      confirmed_at: Date | null; s3_version_id: string | null; requested_at: Date;
    } | undefined;
  }

  async function documents(worker: string, job: string | null) {
    const { rows } = await su.query(
      `SELECT doc_type, s3_key, file_name, file_size, mime_type, s3_version_id, cert_name
         FROM public.worker_documents
        WHERE worker_id = $1 AND job_id IS NOT DISTINCT FROM $2
        ORDER BY uploaded_at, s3_key`,
      [worker, job],
    );
    return rows;
  }

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
    for (const [name, type] of [['employerA', 'employer'], ['employerB', 'employer'], ['workerA', 'worker'], ['workerB', 'worker']] as const) {
      ids[name] = (await su.query<{ id: string }>(
        `INSERT INTO public.users (cognito_sub, user_type) VALUES ($1, $2) RETURNING id`, [subs[name], type],
      )).rows[0].id;
    }
    for (const [job, employer] of [['jobA', 'employerA'], ['jobB', 'employerB']] as const) {
      ids[job] = (await su.query<{ id: string }>(
        `INSERT INTO public.jobs (employer_id, title, location, job_type, status)
         VALUES ($1, 'Least-privilege upload fixture', 'Austin', 'full-time', 'active') RETURNING id`,
        [ids[employer]],
      )).rows[0].id;
    }
    await su.query(
      'INSERT INTO public.job_applications (job_id, worker_id) VALUES ($1, $2), ($3, $4)',
      [ids.jobA, ids.workerA, ids.jobB, ids.workerB],
    );
    // A vault copy (no job) that no tokenized upload may ever touch.
    await su.query(
      `INSERT INTO public.worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type)
       VALUES ($1, NULL, 'resume', $2, 'vault.pdf', 100, 'application/pdf')`,
      [ids.workerA, `documents/vault/${ids.workerA}/resume/${randomUUID()}.pdf`],
    );
    victimB = { userId: ids.employerB, sub: subs.employerB };
  });

  afterAll(async () => {
    if (!su) return;
    const workers = [ids.workerA, ids.workerB].filter(Boolean);
    const jobs = [ids.jobA, ids.jobB].filter(Boolean);
    await su.query('DELETE FROM public.worker_documents WHERE worker_id = ANY($1::uuid[])', [workers]);
    await su.query('DELETE FROM public.document_upload_tokens WHERE job_id = ANY($1::uuid[])', [jobs]);
    await su.query('DELETE FROM public.job_applications WHERE job_id = ANY($1::uuid[])', [jobs]);
    await su.query('DELETE FROM public.jobs WHERE id = ANY($1::uuid[])', [jobs]);
    await su.query('DELETE FROM public.users WHERE cognito_sub = ANY($1::text[])', [Object.values(subs)]);
    await su.end();
  });

  describe('upload_token_issue, called by the request login as the employer', () => {
    it('issues a token for an applicant to the caller\'s own job, expiring in seven days', async () => {
      const hash = newTokenHash();
      const [row] = await callAs<{ outcome: string; expires_at: Date }>(
        'jale_api', ISSUE, [hash, ids.jobA, ids.workerA], { internalUserId: ids.employerA },
      );
      expect(row.outcome).toBe('ok');
      const { rows } = await su.query(
        `SELECT worker_id, job_id, used, used_at, expires_at,
                abs(extract(epoch FROM expires_at - (now() + interval '7 days'))) < 120 AS seven_days
           FROM public.document_upload_tokens WHERE token_hash = $1`,
        [hash],
      );
      expect(rows).toEqual([{
        worker_id: ids.workerA, job_id: ids.jobA, used: false, used_at: null, expires_at: row.expires_at, seven_days: true,
      }]);
    });

    it('refuses another employer\'s job and a worker who did not apply, writing nothing, whatever flags are set', async () => {
      const foreign = newTokenHash();
      const unapplied = newTokenHash();
      expect(await callAs('jale_api', ISSUE, [foreign, ids.jobB, ids.workerB], { internalUserId: ids.employerA, flagsFor: victimB }))
        .toEqual([{ outcome: 'forbidden', expires_at: null }]);
      expect(await callAs('jale_api', ISSUE, [unapplied, ids.jobA, ids.workerB], { internalUserId: ids.employerA, flagsFor: victimB }))
        .toEqual([{ outcome: 'forbidden', expires_at: null }]);
      const { rows } = await su.query(
        'SELECT count(*)::int AS n FROM public.document_upload_tokens WHERE token_hash = ANY($1::text[])', [[foreign, unapplied]],
      );
      expect(rows).toEqual([{ n: 0 }]);
    });

    it('raises 42501 without a caller, and for the empty value a pooled connection carries', async () => {
      expect(await sqlstate(callAs('jale_api', ISSUE, [newTokenHash(), ids.jobA, ids.workerA]))).toBe('42501');
      expect(await sqlstate(callAs('jale_api', ISSUE, [newTokenHash(), ids.jobA, ids.workerA], { internalUserId: '' }))).toBe('42501');
    });

    it('raises 22023 for anything but a lower-case hex SHA-256, so a raw token never reaches the table', async () => {
      const raw = randomBytes(32).toString('base64');
      expect(await sqlstate(callAs('jale_api', ISSUE, [raw, ids.jobA, ids.workerA], { internalUserId: ids.employerA }))).toBe('22023');
      expect(await sqlstate(callAs('jale_api', ISSUE, [newTokenHash().toUpperCase(), ids.jobA, ids.workerA], { internalUserId: ids.employerA })))
        .toBe('22023');
    });
  });

  describe('upload_token_resolve, called by the public login', () => {
    it('issues a slot keyed to the token\'s own job and worker, and re-issues it while unconfirmed', async () => {
      const hash = await seedToken(ids.workerA, ids.jobA);
      const first = await resolve(hash, 'driver_license', 'image/png');
      expect(first.outcome).toBe('ok');
      expect(first.s3_key).toMatch(KEY_SHAPE);
      expect(KEY_SHAPE.exec(first.s3_key!)!.slice(1, 5)).toEqual([ids.jobA, ids.workerA, 'driver_license', 'png']);
      const issued = await slotRow(hash, 'driver_license');
      expect(issued).toMatchObject({
        issued_s3_key: first.s3_key, expected_mime_type: 'image/png', max_file_size: MAX_FILE_SIZE, confirmed_at: null, s3_version_id: null,
      });

      await su.query(`UPDATE public.document_upload_token_slots SET s3_version_id = 'stale' WHERE token_hash = $1`, [hash]);
      const second = await resolve(hash, 'driver_license', 'image/jpeg');
      expect(second.outcome).toBe('ok');
      expect(second.s3_key).not.toBe(first.s3_key);
      expect(second.s3_key!.endsWith('.jpg')).toBe(true);
      expect(await slotRow(hash, 'driver_license')).toMatchObject({
        issued_s3_key: second.s3_key, expected_mime_type: 'image/jpeg', confirmed_at: null, s3_version_id: null,
      });
    });

    it('never re-issues a confirmed slot', async () => {
      const hash = await seedToken(ids.workerA, ids.jobA);
      const { s3_key: key } = await resolve(hash, 'work_auth_doc');
      expect((await confirm(hash, key, { docType: 'work_auth_doc', fileName: 'auth.pdf' })).outcome).toBe('ok');
      expect(await resolve(hash, 'work_auth_doc')).toEqual({ outcome: 'document_already_confirmed', s3_key: null });
      expect((await slotRow(hash, 'work_auth_doc'))!.issued_s3_key).toBe(key);
    });

    it('refuses an unknown, expired, submitted or orphaned token, whatever flags are set', async () => {
      const victim = { userId: ids.workerB, sub: subs.workerB };
      const expired = await seedToken(ids.workerA, ids.jobA, { expires: '-1 second' });
      const submitted = await seedToken(ids.workerA, ids.jobA, { used: true });
      const orphanJob = (await su.query<{ id: string }>(
        `INSERT INTO public.jobs (employer_id, title, location, job_type, status)
         VALUES ($1, 'Least-privilege orphan fixture', 'Austin', 'full-time', 'active') RETURNING id`, [ids.employerA],
      )).rows[0].id;
      const orphaned = await seedToken(ids.workerA, orphanJob);
      for (const hash of [newTokenHash(), expired, submitted, orphaned]) {
        expect(await resolve(hash, 'resume', 'application/pdf', { flagsFor: victim })).toEqual({ outcome: 'invalid_token', s3_key: null });
      }
      const { rows } = await su.query(
        'SELECT count(*)::int AS n FROM public.document_upload_token_slots WHERE token_hash = ANY($1::text[])', [[expired, submitted, orphaned]],
      );
      expect(rows).toEqual([{ n: 0 }]);
      await su.query('DELETE FROM public.jobs WHERE id = $1', [orphanJob]);
    });

    it('refuses a document type outside the four and a MIME type outside the three', async () => {
      const hash = await seedToken(ids.workerA, ids.jobA);
      expect(await resolve(hash, 'ssn')).toEqual({ outcome: 'invalid_doc_type', s3_key: null });
      expect(await resolve(hash, 'resume', 'image/gif')).toEqual({ outcome: 'invalid_mime_type', s3_key: null });
      expect(await slotRow(hash, 'ssn')).toBeUndefined();
      expect(await slotRow(hash, 'resume')).toBeUndefined();
    });
  });

  describe('upload_token_slot, the read-only pre-check', () => {
    it('returns the size limit for the exact key and MIME type, and refuses a wrong key, type, a confirmed slot or a bad token', async () => {
      const hash = await seedToken(ids.workerA, ids.jobA);
      const { s3_key: key } = await resolve(hash, 'resume');
      const slot = (args: unknown[]) => callAs('jale_api_public', SLOT, args);
      const refused = [{ outcome: 'invalid_or_confirmed_upload', max_file_size: null }];
      expect(await slot([hash, 'resume', key, 'application/pdf'])).toEqual([{ outcome: 'ok', max_file_size: MAX_FILE_SIZE }]);
      expect(await slot([hash, 'resume', `${key}.other`, 'application/pdf'])).toEqual(refused);
      expect(await slot([hash, 'resume', key, 'image/png'])).toEqual(refused);
      expect(await slot([hash, 'driver_license', key, 'application/pdf'])).toEqual(refused);
      expect(await slot([newTokenHash(), 'resume', key, 'application/pdf'])).toEqual(refused);
      await su.query(`UPDATE public.document_upload_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, [hash]);
      expect(await slot([hash, 'resume', key, 'application/pdf'])).toEqual(refused);
    });
  });

  describe('upload_token_confirm', () => {
    it('confirms the slot and stores the document under the token\'s worker and job, with the sanitised name', async () => {
      const hash = await seedToken(ids.workerB, ids.jobB);
      const { s3_key: key } = await resolve(hash, 'driver_license', 'image/jpeg');
      const result = await confirm(hash, key, {
        docType: 'driver_license', mime: 'image/jpeg', fileName: ' ..\\scan/\u0007front.jpg ', size: 4096, version: 'v-7',
      });
      expect(result.outcome).toBe('ok');
      expect(result.document_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(await documents(ids.workerB, ids.jobB)).toEqual([{
        doc_type: 'driver_license', s3_key: key, file_name: '.._scan_front.jpg', file_size: 4096,
        mime_type: 'image/jpeg', s3_version_id: 'v-7', cert_name: null,
      }]);
      expect(await slotRow(hash, 'driver_license')).toMatchObject({ confirmed_at: expect.any(Date), s3_version_id: 'v-7' });
      // A name that sanitises to nothing falls back to <type>.<subtype>; a missing version id is stored as NULL.
      const again = await seedToken(ids.workerB, ids.jobB);
      const { s3_key: next } = await resolve(again, 'driver_license', 'image/png');
      expect((await confirm(again, next, { docType: 'driver_license', mime: 'image/png', fileName: ' \u0007\t ', version: null })).outcome).toBe('ok');
      expect(await documents(ids.workerB, ids.jobB)).toEqual([expect.objectContaining({
        s3_key: next, file_name: 'driver_license.png', s3_version_id: null,
      })]);
    });

    it('replaces the job\'s earlier document of that type, never the vault copy', async () => {
      const vault = await documents(ids.workerA, null);
      expect(vault).toHaveLength(1);
      const first = await seedToken(ids.workerA, ids.jobA);
      const { s3_key: one } = await resolve(first, 'resume');
      expect((await confirm(first, one)).outcome).toBe('ok');
      const second = await seedToken(ids.workerA, ids.jobA);
      const { s3_key: two } = await resolve(second, 'resume');
      expect((await confirm(second, two, { fileName: 'resume-2.pdf' })).outcome).toBe('ok');
      expect((await documents(ids.workerA, ids.jobA)).filter((d) => d.doc_type === 'resume'))
        .toEqual([expect.objectContaining({ s3_key: two, file_name: 'resume-2.pdf' })]);
      expect(await documents(ids.workerA, null)).toEqual(vault);
    });

    it('refuses a replayed confirm, a wrong object key, a wrong type and an out-of-range size, leaving the slot as it was', async () => {
      const victim = { userId: ids.workerB, sub: subs.workerB };
      const hash = await seedToken(ids.workerA, ids.jobA);
      const { s3_key: key } = await resolve(hash, 'driver_license');
      const refused = { outcome: 'invalid_or_confirmed_upload', document_id: null };
      const before = await documents(ids.workerA, ids.jobA);
      const otherToken = await seedToken(ids.workerB, ids.jobB);
      const { s3_key: otherKey } = await resolve(otherToken, 'driver_license');
      expect(await confirm(hash, otherKey, { docType: 'driver_license', ctx: { flagsFor: victim } })).toEqual(refused);
      expect(await confirm(hash, key, { docType: 'resume', ctx: { flagsFor: victim } })).toEqual(refused);
      expect(await confirm(hash, key, { docType: 'driver_license', mime: 'image/png' })).toEqual(refused);
      for (const size of [0, MAX_FILE_SIZE + 1]) {
        expect(await confirm(hash, key, { docType: 'driver_license', size })).toEqual({ outcome: 'invalid_file_size', document_id: null });
      }
      expect(await slotRow(hash, 'driver_license')).toMatchObject({ issued_s3_key: key, confirmed_at: null });
      expect(await documents(ids.workerA, ids.jobA)).toEqual(before);

      expect((await confirm(hash, key, { docType: 'driver_license' })).outcome).toBe('ok');
      const after = await documents(ids.workerA, ids.jobA);
      expect(await confirm(hash, key, { docType: 'driver_license' })).toEqual(refused);
      expect(await documents(ids.workerA, ids.jobA)).toEqual(after);
      // The other worker's slot was never confirmed through this token.
      expect(await slotRow(otherToken, 'driver_license')).toMatchObject({ issued_s3_key: otherKey, confirmed_at: null });
      expect((await documents(ids.workerB, ids.jobB)).map((d) => d.s3_key)).not.toContain(otherKey);
    });

    it('caps certification documents per job (20) and per name (5) without burning the slot', async () => {
      await su.query(
        `INSERT INTO public.worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type, cert_name)
         SELECT $1, $2, 'certification_doc', 'documents/cap/' || $3 || '/' || g, 'c.pdf', 10, 'application/pdf',
                CASE WHEN g <= 5 THEN 'OSHA 10' ELSE 'Other ' || g END
           FROM generate_series(1, 19) AS g`,
        [ids.workerB, ids.jobB, stamp],
      );
      const named = await seedToken(ids.workerB, ids.jobB);
      const { s3_key: namedKey } = await resolve(named, 'certification_doc');
      expect(await confirm(named, namedKey, { docType: 'certification_doc', certName: 'OSHA 10' }))
        .toEqual({ outcome: 'certification_document_name_limit', document_id: null });
      expect(await slotRow(named, 'certification_doc')).toMatchObject({ confirmed_at: null });
      expect((await confirm(named, namedKey, { docType: 'certification_doc', certName: 'Forklift' })).outcome).toBe('ok');

      const full = await seedToken(ids.workerB, ids.jobB);
      const { s3_key: fullKey } = await resolve(full, 'certification_doc');
      expect(await confirm(full, fullKey, { docType: 'certification_doc', certName: 'Crane' }))
        .toEqual({ outcome: 'certification_document_limit', document_id: null });
      expect(await slotRow(full, 'certification_doc')).toMatchObject({ confirmed_at: null });
      const { rows } = await su.query(
        `SELECT count(*)::int AS n FROM public.worker_documents WHERE worker_id = $1 AND job_id = $2 AND doc_type = 'certification_doc'`,
        [ids.workerB, ids.jobB],
      );
      expect(rows).toEqual([{ n: 20 }]);
      await su.query(`DELETE FROM public.worker_documents WHERE worker_id = $1 AND doc_type = 'certification_doc'`, [ids.workerB]);
    });

    it('answers document_conflict when a concurrent upload of the same type wins, leaving the slot unconfirmed', async () => {
      const hash = await seedToken(ids.workerB, ids.jobB);
      const { s3_key: key } = await resolve(hash, 'work_auth_doc');
      const racer = new Client({ connectionString: databaseUrl });
      await racer.connect();
      const caller = loginClient('jale_api_public');
      await caller.connect();
      try {
        await su.query('DELETE FROM public.worker_documents WHERE worker_id = $1 AND job_id = $2 AND doc_type = $3', [ids.workerB, ids.jobB, 'work_auth_doc']);
        await racer.query('BEGIN');
        await racer.query(
          `INSERT INTO public.worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type)
           VALUES ($1, $2, 'work_auth_doc', $3, 'racer.pdf', 10, 'application/pdf')`,
          [ids.workerB, ids.jobB, `documents/race/${stamp}`],
        );
        const pid = (await caller.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const pending = caller.query(CONFIRM, [hash, 'work_auth_doc', key, 'application/pdf', 'mine.pdf', 10, 'v1', null]);
        for (let i = 0; i < 100; i += 1) {
          const { rows } = await su.query(`SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`, [pid]);
          if (rows[0]?.wait_event_type === 'Lock') break;
          await new Promise((r) => setTimeout(r, 50));
        }
        await racer.query('COMMIT');
        expect((await pending).rows).toEqual([{ outcome: 'document_conflict', document_id: null }]);
      } finally {
        await racer.query('ROLLBACK').catch(() => undefined);
        await racer.end();
        await caller.end();
      }
      expect(await slotRow(hash, 'work_auth_doc')).toMatchObject({ confirmed_at: null });
      expect(await documents(ids.workerB, ids.jobB)).toEqual(
        expect.arrayContaining([expect.objectContaining({ doc_type: 'work_auth_doc', file_name: 'racer.pdf' })]),
      );
    });

    it('raises 22023 for a certification name on another document type', async () => {
      const hash = await seedToken(ids.workerA, ids.jobA);
      const { s3_key: key } = await resolve(hash, 'driver_license');
      expect(await sqlstate(confirm(hash, key, { docType: 'driver_license', certName: 'OSHA 10' }))).toBe('22023');
      expect(await slotRow(hash, 'driver_license')).toMatchObject({ confirmed_at: null });
    });
  });

  describe('upload_token_submit', () => {
    it('needs a confirmed slot, then marks the token used once, keeping the first time on a repeat', async () => {
      const hash = await seedToken(ids.workerA, ids.jobA);
      expect(await callAs('jale_api_public', SUBMIT, [hash])).toEqual([{ outcome: 'confirm_required' }]);
      const { s3_key: key } = await resolve(hash, 'resume');
      expect((await confirm(hash, key)).outcome).toBe('ok');
      expect(await callAs('jale_api_public', SUBMIT, [hash])).toEqual([{ outcome: 'ok' }]);
      const first = (await su.query('SELECT used, used_at FROM public.document_upload_tokens WHERE token_hash = $1', [hash])).rows[0];
      expect(first.used).toBe(true);
      expect(first.used_at).toBeInstanceOf(Date);
      expect(await callAs('jale_api_public', SUBMIT, [hash])).toEqual([{ outcome: 'ok' }]);
      expect((await su.query('SELECT used_at FROM public.document_upload_tokens WHERE token_hash = $1', [hash])).rows[0].used_at)
        .toEqual(first.used_at);

      // A submitted token resolves and confirms nothing more.
      expect(await resolve(hash, 'driver_license')).toEqual({ outcome: 'invalid_token', s3_key: null });
      const { s3_key: stale } = (await su.query(
        `SELECT issued_s3_key AS s3_key FROM public.document_upload_token_slots WHERE token_hash = $1 AND doc_type = 'resume'`, [hash],
      )).rows[0];
      expect(await confirm(hash, stale)).toEqual({ outcome: 'invalid_or_confirmed_upload', document_id: null });
    });

    it('refuses an unknown or expired token', async () => {
      const expired = await seedToken(ids.workerA, ids.jobA, { expires: '-1 second' });
      await su.query(
        `INSERT INTO public.document_upload_token_slots (token_hash, doc_type, issued_s3_key, expected_mime_type, max_file_size, confirmed_at)
         VALUES ($1, 'resume', $2, 'application/pdf', $3, now())`,
        [expired, `documents/expired/${stamp}`, MAX_FILE_SIZE],
      );
      expect(await callAs('jale_api_public', SUBMIT, [expired])).toEqual([{ outcome: 'invalid_token' }]);
      expect(await callAs('jale_api_public', SUBMIT, [newTokenHash()])).toEqual([{ outcome: 'invalid_token' }]);
      expect((await su.query('SELECT used FROM public.document_upload_tokens WHERE token_hash = $1', [expired])).rows[0].used).toBe(false);
    });
  });
});
