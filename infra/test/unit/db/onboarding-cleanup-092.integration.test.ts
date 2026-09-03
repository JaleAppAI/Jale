/**
 * onboarding-cleanup-092.integration.test.ts
 *
 * Sprint 23 L8. The PostgreSQL gate for migration
 * 092_onboarding_cleanup_drops.sql, which is a DROP-ONLY migration: it
 * removes migration 053 in full (the web-worker onboarding bypass definer,
 * its `users_web_worker_bypass_definer` UPDATE policy and its
 * `SELECT (email)` column grant), migration 052's pending-signup-name half
 * (both SECURITY DEFINER functions and `users.pending_full_name` /
 * `_set_at`), migration 006's v1 trust columns (`users.trust_signals` /
 * `_completed_at`), and the 022/080 `enforce_job_application_required_docs()`
 * function whose trigger 091 already retired.
 *
 * WHY THIS NEEDS A REAL DATABASE
 * Every fact here is a catalog or ACL fact, and a mocked pool has neither.
 * Three failure modes in particular are invisible anywhere else:
 *
 *   1. A WIDENED REVOKE. `REVOKE SELECT (email) ON users FROM jale_whatsapp`
 *      and `REVOKE SELECT ON users FROM jale_whatsapp` differ by one pair of
 *      parentheses. The second one type-checks, applies without error, and
 *      silently takes 004's fourteen-column lookup grant, 041's
 *      tos_accepted_at and 049's privacy_accepted_at with it -- which turns
 *      every WhatsApp inbound turn into a 42501. So this suite does not only
 *      assert that the email grant is GONE; it re-reads every neighbouring
 *      column grant and proves the role can still run its real lookup.
 *   2. DROPPING THE WRONG GUARD. `enforce_job_application_required_docs`
 *      (dead, dropped) and `enforce_job_application_hire_requirements`
 *      (091's live hire gate) differ by two words. Dropping the second would
 *      un-gate every hire and no unit test would notice.
 *   3. A DOOR THAT NEEDED THE DROPPED OBJECT AFTER ALL. A policy is never
 *      referenced by name, so grep cannot prove `users_web_worker_bypass_definer`
 *      was unused. The last group drives the two doors that a
 *      web-registered worker actually travels -- 086's
 *      `start_web_onboarding_workflow` and 087's
 *      `bind_verified_identity_and_start_workflow` -- against the real
 *      policies, with the bypass gone.
 *
 * IT ALSO CARRIES THE SURVIVING HALF OF THE DELETED 052 SUITE.
 * `whatsapp-onboarding-052.integration.test.ts` was deregistered and deleted
 * in the same PR because 092 dropped the objects its five staging cases
 * exercised. Its other four cases covered migration 052's SECOND half --
 * the `worker_skills` DELETE grant and policy, `saveTrustAnswer`'s
 * upsert-by-question_index, and `findPreviousStepKey` -- all of which 092
 * deliberately KEEPS. They are reproduced verbatim in the last group rather
 * than deleted with the file: deregistering a suite must never be a quiet
 * way to lose coverage.
 *
 * Set JALE_TEST_DATABASE_URL to a SUPERUSER connection string for a
 * disposable PostgreSQL 16 database with migrations 001-092 applied (see
 * db/local/bootstrap-testbed.sh). Fixture setup and verification reads use
 * that superuser connection; every role-scoped call goes through a separate
 * pool authenticated as `jale_whatsapp` (test-whatsapp-pw).
 */
import { randomUUID, createHash } from 'node:crypto';
import { Client, Pool, type PoolClient } from 'pg';

import {
  findPreviousStepKey,
  resetPendingTrustAssessmentAndSkills,
} from '../../../lambda/whatsapp/lib/onboarding-repository';
import { createOnboardingV2Adapters } from '../../../lambda/whatsapp/lib/onboarding-adapters';
import { setInternalUserRlsContext } from '../../../lambda/lib/db';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('CONCERN: the migration-092 cleanup gate was not run', () => {
    // eslint-disable-next-line no-console
    console.warn(
      '[onboarding-cleanup-092] DONE_WITH_CONCERNS: set JALE_TEST_DATABASE_URL to a ' +
        'disposable PostgreSQL 16 superuser URL with migrations 001-092 applied to run ' +
        'the real-PostgreSQL cleanup gate.',
    );
    expect(databaseUrl).toBeUndefined();
  });
}

