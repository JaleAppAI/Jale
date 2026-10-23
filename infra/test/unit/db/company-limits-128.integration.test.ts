/**
 * company-limits-128 -- migration 128 on a real bed, through the real logins:
 *  - jale_cap.employer_org_usage (jale_api): company-wide counts for an
 *    active member, a suspended foreman's jobs included; 42501 for anyone
 *    else; with p_lock, the company row stays locked FOR NO KEY UPDATE to
 *    COMMIT, while a foreign-key check (FOR KEY SHARE) still passes;
 *  - billing_enforce_org_limits / billing_restore_org (jale_billing): suspend
 *    the most recently joined foremen first (marked billing_suspended_at),
 *    then pause jobs across members, suspended members' first and then the
 *    newest of active members', and revoke the newest live invites;
 *    restore only marked foremen, earliest marked then earliest joined, then
 *    resume the oldest billing-paused jobs of active members; both
 *    idempotent, and neither touches another company.
 * Fixtures through the superuser URL; afterAll removes them.
 *
 * Run: bash infra/db/local/bootstrap-testbed.sh --ephemeral --ref none -- \
 *   bash infra/scripts/run-whatsapp-v2-db-tests.sh --suite test/unit/db/company-limits-128.integration.test.ts
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { describeInProfiles, loginClient, withLoginClient } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: company-limits-128 needs JALE_TEST_DATABASE_URL (see header)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

type Person = { id: string; sub: string; email: string };
type World = { owner: Person; f1: Person; f2: Person; f3: Person; org: string; stranger: Person; strangerOrg: string };

const ENFORCE_SQL = `SELECT paused_count, paused_titles, suspended_count, suspended_emails, revoked_invite_count, owner_email
                       FROM jale_billing_internal.billing_enforce_org_limits($1, $2, $3)`;
const RESTORE_SQL = `SELECT resumed_count, resumed_titles, restored_count, restored_emails, owner_email
                       FROM jale_billing_internal.billing_restore_org($1, $2, $3)`;
const USAGE_SQL = `SELECT organization_id, active_jobs, templates, active_foremen, suspended_foremen, pending_invites
                     FROM jale_cap.employer_org_usage($1)`;

maybeDescribe('migration 128: company limits', () => {
  let su: Client;
  const companies: string[] = [];

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
  });
  afterAll(async () => {
    try {
      const ids = (await su.query<{ id: string }>(`SELECT id FROM users WHERE cognito_sub LIKE 'lim128-%'`)).rows.map((r) => r.id);
      // job_visibility_events has no FK to jobs; job_status_events cascade from jobs.
      await su.query(
        `DELETE FROM job_visibility_events WHERE job_id IN (SELECT id FROM jobs WHERE employer_id = ANY($1::uuid[]))`, [ids]);
      await su.query(`DELETE FROM jobs WHERE employer_id = ANY($1::uuid[])`, [ids]);
      // Invites cascade from their company.
      await su.query(`DELETE FROM organization_members WHERE organization_id = ANY($1::uuid[])`, [companies]);
      await su.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [companies]);
      // Templates cascade from users.
      await su.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [ids]);
    } finally {
      await su.end();
    }
  });

  async function user(): Promise<Person> {
    const sub = `lim128-${randomUUID()}`;
    const email = `${sub}@example.invalid`;
    const { rows } = await su.query<{ id: string }>(
      `INSERT INTO users (cognito_sub, user_type, email) VALUES ($1, 'employer', $2) RETURNING id`, [sub, email]);
    return { id: rows[0].id, sub, email };
  }
  async function company(owner: Person): Promise<string> {
    const org = (await su.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ('Lim128 Co') RETURNING id`)).rows[0].id;
    companies.push(org);
    await su.query(`INSERT INTO organization_members (user_id, organization_id, role) VALUES ($1, $2, 'owner')`, [owner.id, org]);
    return org;
  }
  /**
   * A foreman. `billingSuspendedAt` marks a billing suspension (the enforcer's
   * mark) and is the time the status changed; without it a suspension is for
   * another reason.
   */
  async function foreman(org: string, p: Person, joinedAt: string, status = 'active', billingSuspendedAt: string | null = null): Promise<void> {
    await su.query(
      `INSERT INTO organization_members (user_id, organization_id, role, status, joined_at, status_changed_at, billing_suspended_at)
       VALUES ($1, $2, 'foreman', $3, $4, COALESCE($5::timestamptz, $4::timestamptz), $5::timestamptz)`,
      [p.id, org, status, joinedAt, billingSuspendedAt],
    );
  }
  /** An owner, three foremen who joined on 1, 2 and 3 Jan, and a stranger with a company of their own. */
  async function world(): Promise<World> {
    const owner = await user();
    const org = await company(owner);
    const f1 = await user();
    const f2 = await user();
    const f3 = await user();
    await foreman(org, f1, '2026-01-01T00:00:00Z');
    await foreman(org, f2, '2026-01-02T00:00:00Z');
    await foreman(org, f3, '2026-01-03T00:00:00Z');
    const stranger = await user();
    const strangerOrg = await company(stranger);
    return { owner, f1, f2, f3, org, stranger, strangerOrg };
  }
  async function job(employer: Person, title: string, createdAt: string, status = 'active', billingPaused = false): Promise<string> {
    return (await su.query<{ id: string }>(
      `INSERT INTO jobs (employer_id, title, location, job_type, status, created_at, billing_paused_at)
       VALUES ($1, $2, 'Austin', 'full-time', $3, $4, CASE WHEN $5::boolean THEN $4::timestamptz END) RETURNING id`,
      [employer.id, title, status, createdAt, billingPaused],
    )).rows[0].id;
  }
  async function invite(w: World, createdAt: string, expiresAt: string, accepted = false): Promise<string> {
    return inviteTo(w.org, w.owner, createdAt, expiresAt, accepted);
  }
  async function inviteTo(org: string, by: Person, createdAt: string, expiresAt: string, accepted = false): Promise<string> {
    return (await su.query<{ id: string }>(
      `INSERT INTO organization_invites (organization_id, email, token_hash, invited_by, created_at, expires_at, accepted_at)
       VALUES ($1, $2, decode(md5(random()::text) || md5(random()::text), 'hex'), $3, $4, $5,
               CASE WHEN $6::boolean THEN $4::timestamptz END)
       RETURNING id`,
      [org, `invitee-${randomUUID()}@example.invalid`, by.id, createdAt, expiresAt, accepted],
    )).rows[0].id;
  }
  /** Lists the job publicly under a fresh code; returns the code. */
  async function publish(jobId: string): Promise<string> {
    const code = randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
    await su.query(`UPDATE jobs SET public_code = $2, public_listing_enabled = true WHERE id = $1`, [jobId, code]);
    return code;
  }
  /** Status events of these jobs, as "title:from>to@employer". */
  const statusEvents = async (ids: string[]) => (await su.query<{ e: string }>(
    `SELECT j.title || ':' || e.from_status || '>' || e.to_status || '@' || e.employer_id::text AS e
       FROM job_status_events e JOIN jobs j ON j.id = e.job_id
      WHERE e.job_id = ANY($1::uuid[]) AND e.actor = 'billing' ORDER BY 1`, [ids])).rows.map((r) => r.e);
  /** Visibility events of these jobs, as "code:kind". */
  const visibilityEvents = async (ids: string[]) => (await su.query<{ e: string }>(
    `SELECT public_code || ':' || event_kind AS e FROM job_visibility_events WHERE job_id = ANY($1::uuid[]) ORDER BY 1`,
    [ids])).rows.map((r) => r.e);
  async function asApi<T>(settings: { sub?: string; internal?: string }, fn: (c: Client) => Promise<T>): Promise<T> {
    return withLoginClient('jale_api', async (c) => {
      await c.query('BEGIN');
      try {
        if (settings.sub !== undefined) await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [settings.sub]);
        if (settings.internal !== undefined) await c.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [settings.internal]);
        return await fn(c);
      } finally {
        await c.query('ROLLBACK');
      }
    });
  }
  const as = (p: Person) => ({ sub: p.sub, internal: p.id });
  /** Runs one statement as the webhook processor's login and COMMITs it, as the processor does. */
  async function asBilling<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<T> {
    return withLoginClient('jale_billing', async (c) => {
      await c.query('BEGIN');
      try {
        const { rows } = await c.query(sql, params);
        await c.query('COMMIT');
        return rows[0] as T;
      } catch (err) {
        await c.query('ROLLBACK');
        throw err;
      }
    });
  }
  async function rejects(c: Client, sql: string, params: unknown[], code: string): Promise<void> {
    await c.query('SAVEPOINT expected_error');
    await expect(c.query(sql, params)).rejects.toMatchObject({ code });
    await c.query('ROLLBACK TO SAVEPOINT expected_error');
  }
  const statusOf = async (ids: string[]) => Object.fromEntries((await su.query<{ id: string; status: string; marked: boolean }>(
    `SELECT id, status, billing_paused_at IS NOT NULL AS marked FROM jobs WHERE id = ANY($1::uuid[])`, [ids],
  )).rows.map((r) => [r.id, `${r.status}${r.marked ? '+billing' : ''}`]));
  /** A member's status, with '+billing' when the enforcer's mark is set. */
  const memberStatus = async (p: Person) => {
    const row = (await su.query<{ status: string; marked: boolean }>(
      `SELECT status, billing_suspended_at IS NOT NULL AS marked FROM organization_members WHERE user_id = $1`, [p.id])).rows[0];
    return `${row.status}${row.marked ? '+billing' : ''}`;
  };

  describeInProfiles(['standard', 'request', 'owner-unrestricted'], 'the catalog', () => {
    it('employer_org_usage is a pinned definer of its own NOLOGIN owner, callable by jale_api alone', async () => {
      const { rows } = await su.query(
        `SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
                ARRAY(SELECT pg_catalog.pg_get_userbyid(a.grantee) FROM aclexplode(p.proacl) a
                       WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner ORDER BY 1)::text[] AS callers,
                r.rolcanlogin AS owner_logs_in, r.rolinherit AS owner_inherits,
                pg_catalog.pg_get_function_result(p.oid) AS result
           FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
          WHERE p.oid = 'jale_cap.employer_org_usage(boolean)'::regprocedure`,
      );
      expect(rows).toEqual([{
        owner: 'jale_cap_org_limits', definer: true, config: ['search_path=pg_catalog, pg_temp'], callers: ['jale_api'],
        owner_logs_in: false, owner_inherits: false,
        // pending_invites is last: readers that name their columns are unaffected.
        result: 'TABLE(organization_id uuid, active_jobs integer, templates integer, active_foremen integer, suspended_foremen integer, pending_invites integer)',
      }]);
    });

    it('the company enforcer functions are pinned definers for jale_billing alone; 136 dropped 125\'s per-person pair', async () => {
      const { rows } = await su.query(
        `SELECT p.proname::text AS fn, pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
                pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer,
                ARRAY(SELECT pg_catalog.pg_get_userbyid(a.grantee) FROM aclexplode(p.proacl) a
                       WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner ORDER BY 1)::text[] AS callers
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'jale_billing_internal' ORDER BY 1`,
      );
      const company = 'p_organization_id uuid, p_active_job_limit integer, p_foreman_seat_limit integer';
      expect(rows).toEqual([
        { fn: 'billing_enforce_org_limits', args: company, owner: 'jale_billing_job_enforcer', definer: true, callers: ['jale_billing'] },
        { fn: 'billing_restore_org', args: company, owner: 'jale_billing_job_enforcer', definer: true, callers: ['jale_billing'] },
      ]);
    });

    it('no runtime login holds a right on organizations; the processor\'s login none on the membership tables', async () => {
      const { rows } = await su.query(
        `SELECT has_any_column_privilege('jale_api', 'public.organizations', 'SELECT') AS api_org,
                has_any_column_privilege('jale_billing', 'public.organizations', 'SELECT') AS billing_org,
                has_any_column_privilege('jale_billing', 'public.organization_members', 'SELECT') AS billing_members,
                has_any_column_privilege('jale_billing', 'public.organization_invites', 'SELECT') AS billing_invites,
                has_table_privilege('jale_api', 'public.organization_members', 'UPDATE') AS api_member_update`,
      );
      expect(rows[0]).toEqual({ api_org: false, billing_org: false, billing_members: false, billing_invites: false, api_member_update: false });
    });

    it('organization_members.billing_suspended_at is a nullable mark the enforcer alone writes and the usage owner reads', async () => {
      const { rows } = await su.query(
        `SELECT format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
                has_column_privilege('jale_billing_job_enforcer', 'public.organization_members', 'billing_suspended_at', 'UPDATE') AS enforcer_writes,
                has_column_privilege('jale_api', 'public.organization_members', 'billing_suspended_at', 'SELECT') AS api_reads,
                has_column_privilege('jale_cap_org_limits', 'public.organization_members', 'billing_suspended_at', 'SELECT') AS usage_reads,
                has_column_privilege('jale_cap_org_limits', 'public.organization_members', 'billing_suspended_at', 'UPDATE') AS usage_writes
           FROM pg_attribute a
          WHERE a.attrelid = 'public.organization_members'::regclass AND a.attname = 'billing_suspended_at' AND NOT a.attisdropped`,
      );
      expect(rows).toEqual([{
        type: 'timestamp with time zone', not_null: false, enforcer_writes: true, api_reads: false, usage_reads: true, usage_writes: false,
      }]);
    });

    it('the usage owner reads four invite columns and writes none; jale_api reads no invite', async () => {
      const { rows } = await su.query<{ col: string }>(
        `SELECT a.attname::text AS col FROM pg_attribute a
          WHERE a.attrelid = 'public.organization_invites'::regclass AND a.attnum > 0 AND NOT a.attisdropped
            AND has_column_privilege('jale_cap_org_limits', 'public.organization_invites', a.attname, 'SELECT')
          ORDER BY 1`,
      );
      expect(rows.map((r) => r.col)).toEqual(['accepted_at', 'expires_at', 'organization_id', 'revoked_at']);
      const writes = await su.query(
        `SELECT has_any_column_privilege('jale_cap_org_limits', 'public.organization_invites', 'UPDATE') AS usage_writes,
                has_any_column_privilege('jale_api', 'public.organization_invites', 'SELECT') AS api_reads`,
      );
      expect(writes.rows[0]).toEqual({ usage_writes: false, api_reads: false });
    });
  });

  describeInProfiles(['standard', 'request'], 'the company usage read', () => {
    it('counts every member\'s active jobs, a suspended foreman\'s included, every member\'s templates, billing-suspended foremen and live invites; never another company\'s', async () => {
      const w = await world();
      // f2 suspended by billing (marked); f3 suspended for another reason (no mark).
      await su.query(
        `UPDATE organization_members SET status = 'suspended', billing_suspended_at = now() WHERE user_id = $1`, [w.f2.id]);
      await su.query(`UPDATE organization_members SET status = 'suspended' WHERE user_id = $1`, [w.f3.id]);
      await job(w.owner, 'Owner live', '2026-02-01T00:00:00Z');
      await job(w.f1, 'F1 live', '2026-02-02T00:00:00Z');
      await job(w.f2, 'Suspended foreman live', '2026-02-03T00:00:00Z');
      await job(w.f3, 'F3 paused', '2026-02-04T00:00:00Z', 'paused');
      await job(w.stranger, 'Stranger live', '2026-02-05T00:00:00Z');
      for (const p of [w.owner, w.f2, w.stranger]) {
        await su.query(`INSERT INTO employer_job_templates (employer_id, name, payload) VALUES ($1, 'T', '{}'::jsonb)`, [p.id]);
      }
      // One live invite counts; expired, accepted and revoked ones do not; the stranger's is theirs.
      await invite(w, '2026-03-01T00:00:00Z', '2099-01-01T00:00:00Z');
      await invite(w, '2026-01-01T00:00:00Z', '2026-01-08T00:00:00Z');
      await invite(w, '2026-01-05T00:00:00Z', '2099-01-01T00:00:00Z', true);
      const revoked = await invite(w, '2026-03-02T00:00:00Z', '2099-01-01T00:00:00Z');
      await su.query(`UPDATE organization_invites SET revoked_at = now() WHERE id = $1`, [revoked]);
      await inviteTo(w.strangerOrg, w.stranger, '2026-03-03T00:00:00Z', '2099-01-01T00:00:00Z');

      const expected = {
        organization_id: w.org, active_jobs: 3, templates: 2, active_foremen: 1, suspended_foremen: 1, pending_invites: 1,
      };
      expect(await asApi(as(w.f1), async (c) => (await c.query(USAGE_SQL, [false])).rows[0])).toEqual(expected);
      expect(await asApi(as(w.owner), async (c) => (await c.query(USAGE_SQL, [true])).rows[0])).toEqual(expected);
      expect(await asApi(as(w.stranger), async (c) => (await c.query(USAGE_SQL, [false])).rows[0])).toEqual({
        organization_id: w.strangerOrg, active_jobs: 1, templates: 1, active_foremen: 0, suspended_foremen: 0, pending_invites: 1,
      });
    });

    it('refuses a caller who is unset, malformed, suspended or in no company (42501)', async () => {
      const w = await world();
      await su.query(`UPDATE organization_members SET status = 'suspended' WHERE user_id = $1`, [w.f2.id]);
      const loner = await user();
      for (const settings of [{}, { internal: 'not-a-uuid' }, as(w.f2), as(loner)]) {
        await asApi(settings, (c) => rejects(c, USAGE_SQL, [false], '42501'));
        await asApi(settings, (c) => rejects(c, USAGE_SQL, [true], '42501'));
      }
    });

    it('with p_lock, the company row stays locked FOR NO KEY UPDATE until the member\'s transaction ends; a foreign-key check still passes', async () => {
      const w = await world();
      const member = loginClient('jale_api');
      await member.connect();
      try {
        await member.query('BEGIN');
        await member.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [w.f1.id]);
        await member.query(USAGE_SQL, [true]);
        // The gate itself: a second NO KEY UPDATE (and so FOR UPDATE) must wait.
        await expect(su.query(`SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE NOWAIT`, [w.org]))
          .rejects.toMatchObject({ code: '55P03' });
        await expect(su.query(`SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE NOWAIT`, [w.org]))
          .rejects.toMatchObject({ code: '55P03' });
        // An insert naming the company (a subscription, a member, an invite) checks
        // its foreign key with FOR KEY SHARE, which NO KEY UPDATE does not block.
        await expect(su.query(`SELECT 1 FROM organizations WHERE id = $1 FOR KEY SHARE NOWAIT`, [w.org])).resolves.toBeDefined();
        await member.query('ROLLBACK');
        await expect(su.query(`SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE NOWAIT`, [w.org])).resolves.toBeDefined();
      } finally {
        await member.query('ROLLBACK').catch(() => undefined);
        await member.end();
      }
    });
  });

  describeInProfiles(['standard', 'request'], 'billing by company', () => {
    it('enforce pauses the newest active jobs across members, suspends the most recently joined foremen and revokes the newest live invites', async () => {
      const w = await world();
      const o1 = await job(w.owner, 'O1', '2026-02-01T00:00:00Z');
      const f1a = await job(w.f1, 'F1a', '2026-02-02T00:00:00Z');
      const o2 = await job(w.owner, 'O2', '2026-02-03T00:00:00Z');
      const f3a = await job(w.f3, 'F3a', '2026-02-04T00:00:00Z');
      const manual = await job(w.f2, 'F2 manual pause', '2026-02-05T00:00:00Z', 'paused');
      // O1 (kept) and O2 (paused) are public; F3a is paused but has no public code.
      await publish(o1);
      const o2Code = await publish(o2);
      const live1 = await invite(w, '2026-03-01T00:00:00Z', '2099-01-01T00:00:00Z');
      const live2 = await invite(w, '2026-03-02T00:00:00Z', '2099-01-01T00:00:00Z');
      const expired = await invite(w, '2026-01-01T00:00:00Z', '2026-01-08T00:00:00Z');
      const accepted = await invite(w, '2026-01-05T00:00:00Z', '2099-01-01T00:00:00Z', true);

      const result = await asBilling(ENFORCE_SQL, [w.org, 2, 1]);

      expect(result).toEqual({
        paused_count: 2, paused_titles: ['O2', 'F3a'],
        suspended_count: 2, suspended_emails: [w.f3.email, w.f2.email],
        revoked_invite_count: 2, owner_email: w.owner.email,
      });
      expect(await statusOf([o1, f1a, o2, f3a, manual])).toEqual({
        [o1]: 'active', [f1a]: 'active', [o2]: 'paused+billing', [f3a]: 'paused+billing', [manual]: 'paused',
      });
      // One status event per paused job, with the job's own employer; a 'removed'
      // visibility event only for the public one.
      expect(await statusEvents([o1, f1a, o2, f3a, manual])).toEqual([
        `F3a:active>paused@${w.f3.id}`, `O2:active>paused@${w.owner.id}`,
      ]);
      expect(await visibilityEvents([o1, f1a, o2, f3a, manual])).toEqual([`${o2Code}:removed`]);
      expect([await memberStatus(w.owner), await memberStatus(w.f1), await memberStatus(w.f2), await memberStatus(w.f3)])
        .toEqual(['active', 'active', 'suspended+billing', 'suspended+billing']);
      const invites = await su.query<{ id: string; revoked: boolean }>(
        `SELECT id, revoked_at IS NOT NULL AS revoked FROM organization_invites WHERE id = ANY($1::uuid[])`,
        [[live1, live2, expired, accepted]]);
      expect(Object.fromEntries(invites.rows.map((r) => [r.id, r.revoked])))
        .toEqual({ [live1]: true, [live2]: true, [expired]: false, [accepted]: false });
    });

    it('on Free, enforce suspends the foreman first and pauses their older job, so the owner\'s newer job stays live', async () => {
      const owner = await user();
      const org = await company(owner);
      const f = await user();
      await foreman(org, f, '2026-01-01T00:00:00Z');
      const older = await job(f, 'Foreman older', '2026-02-01T00:00:00Z');
      const newer = await job(owner, 'Owner newer', '2026-02-02T00:00:00Z');
      const code = await publish(older);

      // Free: one active job, no foreman seat.
      const result = await asBilling(ENFORCE_SQL, [org, 1, 0]);

      expect(result).toEqual({
        paused_count: 1, paused_titles: ['Foreman older'],
        suspended_count: 1, suspended_emails: [f.email],
        revoked_invite_count: 0, owner_email: owner.email,
      });
      expect(await memberStatus(f)).toBe('suspended+billing');
      expect(await statusOf([older, newer])).toEqual({ [older]: 'paused+billing', [newer]: 'active' });
      expect(await statusEvents([older, newer])).toEqual([`Foreman older:active>paused@${f.id}`]);
      expect(await visibilityEvents([older, newer])).toEqual([`${code}:removed`]);

      // A repeated webhook changes nothing.
      expect(await asBilling(ENFORCE_SQL, [org, 1, 0])).toEqual({
        paused_count: 0, paused_titles: [], suspended_count: 0, suspended_emails: [], revoked_invite_count: 0, owner_email: owner.email,
      });
      expect(await statusOf([older, newer])).toEqual({ [older]: 'paused+billing', [newer]: 'active' });
      // Restore on the same plan brings nothing back: no seat is free and the owner's job holds the slot.
      expect(await asBilling(RESTORE_SQL, [org, 1, 0])).toEqual({
        resumed_count: 0, resumed_titles: [], restored_count: 0, restored_emails: [], owner_email: owner.email,
      });
    });

    it('enforce pauses a suspended foreman\'s job first; among active members\' jobs the oldest stay, whoever posted them', async () => {
      const owner = await user();
      const org = await company(owner);
      const f1 = await user();
      const f2 = await user();
      await foreman(org, f1, '2026-01-01T00:00:00Z');
      await foreman(org, f2, '2026-01-02T00:00:00Z');
      // f2 (joined last, so suspended) has the oldest job; f1's beats the owner's on age.
      const f2Job = await job(f2, 'F2 oldest', '2026-02-01T00:00:00Z');
      const f1Job = await job(f1, 'F1 middle', '2026-02-02T00:00:00Z');
      const ownerJob = await job(owner, 'Owner newest', '2026-02-03T00:00:00Z');

      const result = await asBilling(ENFORCE_SQL, [org, 1, 1]);

      expect(result).toEqual({
        paused_count: 2, paused_titles: ['F2 oldest', 'Owner newest'],
        suspended_count: 1, suspended_emails: [f2.email],
        revoked_invite_count: 0, owner_email: owner.email,
      });
      expect([await memberStatus(owner), await memberStatus(f1), await memberStatus(f2)])
        .toEqual(['active', 'active', 'suspended+billing']);
      expect(await statusOf([f2Job, f1Job, ownerJob])).toEqual({
        [f2Job]: 'paused+billing', [f1Job]: 'active', [ownerJob]: 'paused+billing',
      });
      expect(await statusEvents([f2Job, f1Job, ownerJob])).toEqual([
        `F2 oldest:active>paused@${f2.id}`, `Owner newest:active>paused@${owner.id}`,
      ]);
    });

    it('a Free downgrade round-trips: restore on Pro brings the foreman back and resumes every paused job, oldest first', async () => {
      const owner = await user();
      const org = await company(owner);
      const f = await user();
      await foreman(org, f, '2026-01-01T00:00:00Z');
      const fOld = await job(f, 'Foreman older', '2026-02-01T00:00:00Z');
      const oNew = await job(owner, 'Owner newer', '2026-02-02T00:00:00Z');
      const oNewest = await job(owner, 'Owner newest', '2026-02-03T00:00:00Z');

      const enforced = await asBilling<{ paused_titles: string[] }>(ENFORCE_SQL, [org, 1, 0]);
      expect(enforced.paused_titles).toEqual(['Foreman older', 'Owner newest']);
      expect(await statusOf([fOld, oNew, oNewest])).toEqual({
        [fOld]: 'paused+billing', [oNew]: 'active', [oNewest]: 'paused+billing',
      });

      // Pro: ten jobs, three seats.
      const restored = await asBilling(RESTORE_SQL, [org, 10, 3]);

      expect(restored).toEqual({
        resumed_count: 2, resumed_titles: enforced.paused_titles, restored_count: 1, restored_emails: [f.email], owner_email: owner.email,
      });
      expect(await memberStatus(f)).toBe('active');
      expect(await statusOf([fOld, oNew, oNewest])).toEqual({ [fOld]: 'active', [oNew]: 'active', [oNewest]: 'active' });
    });

    it('a partial restore resumes the oldest billing-paused job across the owner and the restored foreman', async () => {
      const owner = await user();
      const org = await company(owner);
      const f = await user();
      await foreman(org, f, '2026-01-01T00:00:00Z');
      const fJob = await job(f, 'Foreman oldest', '2026-02-01T00:00:00Z');
      const oKept = await job(owner, 'Owner kept', '2026-02-02T00:00:00Z');
      const oPaused = await job(owner, 'Owner paused', '2026-02-03T00:00:00Z');
      await asBilling(ENFORCE_SQL, [org, 1, 0]);
      expect(await statusOf([fJob, oKept, oPaused])).toEqual({
        [fJob]: 'paused+billing', [oKept]: 'active', [oPaused]: 'paused+billing',
      });

      // Two jobs, one seat: the foreman comes back, and one slot opens. The
      // foreman's job is older than the owner's paused one, so it resumes.
      const restored = await asBilling(RESTORE_SQL, [org, 2, 1]);

      expect(restored).toEqual({
        resumed_count: 1, resumed_titles: ['Foreman oldest'], restored_count: 1, restored_emails: [f.email], owner_email: owner.email,
      });
      expect(await statusOf([fJob, oKept, oPaused])).toEqual({
        [fJob]: 'active', [oKept]: 'active', [oPaused]: 'paused+billing',
      });
    });

    for (const status of ['suspended', 'removed']) {
      it(`a ${status} member without the billing mark: their older job is paused first, and restore neither returns them nor resumes it`, async () => {
        const owner = await user();
        const org = await company(owner);
        const active = await user();
        const other = await user();
        await foreman(org, active, '2026-01-01T00:00:00Z');
        // Not the enforcer's doing: no billing_suspended_at.
        await foreman(org, other, '2026-01-02T00:00:00Z', status);
        const otherJob = await job(other, 'Other oldest', '2026-02-01T00:00:00Z');
        const activeJob = await job(active, 'Active newest', '2026-02-02T00:00:00Z');

        // One job, one seat: the active foreman holds the seat, so nobody is suspended.
        const result = await asBilling(ENFORCE_SQL, [org, 1, 1]);

        expect(result).toEqual({
          paused_count: 1, paused_titles: ['Other oldest'], suspended_count: 0, suspended_emails: [],
          revoked_invite_count: 0, owner_email: owner.email,
        });
        expect(await statusOf([otherJob, activeJob])).toEqual({ [otherJob]: 'paused+billing', [activeJob]: 'active' });
        expect(await statusEvents([otherJob, activeJob])).toEqual([`Other oldest:active>paused@${other.id}`]);
        expect([await memberStatus(active), await memberStatus(other)]).toEqual(['active', status]);

        expect(await asBilling(RESTORE_SQL, [org, 10, 3])).toEqual({
          resumed_count: 0, resumed_titles: [], restored_count: 0, restored_emails: [], owner_email: owner.email,
        });
        expect(await memberStatus(other)).toBe(status);
        expect(await statusOf([otherJob, activeJob])).toEqual({ [otherJob]: 'paused+billing', [activeJob]: 'active' });
      });
    }

    it('under the job limit, a foreman cut by seats keeps their active job', async () => {
      const owner = await user();
      const org = await company(owner);
      const f = await user();
      await foreman(org, f, '2026-01-01T00:00:00Z');
      const fJob = await job(f, 'Foreman job', '2026-02-01T00:00:00Z');
      await job(owner, 'Owner job', '2026-02-02T00:00:00Z');

      const result = await asBilling(ENFORCE_SQL, [org, 10, 0]);

      expect(result).toEqual({
        paused_count: 0, paused_titles: [], suspended_count: 1, suspended_emails: [f.email],
        revoked_invite_count: 0, owner_email: owner.email,
      });
      expect(await memberStatus(f)).toBe('suspended+billing');
      expect(await statusOf([fJob])).toEqual({ [fJob]: 'active' });
      expect(await statusEvents([fJob])).toEqual([]);
    });

    it('a second enforce with the same limits changes nothing (a repeated webhook)', async () => {
      const w = await world();
      const keep = await job(w.owner, 'Keep', '2026-02-01T00:00:00Z');
      const pause = await job(w.f1, 'Pause', '2026-02-02T00:00:00Z');
      const code = await publish(pause);
      await asBilling(ENFORCE_SQL, [w.org, 1, 0]);
      const members = `SELECT user_id, status, status_changed_at, billing_suspended_at FROM organization_members
                        WHERE organization_id = $1 ORDER BY user_id`;
      const changed = (await su.query(members, [w.org])).rows;

      const again = await asBilling(ENFORCE_SQL, [w.org, 1, 0]);

      expect(again).toEqual({
        paused_count: 0, paused_titles: [], suspended_count: 0, suspended_emails: [], revoked_invite_count: 0, owner_email: w.owner.email,
      });
      expect((await su.query(members, [w.org])).rows).toEqual(changed);
      // No second event of either kind.
      expect(await statusEvents([keep, pause])).toEqual([`Pause:active>paused@${w.f1.id}`]);
      expect(await visibilityEvents([keep, pause])).toEqual([`${code}:removed`]);
    });

    it('restore brings back the earliest suspended foremen up to the seats left, then the billing-paused jobs of active members oldest first, and repeats as a no-op', async () => {
      const owner = await user();
      const org = await company(owner);
      const f1 = await user();
      const f2 = await user();
      const f3 = await user();
      const removed = await user();
      await foreman(org, f1, '2026-01-01T00:00:00Z');
      await foreman(org, f2, '2026-01-02T00:00:00Z', 'suspended', '2026-04-01T00:00:00Z');
      await foreman(org, f3, '2026-01-03T00:00:00Z', 'suspended', '2026-04-02T00:00:00Z');
      await foreman(org, removed, '2026-01-04T00:00:00Z', 'removed');
      const live = await job(owner, 'Live', '2026-02-01T00:00:00Z');
      const p1 = await job(owner, 'P1', '2026-02-02T00:00:00Z', 'paused', true);
      const p2 = await job(f3, 'P2', '2026-02-03T00:00:00Z', 'paused', true);
      const p3 = await job(f2, 'P3', '2026-02-04T00:00:00Z', 'paused', true);
      const manual = await job(f1, 'Manual', '2026-02-05T00:00:00Z', 'paused');

      const result = await asBilling(RESTORE_SQL, [org, 3, 2]);

      // Seats: 2 - 1 active foreman = 1, so f2 (marked first) comes back; f3 waits; removed never does.
      // Jobs: 3 - 1 active = 2 slots. P1 (the owner's) and P3 (f2's, restored) resume; P2 stays
      // paused because f3 is still suspended; the manual pause is not billing's.
      expect(result).toEqual({
        resumed_count: 2, resumed_titles: ['P1', 'P3'], restored_count: 1, restored_emails: [f2.email], owner_email: owner.email,
      });
      expect([await memberStatus(f1), await memberStatus(f2), await memberStatus(f3), await memberStatus(removed)])
        .toEqual(['active', 'active', 'suspended+billing', 'removed']);
      expect(await statusOf([live, p1, p2, p3, manual])).toEqual({
        [live]: 'active', [p1]: 'active', [p2]: 'paused+billing', [p3]: 'active', [manual]: 'paused',
      });
      const events = await su.query(
        `SELECT job_id, employer_id, from_status, to_status, actor FROM job_status_events WHERE job_id = ANY($1::uuid[]) ORDER BY job_id`,
        [[p1, p2, p3]]);
      expect(events.rows).toEqual(expect.arrayContaining([
        { job_id: p1, employer_id: owner.id, from_status: 'paused', to_status: 'active', actor: 'billing' },
        { job_id: p3, employer_id: f2.id, from_status: 'paused', to_status: 'active', actor: 'billing' },
      ]));
      expect(events.rows).toHaveLength(2);

      expect(await asBilling(RESTORE_SQL, [org, 3, 2])).toEqual({
        resumed_count: 0, resumed_titles: [], restored_count: 0, restored_emails: [], owner_email: owner.email,
      });
    });

    it('restore brings a billing-paused job whose hires fill it back filled, and announces a resumed public job', async () => {
      const w = await world();
      const worker = await user();
      await su.query(`UPDATE users SET user_type = 'worker' WHERE id = $1`, [worker.id]);
      const full = (await su.query<{ id: string }>(
        `INSERT INTO jobs (employer_id, title, location, job_type, status, created_at, billing_paused_at, number_of_workers_needed)
         VALUES ($1, 'Full', 'Austin', 'full-time', 'paused', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z', 1) RETURNING id`,
        [w.f1.id])).rows[0].id;
      await su.query(
        `INSERT INTO job_applications (job_id, worker_id, status, hired_at) VALUES ($1, $2, 'hired', now())`, [full, worker.id]);
      const fullCode = await publish(full);
      const open = await job(w.owner, 'Open', '2026-02-02T00:00:00Z', 'paused', true);
      const openCode = await publish(open);
      expect(await su.query(`SELECT status, workers_hired FROM jobs WHERE id = $1`, [full]).then((r) => r.rows[0]))
        .toEqual({ status: 'paused', workers_hired: 1 });

      const result = await asBilling(RESTORE_SQL, [w.org, 1, 3]);

      // The filled job takes no slot and is neither counted nor announced; the open one resumes.
      expect(result).toMatchObject({ resumed_count: 1, resumed_titles: ['Open'] });
      expect(await statusOf([full, open])).toEqual({ [full]: 'filled', [open]: 'active' });
      expect(await statusEvents([full, open])).toEqual([
        `Full:paused>filled@${w.f1.id}`, `Open:paused>active@${w.owner.id}`,
      ]);
      expect(await visibilityEvents([full, open])).toEqual([`${openCode}:published`]);
      expect(fullCode).toHaveLength(6);
    });

    it('a tied batch comes back earliest joined first', async () => {
      const w = await world();
      // One downgrade to no seats suspends all three foremen in one statement: one mark time.
      await asBilling(ENFORCE_SQL, [w.org, 10, 0]);
      const marks = await su.query<{ n: number }>(
        `SELECT count(DISTINCT billing_suspended_at)::int AS n FROM organization_members WHERE organization_id = $1 AND role = 'foreman'`, [w.org]);
      expect(marks.rows[0].n).toBe(1);

      const result = await asBilling<{ restored_count: number; restored_emails: string[] }>(RESTORE_SQL, [w.org, 10, 2]);

      // The reverse of the suspension order (most recently joined first): f1, then f2.
      expect(result).toMatchObject({ restored_count: 2, restored_emails: [w.f1.email, w.f2.email] });
      expect([await memberStatus(w.f1), await memberStatus(w.f2), await memberStatus(w.f3)])
        .toEqual(['active', 'active', 'suspended+billing']);
    });

    it('restore never brings back a member suspended for another reason (no billing mark)', async () => {
      const w = await world();
      // Not the enforcer's suspension: status only, no billing_suspended_at.
      await su.query(`UPDATE organization_members SET status = 'suspended', status_changed_at = now() WHERE user_id = $1`, [w.f2.id]);

      // Pro's 3 seats: f1 and f3 hold two, so one is free, but f2 carries no mark.
      const result = await asBilling<{ restored_count: number }>(RESTORE_SQL, [w.org, 10, 3]);

      expect(result.restored_count).toBe(0);
      expect(await memberStatus(w.f2)).toBe('suspended');
    });

    it('a live pending invite holds a seat on restore', async () => {
      const w = await world();
      await su.query(
        `UPDATE organization_members SET status = 'suspended', status_changed_at = now(), billing_suspended_at = now()
          WHERE user_id = ANY($1::uuid[])`,
        [[w.f2.id, w.f3.id]]);
      await invite(w, '2026-03-01T00:00:00Z', '2099-01-01T00:00:00Z');
      // Pro's 3 seats: f1 active + 1 live invite = 2 held, so one suspended foreman returns.
      const result = await asBilling<{ restored_count: number }>(RESTORE_SQL, [w.org, 10, 3]);
      expect(result.restored_count).toBe(1);
    });

    it('enforce and restore change nothing in another company', async () => {
      const w = await world();
      await job(w.owner, 'Mine', '2026-02-01T00:00:00Z');
      const sf = await user();
      const ss = await user();
      await foreman(w.strangerOrg, sf, '2026-01-01T00:00:00Z');
      await foreman(w.strangerOrg, ss, '2026-01-02T00:00:00Z', 'suspended', '2026-04-01T00:00:00Z');
      const s1 = await job(w.stranger, 'S1', '2026-02-01T00:00:00Z');
      const s2 = await job(sf, 'S2', '2026-02-02T00:00:00Z');
      const s3 = await job(w.stranger, 'S3', '2026-02-03T00:00:00Z', 'paused', true);
      const si = await inviteTo(w.strangerOrg, w.stranger, '2026-03-01T00:00:00Z', '2099-01-01T00:00:00Z');
      const strangerState = async () => ({
        jobs: await statusOf([s1, s2, s3]),
        members: [await memberStatus(w.stranger), await memberStatus(sf), await memberStatus(ss)],
        inviteRevoked: (await su.query<{ revoked: boolean }>(
          `SELECT revoked_at IS NOT NULL AS revoked FROM organization_invites WHERE id = $1`, [si])).rows[0].revoked,
        events: [...await statusEvents([s1, s2, s3]), ...await visibilityEvents([s1, s2, s3])],
      });
      const before = await strangerState();
      expect(before).toEqual({
        jobs: { [s1]: 'active', [s2]: 'active', [s3]: 'paused+billing' }, members: ['active', 'active', 'suspended+billing'],
        inviteRevoked: false, events: [],
      });

      await asBilling(ENFORCE_SQL, [w.org, 0, 0]);
      expect(await strangerState()).toEqual(before);
      await asBilling(RESTORE_SQL, [w.org, 10, 3]);
      expect(await strangerState()).toEqual(before);
    });

    it('the billing mark sits only on a suspended member (23514 otherwise)', async () => {
      const w = await world();
      await su.query('BEGIN');
      try {
        await rejects(su, `UPDATE organization_members SET billing_suspended_at = now() WHERE user_id = $1`, [w.f1.id], '23514');
        await su.query(`UPDATE organization_members SET status = 'suspended', billing_suspended_at = now() WHERE user_id = $1`, [w.f1.id]);
        await rejects(su, `UPDATE organization_members SET status = 'active' WHERE user_id = $1`, [w.f1.id], '23514');
      } finally {
        await su.query('ROLLBACK');
      }
    });

    it('refuses a negative limit and an unknown company', async () => {
      const w = await world();
      await expect(asBilling(ENFORCE_SQL, [w.org, -1, 0])).rejects.toMatchObject({ code: '22023' });
      await expect(asBilling(RESTORE_SQL, [w.org, 1, -1])).rejects.toMatchObject({ code: '22023' });
      await expect(asBilling(ENFORCE_SQL, [randomUUID(), 1, 0])).rejects.toMatchObject({ code: 'P0002' });
      await expect(asBilling(RESTORE_SQL, [randomUUID(), 1, 0])).rejects.toMatchObject({ code: 'P0002' });
    });

    it('the processor\'s login still cannot touch companies or memberships directly (42501)', async () => {
      const w = await world();
      await expect(asBilling(`SELECT status FROM organization_members WHERE user_id = $1`, [w.f1.id])).rejects.toMatchObject({ code: '42501' });
      await expect(asBilling(`UPDATE organizations SET name = 'x' WHERE id = $1`, [w.org])).rejects.toMatchObject({ code: '42501' });
      await expect(asBilling(`SELECT id FROM jobs LIMIT 1`, [])).rejects.toMatchObject({ code: '42501' });
    });
  });
});
