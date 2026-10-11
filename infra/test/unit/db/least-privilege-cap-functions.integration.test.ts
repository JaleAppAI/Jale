/**
 * least-privilege-cap-functions.integration.test.ts -- the jale_cap
 * capability functions on a real bed.
 *
 * Each capability function is a SECURITY DEFINER with a catalog-only
 * search_path, owned by a NOLOGIN owner role, closed to PUBLIC and executable
 * by exactly the login that calls it. This suite proves that contract from the
 * catalog and over real authenticated connections (never SET ROLE): the
 * caller reaches the function body, and every other runtime login is refused
 * with 42501 before it does.
 *
 * The expected signatures, owners and callers come from the access manifest
 * (infra/db/access/manifest.json), which infra/db/access/SIGNATURES.md
 * documents for the code that calls these functions.
 *
 * Connection: JALE_TEST_DATABASE_URL (the bed's superuser URL); logins sign in
 * through helpers/login-pool with the bed's fixed test passwords.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import * as path from 'node:path';
import {
  loadManifest, parseManifest, readManifestFiles, runtimeLogins, type FunctionEntry,
} from '../../../db/access/access-manifest';
import { setEveryCapabilityFlag, type FlagVictim } from './helpers/capability-flags';
import { loginClient, withLoginClient } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: least-privilege capability functions PostgreSQL gate was not run', () => {
    console.warn('[least-privilege-cap-functions] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

const manifest = loadManifest();
/** Every jale_cap function of the merged manifest, a later change's fragment included. */
const capFunctions: Array<[string, FunctionEntry]> = Object.entries(manifest.functions)
  .filter(([signature]) => signature.startsWith('jale_cap.'))
  .sort(([a], [b]) => a.localeCompare(b));
/** The capability functions migration 105 creates: manifest.json's own entries. */
const baseManifest = parseManifest(readManifestFiles(path.join(__dirname, '..', '..', '..', 'db', 'access')).base);
const ownCapFunctions = new Set(Object.entries(baseManifest.functions)
  .filter(([signature, fn]) => signature.startsWith('jale_cap.') && fn.created_by === '105')
  .map(([signature]) => signature));

/** `jale_cap.f(text, uuid)` -> `SELECT * FROM jale_cap.f(NULL::text, NULL::uuid)`. */
function nullCall(signature: string): string {
  const open = signature.indexOf('(');
  const name = signature.slice(0, open);
  const types = signature.slice(open + 1, -1).split(',').map((t) => t.trim()).filter(Boolean);
  return `SELECT * FROM ${name}(${types.map((t) => `NULL::${t}`).join(', ')})`;
}

/**
 * How a call ends for a login: `refused` when PostgreSQL turns the login away
 * before the body runs (no EXECUTE, or no USAGE on the schema), otherwise
 * `reached` -- the body ran, whatever it answered. A body raises 42501 too
 * (an unset caller context), so the SQLSTATE alone cannot tell the two apart.
 */
async function reachOf(client: Client, sql: string): Promise<'reached' | 'refused'> {
  try {
    await client.query(sql);
    return 'reached';
  } catch (err) {
    const { code, message } = err as { code?: string; message: string };
    return code === '42501' && /^permission denied for (function|schema) /.test(message) ? 'refused' : 'reached';
  }
}

