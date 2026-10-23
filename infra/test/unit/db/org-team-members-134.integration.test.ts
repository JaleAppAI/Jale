/**
 * org-team-members-134 -- migration 134 on a real bed: member removal, the
 * owner's team lists, the caller's membership and the desired Cognito state,
 * each definer run as its real login (jale_api with app.current_user_id and
 * app.current_internal_user_id set; jale_billing with nothing set), inside a
 * transaction that is rolled back unless the case needs committed rows.
 *
 *  - the catalog: every 134 function's owner (jale_cap_org_team), definer
 *    security, pinned search_path and its one caller; the capability owner's
 *    new column rights (employer_profiles, jobs, users.full_name) and its two
 *    open SELECT policies; the full (organization_id, email) invites index;
 *  - org_team_remove_member: has_jobs while any job names the member (closed
 *    and filled included), then removed (billing mark cleared, cognito_sub
 *    returned); a plain suspended foreman removed; is_owner, already_removed,
 *    not_found (another company's member), not_owner;
 *  - org_team_members / org_team_invites: the owner's lists (active and
 *    suspended members only, job counts, billing_suspended, display names;
 *    pending invites incl. expired); a removed member never listed; a
 *    foreman is refused with 42501;
 *  - org_team_membership: any employer login's own membership, removed
 *    included, with has_live_invite; no rows without one;
 *  - org_member_access: enabled for active foremen and for a removed one with
 *    a live invite of the company, disabled otherwise and again once the
 *    enforcer revokes the invite; owners never listed; the since window sorts
 *    a re-invite of a long-removed member first (order checked to the
 *    microsecond); a padded, mixed-case users.email still matches its
 *    invite; argument errors raise 22023 and the bounds are accepted.
 * Invites are created through 133's definers; other fixtures through the
 * superuser URL (Task 1's World). afterAll removes them, the invite mail
 * included.
 *
 * Run: bash infra/db/local/bootstrap-testbed.sh --ephemeral --ref none --profile request \
 *   --container <name> --port <port> -- \
 *   bash infra/scripts/run-whatsapp-v2-db-tests.sh --suite test/unit/db/org-team-members-134.integration.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { FIXTURE_TOS_VERSION, World, type UserFixture } from './r-paths-world';
import { describeInProfiles, withLoginClient } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: org-team-members-134 needs JALE_TEST_DATABASE_URL (see header)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

const hash = (t: string): Buffer => createHash('sha256').update(t, 'utf8').digest();

const CREATE_SQL = 'SELECT * FROM jale_cap.org_team_invite_create($1, $2, $3, $4)';
const QUEUE_SQL = 'SELECT jale_cap.org_team_invite_queue_email($1, $2, $3, $4) AS id';
const REMOVE_SQL = 'SELECT * FROM jale_cap.org_team_remove_member($1)';
const MEMBERS_SQL = 'SELECT * FROM jale_cap.org_team_members()';
const INVITES_SQL = 'SELECT * FROM jale_cap.org_team_invites()';
const MEMBERSHIP_SQL = 'SELECT * FROM jale_cap.org_team_membership()';
const ACCESS_SQL = 'SELECT * FROM jale_cap.org_member_access($1, $2, $3)';

/** Every 134 function: [signature, caller, pg_get_function_result]. */
const FUNCTIONS: Array<[string, string, string]> = [
  ['jale_cap.org_member_access(uuid, timestamp with time zone, integer)', 'jale_billing',
    'TABLE(user_id uuid, cognito_sub text, enabled boolean, changed_at timestamp with time zone)'],
  ['jale_cap.org_team_invites()', 'jale_api',
    'TABLE(invite_id uuid, email text, contact_name text, created_at timestamp with time zone, expires_at timestamp with time zone, last_sent_at timestamp with time zone, expired boolean)'],
  ['jale_cap.org_team_members()', 'jale_api',
    'TABLE(user_id uuid, email text, display_name text, role text, status text, billing_suspended boolean, joined_at timestamp with time zone, status_changed_at timestamp with time zone, active_jobs integer, open_jobs integer)'],
  ['jale_cap.org_team_membership()', 'jale_api',
    'TABLE(user_id uuid, organization_id uuid, role text, status text, company_name text, has_live_invite boolean)'],
  ['jale_cap.org_team_remove_member(uuid)', 'jale_api', 'TABLE(outcome text, cognito_sub text)'],
];

