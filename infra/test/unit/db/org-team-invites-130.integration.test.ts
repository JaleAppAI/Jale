/**
 * org-team-invites-130 -- migration 130 on a real bed: the team invites and
 * their acceptance, each definer run as its real login (jale_api with
 * app.current_user_id and app.current_internal_user_id set; jale_api_public
 * and jale_billing with nothing set), inside a transaction that is rolled
 * back unless the case needs committed rows.
 *
 *  - the catalog: every invite function's owner (jale_cap_org_team), definer
 *    security, pinned search_path and its one caller; no runtime login gains
 *    a right on organizations, organization_invites or the invite mail; the
 *    capability owner's exact column rights; organization_invites.last_sent_at;
 *  - create: the normalised email, not_owner, seat_limit_reached (billing-
 *    suspended foremen hold no seat), an expired pending invite revoked so a
 *    new one can be made, invite_pending, email_in_use, already_member, a
 *    removed member's cognito_sub, invalid_email, the company send cap;
 *  - resend: the per-invite cap and its 24 h window, the token and expiry
 *    rotated, too_soon, a free seat for an expired invite, not_found, closed;
 *  - revoke, the invite email (queue_email), the mail purge, the public
 *    lookup, accept by token and accept by verified email.
 * Fixtures through the superuser URL (Task 1's World); afterAll removes them,
 * the invite mail included.
 *
 * Run: bash infra/db/local/bootstrap-testbed.sh --ephemeral --ref none --profile request \
 *   --container <name> --port <port> -- \
 *   bash infra/scripts/run-whatsapp-v2-db-tests.sh --suite test/unit/db/org-team-invites-130.integration.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { FIXTURE_TOS_VERSION, World, type UserFixture } from './r-paths-world';
import { describeInProfiles, withLoginClient } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: org-team-invites-130 needs JALE_TEST_DATABASE_URL (see header)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

const hash = (t: string): Buffer => createHash('sha256').update(t, 'utf8').digest();
/** A token unique to this run (token_hash is UNIQUE on the bed). */
const RUN = randomUUID();
const T = (name: string): string => `${name}-${RUN}`;

const CREATE_SQL = 'SELECT * FROM jale_cap.org_team_invite_create($1, $2, $3, $4)';
const RESEND_SQL = 'SELECT * FROM jale_cap.org_team_invite_resend($1, $2, $3)';
const REVOKE_SQL = 'SELECT * FROM jale_cap.org_team_invite_revoke($1)';
const QUEUE_SQL = 'SELECT jale_cap.org_team_invite_queue_email($1, $2, $3, $4) AS id';
const LOOKUP_SQL = 'SELECT * FROM jale_cap.org_team_invite_lookup($1)';
const ACCEPT_SQL = 'SELECT * FROM jale_cap.org_team_invite_accept($1)';
const ACCEPT_EMAIL_SQL = 'SELECT * FROM jale_cap.org_team_invite_accept_email()';
const PURGE_SQL = 'SELECT jale_cap.org_team_invite_mail_purge($1) AS n';

type CreateRow = {
  outcome: string; invite_id: string | null; email: string | null; contact_name: string | null;
  created_at: Date | null; expires_at: Date | null; last_sent_at: Date | null; company_name: string | null;
  cognito_sub: string | null;
};
type ResendRow = CreateRow & { retry_after_seconds: number | null };

/** Every invite function: [signature, caller (null: internal, nobody), pg_get_function_result]. */
const FUNCTIONS: Array<[string, string | null, string]> = [
  ['jale_cap.org_team_invite_accept(bytea)', 'jale_api', 'TABLE(outcome text, organization_id uuid)'],
  ['jale_cap.org_team_invite_accept_email()', 'jale_api', 'TABLE(outcome text, organization_id uuid)'],
  ['jale_cap.org_team_invite_create(text, text, bytea, integer)', 'jale_api',
    'TABLE(outcome text, invite_id uuid, email text, contact_name text, created_at timestamp with time zone, expires_at timestamp with time zone, last_sent_at timestamp with time zone, company_name text, cognito_sub text)'],
  ['jale_cap.org_team_invite_lookup(bytea)', 'jale_api_public',
    'TABLE(outcome text, company_name text, email text, contact_name text, existing_account boolean, expires_at timestamp with time zone)'],
  ['jale_cap.org_team_invite_mail_purge(integer)', 'jale_billing', 'integer'],
  ['jale_cap.org_team_invite_queue_email(uuid, text, text, text)', 'jale_api', 'uuid'],
  ['jale_cap.org_team_invite_resend(uuid, bytea, integer)', 'jale_api',
    'TABLE(outcome text, invite_id uuid, email text, contact_name text, created_at timestamp with time zone, expires_at timestamp with time zone, last_sent_at timestamp with time zone, company_name text, cognito_sub text, retry_after_seconds integer)'],
  ['jale_cap.org_team_invite_revoke(uuid)', 'jale_api', 'TABLE(outcome text, cognito_sub text)'],
  ['jale_cap.org_team_locked_owner_org()', null, 'uuid'],
];

/** Step 3's sections 2, 3 and 5, as table:column:privilege, sorted (C collation). */
const REVIEWED_COLUMN_RIGHTS = [
  'email_outbox:attempt_count:SELECT', 'email_outbox:body_html:INSERT', 'email_outbox:body_text:INSERT',
  'email_outbox:created_at:SELECT', 'email_outbox:id:SELECT', 'email_outbox:idempotency_key:INSERT',
  'email_outbox:recipient_email:INSERT', 'email_outbox:source_id:INSERT', 'email_outbox:source_id:SELECT',
  'email_outbox:source_type:INSERT', 'email_outbox:source_type:SELECT', 'email_outbox:status:SELECT',
  'email_outbox:subject:INSERT',
  'organization_invites:accepted_at:SELECT', 'organization_invites:accepted_at:UPDATE',
  'organization_invites:contact_name:INSERT', 'organization_invites:contact_name:SELECT',
  'organization_invites:created_at:SELECT', 'organization_invites:email:INSERT', 'organization_invites:email:SELECT',
  'organization_invites:expires_at:INSERT', 'organization_invites:expires_at:SELECT', 'organization_invites:expires_at:UPDATE',
  'organization_invites:id:SELECT', 'organization_invites:invited_by:INSERT', 'organization_invites:invited_by:SELECT',
  'organization_invites:last_sent_at:INSERT', 'organization_invites:last_sent_at:SELECT', 'organization_invites:last_sent_at:UPDATE',
  'organization_invites:organization_id:INSERT', 'organization_invites:organization_id:SELECT',
  'organization_invites:revoked_at:SELECT', 'organization_invites:revoked_at:UPDATE',
  'organization_invites:token_hash:INSERT', 'organization_invites:token_hash:SELECT', 'organization_invites:token_hash:UPDATE',
  'organization_members:billing_suspended_at:SELECT', 'organization_members:billing_suspended_at:UPDATE',
  'organization_members:invited_by:INSERT', 'organization_members:invited_by:SELECT', 'organization_members:invited_by:UPDATE',
  'organization_members:joined_at:INSERT', 'organization_members:joined_at:SELECT', 'organization_members:joined_at:UPDATE',
  'organization_members:organization_id:INSERT', 'organization_members:organization_id:SELECT',
  'organization_members:role:INSERT', 'organization_members:role:SELECT',
  'organization_members:status:INSERT', 'organization_members:status:SELECT', 'organization_members:status:UPDATE',
  'organization_members:status_changed_at:INSERT', 'organization_members:status_changed_at:SELECT',
  'organization_members:status_changed_at:UPDATE',
  'organization_members:user_id:INSERT', 'organization_members:user_id:SELECT',
  'organizations:id:SELECT', 'organizations:updated_at:UPDATE',
  'users:cognito_sub:SELECT', 'users:email:SELECT', 'users:id:SELECT', 'users:user_type:SELECT',
];