function maybeDescribe(name: string, fn: () => void): void {
  if (databaseUrl) describe(name, fn);
  else describe.skip(name, fn);
}

function urlForRole(baseUrl: string, user: string, password: string): string {
  const u = new URL(baseUrl);
  u.username = user;
  u.password = password;
  return u.toString();
}

/** Structural cast — the modules under test type their client parameter as
 * `PoolClient` but only ever call query/BEGIN/COMMIT on it. */
function pc(client: Client): PoolClient {
  return client as unknown as PoolClient;
}

// ---------------------------------------------------------------------------
// Group 1-3: the catalog/ACL contract.
// ---------------------------------------------------------------------------
maybeDescribe('migration 092: the dropped objects are absent', () => {
  let su: Client;

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
  });

  afterAll(async () => {
    await su.end();
  });

  test('053 is gone in full: the bypass definer, its UPDATE policy, and its users.email grant', async () => {
    const fn = await su.query<{ oid: string | null }>(
      `SELECT to_regprocedure('public.bypass_onboarding_for_web_worker(uuid,uuid,text,text,text)')::text AS oid`,
    );
    expect(fn.rows[0].oid).toBeNull();

    const policy = await su.query(
      `SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'users'
          AND policyname = 'users_web_worker_bypass_definer'`,
    );
    expect(policy.rowCount).toBe(0);

    // privilege_type is pinned to SELECT on purpose. column_privileges
    // expands 004's TABLE-level INSERT grant across every column, so
    // users.email legitimately still carries an INSERT row that 092 neither
    // created nor removed. An unscoped query here would read that as a
    // surviving 053 grant.
    const emailSelect = await su.query(
      `SELECT 1 FROM information_schema.column_privileges
        WHERE grantee = 'jale_whatsapp' AND table_schema = 'public'
          AND table_name = 'users' AND column_name = 'email'
          AND privilege_type = 'SELECT'`,
    );
    expect(emailSelect.rowCount).toBe(0);
  });

  test('052 half one is gone: both pending-name definers and both users columns', async () => {
    const fns = await su.query<{ stage: string | null; promote: string | null }>(
      `SELECT to_regprocedure('public.stage_worker_pending_name(text,text)')::text   AS stage,
              to_regprocedure('public.promote_worker_pending_name(text)')::text      AS promote`,
    );
    expect(fns.rows[0]).toEqual({ stage: null, promote: null });

    const cols = await su.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users'
          AND column_name IN ('pending_full_name', 'pending_full_name_set_at')`,
    );
    expect(cols.rows).toEqual([]);
  });

  test('006 is gone: users.trust_signals and trust_signals_completed_at, with their grants', async () => {
    const cols = await su.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users'
          AND column_name IN ('trust_signals', 'trust_signals_completed_at')`,
    );
    expect(cols.rows).toEqual([]);

    // Dropping a column discards its ACL entries, so this is really an
    // assertion that no later migration re-added a column of that name with
    // grants attached.
    const privs = await su.query(
      `SELECT 1 FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = 'users'
          AND column_name IN ('trust_signals', 'trust_signals_completed_at')`,
    );
    expect(privs.rowCount).toBe(0);
  });

  test('022/080 is gone: the retired guard function -- and 091 hire gate is NOT', async () => {
    const dead = await su.query<{ count: string }>(
      `SELECT count(*) FROM pg_proc WHERE proname = 'enforce_job_application_required_docs'`,
    );
    expect(dead.rows).toEqual([{ count: '0' }]);

    const trigger = await su.query<{ count: string }>(
      `SELECT count(*) FROM pg_trigger
        WHERE tgname = 'job_applications_required_docs_guard'
          AND tgrelid = 'public.job_applications'::regclass
          AND NOT tgisinternal`,
    );
    expect(trigger.rows).toEqual([{ count: '0' }]);

    // The name that differs by two words and must have survived. Dropping
    // this one instead would leave every hire un-gated.
    const live = await su.query<{ count: string }>(
      `SELECT count(*) FROM pg_proc WHERE proname = 'enforce_job_application_hire_requirements'`,
    );
    expect(live.rows).toEqual([{ count: '1' }]);

    const hireTrigger = await su.query<{ count: string }>(
      `SELECT count(*) FROM pg_trigger
        WHERE tgname = 'job_applications_hire_requirements_guard'
          AND tgrelid = 'public.job_applications'::regclass
          AND NOT tgisinternal`,
    );
    expect(hireTrigger.rows).toEqual([{ count: '1' }]);
  });

  test('nothing else on users moved: RLS is still FORCEd and every surviving policy is present', async () => {
    const rls = await su.query<{ enabled: boolean; forced: boolean }>(
      `SELECT rel.relrowsecurity AS enabled, rel.relforcerowsecurity AS forced
         FROM pg_class rel JOIN pg_namespace n ON n.oid = rel.relnamespace
        WHERE n.nspname = 'public' AND rel.relname = 'users'`,
    );
    expect(rls.rows[0]).toEqual({ enabled: true, forced: true });

    // 027's reconcile lane is now the ONLY jale_admin write policy on users,
    // and it is what covers every surviving jale_admin write there. 042's
    // bind definer policy is FOR SELECT and is untouched.
    const survivors = await su.query<{ policyname: string }>(
      `SELECT policyname FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'users'
          AND policyname IN ('users_worker_reconcile', 'users_onboarding_bind_definer',
                             'wa_users_read', 'wa_users_update', 'wa_users_insert',
                             'users_matching_read')
        ORDER BY policyname`,
    );
    expect(survivors.rows.map((r) => r.policyname)).toEqual([
      'users_matching_read', 'users_onboarding_bind_definer', 'users_worker_reconcile',
      'wa_users_insert', 'wa_users_read', 'wa_users_update',
    ]);
  });
});