maybeDescribe('jale_cap capability functions', () => {
  let su: Client;
  const clients = new Map<string, Client>();

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
    for (const login of runtimeLogins(manifest)) {
      const client = loginClient(login);
      await client.connect();
      clients.set(login, client);
    }
  });

  afterAll(async () => {
    for (const client of clients.values()) await client.end();
    await su?.end();
  });

  it('manifest.json lists every capability function 105 creates: the re-owned definers and the job-messaging triggers included', () => {
    expect([...ownCapFunctions].sort()).toEqual([
      'jale_cap.apply_ses_feedback(text)',
      'jale_cap.employer_claim_worker_intent(uuid, text, uuid, jsonb, jsonb)',
      'jale_cap.employer_stage_recipient(uuid)',
      'jale_cap.employer_worker_delivery_context(uuid)',
      'jale_cap.job_conversation_application_guard()',
      'jale_cap.job_message_outbox_recipient()',
      'jale_cap.list_stale_job_outbox_workers(interval)',
      'jale_cap.resolve_share_link(text)',
      'jale_cap.retention_purge(integer)',
      'jale_cap.sync_job_hired_counts()',
      'jale_cap.upload_token_confirm(text, text, text, text, text, integer, text, text)',
      'jale_cap.upload_token_issue(text, uuid, uuid)',
      'jale_cap.upload_token_resolve(text, text, text)',
      'jale_cap.upload_token_slot(text, text, text, text)',
      'jale_cap.upload_token_submit(text)',
    ]);
  });

  it('jale_cap is owned by the master and closed to PUBLIC', async () => {
    const { rows } = await su.query<{ owner: string; public_usage: boolean; public_create: boolean }>(
      `SELECT pg_catalog.pg_get_userbyid(n.nspowner) AS owner,
              EXISTS (SELECT 1 FROM aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
                       WHERE a.grantee = 0 AND a.privilege_type = 'USAGE') AS public_usage,
              EXISTS (SELECT 1 FROM aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
                       WHERE a.grantee = 0 AND a.privilege_type = 'CREATE') AS public_create
         FROM pg_catalog.pg_namespace n WHERE n.nspname = 'jale_cap'`,
    );
    expect(rows).toEqual([{ owner: manifest.master, public_usage: false, public_create: false }]);
  });

  it('only the callers of a capability function hold USAGE on jale_cap', async () => {
    const callers = new Set(capFunctions.flatMap(([, fn]) => fn.execute));
    const { rows } = await su.query<{ login: string; usage: boolean }>(
      `SELECT r.rolname AS login, pg_catalog.has_schema_privilege(r.oid, 'jale_cap', 'USAGE') AS usage
         FROM pg_catalog.pg_roles r WHERE r.rolname = ANY($1::text[])`,
      [runtimeLogins(manifest)],
    );
    const actual = rows.map((r) => [r.login, r.usage]).sort();
    expect(actual).toEqual(runtimeLogins(manifest).map((login) => [login, callers.has(login)]).sort());
  });

  describe.each(capFunctions)('%s', (signature, fn) => {
    it('matches its manifest entry: arguments, result, owner, definer, pinned search_path', async () => {
      const { rows } = await su.query(
        `SELECT pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments,
                pg_catalog.pg_get_function_result(p.oid) AS returns,
                pg_catalog.pg_get_userbyid(p.proowner) AS owner,
                p.prosecdef AS definer,
                p.proconfig AS config
           FROM pg_catalog.pg_proc p
          WHERE p.oid = pg_catalog.to_regprocedure($1)`,
        [signature],
      );
      expect(rows).toEqual([{
        arguments: fn.arguments,
        returns: fn.returns,
        owner: fn.owner,
        definer: fn.security === 'definer',
        config: [`search_path=${fn.search_path}`],
      }]);
    });

    it('is executable by its owner and its callers only, never by PUBLIC', async () => {
      const { rows } = await su.query<{ grantee: string }>(
        `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END AS grantee
           FROM pg_catalog.pg_proc p,
                LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
          WHERE p.oid = pg_catalog.to_regprocedure($1) AND a.privilege_type = 'EXECUTE'`,
        [signature],
      );
      expect(rows.map((r) => r.grantee).sort()).toEqual([fn.owner, ...fn.execute].sort());
    });

    // A trigger function cannot be called at all; its EXECUTE right is
    // proven from the catalog instead (no runtime login holds it).
    const isTrigger = fn.returns === 'trigger';

    it('its caller reaches the body over a real connection', async () => {
      for (const caller of fn.execute) {
        const client = clients.get(caller);
        expect(client).toBeDefined();
        expect([caller, await reachOf(client!, nullCall(signature))]).toEqual([caller, 'reached']);
      }
    });

    it('every other runtime login is refused before the body runs (42501)', async () => {
      const others = runtimeLogins(manifest).filter((login) => !fn.execute.includes(login));
      const outcomes = [];
      for (const login of others) {
        if (isTrigger) {
          const { rows } = await su.query<{ executes: boolean }>(
            'SELECT pg_catalog.has_function_privilege($1, pg_catalog.to_regprocedure($2), \'EXECUTE\') AS executes',
            [login, signature],
          );
          outcomes.push([login, rows[0].executes ? 'reached' : 'refused']);
        } else {
          outcomes.push([login, await reachOf(clients.get(login)!, nullCall(signature))]);
        }
      }
      expect(outcomes).toEqual(others.map((login) => [login, 'refused']));
    });
  });
});