type MemberRow = {
  user_id: string; email: string; display_name: string; role: string; status: string; billing_suspended: boolean;
  joined_at: Date; status_changed_at: Date; active_jobs: number; open_jobs: number;
};
type InviteRow = {
  invite_id: string; email: string; contact_name: string | null; created_at: Date; expires_at: Date;
  last_sent_at: Date; expired: boolean;
};
type MembershipRow = {
  user_id: string; organization_id: string; role: string; status: string; company_name: string; has_live_invite: boolean;
};
type AccessRow = { user_id: string; cognito_sub: string; enabled: boolean; changed_at: Date };

maybeDescribe('migration 134: removal, team lists, membership, member access', () => {
  let world: World;
  /** Employer logins with no company. */
  const bareLogins: string[] = [];

  beforeAll(async () => {
    world = new World(databaseUrl!);
    await world.connect();
  });
  afterAll(async () => {
    try {
      const orgs = (await world.su.query<{ organization_id: string }>(
        `SELECT organization_id FROM organization_members WHERE user_id = ANY($1::uuid[]) AND role = 'owner'`,
        [world.users])).rows.map((r) => r.organization_id);
      await world.su.query(
        `DELETE FROM email_outbox WHERE source_type = 'organization_invite'
            AND source_id IN (SELECT id FROM organization_invites WHERE organization_id = ANY($1::uuid[]))`, [orgs]);
      await world.su.query(`DELETE FROM employer_profiles WHERE user_id = ANY($1::uuid[])`, [world.users]);
      // Invites cascade from their company; members of a company go with it.
      await world.cleanup();
      await world.su.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [bareLogins]);
    } finally {
      await world.end();
    }
  });

  const freshEmail = () => `member131-${randomUUID()}@example.com`;

  async function bareLogin(email: string): Promise<UserFixture> {
    const id = randomUUID();
    const sub = `fixture-employer-${randomUUID()}`;
    await world.su.query(
      `INSERT INTO users (id, cognito_sub, user_type, full_name, email, tos_version)
       VALUES ($1, $2, 'employer', 'Bare Login', $3, $4)`, [id, sub, email, FIXTURE_TOS_VERSION]);
    bareLogins.push(id);
    return { id, sub };
  }
  async function orgOf(owner: UserFixture): Promise<string> {
    return (await world.su.query<{ organization_id: string }>(
      'SELECT organization_id FROM organization_members WHERE user_id = $1', [owner.id])).rows[0].organization_id;
  }
  async function emailOf(p: UserFixture): Promise<string> {
    return (await world.su.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [p.id])).rows[0].email;
  }
  async function memberRow(p: UserFixture) {
    return (await world.su.query<{ status: string; billing_suspended_at: Date | null; status_changed_at: Date }>(
      'SELECT status, billing_suspended_at, status_changed_at FROM organization_members WHERE user_id = $1', [p.id])).rows[0];
  }

  async function inTransaction<T>(login: string, caller: UserFixture | null, commit: boolean,
    fn: (c: Client) => Promise<T>): Promise<T> {
    return withLoginClient(login, async (c) => {
      await c.query('BEGIN');
      let done = false;
      try {
        if (caller) {
          await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [caller.sub]);
          await c.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [caller.id]);
        }
        const result = await fn(c);
        if (commit) {
          await c.query('COMMIT');
          done = true;
        }
        return result;
      } finally {
        if (!done) await c.query('ROLLBACK');
      }
    });
  }
  const asApi = <T>(caller: UserFixture, fn: (c: Client) => Promise<T>) => inTransaction('jale_api', caller, false, fn);
  const commitApi = <T>(caller: UserFixture, fn: (c: Client) => Promise<T>) => inTransaction('jale_api', caller, true, fn);
  const asBilling = <T>(fn: (c: Client) => Promise<T>) => inTransaction('jale_billing', null, false, fn);
  async function rejects(c: Client, sql: string, params: unknown[], code: string, message?: string): Promise<void> {
    await c.query('SAVEPOINT expected_error');
    await expect(c.query(sql, params)).rejects.toMatchObject(message === undefined ? { code } : { code, message });
    await c.query('ROLLBACK TO SAVEPOINT expected_error');
  }

  const remove = async (c: Client, userId: string | null) =>
    (await c.query<{ outcome: string; cognito_sub: string | null }>(REMOVE_SQL, [userId])).rows;
  const access = async (c: Client, org: string | null, since: Date | string | null, limit: number | null) =>
    (await c.query<AccessRow>(ACCESS_SQL, [org, since, limit])).rows;

  /** Create plus queue_email in one committed transaction, as the owner (133's path); the invite id. */
  async function invite(owner: UserFixture, email: string, name: string | null = null): Promise<string> {
    return commitApi(owner, async (c) => {
      const rows = (await c.query<{ outcome: string; invite_id: string }>(CREATE_SQL, [email, name, hash(randomUUID()), 10])).rows;
      expect(rows.map((r) => r.outcome)).toEqual(['created']);
      await c.query(QUEUE_SQL, [rows[0].invite_id, 'You are invited', 'Join the team', null]);
      return rows[0].invite_id;
    });
  }

  describeInProfiles(['standard', 'request', 'owner-unrestricted'], 'the catalog', () => {
    it('each 134 function has its owner, definer security, pinned search_path and one caller', async () => {
      const actual = [];
      for (const [signature] of FUNCTIONS) {
        const { rows } = await world.su.query(
          `SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
                  l.lanname AS language, pg_catalog.pg_get_function_result(p.oid) AS returns,
                  ARRAY(SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END
                          FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                         WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner
                         ORDER BY 1) AS callers
             FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid = p.prolang
            WHERE p.oid = pg_catalog.to_regprocedure($1)`, [signature]);
        actual.push([signature, rows]);
      }
      expect(actual).toEqual(FUNCTIONS.map(([signature, caller, returns]) => [signature, [{
        owner: 'jale_cap_org_team', definer: true, config: ['search_path=pg_catalog, pg_temp'], language: 'plpgsql',
        returns, callers: [caller],
      }]]));
    });

    it('jale_cap_org_team reads employer_profiles (user_id, contact_name), jobs (id, employer_id, status) and users.full_name, under two open SELECT policies', async () => {
      const { rows } = await world.su.query<{ grants: string[] }>(
        `SELECT array_agg(c.relname || ':' || a.attname || ':' || p.privilege
                          ORDER BY (c.relname || ':' || a.attname || ':' || p.privilege) COLLATE "C") AS grants
           FROM pg_class c
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
           CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) p(privilege)
          WHERE c.oid IN ('public.employer_profiles'::regclass, 'public.jobs'::regclass, 'public.users'::regclass)
            AND has_column_privilege('jale_cap_org_team', c.oid, a.attname, p.privilege)`);
      expect(rows[0].grants).toEqual([
        'employer_profiles:contact_name:SELECT', 'employer_profiles:user_id:SELECT',
        'jobs:employer_id:SELECT', 'jobs:id:SELECT', 'jobs:status:SELECT',
        'users:cognito_sub:SELECT', 'users:email:SELECT', 'users:full_name:SELECT', 'users:id:SELECT', 'users:user_type:SELECT',
      ]);
      const policies = await world.su.query(
        `SELECT p.polrelid::regclass::text AS rel, p.polname, p.polcmd, p.polpermissive,
                pg_get_expr(p.polqual, p.polrelid) AS using, pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
           FROM pg_policy p
          WHERE 'jale_cap_org_team'::regrole::oid = ANY (p.polroles)
            AND p.polrelid IN ('public.employer_profiles'::regclass, 'public.jobs'::regclass)
          ORDER BY 1, 2`);
      expect(policies.rows).toEqual([
        { rel: 'employer_profiles', polname: 'employer_profiles_cap_org_team_select', polcmd: 'r', polpermissive: true, using: 'true', with_check: null },
        { rel: 'jobs', polname: 'jobs_cap_org_team_select', polcmd: 'r', polpermissive: true, using: 'true', with_check: null },
      ]);
      const count = await world.su.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_policy p WHERE 'jale_cap_org_team'::regrole::oid = ANY (p.polroles)`);
      expect(count.rows[0].n).toBe(14);
    });

    it('organization_invites has the full (organization_id, email) index the member access and membership reads use', async () => {
      const { rows } = await world.su.query(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'organization_invites_by_org_email'`);
      expect(rows).toEqual([{
        indexdef: 'CREATE INDEX organization_invites_by_org_email ON public.organization_invites USING btree (organization_id, email)',
      }]);
    });
  });

  describeInProfiles(['standard', 'request'], 'removal and lists', () => {
    it('remove: has_jobs while any job names the member; removed once none does, billing mark cleared, cognito_sub returned', async () => {
      const owner = await world.employer();
      const foreman = await world.foreman(owner.id, { status: 'suspended', billingSuspended: true });
      const job = await world.job(foreman.id, { status: 'paused' });
      expect(await asApi(owner, (c) => remove(c, foreman.id))).toEqual([{ outcome: 'has_jobs', cognito_sub: null }]);
      expect(await memberRow(foreman)).toEqual(expect.objectContaining({ status: 'suspended', billing_suspended_at: expect.any(Date) }));

      // The owner (Task 9's handler) moves the job first; then the removal goes through.
      await world.su.query('UPDATE jobs SET employer_id = $1 WHERE id = $2', [owner.id, job.id]);
      const before = (await memberRow(foreman)).status_changed_at;
      expect(await commitApi(owner, (c) => remove(c, foreman.id))).toEqual([{ outcome: 'removed', cognito_sub: foreman.sub }]);
      const after = await memberRow(foreman);
      expect(after).toEqual(expect.objectContaining({ status: 'removed', billing_suspended_at: null }));
      expect(after.status_changed_at.getTime()).toBeGreaterThan(before.getTime());
    });

    it('remove: is_owner for the owner, already_removed, not_found for another company\'s member, not_owner for a foreman', async () => {
      const owner = await world.employer();
      const active = await world.foreman(owner.id);
      const removed = await world.foreman(owner.id, { status: 'removed' });
      const other = await world.employer();
      const otherForeman = await world.foreman(other.id);
      const outcomes = await asApi(owner, async (c) => [
        await remove(c, owner.id),
        await remove(c, removed.id),
        await remove(c, otherForeman.id),
        await remove(c, other.id),
        await remove(c, randomUUID()),
        await remove(c, null),
      ]);
      expect(outcomes).toEqual([
        [{ outcome: 'is_owner', cognito_sub: null }],
        [{ outcome: 'already_removed', cognito_sub: null }],
        [{ outcome: 'not_found', cognito_sub: null }],
        [{ outcome: 'not_found', cognito_sub: null }],
        [{ outcome: 'not_found', cognito_sub: null }],
        [{ outcome: 'not_found', cognito_sub: null }],
      ]);
      // A foreman removes no one, committed or not.
      expect(await commitApi(active, (c) => remove(c, removed.id))).toEqual([{ outcome: 'not_owner', cognito_sub: null }]);
      expect(await commitApi(active, (c) => remove(c, active.id))).toEqual([{ outcome: 'not_owner', cognito_sub: null }]);
      expect((await memberRow(active)).status).toBe('active');
      expect((await memberRow(otherForeman)).status).toBe('active');
      // A removed owner of nothing: a bare login is not an owner either.
      const bare = await bareLogin(freshEmail());
      expect(await asApi(bare, (c) => remove(c, active.id))).toEqual([{ outcome: 'not_owner', cognito_sub: null }]);
    });

    it('remove: has_jobs for a closed or a filled job too; a suspended foreman (no billing mark) is removed', async () => {
      const owner = await world.employer();
      const withClosed = await world.foreman(owner.id);
      const withFilled = await world.foreman(owner.id);
      const suspended = await world.foreman(owner.id, { status: 'suspended' });
      await world.job(withClosed.id, { status: 'closed' });
      await world.job(withFilled.id, { status: 'filled' });
      expect(await asApi(owner, async (c) => [await remove(c, withClosed.id), await remove(c, withFilled.id)])).toEqual([
        [{ outcome: 'has_jobs', cognito_sub: null }],
        [{ outcome: 'has_jobs', cognito_sub: null }],
      ]);
      expect((await memberRow(withClosed)).status).toBe('active');
      expect((await memberRow(withFilled)).status).toBe('active');
      expect(await commitApi(owner, (c) => remove(c, suspended.id))).toEqual([{ outcome: 'removed', cognito_sub: suspended.sub }]);
      expect(await memberRow(suspended)).toEqual(expect.objectContaining({ status: 'removed', billing_suspended_at: null }));
    });

    it('org_team_members and org_team_invites: the owner sees every active and suspended member (removed ones excluded) and every pending invite; a foreman is refused (42501)', async () => {
      const owner = await world.employer({ companyName: 'Lists Co' });
      const named = await world.foreman(owner.id, { fullName: 'Ignored Full Name' });
      await world.su.query(`INSERT INTO employer_profiles (user_id, contact_name) VALUES ($1, '  Luis Pérez ')`, [named.id]);
      const suspended = await world.foreman(owner.id, { status: 'suspended', billingSuspended: true, fullName: '  ' });
      await world.foreman(owner.id, { status: 'removed', fullName: 'Rita Removed' });
      await world.job(owner.id, { status: 'active' });
      await world.job(named.id, { status: 'active' });
      await world.job(named.id, { status: 'paused' });
      await world.job(named.id, { status: 'closed' });
      await world.job(suspended.id, { status: 'paused' });

      const older = await invite(owner, freshEmail(), 'Old Invite');
      const newer = await invite(owner, freshEmail());
      const revoked = await invite(owner, freshEmail());
      await world.su.query(`UPDATE organization_invites SET created_at = now() - interval '2 days', expires_at = now() - interval '1 minute' WHERE id = $1`, [older]);
      await world.su.query(`UPDATE organization_invites SET revoked_at = now() WHERE id = $1`, [revoked]);
      // Another company's invite never shows.
      const other = await world.employer();
      await invite(other, freshEmail());

      const { members, invites } = await asApi(owner, async (c) => ({
        members: (await c.query<MemberRow>(MEMBERS_SQL)).rows,
        invites: (await c.query<InviteRow>(INVITES_SQL)).rows,
      }));
      expect(members.map((m) => ({ ...m, joined_at: undefined, status_changed_at: undefined }))).toEqual([
        { user_id: owner.id, email: await emailOf(owner), display_name: 'Fixture Employer', role: 'owner', status: 'active',
          billing_suspended: false, joined_at: undefined, status_changed_at: undefined, active_jobs: 1, open_jobs: 1 },
        { user_id: named.id, email: await emailOf(named), display_name: 'Luis Pérez', role: 'foreman', status: 'active',
          billing_suspended: false, joined_at: undefined, status_changed_at: undefined, active_jobs: 1, open_jobs: 2 },
        { user_id: suspended.id, email: await emailOf(suspended), display_name: await emailOf(suspended), role: 'foreman',
          status: 'suspended', billing_suspended: true, joined_at: undefined, status_changed_at: undefined, active_jobs: 0, open_jobs: 1 },
      ]);
      for (const m of members) {
        expect(m.joined_at).toBeInstanceOf(Date);
        expect(m.status_changed_at).toBeInstanceOf(Date);
      }
      const stored = await world.su.query<InviteRow & { id: string }>(
        `SELECT id AS invite_id, email, contact_name, created_at, expires_at, last_sent_at, expires_at <= now() AS expired
           FROM organization_invites WHERE id = ANY($1::uuid[]) ORDER BY created_at DESC`, [[newer, older]]);
      expect(invites).toEqual(stored.rows);
      expect(invites.map((i) => [i.invite_id, i.expired, i.contact_name])).toEqual([[newer, false, null], [older, true, 'Old Invite']]);

      // A foreman, active or not, and a login with no company are refused.
      for (const caller of [named, suspended, await bareLogin(freshEmail())]) {
        await asApi(caller, async (c) => {
          await rejects(c, MEMBERS_SQL, [], '42501', 'org_team: the caller is not the active owner');
          await rejects(c, INVITES_SQL, [], '42501', 'org_team: the caller is not the active owner');
        });
      }
      // No caller context at all.
      await inTransaction('jale_api', null, false, async (c) => {
        await rejects(c, MEMBERS_SQL, [], '42501');
        await rejects(c, INVITES_SQL, [], '42501');
      });
    });

    it('org_team_members: a removed member is not listed, nor their email; re-invited, they appear only as an invite', async () => {
      const owner = await world.employer();
      const active = await world.foreman(owner.id);
      const removed = await world.foreman(owner.id, { status: 'removed' });
      const removedEmail = await emailOf(removed);
      const before = await asApi(owner, async (c) => (await c.query<MemberRow>(MEMBERS_SQL)).rows);
      expect(before.map((m) => m.user_id)).toEqual([owner.id, active.id]);
      expect(before.map((m) => m.email)).not.toContain(removedEmail);
      // Removing the active one through the definer drops them from the list too.
      expect(await commitApi(owner, (c) => remove(c, active.id))).toEqual([{ outcome: 'removed', cognito_sub: active.sub }]);
      const inviteId = await invite(owner, removedEmail);
      const after = await asApi(owner, async (c) => ({
        members: (await c.query<MemberRow>(MEMBERS_SQL)).rows,
        invites: (await c.query<InviteRow>(INVITES_SQL)).rows,
      }));
      expect(after.members.map((m) => m.user_id)).toEqual([owner.id]);
      expect(after.invites.map((i) => [i.invite_id, i.email])).toEqual([[inviteId, removedEmail]]);
    });

    it('org_team_membership answers any employer login, removed included, with has_live_invite; no rows for a login with no membership', async () => {
      const owner = await world.employer({ companyName: 'Membership Co' });
      const org = await orgOf(owner);
      const active = await world.foreman(owner.id);
      const suspended = await world.foreman(owner.id, { status: 'suspended', billingSuspended: true });
      const removed = await world.foreman(owner.id, { status: 'removed' });
      const removedInvited = await world.foreman(owner.id, { status: 'removed', email: `  ${freshEmail().toUpperCase()} ` });
      await invite(owner, (await emailOf(removedInvited)).trim().toLowerCase());
      // An expired re-invite is not live.
      const removedExpired = await world.foreman(owner.id, { status: 'removed' });
      const expired = await invite(owner, await emailOf(removedExpired));
      await world.su.query(`UPDATE organization_invites SET expires_at = now() - interval '1 minute' WHERE id = $1`, [expired]);

      const read = (p: UserFixture) => asApi(p, async (c) => (await c.query<MembershipRow>(MEMBERSHIP_SQL)).rows);
      const row = (p: UserFixture, role: string, status: string, hasLiveInvite: boolean): MembershipRow => ({
        user_id: p.id, organization_id: org, role, status, company_name: 'Membership Co', has_live_invite: hasLiveInvite,
      });
      expect(await read(owner)).toEqual([row(owner, 'owner', 'active', false)]);
      expect(await read(active)).toEqual([row(active, 'foreman', 'active', false)]);
      expect(await read(suspended)).toEqual([row(suspended, 'foreman', 'suspended', false)]);
      expect(await read(removed)).toEqual([row(removed, 'foreman', 'removed', false)]);
      expect(await read(removedInvited)).toEqual([row(removedInvited, 'foreman', 'removed', true)]);
      expect(await read(removedExpired)).toEqual([row(removedExpired, 'foreman', 'removed', false)]);
      // A login with no membership, even one invited somewhere, and a worker: no rows.
      const bareEmail = freshEmail();
      const bare = await bareLogin(bareEmail);
      await invite(owner, bareEmail);
      expect(await read(bare)).toEqual([]);
      expect(await read(await world.worker())).toEqual([]);
      // No caller context: 42501.
      await inTransaction('jale_api', null, false, (c) => rejects(c, MEMBERSHIP_SQL, [], '42501'));
    });

    it('org_member_access: active enabled; suspended and removed disabled; a removed member with a live invite enabled; after the enforcer revokes it, disabled; owners never listed', async () => {
      const owner = await world.employer();
      const org = await orgOf(owner);
      const active = await world.foreman(owner.id);
      const suspended = await world.foreman(owner.id, { status: 'suspended' });
      const billingSuspended = await world.foreman(owner.id, { status: 'suspended', billingSuspended: true });
      const removed = await world.foreman(owner.id, { status: 'removed' });
      const reinvited = await world.foreman(owner.id, { status: 'removed' });
      const inviteId = await invite(owner, await emailOf(reinvited));
      const sent = (await world.su.query<{ last_sent_at: Date }>(
        'SELECT last_sent_at FROM organization_invites WHERE id = $1', [inviteId])).rows[0].last_sent_at;
      // Another company's foreman never shows in this company's answer.
      const other = await world.employer();
      await world.foreman(other.id);

      const byUser = (rows: AccessRow[]) => [...rows].sort((a, b) => a.user_id.localeCompare(b.user_id));
      const expected = (p: UserFixture, enabled: boolean) => ({ user_id: p.id, cognito_sub: p.sub, enabled, changed_at: expect.any(Date) });
      const rows = await asBilling((c) => access(c, org, null, null));
      expect(byUser(rows)).toEqual(byUser([
        expected(active, true), expected(suspended, false), expected(billingSuspended, false),
        expected(removed, false), expected(reinvited, true),
      ] as unknown as AccessRow[]));
      expect(rows.find((r) => r.user_id === owner.id)).toBeUndefined();
      // The re-invite is the reinvited member's latest change.
      expect(rows.find((r) => r.user_id === reinvited.id)!.changed_at).toEqual(sent);
      const statusChanged = (await memberRow(active)).status_changed_at;
      expect(rows.find((r) => r.user_id === active.id)!.changed_at).toEqual(statusChanged);

      // A downgrade to one seat (one active foreman holds it) revokes the live invite; read in the
      // enforcer's own transaction, as the billing processor does (Task 6).
      const afterEnforce = await asBilling(async (c) => {
        const enforced = await c.query<{ revoked_invite_count: number; suspended_count: number }>(
          'SELECT revoked_invite_count, suspended_count FROM jale_billing_internal.billing_enforce_org_limits($1, 100, 1)', [org]);
        expect(enforced.rows).toEqual([{ revoked_invite_count: 1, suspended_count: 0 }]);
        const revokedAt = (await c.query<{ revoked_at: Date }>(
          'SELECT now() AS revoked_at')).rows[0].revoked_at;
        return { rows: await access(c, org, null, null), revokedAt };
      });
      const reinvitedRow = afterEnforce.rows.find((r) => r.user_id === reinvited.id)!;
      expect(reinvitedRow.enabled).toBe(false);
      expect(reinvitedRow.changed_at).toEqual(afterEnforce.revokedAt);
      expect(afterEnforce.rows.find((r) => r.user_id === active.id)!.enabled).toBe(true);
      expect(afterEnforce.rows.find((r) => r.user_id === owner.id)).toBeUndefined();

      // An expired re-invite disables too, changed when it expired.
      await world.su.query(`UPDATE organization_invites SET expires_at = now() WHERE id = $1`, [inviteId]);
      const expiredAt = (await world.su.query<{ expires_at: Date }>(
        'SELECT expires_at FROM organization_invites WHERE id = $1', [inviteId])).rows[0].expires_at;
      const afterExpiry = (await asBilling((c) => access(c, org, null, null))).find((r) => r.user_id === reinvited.id)!;
      expect(afterExpiry).toEqual({ user_id: reinvited.id, cognito_sub: reinvited.sub, enabled: false, changed_at: expiredAt });
    });

    it('org_member_access since: a member removed 30 days ago but re-invited today sorts first and survives p_limit 1', async () => {
      const owner = await world.employer();
      const org = await orgOf(owner);
      const longRemoved = await world.foreman(owner.id, { status: 'removed' });
      const quiet = await world.foreman(owner.id, { status: 'removed' });
      const recentA = await world.foreman(owner.id);
      const recentB = await world.foreman(owner.id, { status: 'suspended', billingSuspended: true });
      await world.su.query(
        `UPDATE organization_members SET status_changed_at = now() - interval '30 days' WHERE user_id = ANY($1::uuid[])`,
        [[longRemoved.id, quiet.id]]);
      await world.su.query(
        `UPDATE organization_members SET status_changed_at = now() - interval '1 day' WHERE user_id = ANY($1::uuid[])`,
        [[recentA.id, recentB.id]]);
      // The re-invite is the newest change on the bed.
      await invite(owner, await emailOf(longRemoved));

      const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
      const ours = new Set([longRemoved.id, quiet.id, recentA.id, recentB.id]);
      const { first, all } = await asBilling(async (c) => ({
        first: await access(c, null, since, 1),
        all: await access(c, null, since, 1000),
      }));
      expect(first).toEqual([{ user_id: longRemoved.id, cognito_sub: longRemoved.sub, enabled: true, changed_at: expect.any(Date) }]);
      const mine = all.filter((r) => ours.has(r.user_id));
      // quiet (removed 30 days ago, nothing since) is outside the window.
      expect(mine.map((r) => r.user_id)).toEqual([
        longRemoved.id,
        ...[recentA.id, recentB.id].sort(),
      ]);
      expect(mine.map((r) => r.enabled)).toEqual([true, ...[recentA.id, recentB.id].sort().map((id) => id === recentA.id)]);
      // The whole answer is ordered changed_at DESC, user_id, and never lists an owner. A JS Date
      // drops microseconds, so the order is checked on epoch microseconds read in the same call.
      const exact = await asBilling(async (c) => (await c.query<{ user_id: string; us: string }>(
        `SELECT user_id, (extract(epoch FROM changed_at) * 1000000)::numeric(20, 0)::text AS us
           FROM jale_cap.org_member_access(NULL, $1, 1000)`, [since])).rows);
      expect(exact.length).toBeGreaterThanOrEqual(mine.length);
      for (let i = 1; i < exact.length; i += 1) {
        const [a, b] = [exact[i - 1], exact[i]];
        const [ua, ub] = [BigInt(a.us), BigInt(b.us)];
        expect([a, b, ua > ub || (ua === ub && a.user_id < b.user_id)]).toEqual([a, b, true]);
      }
      expect(all.every((r) => r.changed_at.getTime() > since.getTime())).toBe(true);
      expect(all.find((r) => r.user_id === owner.id)).toBeUndefined();
      // The company form agrees with the window form for this company.
      const company = await asBilling((c) => access(c, org, null, null));
      expect(company.map((r) => r.user_id).sort()).toEqual([...ours].sort());
    });

    it('org_member_access: both or neither key set, or p_limit 0 / 1001, raise 22023', async () => {
      const owner = await world.employer();
      const org = await orgOf(owner);
      const now = new Date();
      await asBilling(async (c) => {
        for (const args of [
          [org, now, 10],      // both keys
          [org, now, null],
          [null, null, null],  // neither
          [null, null, 10],
          [null, now, 0],      // p_limit out of 1..1000
          [null, now, 1001],
          [null, now, -1],
          [null, now, null],   // the window needs its limit
          [org, null, 10],     // the company form takes no limit
        ] as Array<[string | null, Date | null, number | null]>) {
          await rejects(c, ACCESS_SQL, args, '22023');
        }
        // The bounds themselves are accepted: limits 1 and 1000 with a window starting at this
        // transaction's now() (nothing on the bed has changed after it), and the company form
        // for a company with no foreman. Each answers with no row rather than 22023.
        const dbNow = (await c.query<{ t: string }>('SELECT now()::text AS t')).rows[0].t;
        expect(await access(c, null, dbNow, 1000)).toEqual([]);
        expect(await access(c, null, dbNow, 1)).toEqual([]);
        expect(await access(c, org, null, null)).toEqual([]);
      });
    });

    it('org_member_access matches a removed member\'s live invite whatever the case and padding of users.email', async () => {
      // users.email has no lower(btrim()) CHECK (118's CHECK is on organization_invites), so a login's
      // email can be stored padded or mixed case; 133 invites it normalised.
      const owner = await world.employer();
      const org = await orgOf(owner);
      const plain = freshEmail();
      const padded = await world.foreman(owner.id, { status: 'removed', email: `  ${plain.toUpperCase()} ` });
      await invite(owner, plain);
      const rows = await asBilling((c) => access(c, org, null, null));
      expect(rows).toEqual([{ user_id: padded.id, cognito_sub: padded.sub, enabled: true, changed_at: expect.any(Date) }]);
      const stored = await world.su.query<{ email: string; normalised: string }>(
        `SELECT u.email, i.email AS normalised FROM users u, organization_invites i
          WHERE u.id = $1 AND i.organization_id = $2`, [padded.id, org]);
      expect(stored.rows).toEqual([{ email: `  ${plain.toUpperCase()} `, normalised: plain }]);
    });
  });
});