maybeDescribe('migration 092: the two column-scoped REVOKEs took nothing else', () => {
  let su: Client;
  let pool: Pool;

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
    await su.query(`ALTER ROLE jale_whatsapp WITH PASSWORD 'test-whatsapp-pw'`);
    pool = new Pool({
      connectionString: urlForRole(databaseUrl as string, 'jale_whatsapp', 'test-whatsapp-pw'),
      max: 2,
    });
  });

  afterAll(async () => {
    await pool.end();
    await su.end();
  });

  test('jale_whatsapp keeps every users SELECT column 004/041/049 granted it', async () => {
    const expected = [
      'availability', 'city', 'cognito_sub', 'full_name', 'has_transportation', 'id',
      'main_trade', 'main_trade_other', 'phone', 'privacy_accepted_at', 'privacy_version',
      'tos_accepted_at', 'tos_version', 'user_type', 'whatsapp_number', 'years_experience',
    ];
    const rows = await su.query<{ column_name: string }>(
      `SELECT DISTINCT column_name FROM information_schema.column_privileges
        WHERE grantee = 'jale_whatsapp' AND table_schema = 'public'
          AND table_name = 'users' AND privilege_type = 'SELECT'
        ORDER BY column_name`,
    );
    // Exactly the pre-092 set minus email, trust_signals and
    // trust_signals_completed_at. An equality assertion, not a superset one:
    // a REVOKE that took too much and a GRANT that quietly added a column
    // are both regressions.
    expect(rows.rows.map((r) => r.column_name)).toEqual(expected);
  });

  test('jale_whatsapp keeps every users UPDATE column 004 granted it', async () => {
    const expected = [
      'availability', 'city', 'cognito_sub', 'full_name', 'has_transportation',
      'main_trade', 'main_trade_other', 'privacy_accepted_at', 'privacy_version',
      'tos_accepted_at', 'tos_version', 'whatsapp_linked_at', 'whatsapp_number',
      'years_experience',
    ];
    const rows = await su.query<{ column_name: string }>(
      `SELECT DISTINCT column_name FROM information_schema.column_privileges
        WHERE grantee = 'jale_whatsapp' AND table_schema = 'public'
          AND table_name = 'users' AND privilege_type = 'UPDATE'
        ORDER BY column_name`,
    );
    expect(rows.rows.map((r) => r.column_name)).toEqual(expected);
  });

  test('and it can still RUN the lookup: the real column list selects as jale_whatsapp', async () => {
    // The ACL assertions above are catalog reads. This is the behavioural
    // one -- the query the processor actually issues on every inbound turn,
    // executed as the role, which is the thing a widened REVOKE breaks.
    const workerId = randomUUID();
    const sub = `wa-092-lookup-${workerId}`;
    await su.query(
      `INSERT INTO users (id, cognito_sub, user_type, phone, whatsapp_number, tos_version)
       VALUES ($1, $2, 'worker', '+15550920001', '+15550920001', 1)`,
      [workerId, sub],
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await setInternalUserRlsContext(client, workerId);
      const r = await client.query(
        `SELECT id, cognito_sub, phone, whatsapp_number, user_type, full_name, city,
                main_trade, main_trade_other, years_experience, has_transportation,
                availability, tos_version, tos_accepted_at, privacy_version,
                privacy_accepted_at
           FROM users WHERE id = $1`,
        [workerId],
      );
      expect(r.rowCount).toBe(1);
      expect(r.rows[0].phone).toBe('+15550920001');
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    await su.query(`DELETE FROM users WHERE id = $1`, [workerId]);
  });

  test('jale_whatsapp still has NO broad SELECT on users, and users.email is now unreadable to it', async () => {
    const broad = await su.query<{ ok: boolean }>(
      `SELECT has_table_privilege('jale_whatsapp', 'public.users', 'SELECT') AS ok`,
    );
    expect(broad.rows[0].ok).toBe(false);

    const workerId = randomUUID();
    await su.query(
      `INSERT INTO users (id, cognito_sub, user_type, email)
       VALUES ($1, $2, 'worker', 'web-092@example.test')`,
      [workerId, `wa-092-email-${workerId}`],
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await setInternalUserRlsContext(client, workerId);
      // 053's whole reason for existing was this read. It is a 42501 now.
      await expect(
        client.query(`SELECT email FROM users WHERE id = $1`, [workerId]),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    await su.query(`DELETE FROM users WHERE id = $1`, [workerId]);
  });

  test('010 kept its other three users columns for jale_matching, and 014 kept its five', async () => {
    // 092's second REVOKE names jale_matching, and 010 put the two trust
    // columns inside a FIVE-column grant -- so the failure mode is a revoke
    // that takes id / user_type / main_trade with them. 014 later granted
    // five more columns to the same role on the same table, so the correct
    // end state is 010's three plus 014's five, exactly.
    const rows = await su.query<{ column_name: string }>(
      `SELECT DISTINCT column_name FROM information_schema.column_privileges
        WHERE grantee = 'jale_matching' AND table_schema = 'public'
          AND table_name = 'users' AND privilege_type = 'SELECT'
        ORDER BY column_name`,
    );
    expect(rows.rows.map((r) => r.column_name)).toEqual([
      'availability', 'city', 'id', 'main_trade', 'main_trade_other',
      'trade_competency_score', 'user_type', 'years_experience',
    ]);
  });
});

maybeDescribe('migration 092: the web door and the bind path still work without 053', () => {
  let su: Client;
  let pool: Pool;

  const workflowVersion = 1;
  const webWorker = { sub: '', id: '', phone: '', runId: '' };
  const boundWorker = { sub: '', id: '', phone: '', convId: '', runId: '' };

  /** Runs `fn` as jale_whatsapp inside one transaction with the RLS context set. */
  async function asWhatsapp<T>(
    workerId: string | null,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (workerId) await setInternalUserRlsContext(client, workerId);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
    await su.query(`ALTER ROLE jale_whatsapp WITH PASSWORD 'test-whatsapp-pw'`);
    pool = new Pool({
      connectionString: urlForRole(databaseUrl as string, 'jale_whatsapp', 'test-whatsapp-pw'),
      max: 2,
    });

    const tag = randomUUID().slice(0, 8);
    webWorker.sub = `wa-092-web-${tag}`;
    webWorker.phone = `+1555092${tag.slice(0, 4).replace(/\D/g, '1').padEnd(4, '2')}`;
    boundWorker.sub = `wa-092-bind-${tag}`;
    boundWorker.phone = `+1555093${tag.slice(0, 4).replace(/\D/g, '1').padEnd(4, '3')}`;
  });

  afterAll(async () => {
    for (const id of [webWorker.id, boundWorker.id].filter(Boolean)) {
      await su.query(
        `DELETE FROM worker_workflow_transitions WHERE run_id IN
           (SELECT id FROM worker_workflow_runs WHERE user_id = $1)`, [id],
      );
      await su.query(`DELETE FROM worker_workflow_runs WHERE user_id = $1`, [id]);
      await su.query(`DELETE FROM worker_onboarding_state WHERE user_id = $1`, [id]);
      await su.query(`DELETE FROM whatsapp_conversations WHERE user_id = $1`, [id]);
      await su.query(`DELETE FROM users WHERE id = $1`, [id]);
    }
    await su.query(`DELETE FROM worker_identity_challenges WHERE provider_challenge_id LIKE 'wa-092-%'`);
    await pool.end();
    await su.end();
  });

  test('the phone-only signup door still opens: reconcile_worker_signup as jale_whatsapp', async () => {
    await asWhatsapp(null, (client) =>
      client.query(`SELECT reconcile_worker_signup($1, $2, $3)`, [webWorker.sub, webWorker.phone, '']),
    );

    const row = await su.query<{ id: string; full_name: string | null; email: string | null }>(
      `SELECT id, full_name, email FROM users WHERE cognito_sub = $1`, [webWorker.sub],
    );
    expect(row.rowCount).toBe(1);
    webWorker.id = row.rows[0].id;
    // Phone-only: nothing is staged (there is nowhere left to stage it) and
    // no email exists -- which is precisely why 053's eligibility predicate
    // could never match again and why its objects were droppable.
    expect(row.rows[0].full_name).toBeNull();
    expect(row.rows[0].email).toBeNull();
  });

  test('start_web_onboarding_workflow (086) still drives a web worker from nothing to legal.review', async () => {
    const started = await asWhatsapp(null, async (client) => {
      const r = await client.query<{
        run_id: string; created: boolean; current_step_key: string; lifecycle: string;
      }>(
        `SELECT * FROM start_web_onboarding_workflow($1, $2, $3)`,
        [webWorker.sub, 'es', workflowVersion],
      );
      return r.rows[0];
    });

    expect(started.created).toBe(true);
    expect(started.current_step_key).toBe('legal.review');
    // NOT 'ready'. 053's bypass used to slam a web-registered worker straight
    // to 'ready' with a completed run; with it gone the worker travels the
    // real v2 engine, which is the whole premise of the drop.
    expect(started.lifecycle).toBe('onboarding');
    webWorker.runId = started.run_id;

    const state = await su.query<{ lifecycle: string }>(
      `SELECT lifecycle FROM worker_onboarding_state WHERE user_id = $1`, [webWorker.id],
    );
    expect(state.rows[0].lifecycle).toBe('onboarding');
  });

  test('even for a worker who LOOKS like 053 eligibility (email + tos_accepted_at), nothing shortcuts', async () => {
    // The exact row shape 053's definer re-validated before slamming the
    // worker to 'ready'. There is no definer left to call, and the door it
    // would have bypassed behaves identically for this worker.
    await su.query(
      `UPDATE users SET email = $2, tos_accepted_at = now() WHERE id = $1`,
      [webWorker.id, `web-092-${webWorker.sub}@example.test`],
    );

    const again = await asWhatsapp(null, async (client) => {
      const r = await client.query<{ run_id: string; created: boolean; lifecycle: string }>(
        `SELECT * FROM start_web_onboarding_workflow($1, $2, $3)`,
        [webWorker.sub, 'es', workflowVersion],
      );
      return r.rows[0];
    });
    expect(again.created).toBe(false);
    expect(again.run_id).toBe(webWorker.runId);
    expect(again.lifecycle).toBe('onboarding');

    // And the function that would have done the shortcut is not callable at
    // all -- 42883 undefined_function, not a permission error.
    await expect(
      asWhatsapp(null, (client) =>
        client.query(
          `SELECT * FROM bypass_onboarding_for_web_worker($1::uuid, $2::uuid, '1', 'es', 'sid')`,
          [webWorker.id, randomUUID()],
        ),
      ),
    ).rejects.toMatchObject({ code: '42883' });
  });

  test('bind_verified_identity_and_start_workflow (087) still binds a first WhatsApp message', async () => {
    await asWhatsapp(null, (client) =>
      client.query(`SELECT reconcile_worker_signup($1, $2, $3)`, [boundWorker.sub, boundWorker.phone, '']),
    );
    const row = await su.query<{ id: string }>(
      `SELECT id FROM users WHERE cognito_sub = $1`, [boundWorker.sub],
    );
    boundWorker.id = row.rows[0].id;

    // A web worker who FINISHED on the web: lifecycle ready + a completed
    // run. This is the case 087 exists for and that 053 used to hide.
    await su.query(
      `INSERT INTO worker_onboarding_state (user_id, lifecycle, lifecycle_changed_at, ready_at)
       VALUES ($1, 'ready', now(), now())`,
      [boundWorker.id],
    );
    const run = await su.query<{ id: string }>(
      `INSERT INTO worker_workflow_runs
         (user_id, workflow_version, current_step_key, status, preferred_language, completed_at)
       VALUES ($1, $2, 'trust.question.3', 'completed', 'en', now()) RETURNING id`,
      [boundWorker.id, workflowVersion],
    );
    boundWorker.runId = run.rows[0].id;

    const conv = await su.query<{ id: string }>(
      `INSERT INTO whatsapp_conversations (whatsapp_number, language, conversation_state)
       VALUES ($1, 'es', 'new') RETURNING id`,
      [boundWorker.phone],
    );
    boundWorker.convId = conv.rows[0].id;

    const phoneHash = createHash('sha256').update(boundWorker.phone).digest('hex');
    await su.query(
      `INSERT INTO worker_identity_challenges
         (phone_hash, provider_challenge_id, preferred_language, current_step_key, status, expires_at)
       VALUES ($1, $2, 'es', 'identity.verify_otp', 'pending', now() + INTERVAL '10 minutes')`,
      [phoneHash, `wa-092-${boundWorker.sub}`],
    );

    const bound = await asWhatsapp(null, async (client) => {
      const r = await client.query<{ run_id: string; onboarding_state_id: string }>(
        `SELECT * FROM bind_verified_identity_and_start_workflow($1, $2::uuid, $3::uuid, $4, 'es', $5)`,
        [phoneHash, boundWorker.id, boundWorker.convId, workflowVersion, 'wa-092-sid'],
      );
      return r.rows[0];
    });

    // 087's whole point: the completed web run is ADOPTED, not replaced, and
    // lifecycle 'ready' is preserved. Before R2 this lane was unreachable
    // because 053's bypass caught the worker first.
    expect(bound.run_id).toBe(boundWorker.runId);

    const runs = await su.query<{ id: string; status: string; current_step_key: string }>(
      `SELECT id, status, current_step_key FROM worker_workflow_runs WHERE user_id = $1`,
      [boundWorker.id],
    );
    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0]).toMatchObject({
      id: boundWorker.runId, status: 'completed', current_step_key: 'trust.question.3',
    });

    const state = await su.query<{ lifecycle: string }>(
      `SELECT lifecycle FROM worker_onboarding_state WHERE user_id = $1`, [boundWorker.id],
    );
    expect(state.rows[0].lifecycle).toBe('ready');

    // The conversation is bound and the worker's whatsapp_number is filled --
    // the two writes 053's definer used to perform under
    // users_web_worker_bypass_definer. 087 does them under its own lane, so
    // dropping that policy cost nothing.
    const convRow = await su.query<{ user_id: string | null }>(
      `SELECT user_id FROM whatsapp_conversations WHERE id = $1`, [boundWorker.convId],
    );
    expect(convRow.rows[0].user_id).toBe(boundWorker.id);
  });
});

