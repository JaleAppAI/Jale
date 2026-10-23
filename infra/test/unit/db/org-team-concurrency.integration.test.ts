/**
 * org-team-concurrency -- migration 130's invite definers under real
 * concurrency, as the deployed logins (two connections; one holds the
 * company lock, the other's call is proven to wait on it, then resolves):
 *  1. two of the owner's sessions inviting for the last seat: the second
 *     waits for the company lock, then counts the first invite, so one is
 *     created and one is seat_limit_reached;
 *  2. an accept waiting on a downgrade (128's billing_enforce_org_limits,
 *     which revokes live invites beyond the seats left) sees its invite
 *     revoked once the downgrade commits, and creates no membership;
 *  3. an accept racing a resend: the resend rotates the token, so the accept
 *     holding the old token re-reads by token after the lock and gets
 *     not_found, with no membership;
 *  4. accept_email waiting on the owner's revoke re-reads the invite after
 *     the lock: none, no membership;
 *  5. the owner's revoke waiting on an accept classifies the accepted
 *     invite after the lock: closed, no cognito_sub;
 *  6. two accepts for one login in two companies (no shared lock): the
 *     second's insert waits on the members primary key and, once the first
 *     commits, answers already_member instead of raising 23505;
 *  7. accept_email racing a start-company (employer_ensure_organization)
 *     for the same login: already_member, not 23505.
 * Fixtures through the superuser URL (Task 1's World); afterAll removes them.
 *
 * Run: bash infra/db/local/bootstrap-testbed.sh --ephemeral --ref none --profile request \
 *   --container <name> --port <port> -- \
 *   bash infra/scripts/run-whatsapp-v2-db-tests.sh --suite test/unit/db/org-team-concurrency.integration.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { FIXTURE_TOS_VERSION, World, type UserFixture } from './r-paths-world';
import { describeInProfiles, loginClient } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: org-team-concurrency needs JALE_TEST_DATABASE_URL (see header)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

const hash = (t: string): Buffer => createHash('sha256').update(t, 'utf8').digest();
const CREATE_SQL = 'SELECT outcome, invite_id FROM jale_cap.org_team_invite_create($1, $2, $3, $4)';
const RESEND_SQL = 'SELECT outcome FROM jale_cap.org_team_invite_resend($1, $2, $3)';
const QUEUE_SQL = 'SELECT jale_cap.org_team_invite_queue_email($1, $2, $3, $4) AS id';
const ACCEPT_SQL = 'SELECT outcome, organization_id FROM jale_cap.org_team_invite_accept($1)';
const ACCEPT_EMAIL_SQL = 'SELECT outcome, organization_id FROM jale_cap.org_team_invite_accept_email()';
const REVOKE_SQL = 'SELECT outcome, cognito_sub FROM jale_cap.org_team_invite_revoke($1)';

maybeDescribe('team invites under concurrency', () => {
  let world: World;
  const bareLogins: string[] = [];
  /** Companies a bare login started itself (the start-company race). */
  const extraOrgs: string[] = [];

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
      await world.cleanup();
      await world.su.query(`DELETE FROM organization_members WHERE user_id = ANY($1::uuid[])`, [bareLogins]);
      await world.su.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [extraOrgs]);
      await world.su.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [bareLogins]);
    } finally {
      await world.end();
    }
  });

  const freshEmail = () => `invitee-${randomUUID()}@example.com`;
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
  async function begin(c: Client, p: UserFixture): Promise<void> {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [p.sub]);
    await c.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [p.id]);
  }
  async function pidOf(c: Client): Promise<number> {
    return (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  }
  /** Waits until backend `pid` is blocked on a lock (proves the wait, not just the outcome). */
  async function waitUntilBlocked(pid: number): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      const { rows } = await world.su.query<{ waiting: boolean }>(
        `SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1`, [pid]);
      if (rows[0]?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`backend ${pid} never waited on a lock`);
  }
  /** A committed invite (create plus its mail), as the owner. */
  async function invite(owner: UserFixture, email: string, token: string): Promise<string> {
    const c = loginClient('jale_api');
    await c.connect();
    try {
      await begin(c, owner);
      const { rows } = await c.query<{ outcome: string; invite_id: string }>(CREATE_SQL, [email, null, hash(token), 10]);
      expect(rows.map((r) => r.outcome)).toEqual(['created']);
      await c.query(QUEUE_SQL, [rows[0].invite_id, 'Invite', 'Join', null]);
      await c.query('COMMIT');
      return rows[0].invite_id;
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  }
  async function membershipOf(userId: string): Promise<unknown[]> {
    return (await world.su.query('SELECT organization_id FROM organization_members WHERE user_id = $1', [userId])).rows;
  }

  describeInProfiles(['standard', 'request'], 'invites and the company lock', () => {
    it('two owners\' sessions inviting for the last seat: one created, one seat_limit_reached', async () => {
      const owner = await world.employer();
      const first = loginClient('jale_api');
      const second = loginClient('jale_api');
      await first.connect();
      await second.connect();
      try {
        const secondPid = await pidOf(second);
        await begin(first, owner);
        await begin(second, owner);
        const created = await first.query<{ outcome: string; invite_id: string }>(
          CREATE_SQL, [freshEmail(), null, hash(randomUUID()), 1]);
        expect(created.rows.map((r) => r.outcome)).toEqual(['created']);
        await first.query(QUEUE_SQL, [created.rows[0].invite_id, 'Invite', 'Join', null]);
        const racing = second.query<{ outcome: string }>(CREATE_SQL, [freshEmail(), null, hash(randomUUID()), 1]);
        racing.catch(() => undefined); // observed below
        await waitUntilBlocked(secondPid);
        await first.query('COMMIT');
        expect((await racing).rows.map((r) => r.outcome)).toEqual(['seat_limit_reached']);
        await second.query('COMMIT');
      } finally {
        await first.query('ROLLBACK').catch(() => undefined);
        await second.query('ROLLBACK').catch(() => undefined);
        await first.end();
        await second.end();
      }
      const { rows } = await world.su.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM organization_invites
          WHERE organization_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`, [await orgOf(owner)]);
      expect(rows[0].n).toBe(1);
    });

    it('an accept waiting on a downgrade sees its invite revoked', async () => {
      const owner = await world.employer();
      const org = await orgOf(owner);
      const email = freshEmail();
      const invitee = await bareLogin(email);
      const token = `downgrade-${randomUUID()}`;
      await invite(owner, email, token);
      const billing = loginClient('jale_billing');
      const accepter = loginClient('jale_api');
      await billing.connect();
      await accepter.connect();
      try {
        const accepterPid = await pidOf(accepter);
        // The downgrade to no seats holds the company lock, the invite revoked but not yet committed.
        await billing.query('BEGIN');
        const enforced = await billing.query<{ revoked_invite_count: number }>(
          'SELECT revoked_invite_count FROM jale_billing_internal.billing_enforce_org_limits($1, 10, 0)', [org]);
        expect(enforced.rows[0].revoked_invite_count).toBe(1);
        // The invitee, who still sees a live invite, asks for the lock and waits.
        await begin(accepter, invitee);
        const accepted = accepter.query<{ outcome: string; organization_id: string | null }>(ACCEPT_SQL, [hash(token)]);
        accepted.catch(() => undefined); // observed below
        await waitUntilBlocked(accepterPid);
        await billing.query('COMMIT');
        expect((await accepted).rows).toEqual([{ outcome: 'revoked', organization_id: null }]);
        await accepter.query('COMMIT');
      } finally {
        await billing.query('ROLLBACK').catch(() => undefined);
        await accepter.query('ROLLBACK').catch(() => undefined);
        await billing.end();
        await accepter.end();
      }
      expect(await membershipOf(invitee.id)).toEqual([]);
    });

    it('an accept racing a resend: the accept holding the old token gives not_found and no membership', async () => {
      const owner = await world.employer();
      const email = freshEmail();
      const invitee = await bareLogin(email);
      const oldToken = `race-old-${randomUUID()}`;
      const id = await invite(owner, email, oldToken);
      await world.su.query(`UPDATE organization_invites SET last_sent_at = now() - interval '2 minutes' WHERE id = $1`, [id]);
      const resender = loginClient('jale_api');
      const accepter = loginClient('jale_api');
      await resender.connect();
      await accepter.connect();
      try {
        const accepterPid = await pidOf(accepter);
        await begin(resender, owner);
        const resent = await resender.query<{ outcome: string }>(RESEND_SQL, [id, hash(`race-new-${randomUUID()}`), 10]);
        expect(resent.rows.map((r) => r.outcome)).toEqual(['resent']);
        await begin(accepter, invitee);
        const accepted = accepter.query<{ outcome: string; organization_id: string | null }>(ACCEPT_SQL, [hash(oldToken)]);
        accepted.catch(() => undefined); // observed below
        await waitUntilBlocked(accepterPid);
        await resender.query('COMMIT');
        expect((await accepted).rows).toEqual([{ outcome: 'not_found', organization_id: null }]);
        await accepter.query('COMMIT');
      } finally {
        await resender.query('ROLLBACK').catch(() => undefined);
        await accepter.query('ROLLBACK').catch(() => undefined);
        await resender.end();
        await accepter.end();
      }
      expect(await membershipOf(invitee.id)).toEqual([]);
    });

    it('accept_email waiting on the owner\'s revoke gets none and no membership', async () => {
      const owner = await world.employer();
      const email = freshEmail();
      const invitee = await bareLogin(email);
      const id = await invite(owner, email, `revoke-race-${randomUUID()}`);
      const revoker = loginClient('jale_api');
      const accepter = loginClient('jale_api');
      await revoker.connect();
      await accepter.connect();
      try {
        const accepterPid = await pidOf(accepter);
        await begin(revoker, owner);
        const revoked = await revoker.query<{ outcome: string }>(REVOKE_SQL, [id]);
        expect(revoked.rows.map((r) => r.outcome)).toEqual(['revoked']);
        // The invitee, who still sees one live invite, asks for its company's lock and waits.
        await begin(accepter, invitee);
        const accepted = accepter.query<{ outcome: string; organization_id: string | null }>(ACCEPT_EMAIL_SQL);
        accepted.catch(() => undefined); // observed below
        await waitUntilBlocked(accepterPid);
        await revoker.query('COMMIT');
        expect((await accepted).rows).toEqual([{ outcome: 'none', organization_id: null }]);
        await accepter.query('COMMIT');
      } finally {
        await revoker.query('ROLLBACK').catch(() => undefined);
        await accepter.query('ROLLBACK').catch(() => undefined);
        await revoker.end();
        await accepter.end();
      }
      expect(await membershipOf(invitee.id)).toEqual([]);
    });

    it('the owner\'s revoke waiting on an accept gets closed and no cognito_sub', async () => {
      const owner = await world.employer();
      const org = await orgOf(owner);
      const email = freshEmail();
      const invitee = await bareLogin(email);
      const token = `accept-race-${randomUUID()}`;
      const id = await invite(owner, email, token);
      const accepter = loginClient('jale_api');
      const revoker = loginClient('jale_api');
      await accepter.connect();
      await revoker.connect();
      try {
        const revokerPid = await pidOf(revoker);
        await begin(accepter, invitee);
        const accepted = await accepter.query<{ outcome: string; organization_id: string }>(ACCEPT_SQL, [hash(token)]);
        expect(accepted.rows).toEqual([{ outcome: 'accepted', organization_id: org }]);
        await begin(revoker, owner);
        const revoked = revoker.query<{ outcome: string; cognito_sub: string | null }>(REVOKE_SQL, [id]);
        revoked.catch(() => undefined); // observed below
        await waitUntilBlocked(revokerPid);
        await accepter.query('COMMIT');
        expect((await revoked).rows).toEqual([{ outcome: 'closed', cognito_sub: null }]);
        await revoker.query('COMMIT');
      } finally {
        await accepter.query('ROLLBACK').catch(() => undefined);
        await revoker.query('ROLLBACK').catch(() => undefined);
        await accepter.end();
        await revoker.end();
      }
      expect(await membershipOf(invitee.id)).toEqual([{ organization_id: org }]);
      const { rows } = await world.su.query(
        'SELECT accepted_at IS NOT NULL AS accepted, revoked_at IS NULL AS not_revoked FROM organization_invites WHERE id = $1', [id]);
      expect(rows).toEqual([{ accepted: true, not_revoked: true }]);
    });

    it('two accepts for one login in two companies: the second waits on the members key and gets already_member, not an error', async () => {
      const first = await world.employer();
      const second = await world.employer();
      const email = freshEmail();
      const invitee = await bareLogin(email);
      const firstToken = `pk-race-a-${randomUUID()}`;
      const secondToken = `pk-race-b-${randomUUID()}`;
      await invite(first, email, firstToken);
      const secondInvite = await invite(second, email, secondToken);
      const a = loginClient('jale_api');
      const b = loginClient('jale_api');
      await a.connect();
      await b.connect();
      try {
        const bPid = await pidOf(b);
        await begin(a, invitee);
        expect((await a.query<{ outcome: string }>(ACCEPT_SQL, [hash(firstToken)])).rows.map((r) => r.outcome)).toEqual(['accepted']);
        // Another company's lock: no wait there. The membership read sees no row yet; the insert waits on a's key.
        await begin(b, invitee);
        const racing = b.query<{ outcome: string; organization_id: string | null }>(ACCEPT_SQL, [hash(secondToken)]);
        racing.catch(() => undefined); // observed below
        await waitUntilBlocked(bPid);
        await a.query('COMMIT');
        expect((await racing).rows).toEqual([{ outcome: 'already_member', organization_id: null }]);
        await b.query('COMMIT');
      } finally {
        await a.query('ROLLBACK').catch(() => undefined);
        await b.query('ROLLBACK').catch(() => undefined);
        await a.end();
        await b.end();
      }
      expect(await membershipOf(invitee.id)).toEqual([{ organization_id: await orgOf(first) }]);
      const { rows } = await world.su.query('SELECT accepted_at FROM organization_invites WHERE id = $1', [secondInvite]);
      expect(rows).toEqual([{ accepted_at: null }]);
    });

    it('accept_email racing a start-company for the same login gets already_member, not an error', async () => {
      const owner = await world.employer();
      const email = freshEmail();
      const invitee = await bareLogin(email);
      await invite(owner, email, `pk-race-c-${randomUUID()}`);
      const starter = loginClient('jale_api');
      const accepter = loginClient('jale_api');
      await starter.connect();
      await accepter.connect();
      let started: string | undefined;
      try {
        const accepterPid = await pidOf(accepter);
        // Post-confirmation's start-company path (118) inserts the owner membership, uncommitted.
        await begin(starter, invitee);
        started = (await starter.query<{ org: string }>(`SELECT public.employer_ensure_organization('Own Co') AS org`)).rows[0].org;
        extraOrgs.push(started);
        // accept_email sees no membership yet, locks the inviting company, and its insert waits on the members key.
        await begin(accepter, invitee);
        const racing = accepter.query<{ outcome: string; organization_id: string | null }>(ACCEPT_EMAIL_SQL);
        racing.catch(() => undefined); // observed below
        await waitUntilBlocked(accepterPid);
        await starter.query('COMMIT');
        expect((await racing).rows).toEqual([{ outcome: 'already_member', organization_id: null }]);
        await accepter.query('COMMIT');
      } finally {
        await starter.query('ROLLBACK').catch(() => undefined);
        await accepter.query('ROLLBACK').catch(() => undefined);
        await starter.end();
        await accepter.end();
      }
      expect(await membershipOf(invitee.id)).toEqual([{ organization_id: started }]);
    });
  });
});