maybeDescribe('migration 130: team invites and acceptance', () => {
  let world: World;
  /** Employer logins with no company (a confirmation that found no invite). */
  const bareLogins: string[] = [];
  /** Outbox rows the superuser inserts with another source type. */
  const extraOutbox: string[] = [];

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
      await world.su.query(`DELETE FROM email_outbox WHERE id = ANY($1::uuid[])`, [extraOutbox]);
      // Invites cascade from their company; members of a company go with it.
      await world.cleanup();
      await world.su.query(`DELETE FROM organization_members WHERE user_id = ANY($1::uuid[])`, [bareLogins]);
      await world.su.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [bareLogins]);
    } finally {
      await world.end();
    }
  });

  const tag = () => randomUUID().slice(0, 8);
  const freshEmail = () => `invitee-${randomUUID()}@example.com`;

  /** An employer login with no company, with this email. */
  async function bareLogin(email: string): Promise<UserFixture> {
    const id = randomUUID();
    const sub = `fixture-employer-${randomUUID()}`;
    await world.su.query(
      `INSERT INTO users (id, cognito_sub, user_type, full_name, email, tos_version)
       VALUES ($1, $2, 'employer', 'Invitee', $3, $4)`, [id, sub, email, FIXTURE_TOS_VERSION]);
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
  /** An invite written by the superuser (bypassing every check). */
  async function rawInvite(org: string, email: string, invitedBy: string, token: string): Promise<string> {
    return (await world.su.query<{ id: string }>(
      `INSERT INTO organization_invites (organization_id, email, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '7 days') RETURNING id`,
      [org, email, hash(token), invitedBy])).rows[0].id;
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
  /** As jale_api with both caller settings, rolled back. */
  const asApi = <T>(caller: UserFixture, fn: (c: Client) => Promise<T>) => inTransaction('jale_api', caller, false, fn);
  /** As jale_api with both caller settings, committed. */
  const commitApi = <T>(caller: UserFixture, fn: (c: Client) => Promise<T>) => inTransaction('jale_api', caller, true, fn);
  /** Runs an expected-error statement under a savepoint, so the transaction stays usable. */
  async function rejects(c: Client, sql: string, params: unknown[], code: string, message?: string): Promise<void> {
    await c.query('SAVEPOINT expected_error');
    await expect(c.query(sql, params)).rejects.toMatchObject(message === undefined ? { code } : { code, message });
    await c.query('ROLLBACK TO SAVEPOINT expected_error');
  }

  const create = async (c: Client, email: string | null, token: string, limit = 10, name: string | null = 'Ana') =>
    (await c.query<CreateRow>(CREATE_SQL, [email, name, hash(token), limit])).rows;
  const resend = async (c: Client, inviteId: string, token: string, limit = 10) =>
    (await c.query<ResendRow>(RESEND_SQL, [inviteId, hash(token), limit])).rows;
  const revoke = async (c: Client, inviteId: string) =>
    (await c.query<{ outcome: string; cognito_sub: string | null }>(REVOKE_SQL, [inviteId])).rows;
  const queue = async (c: Client, inviteId: string) =>
    (await c.query<{ id: string }>(QUEUE_SQL, [inviteId, 'You are invited', 'Join the team: https://example.invalid/i/x', null])).rows[0].id;
  const accept = async (c: Client, token: string | Buffer) =>
    (await c.query<{ outcome: string; organization_id: string | null }>(
      ACCEPT_SQL, [typeof token === 'string' ? hash(token) : token])).rows;
  const acceptEmail = async (c: Client) =>
    (await c.query<{ outcome: string; organization_id: string | null }>(ACCEPT_EMAIL_SQL)).rows;
  const membershipCount = async (c: Client, userId: string) =>
    (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM organization_members WHERE user_id = $1', [userId])).rows[0].n;

  /** Create plus queue_email in one committed transaction, as the owner; the invite id. */
  async function invite(owner: UserFixture, email: string, token: string = randomUUID(), limit = 10): Promise<string> {
    return commitApi(owner, async (c) => {
      const rows = await create(c, email, token, limit);
      expect(rows.map((r) => r.outcome)).toEqual(['created']);
      await queue(c, rows[0].invite_id!);
      return rows[0].invite_id!;
    });
  }
  /** Moves an invite's last send back, past the resend cooldown. */
  const coolDown = (inviteId: string) => world.su.query(
    `UPDATE organization_invites SET last_sent_at = now() - interval '2 minutes' WHERE id = $1`, [inviteId]);

  describeInProfiles(['standard', 'request', 'owner-unrestricted'], 'the catalog', () => {
    it('each invite function has its owner, definer security, pinned search_path and exactly its one caller', async () => {
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
        returns, callers: caller === null ? [] : [caller],
      }]]));
    });

    it('jale_api still holds no right on organizations, organization_invites or email_outbox via 130', async () => {
      const { rows } = await world.su.query<{ login: string; rel: string; any: boolean }>(
        `SELECT l.login, r.rel,
                has_any_column_privilege(l.login, r.rel::regclass, 'SELECT,INSERT,UPDATE')
                OR has_table_privilege(l.login, r.rel::regclass, 'DELETE') AS any
           FROM unnest(ARRAY['jale_api', 'jale_api_public', 'jale_billing']) l(login),
                unnest(ARRAY['public.organizations', 'public.organization_invites']) r(rel)
          ORDER BY 1, 2`);
      expect(rows.filter((r) => r.any)).toEqual([]);
      expect(rows).toHaveLength(6);
      const outbox = await world.su.query<{ login: string; any: boolean }>(
        `SELECT l.login, has_any_column_privilege(l.login, 'public.email_outbox', 'SELECT,INSERT,UPDATE')
                OR has_table_privilege(l.login, 'public.email_outbox', 'DELETE') AS any
           FROM unnest(ARRAY['jale_api', 'jale_api_public']) l(login)`);
      expect(outbox.rows).toEqual([{ login: 'jale_api', any: false }, { login: 'jale_api_public', any: false }]);
      // The invite mail (it carries the raw token) is reachable only by the capability owner's policies.
      const policies = await world.su.query<{ polname: string; roles: string[] }>(
        `SELECT p.polname, ARRAY(SELECT CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r)::text END
                                   FROM unnest(p.polroles) r ORDER BY 1) AS roles
           FROM pg_policy p
          WHERE p.polrelid = 'public.email_outbox'::regclass
            AND (COALESCE(pg_get_expr(p.polqual, p.polrelid), '') LIKE '%organization_invite%'
                 OR COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), '') LIKE '%organization_invite%')
          ORDER BY 1`);
      expect(policies.rows).toEqual([
        { polname: 'email_outbox_cap_org_team_delete', roles: ['jale_cap_org_team'] },
        { polname: 'email_outbox_cap_org_team_insert', roles: ['jale_cap_org_team'] },
        { polname: 'email_outbox_cap_org_team_select', roles: ['jale_cap_org_team'] },
      ]);
    });

    it('jale_cap_org_team is NOLOGIN, NOINHERIT, member of nothing, and holds exactly its reviewed column rights', async () => {
      const role = await world.su.query(
        `SELECT r.rolcanlogin, r.rolinherit, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls, r.rolreplication,
                (SELECT count(*)::int FROM pg_auth_members am WHERE am.member = r.oid) AS member_of,
                (SELECT count(*)::int FROM pg_auth_members am WHERE am.roleid = r.oid AND (am.set_option OR am.inherit_option)) AS windows
           FROM pg_roles r WHERE r.rolname = 'jale_cap_org_team'`);
      expect(role.rows).toEqual([{
        rolcanlogin: false, rolinherit: false, rolsuper: false, rolcreaterole: false, rolcreatedb: false,
        rolbypassrls: false, rolreplication: false, member_of: 0, windows: 0,
      }]);
      const { rows } = await world.su.query<{ grants: string[] }>(
        `SELECT array_agg(c.relname || ':' || a.attname || ':' || p.privilege
                          ORDER BY (c.relname || ':' || a.attname || ':' || p.privilege) COLLATE "C") AS grants
           FROM pg_class c
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
           CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) p(privilege)
          WHERE c.oid IN ('public.organizations'::regclass, 'public.organization_invites'::regclass,
                          'public.organization_members'::regclass, 'public.users'::regclass, 'public.email_outbox'::regclass)
            AND has_column_privilege('jale_cap_org_team', c.oid, a.attname, p.privilege)`);
      expect(rows[0].grants).toEqual(REVIEWED_COLUMN_RIGHTS);
      // DELETE on the invite mail only (its policy keeps it to organization_invite rows).
      const deletes = await world.su.query<{ rel: string }>(
        `SELECT c.relname AS rel FROM pg_class c
          WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
            AND has_table_privilege('jale_cap_org_team', c.oid, 'DELETE') ORDER BY 1`);
      expect(deletes.rows).toEqual([{ rel: 'email_outbox' }]);
      // USAGE on jale_cap (it calls its own internal helper) and CREATE (it owns its functions).
      const schema = await world.su.query(
        `SELECT has_schema_privilege('jale_cap_org_team', 'jale_cap', 'USAGE') AS usage,
                has_schema_privilege('jale_cap_org_team', 'jale_cap', 'CREATE') AS "create",
                has_schema_privilege('jale_billing', 'jale_cap', 'USAGE') AS billing_usage,
                has_function_privilege('jale_cap_org_team', 'public.employer_display_name(uuid)', 'EXECUTE') AS display_name`);
      expect(schema.rows).toEqual([{ usage: true, create: true, billing_usage: true, display_name: true }]);
    });

    it('email_outbox has the invite-mail partial index the send counts read', async () => {
      const { rows } = await world.su.query(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'email_outbox_organization_invite_sends'`);
      expect(rows).toEqual([{
        indexdef: "CREATE INDEX email_outbox_organization_invite_sends ON public.email_outbox USING btree (source_id, created_at) WHERE (source_type = 'organization_invite'::text)",
      }]);
    });

    it('organization_invites.last_sent_at is timestamptz NOT NULL DEFAULT now()', async () => {
      const { rows } = await world.su.query(
        `SELECT format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
                pg_get_expr(d.adbin, d.adrelid) AS "default"
           FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = 'public.organization_invites'::regclass AND a.attname = 'last_sent_at' AND NOT a.attisdropped`);
      expect(rows).toEqual([{ type: 'timestamp with time zone', not_null: true, default: 'now()' }]);
    });
  });

  describeInProfiles(['standard', 'request'], 'invites', () => {
    it('create stores the normalised email and accept matches it whatever its case', async () => {
      const owner = await world.employer({ companyName: 'Acme Roofing' });
      const t = tag();
      const token = randomUUID();
      const inviteId = await commitApi(owner, async (c) => {
        const rows = await create(c, `  Ana.${t}@Example.COM `, token, 10, '  Ana Ruiz ');
        expect(rows).toEqual([expect.objectContaining({
          outcome: 'created', email: `ana.${t}@example.com`, contact_name: 'Ana Ruiz', company_name: 'Acme Roofing', cognito_sub: null,
        })]);
        expect(rows[0].expires_at!.getTime() - rows[0].created_at!.getTime()).toBe(7 * 24 * 3600 * 1000);
        expect(rows[0].last_sent_at).toEqual(rows[0].created_at);
        await queue(c, rows[0].invite_id!);
        return rows[0].invite_id!;
      });
      const stored = await world.su.query('SELECT email, contact_name, invited_by FROM organization_invites WHERE id = $1', [inviteId]);
      expect(stored.rows).toEqual([{ email: `ana.${t}@example.com`, contact_name: 'Ana Ruiz', invited_by: owner.id }]);
      const invitee = await bareLogin(`ANA.${t}@example.com`);
      expect(await asApi(invitee, (c) => accept(c, token))).toEqual([{ outcome: 'accepted', organization_id: await orgOf(owner) }]);
    });

    it('create: a foreman gets not_owner and nothing is written', async () => {
      const owner = await world.employer();
      const foreman = await world.foreman(owner.id);
      const email = freshEmail();
      const rows = await commitApi(foreman, (c) => create(c, email, randomUUID()));
      expect(rows).toEqual([expect.objectContaining({ outcome: 'not_owner', invite_id: null, cognito_sub: null })]);
      const written = await world.su.query('SELECT 1 FROM organization_invites WHERE organization_id = $1', [await orgOf(owner)]);
      expect(written.rows).toEqual([]);
    });

    it('create: seat_limit_reached when active foremen plus live invites reach the limit; a billing-suspended foreman holds no seat', async () => {
      const full = await world.employer();
      await world.foreman(full.id);
      expect((await asApi(full, (c) => create(c, freshEmail(), randomUUID(), 1))).map((r) => r.outcome)).toEqual(['seat_limit_reached']);
      // A live invite holds a seat too.
      const pending = await world.employer();
      await invite(pending, freshEmail(), randomUUID(), 1);
      expect((await asApi(pending, (c) => create(c, freshEmail(), randomUUID(), 1))).map((r) => r.outcome)).toEqual(['seat_limit_reached']);
      const downgraded = await world.employer();
      await world.foreman(downgraded.id, { status: 'suspended', billingSuspended: true });
      expect((await asApi(downgraded, (c) => create(c, freshEmail(), randomUUID(), 1))).map((r) => r.outcome)).toEqual(['created']);
    });

    it('an expired pending invite is revoked so a new one can be created', async () => {
      const owner = await world.employer();
      const email = freshEmail();
      const old = await invite(owner, email);
      await world.su.query(`UPDATE organization_invites SET expires_at = now() - interval '1 minute' WHERE id = $1`, [old]);
      const rows = await commitApi(owner, (c) => create(c, email.toUpperCase(), randomUUID()));
      expect(rows.map((r) => r.outcome)).toEqual(['created']);
      const { rows: stored } = await world.su.query<{ id: string; revoked: boolean; accepted: boolean }>(
        `SELECT id, revoked_at IS NOT NULL AS revoked, accepted_at IS NOT NULL AS accepted
           FROM organization_invites WHERE organization_id = $1 ORDER BY created_at, (id = $2) DESC`, [await orgOf(owner), old]);
      expect(stored).toEqual([
        { id: old, revoked: true, accepted: false },
        { id: rows[0].invite_id, revoked: false, accepted: false },
      ]);
    });

    it('create: invite_pending for a live invite to the same email', async () => {
      const owner = await world.employer();
      const email = freshEmail();
      await invite(owner, email);
      const rows = await asApi(owner, (c) => create(c, ` ${email.toUpperCase()}`, randomUUID()));
      expect(rows).toEqual([expect.objectContaining({ outcome: 'invite_pending', invite_id: null })]);
    });

    it('create: email_in_use for an employer of another company, removed included; already_member for an active or suspended member of this one', async () => {
      const owner = await world.employer();
      const other = await world.employer();
      const otherRemoved = await world.foreman(other.id, { status: 'removed' });
      const active = await world.foreman(owner.id);
      const suspended = await world.foreman(owner.id, { status: 'suspended' });
      const cases: Array<[string, string]> = [
        [await emailOf(other), 'email_in_use'],
        [await emailOf(otherRemoved), 'email_in_use'],
        [await emailOf(active), 'already_member'],
        [await emailOf(suspended), 'already_member'],
        [await emailOf(owner), 'already_member'],
      ];
      const outcomes = await asApi(owner, async (c) => {
        const out: Array<[string, string]> = [];
        for (const [email] of cases) out.push([email, (await create(c, email, randomUUID()))[0].outcome]);
        return out;
      });
      expect(outcomes).toEqual(cases);
    });

    it('create: a removed member of this company is invited and their cognito_sub is returned', async () => {
      const owner = await world.employer();
      const removed = await world.foreman(owner.id, { status: 'removed' });
      const removedEmail = await emailOf(removed);
      const rows = await asApi(owner, (c) => create(c, removedEmail, randomUUID()));
      expect(rows).toEqual([expect.objectContaining({ outcome: 'created', cognito_sub: removed.sub })]);
    });

    it('create: a login with no membership is invited, no cognito_sub', async () => {
      const owner = await world.employer();
      const email = freshEmail();
      await bareLogin(email);
      const rows = await asApi(owner, (c) => create(c, email, randomUUID()));
      expect(rows).toEqual([expect.objectContaining({ outcome: 'created', email, cognito_sub: null })]);
    });

    it('create: invalid_email for "ana", for 255 characters, and nothing is written', async () => {
      const owner = await world.employer();
      const long = `${'a'.repeat(243)}@example.com`;
      expect(long).toHaveLength(255);
      const outcomes = await commitApi(owner, async (c) => [
        (await create(c, 'ana', randomUUID()))[0].outcome,
        (await create(c, long, randomUUID()))[0].outcome,
        (await create(c, null, randomUUID()))[0].outcome,
        (await create(c, 'ana@@example.com', randomUUID()))[0].outcome,
      ]);
      expect(outcomes).toEqual(['invalid_email', 'invalid_email', 'invalid_email', 'invalid_email']);
      const written = await world.su.query('SELECT 1 FROM organization_invites WHERE organization_id = $1', [await orgOf(owner)]);
      expect(written.rows).toEqual([]);
      // 254 characters is still an email.
      const ok = await asApi(owner, (c) => create(c, `${'a'.repeat(242)}@example.com`, randomUUID()));
      expect(ok.map((r) => r.outcome)).toEqual(['created']);
      // Malformed arguments raise 22023.
      await asApi(owner, async (c) => {
        await rejects(c, CREATE_SQL, [freshEmail(), 'Ana', Buffer.alloc(31), 10], '22023');
        await rejects(c, CREATE_SQL, [freshEmail(), 'Ana', hash('x'), null], '22023');
        await rejects(c, CREATE_SQL, [freshEmail(), 'Ana', hash('x'), -1], '22023');
        await rejects(c, CREATE_SQL, [freshEmail(), 'a'.repeat(121), hash('x'), 10], '22023');
      });
    });

    it('rate limits count sends: 20 outbox rows in 24 h give rate_limited to create and to resend', async () => {
      const owner = await world.employer();
      const first = await invite(owner, freshEmail());
      // The create's own row plus 19 more: 20 sends in 24 h.
      await world.su.query(
        `INSERT INTO email_outbox (recipient_email, subject, body_text, source_type, source_id, created_at)
         SELECT 'x@example.invalid', 's', 'b', 'organization_invite', $1, now() - interval '1 hour'
           FROM generate_series(1, 19)`, [first]);
      await coolDown(first);
      expect((await asApi(owner, (c) => create(c, freshEmail(), randomUUID()))).map((r) => r.outcome)).toEqual(['rate_limited']);
      expect((await asApi(owner, (c) => resend(c, first, randomUUID()))).map((r) => r.outcome)).toEqual(['rate_limited']);
      // 19 sends: both go through.
      await world.su.query(
        `DELETE FROM email_outbox WHERE id = (SELECT id FROM email_outbox WHERE source_id = $1 AND created_at < now() - interval '30 minutes' LIMIT 1)`,
        [first]);
      expect((await asApi(owner, (c) => create(c, freshEmail(), randomUUID()))).map((r) => r.outcome)).toEqual(['created']);
      expect((await asApi(owner, (c) => resend(c, first, randomUUID()))).map((r) => r.outcome)).toEqual(['resent']);
    });

    it('resend: the 6th resend of one invite in 24 h is rate_limited; rows older than 24 h do not count', async () => {
      const owner = await world.employer();
      const id = await invite(owner, freshEmail());
      // The invite was created two days ago, with its first mail; four resends in the last hour and ten older than a day.
      await world.su.query(`UPDATE organization_invites SET created_at = now() - interval '2 days', last_sent_at = now() - interval '2 minutes' WHERE id = $1`, [id]);
      await world.su.query(`UPDATE email_outbox SET created_at = now() - interval '2 days' WHERE source_id = $1`, [id]);
      await world.su.query(
        `INSERT INTO email_outbox (recipient_email, subject, body_text, source_type, source_id, created_at)
         SELECT 'x@example.invalid', 's', 'b', 'organization_invite', $1::uuid, now() - interval '1 hour' FROM generate_series(1, 4)
         UNION ALL
         SELECT 'x@example.invalid', 's', 'b', 'organization_invite', $1::uuid, now() - interval '25 hours' FROM generate_series(1, 10)`, [id]);
      expect((await asApi(owner, (c) => resend(c, id, randomUUID()))).map((r) => r.outcome)).toEqual(['resent']);
      await world.su.query(
        `INSERT INTO email_outbox (recipient_email, subject, body_text, source_type, source_id, created_at)
         VALUES ('x@example.invalid', 's', 'b', 'organization_invite', $1, now() - interval '1 hour')`, [id]);
      expect((await asApi(owner, (c) => resend(c, id, randomUUID()))).map((r) => r.outcome)).toEqual(['rate_limited']);
    });

    it('resend rotates the token hash and expiry and stamps last_sent_at; too_soon within 60 s with retry_after_seconds between 1 and 60', async () => {
      const owner = await world.employer({ companyName: 'Acme Roofing' });
      const email = freshEmail();
      const id = await invite(owner, email, T('first-token'));
      await world.su.query(
        `UPDATE organization_invites SET expires_at = now() + interval '1 day', last_sent_at = now() - interval '2 minutes' WHERE id = $1`, [id]);
      const rows = await commitApi(owner, async (c) => {
        const out = await resend(c, id, T('second-token'));
        await queue(c, id);
        return out;
      });
      expect(rows).toEqual([expect.objectContaining({
        outcome: 'resent', invite_id: id, email, contact_name: 'Ana', company_name: 'Acme Roofing', cognito_sub: null, retry_after_seconds: null,
      })]);
      const { rows: stored } = await world.su.query<{ token_hash: Buffer; days: number; recent: boolean }>(
        `SELECT token_hash, round(extract(epoch FROM expires_at - last_sent_at) / 86400)::int AS days,
                last_sent_at > now() - interval '1 minute' AS recent
           FROM organization_invites WHERE id = $1`, [id]);
      expect(stored).toEqual([{ token_hash: hash(T('second-token')), days: 7, recent: true }]);
      expect(rows[0].expires_at!.getTime() - rows[0].last_sent_at!.getTime()).toBe(7 * 24 * 3600 * 1000);
      const again = await asApi(owner, (c) => resend(c, id, T('third-token')));
      expect(again).toEqual([expect.objectContaining({ outcome: 'too_soon', invite_id: null })]);
      expect(again[0].retry_after_seconds).toBeGreaterThanOrEqual(1);
      expect(again[0].retry_after_seconds).toBeLessThanOrEqual(60);
    });

    it('resend: an expired invite needs a free seat; not_found for another company\'s invite', async () => {
      const owner = await world.employer();
      await world.foreman(owner.id);
      const id = await invite(owner, freshEmail(), randomUUID(), 2);
      await world.su.query(
        `UPDATE organization_invites SET expires_at = now() - interval '1 minute', last_sent_at = now() - interval '2 minutes' WHERE id = $1`, [id]);
      expect((await asApi(owner, (c) => resend(c, id, randomUUID(), 1))).map((r) => r.outcome)).toEqual(['seat_limit_reached']);
      expect((await asApi(owner, (c) => resend(c, id, randomUUID(), 2))).map((r) => r.outcome)).toEqual(['resent']);
      const stranger = await world.employer();
      expect((await asApi(stranger, (c) => resend(c, id, randomUUID(), 10))).map((r) => r.outcome)).toEqual(['not_found']);
      expect((await asApi(stranger, (c) => revoke(c, id)))).toEqual([{ outcome: 'not_found', cognito_sub: null }]);
      expect((await asApi(owner, (c) => resend(c, randomUUID(), randomUUID(), 10))).map((r) => r.outcome)).toEqual(['not_found']);
    });

    it('resend and revoke a closed invite: closed (accepted and revoked rows both)', async () => {
      const owner = await world.employer();
      const used = await invite(owner, freshEmail());
      const revoked = await invite(owner, freshEmail());
      await world.su.query(`UPDATE organization_invites SET accepted_at = now(), last_sent_at = now() - interval '2 minutes' WHERE id = $1`, [used]);
      await world.su.query(`UPDATE organization_invites SET revoked_at = now(), last_sent_at = now() - interval '2 minutes' WHERE id = $1`, [revoked]);
      const outcomes = await asApi(owner, async (c) => [
        (await resend(c, used, randomUUID()))[0].outcome, (await revoke(c, used))[0].outcome,
        (await resend(c, revoked, randomUUID()))[0].outcome, (await revoke(c, revoked))[0].outcome,
      ]);
      expect(outcomes).toEqual(['closed', 'closed', 'closed', 'closed']);
    });

    it('revoke: revoked, then closed; a removed member\'s re-invite returns their cognito_sub to disable', async () => {
      const owner = await world.employer();
      const id = await invite(owner, freshEmail());
      expect(await commitApi(owner, (c) => revoke(c, id))).toEqual([{ outcome: 'revoked', cognito_sub: null }]);
      const { rows } = await world.su.query('SELECT revoked_at IS NOT NULL AS revoked FROM organization_invites WHERE id = $1', [id]);
      expect(rows).toEqual([{ revoked: true }]);
      expect(await asApi(owner, (c) => revoke(c, id))).toEqual([{ outcome: 'closed', cognito_sub: null }]);
      const removed = await world.foreman(owner.id, { status: 'removed' });
      const reinvite = await invite(owner, await emailOf(removed));
      expect(await asApi(owner, (c) => revoke(c, reinvite))).toEqual([{ outcome: 'revoked', cognito_sub: removed.sub }]);
      // A foreman cannot revoke.
      const foreman = await world.foreman(owner.id);
      expect(await asApi(foreman, (c) => revoke(c, reinvite))).toEqual([{ outcome: 'not_owner', cognito_sub: null }]);
    });

    it('revoke: a removed member with a live invite in a second company still gets their cognito_sub back when this company revokes', async () => {
      const owner = await world.employer();
      const removed = await world.foreman(owner.id, { status: 'removed' });
      const email = await emailOf(removed);
      // Another company's live invite for the same email (written directly: create would answer email_in_use).
      const other = await world.employer();
      await rawInvite(await orgOf(other), email, other.id, T('second-company'));
      const reinvite = await commitApi(owner, async (c) => {
        const rows = await create(c, email, randomUUID());
        expect(rows).toEqual([expect.objectContaining({ outcome: 'created', cognito_sub: removed.sub })]);
        await queue(c, rows[0].invite_id!);
        return rows[0].invite_id!;
      });
      expect(await asApi(owner, (c) => revoke(c, reinvite))).toEqual([{ outcome: 'revoked', cognito_sub: removed.sub }]);
    });

    it('resend applies create\'s email rules: email_in_use once the invitee joins another company, already_member once they join this one, a removed member\'s cognito_sub; not_owner for a foreman', async () => {
      const owner = await world.employer();
      const org = await orgOf(owner);
      const other = await world.employer();
      // The invitee joins another company after the invite was sent.
      const elsewhereEmail = freshEmail();
      const elsewhere = await bareLogin(elsewhereEmail);
      const toElsewhere = await invite(owner, elsewhereEmail);
      await world.su.query(`INSERT INTO organization_members (user_id, organization_id, role) VALUES ($1, $2, 'foreman')`,
        [elsewhere.id, await orgOf(other)]);
      // The invitee became an active member of this company (by another path).
      const joinedEmail = freshEmail();
      const joined = await bareLogin(joinedEmail);
      const toJoined = await invite(owner, joinedEmail);
      await world.su.query(`INSERT INTO organization_members (user_id, organization_id, role) VALUES ($1, $2, 'foreman')`, [joined.id, org]);
      // A removed member of this company, re-invited.
      const removed = await world.foreman(owner.id, { status: 'removed' });
      const toRemoved = await invite(owner, await emailOf(removed));
      for (const id of [toElsewhere, toJoined, toRemoved]) await coolDown(id);
      const outcomes = await asApi(owner, async (c) => [
        (await resend(c, toElsewhere, randomUUID()))[0],
        (await resend(c, toJoined, randomUUID()))[0],
        (await resend(c, toRemoved, randomUUID()))[0],
      ]);
      expect(outcomes).toEqual([
        expect.objectContaining({ outcome: 'email_in_use', invite_id: null, cognito_sub: null }),
        expect.objectContaining({ outcome: 'already_member', invite_id: null, cognito_sub: null }),
        expect.objectContaining({ outcome: 'resent', invite_id: toRemoved, cognito_sub: removed.sub }),
      ]);
      const foreman = await world.foreman(owner.id);
      expect((await asApi(foreman, (c) => resend(c, toRemoved, randomUUID()))))
        .toEqual([expect.objectContaining({ outcome: 'not_owner', invite_id: null })]);
    });

    it('create: seat limit 0 (Free) gives seat_limit_reached with no foreman and no invite', async () => {
      const owner = await world.employer();
      expect((await asApi(owner, (c) => create(c, freshEmail(), randomUUID(), 0))).map((r) => r.outcome)).toEqual(['seat_limit_reached']);
    });

    it('queue_email writes one organization_invite row to the invite\'s email, idempotency key org-invite:<id>:<16 hex>', async () => {
      const owner = await world.employer();
      const email = freshEmail();
      const id = await invite(owner, email, T('queue-token'));
      const { rows } = await world.su.query(
        `SELECT recipient_email, subject, body_text, body_html, source_type, source_id, idempotency_key, status
           FROM email_outbox WHERE source_type = 'organization_invite' AND source_id = $1`, [id]);
      expect(rows).toEqual([{
        recipient_email: email, subject: 'You are invited', body_text: 'Join the team: https://example.invalid/i/x', body_html: null,
        source_type: 'organization_invite', source_id: id,
        idempotency_key: `org-invite:${id}:${hash(T('queue-token')).subarray(0, 8).toString('hex')}`, status: 'pending',
      }]);
      expect(rows[0].idempotency_key).toMatch(/^org-invite:[0-9a-f-]{36}:[0-9a-f]{16}$/);
    });

    it('queue_email refuses (42501) an invite not created or re-sent in this transaction, and a foreman caller', async () => {
      const owner = await world.employer();
      const id = await invite(owner, freshEmail());
      const message = 'org_team_invite_queue_email: no invite was sent in this transaction';
      const args = [id, 's', 'b', null];
      await asApi(owner, (c) => rejects(c, QUEUE_SQL, args, '42501', message));
      await asApi(owner, (c) => rejects(c, QUEUE_SQL, [randomUUID(), 's', 'b', null], '42501', message));
      const foreman = await world.foreman(owner.id);
      await asApi(foreman, (c) => rejects(c, QUEUE_SQL, args, '42501'));
      // A revoked invite is not pending, even within its transaction.
      await asApi(owner, async (c) => {
        const rows = await create(c, freshEmail(), randomUUID());
        expect((await revoke(c, rows[0].invite_id!))[0].outcome).toBe('revoked');
        await rejects(c, QUEUE_SQL, [rows[0].invite_id, 's', 'b', null], '42501', message);
      });
    });

    it('jale_api reads no organization_invite outbox row', async () => {
      const owner = await world.employer();
      await invite(owner, freshEmail());
      await asApi(owner, async (c) => {
        await c.query('SAVEPOINT read_mail');
        try {
          const { rows } = await c.query(`SELECT body_text FROM email_outbox WHERE source_type = 'organization_invite'`);
          expect(rows).toEqual([]);
        } catch (err) {
          expect(err).toMatchObject({ code: '42501' });
        }
        await c.query('ROLLBACK TO SAVEPOINT read_mail');
      });
    });

    it('mail_purge as jale_billing deletes sent invite mail older than a day and keeps retryable or recent rows', async () => {
      const owner = await world.employer();
      const id = await invite(owner, freshEmail());
      const insert = async (sourceType: string, status: string, attempts: number, age: string): Promise<string> => (await world.su.query<{ id: string }>(
        `INSERT INTO email_outbox (recipient_email, subject, body_text, source_type, source_id, status, attempt_count, sent_at, created_at)
         VALUES ('x@example.invalid', 's', 'b', $1, $2, $3, $4, CASE WHEN $3 = 'sent' THEN now() END, now() - $5::interval)
         RETURNING id`, [sourceType, id, status, attempts, age])).rows[0].id;
      const oldSent = await insert('organization_invite', 'sent', 1, '2 days');
      const oldGivenUp = await insert('organization_invite', 'failed', 5, '2 days');
      const oldRetryable = await insert('organization_invite', 'failed', 2, '2 days');
      const oldPending = await insert('organization_invite', 'pending', 0, '2 days');
      const recentSent = await insert('organization_invite', 'sent', 1, '1 hour');
      const otherKind = await insert('billing_pause', 'sent', 1, '2 days');
      extraOutbox.push(otherKind);
      const purged = await inTransaction('jale_billing', null, true, async (c) => {
        await rejects(c, PURGE_SQL, [0], '22023');
        await rejects(c, PURGE_SQL, [1001], '22023');
        await rejects(c, PURGE_SQL, [null], '22023');
        return (await c.query<{ n: number }>(PURGE_SQL, [1000])).rows[0].n;
      });
      expect(purged).toBeGreaterThanOrEqual(2);
      const { rows } = await world.su.query<{ id: string }>(
        'SELECT id FROM email_outbox WHERE id = ANY($1::uuid[])', [[oldSent, oldGivenUp, oldRetryable, oldPending, recentSent, otherKind]]);
      expect(rows.map((r) => r.id).sort()).toEqual([oldRetryable, oldPending, recentSent, otherKind].sort());
    });

    it('lookup as jale_api_public: valid with company name, email, contact name and existing_account; expired, revoked, used; not_found for an unknown or 31-byte hash', async () => {
      const owner = await world.employer({ companyName: 'Acme Roofing' });
      const withAccount = freshEmail();
      await bareLogin(withAccount);
      const fresh = freshEmail();
      await invite(owner, withAccount, T('lookup-account'));
      await invite(owner, fresh, T('lookup-fresh'));
      const expired = await invite(owner, freshEmail(), T('lookup-expired'));
      const revoked = await invite(owner, freshEmail(), T('lookup-revoked'));
      const used = await invite(owner, freshEmail(), T('lookup-used'));
      await world.su.query(`UPDATE organization_invites SET expires_at = now() - interval '1 minute' WHERE id = $1`, [expired]);
      await world.su.query(`UPDATE organization_invites SET revoked_at = now() WHERE id = $1`, [revoked]);
      await world.su.query(`UPDATE organization_invites SET accepted_at = now() WHERE id = $1`, [used]);
      const looked = await inTransaction('jale_api_public', null, false, async (c) => {
        const out = [];
        for (const token of [hash(T('lookup-account')), hash(T('lookup-fresh')), hash(T('lookup-expired')), hash(T('lookup-revoked')),
          hash(T('lookup-used')), hash(T('lookup-unknown')), hash(T('lookup-account')).subarray(0, 31), null]) {
          out.push((await c.query(LOOKUP_SQL, [token])).rows);
        }
        return out;
      });
      const nothing = { company_name: null, email: null, contact_name: null, existing_account: null, expires_at: null };
      expect(looked).toEqual([
        [{ outcome: 'valid', company_name: 'Acme Roofing', email: withAccount, contact_name: 'Ana', existing_account: true, expires_at: expect.any(Date) }],
        [{ outcome: 'valid', company_name: 'Acme Roofing', email: fresh, contact_name: 'Ana', existing_account: false, expires_at: expect.any(Date) }],
        [{ outcome: 'expired', ...nothing }],
        [{ outcome: 'revoked', ...nothing }],
        [{ outcome: 'used', ...nothing }],
        [{ outcome: 'not_found', ...nothing }],
        [{ outcome: 'not_found', ...nothing }],
        [{ outcome: 'not_found', ...nothing }],
      ]);
    });

    it('lookup: existing_account is false when only a worker login has the invite\'s email', async () => {
      const owner = await world.employer();
      const email = freshEmail();
      const worker = await world.worker();
      await world.su.query('UPDATE users SET email = $2 WHERE id = $1', [worker.id, email]);
      await invite(owner, email, T('lookup-worker'));
      const rows = await inTransaction('jale_api_public', null, false, async (c) => (await c.query(LOOKUP_SQL, [hash(T('lookup-worker'))])).rows);
      expect(rows).toEqual([expect.objectContaining({ outcome: 'valid', email, existing_account: false })]);
    });

    it('accept: a new login becomes an active foreman invited by the inviter, and the invite is used', async () => {
      const owner = await world.employer();
      const email = freshEmail();
      const invitee = await bareLogin(email);
      const id = await invite(owner, email, T('accept-new'));
      const org = await orgOf(owner);
      expect(await commitApi(invitee, (c) => accept(c, T('accept-new')))).toEqual([{ outcome: 'accepted', organization_id: org }]);
      const member = await world.su.query(
        `SELECT organization_id, role, status, invited_by, billing_suspended_at, joined_at > now() - interval '1 minute' AS recent
           FROM organization_members WHERE user_id = $1`, [invitee.id]);
      expect(member.rows).toEqual([{
        organization_id: org, role: 'foreman', status: 'active', invited_by: owner.id, billing_suspended_at: null, recent: true,
      }]);
      const stored = await world.su.query('SELECT accepted_at IS NOT NULL AS accepted, revoked_at FROM organization_invites WHERE id = $1', [id]);
      expect(stored.rows).toEqual([{ accepted: true, revoked_at: null }]);
      expect(await asApi(invitee, (c) => accept(c, T('accept-new')))).toEqual([{ outcome: 'used', organization_id: null }]);
    });

    it('accept: used, revoked and expired give their own outcome, never email_mismatch, and create no membership', async () => {
      const owner = await world.employer();
      const used = await invite(owner, freshEmail(), T('closed-used'));
      const revoked = await invite(owner, freshEmail(), T('closed-revoked'));
      const expired = await invite(owner, freshEmail(), T('closed-expired'));
      await world.su.query(`UPDATE organization_invites SET accepted_at = now() WHERE id = $1`, [used]);
      await world.su.query(`UPDATE organization_invites SET revoked_at = now() WHERE id = $1`, [revoked]);
      await world.su.query(`UPDATE organization_invites SET expires_at = now() - interval '1 minute' WHERE id = $1`, [expired]);
      const caller = await bareLogin(freshEmail());
      const outcomes = await asApi(caller, async (c) => [
        ...(await accept(c, T('closed-used'))), ...(await accept(c, T('closed-revoked'))), ...(await accept(c, T('closed-expired'))),
        { members: await membershipCount(c, caller.id) },
      ]);
      expect(outcomes).toEqual([
        { outcome: 'used', organization_id: null }, { outcome: 'revoked', organization_id: null },
        { outcome: 'expired', organization_id: null }, { members: 0 },
      ]);
    });

    it('accept: email_mismatch creates no membership', async () => {
      const owner = await world.employer();
      await invite(owner, freshEmail(), T('mismatch'));
      const caller = await bareLogin(freshEmail());
      const result = await asApi(caller, async (c) => [...(await accept(c, T('mismatch'))), { members: await membershipCount(c, caller.id) }]);
      expect(result).toEqual([{ outcome: 'email_mismatch', organization_id: null }, { members: 0 }]);
    });

    it('accept: a removed member of this company rejoins active, invited by the inviter, joined_at now', async () => {
      const owner = await world.employer();
      const removed = await world.foreman(owner.id, { status: 'removed' });
      await world.su.query(
        `UPDATE organization_members SET joined_at = now() - interval '30 days', status_changed_at = now() - interval '3 days', invited_by = NULL
          WHERE user_id = $1`, [removed.id]);
      await invite(owner, await emailOf(removed), T('rejoin'));
      const org = await orgOf(owner);
      expect(await commitApi(removed, (c) => accept(c, T('rejoin')))).toEqual([{ outcome: 'rejoined', organization_id: org }]);
      const { rows } = await world.su.query(
        `SELECT organization_id, role, status, invited_by,
                joined_at > now() - interval '1 minute' AS joined_now, status_changed_at > now() - interval '1 minute' AS changed_now
           FROM organization_members WHERE user_id = $1`, [removed.id]);
      expect(rows).toEqual([{
        organization_id: org, role: 'foreman', status: 'active', invited_by: owner.id, joined_now: true, changed_now: true,
      }]);
    });

    it('accept by the owner of another company: already_member, no error', async () => {
      const owner = await world.employer();
      const otherOwner = await world.employer();
      await rawInvite(await orgOf(owner), await emailOf(otherOwner), owner.id, T('other-owner'));
      expect(await asApi(otherOwner, (c) => accept(c, T('other-owner')))).toEqual([{ outcome: 'already_member', organization_id: null }]);
      const { rows } = await world.su.query('SELECT organization_id, role FROM organization_members WHERE user_id = $1', [otherOwner.id]);
      expect(rows).toEqual([{ organization_id: await orgOf(otherOwner), role: 'owner' }]);
    });

    it('accept: already_member for a foreman of another company; not_employer for a worker login', async () => {
      const owner = await world.employer();
      const other = await world.employer();
      const foreman = await world.foreman(other.id);
      await rawInvite(await orgOf(owner), await emailOf(foreman), owner.id, T('other-foreman'));
      expect(await asApi(foreman, (c) => accept(c, T('other-foreman')))).toEqual([{ outcome: 'already_member', organization_id: null }]);
      const worker = await world.worker();
      await rawInvite(await orgOf(owner), freshEmail(), owner.id, T('worker-login'));
      expect(await asApi(worker, (c) => accept(c, T('worker-login')))).toEqual([{ outcome: 'not_employer', organization_id: null }]);
      // An unknown or malformed token is not_found, and no caller context raises 42501.
      expect(await asApi(worker, (c) => accept(c, Buffer.alloc(31)))).toEqual([{ outcome: 'not_found', organization_id: null }]);
      await inTransaction('jale_api', null, false, (c) => rejects(c, ACCEPT_SQL, [hash(T('worker-login'))], '42501'));
    });

    it('accept with a rotated token: the pre-resend token gives not_found', async () => {
      const owner = await world.employer();
      const email = freshEmail();
      const invitee = await bareLogin(email);
      const id = await invite(owner, email, T('before-resend'));
      await coolDown(id);
      await commitApi(owner, async (c) => {
        expect((await resend(c, id, T('after-resend')))[0].outcome).toBe('resent');
        await queue(c, id);
      });
      expect(await asApi(invitee, (c) => accept(c, T('before-resend')))).toEqual([{ outcome: 'not_found', organization_id: null }]);
      expect(await asApi(invitee, (c) => accept(c, T('after-resend')))).toEqual([{ outcome: 'accepted', organization_id: await orgOf(owner) }]);
    });

    it('accept_email: a new login with one live invite becomes its foreman; two live invites give ambiguous; none gives none', async () => {
      const owner = await world.employer();
      const email = freshEmail();
      const invitee = await bareLogin(email.toUpperCase());
      const id = await invite(owner, email);
      const org = await orgOf(owner);
      expect(await commitApi(invitee, (c) => acceptEmail(c))).toEqual([{ outcome: 'accepted', organization_id: org }]);
      const member = await world.su.query('SELECT organization_id, role, status, invited_by FROM organization_members WHERE user_id = $1', [invitee.id]);
      expect(member.rows).toEqual([{ organization_id: org, role: 'foreman', status: 'active', invited_by: owner.id }]);
      const stored = await world.su.query('SELECT accepted_at IS NOT NULL AS accepted FROM organization_invites WHERE id = $1', [id]);
      expect(stored.rows).toEqual([{ accepted: true }]);
      // Now a member: already_member.
      expect(await asApi(invitee, (c) => acceptEmail(c))).toEqual([{ outcome: 'already_member', organization_id: null }]);

      const twice = freshEmail();
      const torn = await bareLogin(twice);
      await invite(await world.employer(), twice);
      await invite(await world.employer(), twice);
      expect(await asApi(torn, async (c) => [...(await acceptEmail(c)), { members: await membershipCount(c, torn.id) }]))
        .toEqual([{ outcome: 'ambiguous', organization_id: null }, { members: 0 }]);

      // An expired, a revoked and an accepted invite are not live.
      const lonely = freshEmail();
      const nobody = await bareLogin(lonely);
      const stale = await invite(await world.employer(), lonely);
      await world.su.query(`UPDATE organization_invites SET expires_at = now() - interval '1 minute' WHERE id = $1`, [stale]);
      expect(await asApi(nobody, (c) => acceptEmail(c))).toEqual([{ outcome: 'none', organization_id: null }]);
      const revokedEmail = freshEmail();
      const revokedLogin = await bareLogin(revokedEmail);
      const revokedInvite = await invite(await world.employer(), revokedEmail);
      await world.su.query(`UPDATE organization_invites SET revoked_at = now() WHERE id = $1`, [revokedInvite]);
      expect(await asApi(revokedLogin, async (c) => [...(await acceptEmail(c)), { members: await membershipCount(c, revokedLogin.id) }]))
        .toEqual([{ outcome: 'none', organization_id: null }, { members: 0 }]);
      // An accepted invite (its login since left the membership table) is not live either.
      const usedEmail = freshEmail();
      const usedLogin = await bareLogin(usedEmail);
      const usedInvite = await invite(await world.employer(), usedEmail);
      await world.su.query(`UPDATE organization_invites SET accepted_at = now() WHERE id = $1`, [usedInvite]);
      expect(await asApi(usedLogin, async (c) => [...(await acceptEmail(c)), { members: await membershipCount(c, usedLogin.id) }]))
        .toEqual([{ outcome: 'none', organization_id: null }, { members: 0 }]);
      const worker = await world.worker();
      expect(await asApi(worker, (c) => acceptEmail(c))).toEqual([{ outcome: 'not_employer', organization_id: null }]);
    });
  });
});