// ---------------------------------------------------------------------------
// Group 4: the surviving half of the deleted migration-052 suite.
//
// Migration 092 drops 052's pending-name lane but KEEPS its worker_skills
// reset. These four cases moved here verbatim from
// whatsapp-onboarding-052.integration.test.ts when that file was deleted, so
// that deregistering a suite did not quietly drop live coverage.
// ---------------------------------------------------------------------------
maybeDescribe('migration 052 (kept by 092): worker_skills reset + trust-answer upsert', () => {
  const workerId = randomUUID();
  const cognitoSub = `wa-092-052-${workerId}`;
  let setup: Client;

  async function connectAsWhatsapp(id?: string): Promise<Client> {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE jale_whatsapp');
    if (id) await setInternalUserRlsContext(pc(client), id);
    return client;
  }

  beforeAll(async () => {
    setup = new Client({ connectionString: databaseUrl });
    await setup.connect();
    await setup.query(
      `INSERT INTO users (id, cognito_sub, user_type) VALUES ($1, $2, 'worker')`,
      [workerId, cognitoSub],
    );
  });

  afterAll(async () => {
    await setup.query(
      `DELETE FROM worker_workflow_transitions WHERE run_id IN
         (SELECT id FROM worker_workflow_runs WHERE user_id = $1)`, [workerId],
    );
    await setup.query('DELETE FROM worker_workflow_runs WHERE user_id = $1', [workerId]);
    await setup.query('DELETE FROM worker_skills WHERE worker_id = $1', [workerId]);
    await setup.query('DELETE FROM worker_trust_assessments WHERE user_id = $1', [workerId]);
    await setup.query('DELETE FROM users WHERE id = $1', [workerId]);
    await setup.end();
  });

  test('052 half two survives 092: jale_whatsapp has DELETE on worker_skills, guarded by a worker-scoped policy', async () => {
    const grant = await setup.query<{ has_delete: boolean }>(
      `SELECT has_table_privilege('jale_whatsapp', 'public.worker_skills', 'DELETE') AS has_delete`,
    );
    expect(grant.rows[0].has_delete).toBe(true);

    const policy = await setup.query(
      `SELECT 1 FROM pg_policies WHERE tablename = 'worker_skills' AND policyname = 'worker_skills_whatsapp_delete'`,
    );
    expect(policy.rowCount).toBe(1);
  });

  test('resetPendingTrustAssessmentAndSkills deletes worker_skills and resets ONLY the pending assessment, leaving a scored one untouched', async () => {
    await setup.query(
      `INSERT INTO worker_skills (worker_id, skill) VALUES ($1, 'electrician'), ($1, 'general_labor')`,
      [workerId],
    );

    const pendingId = randomUUID();
    const scoredId = randomUUID();
    await setup.query(
      `INSERT INTO worker_trust_assessments (id, user_id, profession_key, answers, status)
       VALUES ($1, $2, 'electrician', '[{"question_index":0,"answer_text":"abandoned trade answer"}]'::jsonb, 'pending')`,
      [pendingId, workerId],
    );
    await setup.query(
      `INSERT INTO worker_trust_assessments (id, user_id, profession_key, answers, status, competency_score, scored_at)
       VALUES ($1, $2, 'plumber', '[{"question_index":0,"answer_text":"already scored"}]'::jsonb, 'scored', 80, now())`,
      [scoredId, workerId],
    );

    const client = await connectAsWhatsapp(workerId);
    try {
      await resetPendingTrustAssessmentAndSkills(pc(client), workerId);
      await client.query('COMMIT');
    } finally {
      await client.end();
    }

    const skills = await setup.query('SELECT skill FROM worker_skills WHERE worker_id = $1', [workerId]);
    expect(skills.rowCount).toBe(0);

    const pending = await setup.query('SELECT answers, status FROM worker_trust_assessments WHERE id = $1', [pendingId]);
    expect(pending.rows[0]).toEqual({ answers: [], status: 'pending' });

    // A scored assessment must NEVER be touched by a RESTART reset.
    const scored = await setup.query(
      'SELECT answers, status, competency_score FROM worker_trust_assessments WHERE id = $1', [scoredId],
    );
    expect(scored.rows[0]).toEqual({
      answers: [{ question_index: 0, answer_text: 'already scored' }],
      status: 'scored',
      competency_score: 80,
    });

    await setup.query('DELETE FROM worker_trust_assessments WHERE id = ANY($1)', [[pendingId, scoredId]]);
  });

  test('saveTrustAnswer REPLACES the element sharing question_index (BACK + re-answer) against a REAL row, never appends a duplicate', async () => {
    const adapters = createOnboardingV2Adapters({
      reconcileUserRow: async () => ({ userId: workerId, tosVersion: null }),
    });

    const client = await connectAsWhatsapp(workerId);
    try {
      await adapters.profile.saveTrustAnswer(pc(client), {
        workerId,
        professionKey: 'concrete',
        questionIndex: 0,
        qEn: 'Q0 original',
        qEs: 'Q0 original es',
        answerText: 'original answer',
        answerSource: 'text',
      });
      // BACK, then re-answer the SAME question — must replace, not append.
      await adapters.profile.saveTrustAnswer(pc(client), {
        workerId,
        professionKey: 'concrete',
        questionIndex: 0,
        qEn: 'Q0 corrected',
        qEs: 'Q0 corrected es',
        answerText: 'corrected answer',
        answerSource: 'text',
      });
      // A distinct question index still appends normally.
      await adapters.profile.saveTrustAnswer(pc(client), {
        workerId,
        professionKey: 'concrete',
        questionIndex: 1,
        qEn: 'Q1',
        qEs: 'Q1 es',
        answerText: 'answer to Q1',
        answerSource: 'text',
      });
      await client.query('COMMIT');
    } finally {
      await client.end();
    }

    const row = await setup.query<{ answers: Array<{ question_index: number; answer_text: string }> }>(
      `SELECT answers FROM worker_trust_assessments
        WHERE user_id = $1 AND profession_key = 'concrete' AND status = 'pending'`,
      [workerId],
    );
    expect(row.rowCount).toBe(1);
    const answers = row.rows[0].answers;
    expect(answers).toHaveLength(2);
    expect(answers.filter((a) => a.question_index === 0)).toHaveLength(1);
    expect(answers.find((a) => a.question_index === 0)?.answer_text).toBe('corrected answer');
    expect(answers.find((a) => a.question_index === 1)?.answer_text).toBe('answer to Q1');

    await setup.query(
      `DELETE FROM worker_trust_assessments WHERE user_id = $1 AND profession_key = 'concrete'`, [workerId],
    );
  });

  test('findPreviousStepKey excludes worker_back/worker_restart transitions and voice holding steps against REAL rows', async () => {
    const run = await setup.query<{ id: string }>(
      `INSERT INTO worker_workflow_runs (user_id, workflow_version, current_step_key)
       VALUES ($1, 1, 'trust.question.2') RETURNING id`,
      [workerId],
    );
    const runId = run.rows[0].id;

    // A genuine forward-progress history: legal.review -> profile.name ->
    // ... -> trust.question.1 -> trust.question.2, followed by a BACK/typed-
    // answer/BACK oscillation exactly like the production defect.
    const transitions: Array<[string | null, string, string]> = [
      [null, 'legal.review', 'otp_verified'],
      ['legal.review', 'profile.voice_choice', 'legal_accept'],
      ['profile.voice_choice', 'profile.voice_processing', 'profile_voice_ingest_started'],
      ['profile.voice_processing', 'profile.name', 'profile_voice_processing_timeout'],
      ['profile.name', 'trust.question.1', 'profile_answered'],
      ['trust.question.1', 'trust.question.2', 'trust_answer_recorded'],
      // First BACK: trust.question.2 -> trust.question.1.
      ['trust.question.2', 'trust.question.1', 'worker_back'],
      // Re-answer: trust.question.1 -> trust.question.2 again.
      ['trust.question.1', 'trust.question.2', 'trust_answer_recorded'],
    ];
    for (const [fromStepKey, toStepKey, reason] of transitions) {
      await setup.query(
        `INSERT INTO worker_workflow_transitions (run_id, from_step_key, to_step_key, reason)
         VALUES ($1, $2, $3, $4)`,
        [runId, fromStepKey, toStepKey, reason],
      );
    }

    const client = await connectAsWhatsapp(workerId);
    try {
      // A SECOND BACK from trust.question.2 must walk to trust.question.1 —
      // never bounce forward via the FIRST BACK's own `worker_back` row.
      const prev = await findPreviousStepKey(pc(client), runId, 'trust.question.2');
      expect(prev).toBe('trust.question.1');

      // BACK from profile.name must never land on either voice holding step,
      // even though the real transition history passed through them.
      const prevFromName = await findPreviousStepKey(pc(client), runId, 'profile.name');
      expect(prevFromName).not.toBe('profile.voice_choice');
      expect(prevFromName).not.toBe('profile.voice_processing');
      await client.query('COMMIT');
    } finally {
      await client.end();
    }
  });
});