/**
 * Migration 105 makes job-scoped documents and upload tokens cascade from
 * their job, so the request login deletes a job without holding any right on
 * those tables. Before 105 the same delete failed with 23503.
 */
maybeDescribe('job-scoped documents follow their job', () => {
  let su: Client;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const employerSub = `lp-d2-employer-${stamp}`;
  const workerSub = `lp-d2-worker-${stamp}`;
  const tokenHash = `lp-d2-token-${stamp}`;
  let employerId = '';
  let workerId = '';
  let jobId = '';

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
    employerId = (await su.query<{ id: string }>(
      `INSERT INTO public.users (cognito_sub, user_type) VALUES ($1, 'employer') RETURNING id`, [employerSub],
    )).rows[0].id;
    workerId = (await su.query<{ id: string }>(
      `INSERT INTO public.users (cognito_sub, user_type) VALUES ($1, 'worker') RETURNING id`, [workerSub],
    )).rows[0].id;
    jobId = (await su.query<{ id: string }>(
      `INSERT INTO public.jobs (employer_id, title, location, job_type, status)
       VALUES ($1, 'Least-privilege cascade fixture', 'Austin', 'full-time', 'active') RETURNING id`, [employerId],
    )).rows[0].id;
    await su.query(`INSERT INTO public.job_applications (job_id, worker_id) VALUES ($1, $2)`, [jobId, workerId]);
    await su.query(
      `INSERT INTO public.worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type)
       VALUES ($1, $2, 'resume', 'documents/lp-d2/resume.pdf', 'resume.pdf', 1024, 'application/pdf')`,
      [workerId, jobId],
    );
    await su.query(
      `INSERT INTO public.document_upload_tokens (token_hash, worker_id, job_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [tokenHash, workerId, jobId],
    );
  });

  afterAll(async () => {
    if (su) {
      await su.query('DELETE FROM public.document_upload_tokens WHERE token_hash = $1', [tokenHash]);
      await su.query('DELETE FROM public.worker_documents WHERE worker_id = $1', [workerId]);
      await su.query('DELETE FROM public.jobs WHERE id = $1', [jobId]);
      await su.query('DELETE FROM public.users WHERE cognito_sub = ANY($1::text[])', [[employerSub, workerSub]]);
      await su.end();
    }
  });

  it('the request login, as the employer, deletes the job and its job-scoped documents and tokens go with it', async () => {
    const deleted = await withLoginClient('jale_api', async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [employerSub]);
        await client.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [employerId]);
        const result = await client.query('DELETE FROM public.jobs WHERE id = $1 AND employer_id = $2', [jobId, employerId]);
        await client.query('COMMIT');
        return result.rowCount;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    });
    expect(deleted).toBe(1);
    const { rows } = await su.query<{ docs: number; tokens: number; applications: number }>(
      `SELECT (SELECT count(*) FROM public.worker_documents WHERE job_id = $1)::int AS docs,
              (SELECT count(*) FROM public.document_upload_tokens WHERE job_id = $1)::int AS tokens,
              (SELECT count(*) FROM public.job_applications WHERE job_id = $1)::int AS applications`,
      [jobId],
    );
    expect(rows).toEqual([{ docs: 0, tokens: 0, applications: 0 }]);
  });
});

/** Runs `sql` as `login` in its own transaction, after setting every capability flag for `victim` when given, and commits. */
async function callAs<T extends object>(
  login: string, sql: string, params: unknown[], victim?: FlagVictim,
): Promise<T[]> {
  return withLoginClient(login, async (client) => {
    await client.query('BEGIN');
    try {
      if (victim) await setEveryCapabilityFlag(client, victim);
      const { rows } = await client.query<T>(sql, params);
      await client.query('COMMIT');
      return rows;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  });
}

async function sqlstateOfCall(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const shareCode = () => Array.from(randomBytes(8), (b) => CROCKFORD[b % 32]).join('');
const hex64 = () => randomBytes(32).toString('hex');

/**
 * The share-link lookup: one active link for a presented code;
 * the request login cannot list links or read a revoked one.
 */
maybeDescribe('jale_cap.resolve_share_link', () => {
  let su: Client;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const subs = { employer: `lp-sl-employer-${stamp}`, worker: `lp-sl-worker-${stamp}` };
  const ids = { employer: '', worker: '', job: '' };
  const codes = { active: shareCode(), revoked: shareCode(), employer: shareCode() };
  const RESOLVE = 'SELECT * FROM jale_cap.resolve_share_link($1)';

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
    ids.employer = (await su.query<{ id: string }>(
      `INSERT INTO public.users (cognito_sub, user_type) VALUES ($1, 'employer') RETURNING id`, [subs.employer])).rows[0].id;
    ids.worker = (await su.query<{ id: string }>(
      `INSERT INTO public.users (cognito_sub, user_type) VALUES ($1, 'worker') RETURNING id`, [subs.worker])).rows[0].id;
    ids.job = (await su.query<{ id: string }>(
      `INSERT INTO public.jobs (employer_id, title, location, job_type, status)
       VALUES ($1, 'Least-privilege share fixture', 'Austin', 'full-time', 'active') RETURNING id`, [ids.employer])).rows[0].id;
    await su.query(
      `INSERT INTO public.job_share_links (code, job_id, referrer_worker_id, referrer_employer_id, channel, revoked_at)
       VALUES ($1, $4, $5, NULL, 'whatsapp', NULL), ($2, $4, $5, NULL, 'sms', now()), ($3, $4, NULL, $6, 'copy_link', NULL)`,
      [codes.active, codes.revoked, codes.employer, ids.job, ids.worker, ids.employer],
    );
  });

  afterAll(async () => {
    if (!su) return;
    await su.query('DELETE FROM public.job_share_links WHERE code = ANY($1::text[])', [Object.values(codes)]);
    await su.query('DELETE FROM public.jobs WHERE id = $1', [ids.job]);
    await su.query('DELETE FROM public.users WHERE cognito_sub = ANY($1::text[])', [Object.values(subs)]);
    await su.end();
  });

  it('returns the one active link for a code, with either referrer', async () => {
    expect(await callAs('jale_api', RESOLVE, [codes.active])).toEqual([
      { job_id: ids.job, channel: 'whatsapp', referrer_worker_id: ids.worker, referrer_employer_id: null },
    ]);
    expect(await callAs('jale_api', RESOLVE, [codes.employer])).toEqual([
      { job_id: ids.job, channel: 'copy_link', referrer_worker_id: null, referrer_employer_id: ids.employer },
    ]);
  });

  it('gives no row for a revoked, unknown, malformed or missing code, whatever flags are set', async () => {
    const victim = { userId: ids.worker, sub: subs.worker };
    for (const code of [codes.revoked, shareCode(), codes.active.toLowerCase(), `JALE${codes.active}`, `${codes.active}0`, '', null]) {
      expect([code, await callAs('jale_api', RESOLVE, [code], victim)]).toEqual([code, []]);
    }
  });

  it('cannot list links: the request login reads no link directly', async () => {
    expect(await sqlstateOfCall(callAs('jale_api', 'SELECT code FROM public.job_share_links WHERE revoked_at IS NULL', []))).toBe(null);
    expect(await callAs('jale_api', 'SELECT code FROM public.job_share_links WHERE code = ANY($1::text[])', [Object.values(codes)]))
      .toEqual([]);
  });
});

/**
 * The delivery-feedback job: one call per actionable
 * notification. A digest's employer is switched off through 090's function;
 * anything else is reported and left alone.
 */
maybeDescribe('jale_cap.apply_ses_feedback', () => {
  let su: Client;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const subs = { employer: `lp-ses-employer-${stamp}`, victim: `lp-ses-victim-${stamp}` };
  const ids = { employer: '', victim: '' };
  const messages = { digest: `lp-ses-digest-${stamp}`, billing: `lp-ses-billing-${stamp}` };
  const APPLY = 'SELECT * FROM jale_cap.apply_ses_feedback($1)';

  async function settings(employer: string) {
    return (await su.query<{ enabled: boolean; unsubscribe_token_version: number }>(
      'SELECT enabled, unsubscribe_token_version FROM public.employer_digest_settings WHERE employer_id = $1', [employer])).rows[0];
  }

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
    for (const name of ['employer', 'victim'] as const) {
      ids[name] = (await su.query<{ id: string }>(
        `INSERT INTO public.users (cognito_sub, user_type) VALUES ($1, 'employer') RETURNING id`, [subs[name]])).rows[0].id;
      await su.query('INSERT INTO public.employer_digest_settings (employer_id, enabled) VALUES ($1, true)', [ids[name]]);
    }
    await su.query(
      `INSERT INTO public.email_outbox (recipient_email, subject, body_text, source_type, source_id, status, sent_at, ses_message_id)
       VALUES ('digest@example.com', 'Digest', 'Body', 'employer_digest', $1, 'sent', now(), $2),
              ('billing@example.com', 'Billing', 'Body', 'billing_pause', $3, 'sent', now(), $4)`,
      [ids.employer, messages.digest, randomUUID(), messages.billing],
    );
  });

  afterAll(async () => {
    if (!su) return;
    await su.query('DELETE FROM public.email_outbox WHERE ses_message_id = ANY($1::text[])', [Object.values(messages)]);
    await su.query('DELETE FROM public.employer_digest_settings WHERE employer_id = ANY($1::uuid[])', [[ids.employer, ids.victim]]);
    await su.query('DELETE FROM public.users WHERE cognito_sub = ANY($1::text[])', [Object.values(subs)]);
    await su.end();
  });

  it('switches off the digest the bounced message was sent for, once, and only that one, whatever flags are set', async () => {
    const victim = { userId: ids.victim, sub: subs.victim };
    expect(await callAs('jale_job_ses_feedback', APPLY, [messages.digest], victim))
      .toEqual([{ outcome: 'digest', source_type: 'employer_digest', changed: 1 }]);
    expect(await settings(ids.employer)).toEqual({ enabled: false, unsubscribe_token_version: 2 });
    expect(await callAs('jale_job_ses_feedback', APPLY, [messages.digest]))
      .toEqual([{ outcome: 'digest', source_type: 'employer_digest', changed: 0 }]);
    expect(await settings(ids.employer)).toEqual({ enabled: false, unsubscribe_token_version: 2 });
    expect(await settings(ids.victim)).toEqual({ enabled: true, unsubscribe_token_version: 1 });
  });

  it('reports a message that is not a digest, and an unknown one, without writing', async () => {
    expect(await callAs('jale_job_ses_feedback', APPLY, [messages.billing]))
      .toEqual([{ outcome: 'not_digest', source_type: 'billing_pause', changed: 0 }]);
    expect(await callAs('jale_job_ses_feedback', APPLY, [`lp-ses-unknown-${stamp}`]))
      .toEqual([{ outcome: 'unknown_message', source_type: null, changed: 0 }]);
    expect(await settings(ids.victim)).toEqual({ enabled: true, unsubscribe_token_version: 1 });
  });

  it('raises 22023 for an empty or missing message id', async () => {
    expect(await sqlstateOfCall(callAs('jale_job_ses_feedback', APPLY, ['']))).toBe('22023');
    expect(await sqlstateOfCall(callAs('jale_job_ses_feedback', APPLY, [null]))).toBe('22023');
  });
});

/**
 * The referral retention job: expired rows only, in bounded batches, with
 * the ages the job has always used.
 */
maybeDescribe('jale_cap.retention_purge', () => {
  let su: Client;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const employerSub = `lp-ret-employer-${stamp}`;
  const workerSub = `lp-ret-worker-${stamp}`;
  let job = '';
  let worker = '';
  const tokens = { old: hex64(), consumedOld: hex64(), recent: hex64() };
  const claims = { claimedOld: hex64(), claimedRecent: hex64(), unclaimedOld: hex64(), unclaimedRecent: hex64() };
  const opens = { old: randomUUID(), recent: randomUUID() };
  const PURGE = 'SELECT * FROM jale_cap.retention_purge($1)';

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
    const employer = (await su.query<{ id: string }>(
      `INSERT INTO public.users (cognito_sub, user_type) VALUES ($1, 'employer') RETURNING id`, [employerSub])).rows[0].id;
    worker = (await su.query<{ id: string }>(
      `INSERT INTO public.users (cognito_sub, user_type) VALUES ($1, 'worker') RETURNING id`, [workerSub])).rows[0].id;
    job = (await su.query<{ id: string }>(
      `INSERT INTO public.jobs (employer_id, title, location, job_type, status)
       VALUES ($1, 'Least-privilege retention fixture', 'Austin', 'full-time', 'active') RETURNING id`, [employer])).rows[0].id;
    await su.query(
      `INSERT INTO public.referral_apply_tokens (token_hash, job_id, expires_at, consumed_at, consumed_phone_hash)
       VALUES ($1, $4, now() - interval '8 days', NULL, NULL),
              ($2, $4, now() - interval '8 days', now() - interval '9 days', $5),
              ($3, $4, now() - interval '6 days', NULL, NULL)`,
      [tokens.old, tokens.consumedOld, tokens.recent, job, hex64()],
    );
    await su.query(
      `INSERT INTO public.referral_pending_claims (phone_hash, job_id, expires_at, claimed_at, claimed_worker_id)
       VALUES ($1, $5, now(), now() - interval '31 days', $6),
              ($2, $5, now(), now() - interval '29 days', $6),
              ($3, $5, now() - interval '31 days', NULL, NULL),
              ($4, $5, now() + interval '1 day', NULL, NULL)`,
      [claims.claimedOld, claims.claimedRecent, claims.unclaimedOld, claims.unclaimedRecent, job, worker],
    );
    await su.query(
      `INSERT INTO public.job_share_opens (id, job_id, device_kind, opened_at)
       VALUES ($1, $3, 'mobile', now() - interval '401 days'), ($2, $3, 'mobile', now() - interval '399 days')`,
      [opens.old, opens.recent, job],
    );
  });

  afterAll(async () => {
    if (!su) return;
    await su.query('DELETE FROM public.jobs WHERE id = $1', [job]);
    await su.query('DELETE FROM public.users WHERE cognito_sub = ANY($1::text[])', [[employerSub, workerSub]]);
    await su.end();
  });

  async function remaining() {
    const { rows } = await su.query<{ tokens: string[]; claims: string[]; opens: string[] }>(
      `SELECT ARRAY(SELECT token_hash FROM public.referral_apply_tokens WHERE job_id = $1 ORDER BY token_hash) AS tokens,
              ARRAY(SELECT phone_hash FROM public.referral_pending_claims WHERE job_id = $1 ORDER BY phone_hash) AS claims,
              ARRAY(SELECT id::text FROM public.job_share_opens WHERE job_id = $1 ORDER BY id) AS opens`,
      [job],
    );
    return rows[0];
  }

  it('deletes exactly the rows past their retention age, whatever flags are set', async () => {
    const victim = { userId: worker, sub: workerSub };
    let purged: { tokens_deleted: number; claims_deleted: number; opens_deleted: number };
    do {
      [purged] = await callAs('jale_job_retention', PURGE, [5000], victim);
    } while (purged.tokens_deleted === 5000 || purged.claims_deleted === 5000 || purged.opens_deleted === 5000);
    expect(await remaining()).toEqual({
      tokens: [tokens.recent],
      claims: [claims.claimedRecent, claims.unclaimedRecent].sort(),
      opens: [opens.recent],
    });
  });

  it('deletes at most the batch from each table per call', async () => {
    const extra = [randomUUID(), randomUUID(), randomUUID()];
    await su.query(
      `INSERT INTO public.job_share_opens (id, job_id, device_kind, opened_at)
       SELECT id, $2, 'unknown', now() - interval '500 days' FROM unnest($1::uuid[]) AS id`,
      [extra, job],
    );
    const [first] = await callAs<{ opens_deleted: number }>('jale_job_retention', PURGE, [2]);
    expect(first.opens_deleted).toBe(2);
    let total = first.opens_deleted;
    for (let last = first.opens_deleted; last === 2;) {
      const [next] = await callAs<{ opens_deleted: number }>('jale_job_retention', PURGE, [2]);
      last = next.opens_deleted;
      total += last;
    }
    expect(total).toBeGreaterThanOrEqual(3);
    expect((await remaining()).opens).toEqual([opens.recent]);
  });

  it('raises 22023 for a batch outside 1..5000', async () => {
    for (const batch of [0, 5001, -1, null]) {
      expect([batch, await sqlstateOfCall(callAs('jale_job_retention', PURGE, [batch]))]).toEqual([batch, '22023']);
    }
  });
});
