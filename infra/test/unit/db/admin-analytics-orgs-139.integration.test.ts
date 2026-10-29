/**
 * admin-analytics-orgs-139.integration.test.ts
 *
 * PostgreSQL-backed tests for migration 139 (employer organizations, Phase 5):
 * admin analytics count companies instead of employer logins. Every function
 * is called as the admin console login (jale_admin_console), the way the
 * console calls it.
 *
 * A company is an employer login with no foreman membership, keyed by its
 * organization (or by the login itself when it has no membership at all).
 * The suite proves:
 *  - one count per company: totals, sign-ups, acquisition and paying-weekly
 *    move by one for an owner with foremen, and by nothing for a foreman;
 *  - paying companies and the Companies list report seats as the owner's
 *    billing page does (active foremen used, live invites pending, only
 *    billing-suspended foremen suspended, the plan's seat limit, the free
 *    limit once a past-due grace period has ended);
 *  - the slowest employers are grouped by company: a foreman's and a removed
 *    foreman's jobs count in the company row, a memberless login is its own
 *    row, an owner-less company is keyed by the job's holder, and no row
 *    ever has a NULL employer_id;
 *  - a memberless login is one company in totals, sign-ups, acquisition,
 *    template reuse and paying-weekly employers;
 *  - paying-weekly groups by company: a company paying through a second
 *    subscription is neither new nor churned;
 *  - the test-account rule follows the owner (email and seed- sub), never a
 *    foreman; paying_employers and totals apply none, paying_weekly the payer;
 *  - the Companies list's order and page bound;
 *  - template reuse counts companies;
 *  - the company members list: order, names (never an email, even for a
 *    member with no name), columns;
 *  - organization_members and organization_invites are read through 139's
 *    own policies (dropped in a rolled-back transaction, the figures vanish),
 *    company_members included, never only through 118's name gate;
 *  - argument rejection.
 *
 * Every figure is a whole-database delta around one fixture step, or a row
 * found by its own id (never by list position or length), so the suite is
 * valid on a shared bed. Fixtures are written as the superuser through
 * World (r-paths-world.ts) with triggers on: 127 stamps a subscription's
 * company and 100 writes its history row. afterAll removes them.
 *
 * Run: bash infra/db/local/bootstrap-testbed.sh --ephemeral --profile standard --repo . -- \
 *   bash infra/scripts/run-whatsapp-v2-db-tests.sh --suite test/unit/db/admin-analytics-orgs-139.integration.test.ts
 *
 * Always --runInBand (the runner does): the assertions are whole-database deltas.
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { World, type UserFixture } from './r-paths-world';
import { itInProfiles, withLoginClient } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: admin-analytics-orgs-139 needs JALE_TEST_DATABASE_URL (see header)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

type Row = Record<string, any>;

const COMPANIES_COLUMNS = [
  'organization_id', 'owner_id', 'display_name', 'created_at', 'plan_code', 'plan_status', 'members_active',
  'seats_used', 'seats_pending', 'seats_suspended', 'seat_limit', 'active_jobs',
];
const MEMBERS_COLUMNS = [
  'user_id', 'display_name', 'role', 'status', 'billing_suspended', 'joined_at', 'status_changed_at', 'active_jobs',
];
const PAYING_COLUMNS = [
  'employer_id', 'display_name', 'plan_code', 'status', 'current_period_end', 'cancel_at_period_end',
  'organization_id', 'members_active', 'seats_used', 'seats_pending', 'seats_suspended', 'seat_limit',
];
const SLOWEST_COLUMNS = [
  'employer_id', 'display_name', 'applications', 'unanswered_7d', 'first_response_p50_hours', 'active_jobs',
  'organization_id',
];

/** Runs one statement as the admin console; rows and column names. */
async function asConsole(sql: string, args: unknown[] = []): Promise<{ rows: Row[]; columns: string[] }> {
  return withLoginClient('jale_admin_console', async (c) => {
    const r = await c.query(sql, args);
    return { rows: r.rows, columns: r.fields.map((f) => f.name) };
  });
}
const consoleRows = async (sql: string, args: unknown[] = []): Promise<Row[]> => (await asConsole(sql, args)).rows;

/** The error a console call raises, or null. */
async function consoleError(sql: string, args: unknown[] = []): Promise<string | null> {
  try {
    await consoleRows(sql, args);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** A companies() or paying_employers() row's seat figures, as numbers. */
function seats(r: Row): Row {
  return {
    members_active: Number(r.members_active),
    seats_used: Number(r.seats_used),
    seats_pending: Number(r.seats_pending),
    seats_suspended: Number(r.seats_suspended),
    seat_limit: r.seat_limit === null ? null : Number(r.seat_limit),
  };
}

maybeDescribe('migration 139: admin analytics by company', () => {
  let world: World;
  let su: Client;
  /** Three workers who apply to every slowest-employer job. */
  let workers: UserFixture[] = [];
  /** A fixed sign-up window start, so a bucket never ages out between two calls. */
  let signupsFrom: Date;
  /** Fixture ids shared by later cases (the RLS proof). */
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    world = new World(databaseUrl!);
    await world.connect();
    su = world.su;
    signupsFrom = (await su.query<{ t: Date }>(`SELECT now() - interval '2 days' AS t`)).rows[0].t;
    workers = [await world.worker(), await world.worker(), await world.worker()];
  });
  afterAll(async () => {
    try {
      await world.cleanup();
    } finally {
      await world.end();
    }
  });

  // ── fixture helpers ───────────────────────────────────────────────

  async function orgOf(owner: UserFixture): Promise<string> {
    return (await su.query<{ organization_id: string }>(
      'SELECT organization_id FROM organization_members WHERE user_id = $1', [owner.id])).rows[0].organization_id;
  }
  /** A subscription of the owner's company (127's trigger stamps organization_id; 100's writes history). */
  async function subscribe(owner: UserFixture, plan: string, status: string, graceEndsAt: string | null = null): Promise<string> {
    return (await su.query<{ id: string }>(
      `INSERT INTO subscriptions (user_id, plan_code, status, grace_ends_at, current_period_start, current_period_end)
       VALUES ($1, $2, $3, $4::timestamptz, now() - interval '3 days', now() + interval '27 days') RETURNING id`,
      [owner.id, plan, status, graceEndsAt],
    )).rows[0].id;
  }
  /** An organization_invites row (128's inviteTo); `expires` (an interval from now) and `revoked` choose its state. */
  async function invite(org: string, by: UserFixture, expires: string, revoked = false): Promise<string> {
    return (await su.query<{ id: string }>(
      `INSERT INTO organization_invites (organization_id, email, token_hash, invited_by, created_at, expires_at, revoked_at)
       VALUES ($1, $2, decode(md5(random()::text) || md5(random()::text), 'hex'), $3,
               now() - interval '10 days', now() + $4::interval, CASE WHEN $5::boolean THEN now() END)
       RETURNING id`,
      [org, `invitee-${randomUUID()}@example.com`, by.id, expires, revoked],
    )).rows[0].id;
  }
  /** Three unanswered applications, 8 days old, so the row has unanswered_7d = 3 and ranks at the top. */
  async function staleApplications(jobId: string): Promise<void> {
    for (const w of workers) {
      await su.query(
        `INSERT INTO job_applications (job_id, worker_id, status, applied_at)
         VALUES ($1, $2, 'pending', now() - interval '8 days')`, [jobId, w.id]);
    }
  }
  /** An employer login with no membership at all (an invalid invite, or a fixture). */
  async function memberless(): Promise<UserFixture> {
    const login = await world.employer({ companyName: 'Fixture Memberless' });
    await su.query('DELETE FROM organization_members WHERE user_id = $1', [login.id]);
    return login;
  }
  async function makeTestAccount(user: UserFixture): Promise<void> {
    await su.query(`UPDATE users SET email = $2 WHERE id = $1`, [user.id, `${user.id}@jale.test`]);
  }

  // ── console reads ─────────────────────────────────────────────────

  async function company(org: string): Promise<Row | undefined> {
    const rows = await consoleRows('SELECT * FROM admin_analytics_companies(1, $1)', [org]);
    expect(rows.length).toBeLessThanOrEqual(1);
    return rows[0];
  }
  async function payingRow(org: string): Promise<Row | undefined> {
    const rows = (await consoleRows('SELECT * FROM admin_analytics_paying_employers()'))
      .filter((r) => r.organization_id === org);
    expect(rows.length).toBeLessThanOrEqual(1);
    return rows[0];
  }
  async function slowest(): Promise<Row[]> {
    return consoleRows('SELECT * FROM admin_analytics_slowest_employers(4, 100)');
  }

  interface Weekly { employers: number; paying: number; new_paying: number; churned: number }
  interface Figures {
    totalEmployers: number;
    payingEmployers: number;
    signups: Map<string, number>;
    acquisition: number;
    payingWeekly: Map<string, Weekly>;
    templateCompanies: number;
    fromTemplate: number;
  }
  async function figures(): Promise<Figures> {
    return withLoginClient('jale_admin_console', async (c) => {
      const t = (await c.query('SELECT total_employers, paying_employers FROM admin_analytics_totals()')).rows[0];
      const signups = new Map<string, number>();
      for (const r of (await c.query(
        `SELECT bucket_start, employer_signups FROM admin_analytics_signups($1, 'day')`, [signupsFrom])).rows) {
        signups.set(new Date(r.bucket_start).toISOString(), Number(r.employer_signups));
      }
      // Acquisition and template reuse are summed over two weeks, so a fixture
      // made just after Monday 00:00 UTC still lands in the window.
      const acquisition = (await c.query('SELECT total FROM admin_analytics_acquisition(2)')).rows
        .reduce((n, r) => n + Number(r.total), 0);
      const payingWeekly = new Map<string, Weekly>();
      for (const r of (await c.query(
        'SELECT week_start, employers, paying, new_paying, churned FROM admin_analytics_paying_weekly(1)')).rows) {
        payingWeekly.set(new Date(r.week_start).toISOString(), {
          employers: Number(r.employers), paying: Number(r.paying),
          new_paying: Number(r.new_paying), churned: Number(r.churned),
        });
      }
      const tr = (await c.query('SELECT employers_using_templates, from_template FROM admin_analytics_template_reuse(2)')).rows;
      return {
        totalEmployers: Number(t.total_employers),
        payingEmployers: Number(t.paying_employers),
        signups,
        acquisition,
        payingWeekly,
        templateCompanies: tr.reduce((n, r) => n + Number(r.employers_using_templates), 0),
        fromTemplate: tr.reduce((n, r) => n + Number(r.from_template), 0),
      };
    });
  }
  const sum = (m: Map<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);
  /** The day bucket (UTC) a login was created in, as signups() keys it. */
  async function signupDay(user: UserFixture): Promise<string> {
    const r = (await su.query<{ d: Date }>(
      `SELECT date_trunc('day', created_at, 'UTC') AS d FROM users WHERE id = $1`, [user.id])).rows[0];
    return r.d.toISOString();
  }
  /** The current week (UTC Monday) as paying_weekly() keys it. */
  async function currentWeek(): Promise<string> {
    return (await su.query<{ w: Date }>(
      `SELECT date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS w`)).rows[0].w.toISOString();
  }
  /**
   * paying_weekly's change in the current week between two figures() calls.
   * The week is read after the second call; a run that straddles Monday
   * 00:00 UTC fails with a clear message rather than a TypeError.
   */
  async function weeklyDelta(before: Figures, after: Figures): Promise<Weekly> {
    const week = await currentWeek();
    const b = before.payingWeekly.get(week);
    const a = after.payingWeekly.get(week);
    if (!a || !b) throw new Error(`paying_weekly: week ${week} missing from a figure (the run crossed Monday 00:00 UTC; re-run)`);
    return {
      employers: a.employers - b.employers, paying: a.paying - b.paying,
      new_paying: a.new_paying - b.new_paying, churned: a.churned - b.churned,
    };
  }
  /** Ids of the given organizations in one companies(500) result, in result order. */
  async function listedOrgs(orgs: string[]): Promise<string[]> {
    return (await consoleRows('SELECT organization_id FROM admin_analytics_companies(500)'))
      .map((r) => r.organization_id as string)
      .filter((id) => orgs.includes(id));
  }

  // ── 1. One company, one count ─────────────────────────────────────

  describe('one company, one count', () => {
    let owner: UserFixture;

    it('an owner with two active foremen (one with a job) adds one employer, one sign-up and one acquisition', async () => {
      const before = await figures();
      owner = await world.employer({ companyName: 'Fixture One Count' });
      const f1 = await world.foreman(owner.id);
      await world.foreman(owner.id);
      await world.job(f1.id);
      const after = await figures();

      expect(after.totalEmployers - before.totalEmployers).toBe(1);
      const day = await signupDay(owner);
      expect((after.signups.get(day) ?? 0) - (before.signups.get(day) ?? 0)).toBe(1);
      expect(sum(after.signups) - sum(before.signups)).toBe(1);
      expect(after.acquisition - before.acquisition).toBe(1);
    });

    it('a foreman joining an existing company adds no employer, no sign-up and no acquisition', async () => {
      const before = await figures();
      await world.foreman(owner.id);
      const after = await figures();

      expect(after.totalEmployers - before.totalEmployers).toBe(0);
      expect(sum(after.signups) - sum(before.signups)).toBe(0);
      expect(after.acquisition - before.acquisition).toBe(0);
    });

    it('a memberless login is one company: employer, sign-up, acquisition, template company and paying-weekly employer', async () => {
      const before = await figures();
      const login = await memberless();
      const t = await world.template(login.id, 'Fixture memberless template');
      const j = await world.job(login.id);
      await su.query('UPDATE jobs SET created_from_template_id = $2 WHERE id = $1', [j.id, t]);
      const after = await figures();

      expect(after.totalEmployers - before.totalEmployers).toBe(1);
      const day = await signupDay(login);
      expect((after.signups.get(day) ?? 0) - (before.signups.get(day) ?? 0)).toBe(1);
      expect(sum(after.signups) - sum(before.signups)).toBe(1);
      expect(after.acquisition - before.acquisition).toBe(1);
      expect(after.fromTemplate - before.fromTemplate).toBe(1);
      expect(after.templateCompanies - before.templateCompanies).toBe(1);
      expect((await weeklyDelta(before, after)).employers).toBe(1);
    });
  });

  // ── 2. Paying ─────────────────────────────────────────────────────

  describe('paying', () => {
    it('a paying owner with two active foremen is one paying company with its seats', async () => {
      const before = await figures();
      const owner = await world.employer({ companyName: 'Fixture Paying Co' });
      await world.foreman(owner.id);
      await world.foreman(owner.id);
      await subscribe(owner, 'employer_pro', 'active');
      const after = await figures();
      const org = await orgOf(owner);

      expect(after.payingEmployers - before.payingEmployers).toBe(1);

      const row = await payingRow(org);
      expect(row).toBeDefined();
      expect(row!.employer_id).toBe(owner.id);
      expect(row!.organization_id).toBe(org);
      expect(row!.plan_code).toBe('employer_pro');
      expect(row!.status).toBe('active');
      expect(seats(row!)).toEqual({
        members_active: 3, seats_used: 2, seats_pending: 0, seats_suspended: 0, seat_limit: 3,
      });

      // paying_weekly: one more paying company this week, new this week; the
      // owner is the one new employer, the two foremen add none.
      expect(await weeklyDelta(before, after)).toEqual({ employers: 1, paying: 1, new_paying: 1, churned: 0 });
    });

    it('a company that keeps paying through a second subscription counts once: no new, no churn', async () => {
      // Subscription A, paid by the owner, has been active since before this
      // week; it is canceled now and subscription B, paid by another login of
      // the same company, starts. Per company: paying at the week's start and
      // at its end. Per subscription or per payer it would be one churned and
      // one new.
      const before = await figures();
      const owner = await world.employer({ companyName: 'Fixture Resubscribe Co' });
      const org = await orgOf(owner);
      const second = await world.foreman(owner.id);
      const a = await subscribe(owner, 'employer_pro', 'active');
      await su.query(
        `UPDATE subscription_status_history
            SET changed_at = date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - interval '2 days'
          WHERE subscription_id = $1`, [a]);
      await su.query(`UPDATE subscriptions SET status = 'canceled', updated_at = now() WHERE id = $1`, [a]);
      const b = await subscribe(second, 'employer_pro', 'active');
      const stamped = (await su.query<{ organization_id: string }>(
        'SELECT organization_id FROM subscriptions WHERE id = $1', [b])).rows[0];
      expect(stamped.organization_id).toBe(org);
      const after = await figures();

      expect(await weeklyDelta(before, after)).toEqual({ employers: 1, paying: 1, new_paying: 0, churned: 0 });
      expect(after.payingEmployers - before.payingEmployers).toBe(1);
    });

    it('no test filter in paying_employers or totals, the payer filter in paying_weekly (seed- sub)', async () => {
      const before = await figures();
      const owner = await world.employer({ companyName: 'Fixture Seed Paying Co' });
      await su.query(`UPDATE users SET cognito_sub = 'seed-' || id WHERE id = $1`, [owner.id]);
      const org = await orgOf(owner);
      await world.foreman(owner.id);
      await subscribe(owner, 'employer_pro', 'active');
      const after = await figures();

      expect(after.payingEmployers - before.payingEmployers).toBe(1);
      const row = await payingRow(org);
      expect(row).toBeDefined();
      expect(row!.employer_id).toBe(owner.id);
      expect(await weeklyDelta(before, after)).toEqual({ employers: 0, paying: 0, new_paying: 0, churned: 0 });
      // A seed- owner is a test company for the Companies list too.
      expect(await listedOrgs([org])).toEqual([]);
      expect(await company(org)).toBeDefined();
    });
  });

  // ── 3. Seats ──────────────────────────────────────────────────────

  describe('seats (companies and paying_employers agree with the billing meter)', () => {
    let owner: UserFixture;
    let org: string;
    let fa: UserFixture;
    let fb: UserFixture;

    /** companies(1, org) and the paying_employers row report the same seats. */
    async function bothSeats(): Promise<Row> {
      const c = await company(org);
      const p = await payingRow(org);
      expect(c).toBeDefined();
      expect(p).toBeDefined();
      expect(seats(p!)).toEqual(seats(c!));
      return seats(c!);
    }

    beforeAll(async () => {
      owner = await world.employer({ companyName: 'Fixture Seats Co' });
      org = await orgOf(owner);
      fa = await world.foreman(owner.id);
      fb = await world.foreman(owner.id);
      await subscribe(owner, 'employer_pro', 'active');
      ids.seatsOrg = org;
    });

    it('starts with two seats used of three, the owner taking none', async () => {
      const c = await company(org);
      expect(c!.owner_id).toBe(owner.id);
      expect(c!.plan_code).toBe('employer_pro');
      expect(c!.plan_status).toBe('active');
      expect(await bothSeats()).toEqual({
        members_active: 3, seats_used: 2, seats_pending: 0, seats_suspended: 0, seat_limit: 3,
      });
    });

    it('a live invite holds a pending seat', async () => {
      await invite(org, owner, '7 days');
      expect(await bothSeats()).toMatchObject({ seats_used: 2, seats_pending: 1 });
    });

    it('an expired and a revoked invite hold none', async () => {
      await invite(org, owner, '-3 days');
      await invite(org, owner, '7 days', true);
      expect(await bothSeats()).toMatchObject({ seats_used: 2, seats_pending: 1 });
    });

    it('a billing-suspended foreman is suspended and frees a seat', async () => {
      await su.query(
        `UPDATE organization_members SET status = 'suspended', billing_suspended_at = now(), status_changed_at = now()
          WHERE user_id = $1`, [fa.id]);
      expect(await bothSeats()).toEqual({
        members_active: 2, seats_used: 1, seats_pending: 1, seats_suspended: 1, seat_limit: 3,
      });
    });

    it('a foreman suspended for another reason frees a seat and is not counted as suspended', async () => {
      await su.query(
        `UPDATE organization_members SET status = 'suspended', billing_suspended_at = NULL, status_changed_at = now()
          WHERE user_id = $1`, [fb.id]);
      expect(await bothSeats()).toEqual({
        members_active: 1, seats_used: 0, seats_pending: 1, seats_suspended: 1, seat_limit: 3,
      });
    });

    it('past due past its grace period: companies falls back to the free plan, paying_employers keeps its row', async () => {
      const o = await world.employer({ companyName: 'Fixture Past Due Co' });
      const o2 = await orgOf(o);
      await world.foreman(o.id);
      await subscribe(o, 'employer_pro', 'past_due', new Date(Date.now() - 2 * 86_400_000).toISOString());

      const c = await company(o2);
      expect(c).toBeDefined();
      expect(c!.plan_code).toBe('employer_free');
      expect(c!.plan_status).toBeNull();
      expect(seats(c!)).toMatchObject({ seats_used: 1, seat_limit: 0 });

      const p = await payingRow(o2);
      expect(p).toBeDefined();
      expect(p!.plan_code).toBe('employer_pro');
      expect(p!.status).toBe('past_due');
      expect(seats(p!)).toMatchObject({ seats_used: 1, seat_limit: 3 });
    });

    it('past due within its grace period keeps the paid plan in companies', async () => {
      const o = await world.employer({ companyName: 'Fixture Grace Co' });
      const o2 = await orgOf(o);
      await subscribe(o, 'employer_pro', 'past_due', new Date(Date.now() + 2 * 86_400_000).toISOString());

      const c = await company(o2);
      expect(c!.plan_code).toBe('employer_pro');
      expect(c!.plan_status).toBe('past_due');
      expect(seats(c!).seat_limit).toBe(3);
    });

    it('a free one-person company: one active member, no seats, a limit of 0', async () => {
      const o = await world.employer({ companyName: 'Fixture Free Co' });
      const o2 = await orgOf(o);
      const c = await company(o2);
      expect(c).toBeDefined();
      expect(c!.organization_id).toBe(o2);
      expect(c!.owner_id).toBe(o.id);
      expect(c!.plan_code).toBe('employer_free');
      expect(c!.plan_status).toBeNull();
      expect(Number(c!.active_jobs)).toBe(0);
      const created = (await su.query<{ created_at: Date }>('SELECT created_at FROM users WHERE id = $1', [o.id])).rows[0];
      expect(new Date(c!.created_at).toISOString()).toBe(created.created_at.toISOString());
      expect(seats(c!)).toEqual({
        members_active: 1, seats_used: 0, seats_pending: 0, seats_suspended: 0, seat_limit: 0,
      });
      expect(await payingRow(o2)).toBeUndefined();
    });
  });

  // ── 4. Slowest employers ──────────────────────────────────────────

  describe('slowest employers are grouped by company', () => {
    it("an owner's and a foreman's jobs make one row keyed by the owner", async () => {
      const owner = await world.employer({ companyName: 'Fixture Slow Co' });
      const org = await orgOf(owner);
      const f = await world.foreman(owner.id);
      const j1 = await world.job(owner.id);
      const j2 = await world.job(f.id);
      await staleApplications(j1.id);
      await staleApplications(j2.id);
      ids.slowOwner = owner.id;
      ids.slowForeman = f.id;
      ids.slowOrg = org;

      const rows = await slowest();
      expect(rows.filter((r) => r.employer_id === f.id)).toEqual([]);
      const mine = rows.filter((r) => r.employer_id === owner.id);
      expect(mine).toHaveLength(1);
      expect(mine[0].organization_id).toBe(org);
      expect(Number(mine[0].applications)).toBe(6);
      expect(Number(mine[0].unanswered_7d)).toBe(6);
      expect(Number(mine[0].active_jobs)).toBe(2);
      expect(mine[0].display_name).toBe('Fixture Slow Co');
      expect(rows.filter((r) => r.organization_id === org)).toHaveLength(1);
    });

    it("a removed foreman's job stays with the company, with no row of its own", async () => {
      const owner = await world.employer({ companyName: 'Fixture Removed Co' });
      const org = await orgOf(owner);
      const removed = await world.foreman(owner.id, { status: 'removed' });
      const j = await world.job(removed.id, { status: 'closed' });
      await world.job(owner.id);
      await staleApplications(j.id);

      const rows = await slowest();
      expect(rows.filter((r) => r.employer_id === removed.id)).toEqual([]);
      const mine = rows.filter((r) => r.employer_id === owner.id);
      expect(mine).toHaveLength(1);
      expect(mine[0].organization_id).toBe(org);
      expect(Number(mine[0].applications)).toBe(3);
      expect(Number(mine[0].active_jobs)).toBe(1);
    });

    it('a memberless login is its own row, with no organization', async () => {
      const login = await memberless();
      const j = await world.job(login.id);
      await staleApplications(j.id);

      const mine = (await slowest()).filter((r) => r.employer_id === login.id);
      expect(mine).toHaveLength(1);
      expect(mine[0].organization_id).toBeNull();
      expect(Number(mine[0].applications)).toBe(3);
      expect(Number(mine[0].active_jobs)).toBe(1);
    });

    it("an owner-less company is keyed by the job's holder, with its organization; no row has a NULL employer_id", async () => {
      const owner = await world.employer({ companyName: 'Fixture Ownerless Co' });
      const org = await orgOf(owner);
      const f = await world.foreman(owner.id);
      const j = await world.job(f.id);
      await staleApplications(j.id);
      await su.query('DELETE FROM organization_members WHERE user_id = $1', [owner.id]);

      const rows = await slowest();
      const mine = rows.filter((r) => r.employer_id === f.id);
      expect(mine).toHaveLength(1);
      expect(mine[0].organization_id).toBe(org);
      expect(Number(mine[0].applications)).toBe(3);
      expect(rows.filter((r) => r.employer_id === null)).toEqual([]);
      // Not a company in the list either: it has no active owner.
      expect(await company(org)).toBeUndefined();
      expect((await consoleRows('SELECT organization_id FROM admin_analytics_companies(500)'))
        .filter((r) => r.organization_id === org)).toEqual([]);
    });

    it('the one-argument call still works and returns the contract columns', async () => {
      const { columns } = await asConsole('SELECT * FROM admin_analytics_slowest_employers(4)');
      expect(columns).toEqual(SLOWEST_COLUMNS);
    });
  });

  // ── 5. Test-account rule ──────────────────────────────────────────

  describe('the test-account rule follows the owner', () => {
    it("a real owner's test foreman still counts in the company's row", async () => {
      const owner = await world.employer({ companyName: 'Fixture Real Owner Co' });
      const org = await orgOf(owner);
      const tf = await world.foreman(owner.id, { email: `${randomUUID()}@jale.test` });
      const j = await world.job(tf.id);
      await staleApplications(j.id);

      const rows = await slowest();
      expect(rows.filter((r) => r.employer_id === tf.id)).toEqual([]);
      const mine = rows.filter((r) => r.employer_id === owner.id);
      expect(mine).toHaveLength(1);
      expect(mine[0].organization_id).toBe(org);
      expect(Number(mine[0].applications)).toBe(3);
      ids.realOwnerOrg = org;
      // Listed in the Companies list, the test foreman holding a seat.
      expect(await listedOrgs([org])).toEqual([org]);
      expect(seats((await company(org))!)).toMatchObject({ members_active: 2, seats_used: 1 });
    });

    it('a test owner hides the company from slowest and the Companies list, but not from its own page', async () => {
      const owner = await world.employer({ companyName: 'Fixture Test Owner Co' });
      const org = await orgOf(owner);
      await makeTestAccount(owner);
      const f = await world.foreman(owner.id);
      const j = await world.job(f.id);
      await staleApplications(j.id);

      const rows = await slowest();
      expect(rows.filter((r) => r.employer_id === owner.id || r.employer_id === f.id || r.organization_id === org))
        .toEqual([]);
      // One companies(500) result: the real-owner company (previous case) is
      // listed, so the test-owner company's absence is the filter, not the limit.
      expect(await listedOrgs([ids.realOwnerOrg, org])).toEqual([ids.realOwnerOrg]);
      const c = await company(org);
      expect(c).toBeDefined();
      expect(c!.owner_id).toBe(owner.id);
      expect(seats(c!)).toMatchObject({ members_active: 2, seats_used: 1 });
    });
  });

  // ── 5b. The Companies list: order and page bound ──────────────────

  it('orders the Companies list by seats held, then members, active jobs, newest owner; companies(n) returns n rows', async () => {
    // Free companies (seat limit 0; nothing enforces it on these rows):
    //   A: 3 active foremen                  seats 3, members 4
    //   B: 1 active foreman + 1 live invite  seats 2, members 2
    //   C: 2 live invites                    seats 2, members 1
    //   D: 2 active jobs                     seats 0, members 1, jobs 2
    //   E: 1 active job                      seats 0, members 1, jobs 1, owner created now
    //   F: 1 active job                      seats 0, members 1, jobs 1, owner created 400 days ago
    const make = async (name: string) => {
      const owner = await world.employer({ companyName: `Fixture Order ${name}` });
      return { owner, org: await orgOf(owner) };
    };
    // Made in reverse, so creation order never passes for the sort.
    const f = await make('F');
    const e = await make('E');
    const d = await make('D');
    const c = await make('C');
    const b = await make('B');
    const a = await make('A');
    for (let i = 0; i < 3; i++) await world.foreman(a.owner.id);
    await world.foreman(b.owner.id);
    await invite(b.org, b.owner, '7 days');
    await invite(c.org, c.owner, '7 days');
    await invite(c.org, c.owner, '7 days');
    await world.job(d.owner.id);
    await world.job(d.owner.id);
    await world.job(e.owner.id);
    await world.job(f.owner.id);
    await su.query(`UPDATE users SET created_at = now() - interval '400 days' WHERE id = $1`, [f.owner.id]);

    const orgs = [a.org, b.org, c.org, d.org, e.org, f.org];
    expect(await listedOrgs(orgs)).toEqual(orgs);
    expect(await consoleRows('SELECT * FROM admin_analytics_companies(2)')).toHaveLength(2);
    // The organization form ignores the page bound: F is found however far down it ranks.
    expect((await company(f.org))!.owner_id).toBe(f.owner.id);
  });

  // ── 6. Template reuse ─────────────────────────────────────────────

  it('an owner and a foreman each posting from a template are one company using templates', async () => {
    const owner = await world.employer({ companyName: 'Fixture Template Co' });
    const f = await world.foreman(owner.id);
    const t1 = await world.template(owner.id, 'Fixture owner template');
    const t2 = await world.template(f.id, 'Fixture foreman template');
    const before = await figures();
    const j1 = await world.job(owner.id);
    const j2 = await world.job(f.id);
    await su.query('UPDATE jobs SET created_from_template_id = $2 WHERE id = $1', [j1.id, t1]);
    await su.query('UPDATE jobs SET created_from_template_id = $2 WHERE id = $1', [j2.id, t2]);
    const after = await figures();

    expect(after.fromTemplate - before.fromTemplate).toBe(2);
    expect(after.templateCompanies - before.templateCompanies).toBe(1);
  });

  // ── 7. Company members ────────────────────────────────────────────

  describe('company_members', () => {
    let owner: UserFixture;
    let org: string;
    const who: Record<string, UserFixture> = {};

    beforeAll(async () => {
      owner = await world.employer({ companyName: 'Constructora Ñandú', fullName: 'Owner Cuenta Ocho', contactName: 'Ana Dueña' });
      org = await orgOf(owner);
      ids.membersOrg = org;
      // Real-looking emails everywhere: none may come back.
      await su.query('UPDATE users SET email = $2 WHERE id = $1', [owner.id, `ana.duena.${owner.id.slice(0, 8)}@example.com`]);
      const mail = (name: string) => `${name}.${randomUUID().slice(0, 8)}@example.com`;
      // Created in the reverse of the expected order, so insertion order never passes for it.
      who.removed = await world.foreman(owner.id, { status: 'removed', fullName: 'Ramón Removido', email: mail('ramon') });
      who.suspended = await world.foreman(owner.id, {
        status: 'suspended', billingSuspended: true, fullName: 'Susana Cuenta', contactName: '   ', email: mail('susana'),
      });
      who.activeLate = await world.foreman(owner.id, { fullName: 'beto cuenta', contactName: 'Beto Activo', email: mail('beto') });
      who.activeEarly = await world.foreman(owner.id, { fullName: 'Carla Cuenta', email: mail('carla') });
      const joined = async (u: UserFixture, days: number) => su.query(
        `UPDATE organization_members SET joined_at = now() - make_interval(days => $2) WHERE user_id = $1`, [u.id, days]);
      await joined(who.removed, 30);
      await joined(who.suspended, 10);
      await joined(who.activeEarly, 5);
      await joined(who.activeLate, 1);
      // Active jobs: the owner 1, Beto 2 (plus a closed one), Susana a paused one.
      await world.job(owner.id);
      await world.job(who.activeLate.id);
      await world.job(who.activeLate.id);
      await world.job(who.activeLate.id, { status: 'closed' });
      await world.job(who.suspended.id, { status: 'paused' });
    });

    it('lists every member, removed included: owner, active, suspended, removed, then by joined date', async () => {
      const rows = await consoleRows('SELECT * FROM admin_analytics_company_members($1)', [org]);
      expect(rows.map((r) => r.user_id)).toEqual([
        owner.id, who.activeEarly.id, who.activeLate.id, who.suspended.id, who.removed.id,
      ]);
      expect(rows.map((r) => [r.display_name, r.role, r.status, r.billing_suspended, Number(r.active_jobs)])).toEqual([
        ['Ana Dueña', 'owner', 'active', false, 1],
        ['Carla Cuenta', 'foreman', 'active', false, 0],
        ['Beto Activo', 'foreman', 'active', false, 2],
        ['Susana Cuenta', 'foreman', 'suspended', true, 0],
        ['Ramón Removido', 'foreman', 'removed', false, 0],
      ]);
      const stored = (await su.query<{ user_id: string; joined_at: Date; status_changed_at: Date }>(
        'SELECT user_id, joined_at, status_changed_at FROM organization_members WHERE organization_id = $1', [org])).rows;
      for (const r of rows) {
        const s = stored.find((x) => x.user_id === r.user_id)!;
        expect(new Date(r.joined_at).toISOString()).toBe(s.joined_at.toISOString());
        expect(new Date(r.status_changed_at).toISOString()).toBe(s.status_changed_at.toISOString());
      }
    });

    it('an owner with no employer_profiles row is named by the account name; a nameless member by nothing, never an email', async () => {
      const solo = await world.employer({ fullName: 'Solo Cuenta Fixture' });
      // A foreman with no contact name and no account name: the only text
      // left about them is their email, which must never stand in.
      const nameless = await world.foreman(solo.id, { email: `nadie.${randomUUID().slice(0, 8)}@example.com` });
      await su.query('UPDATE users SET full_name = NULL WHERE id = $1', [nameless.id]);
      const rows = await consoleRows('SELECT * FROM admin_analytics_company_members($1)', [await orgOf(solo)]);
      expect(rows.map((r) => [r.user_id, r.display_name, r.role])).toEqual([
        [solo.id, 'Solo Cuenta Fixture', 'owner'],
        [nameless.id, null, 'foreman'],
      ]);
      for (const r of rows) {
        for (const v of Object.values(r)) {
          expect(String(v instanceof Date ? v.toISOString() : v)).not.toContain('@');
        }
      }
    });

    it('keeps a non-ASCII company name unchanged through companies', async () => {
      const c = await company(org);
      expect(c!.display_name).toBe('Constructora Ñandú');
      expect(seats(c!)).toEqual({
        members_active: 3, seats_used: 2, seats_pending: 0, seats_suspended: 1, seat_limit: 0,
      });
      expect(Number(c!.active_jobs)).toBe(3);
    });

    it('returns exactly the contract columns, and no email in any value', async () => {
      const members = await asConsole('SELECT * FROM admin_analytics_company_members($1)', [org]);
      expect(members.columns).toEqual(MEMBERS_COLUMNS);
      const companies = await asConsole('SELECT * FROM admin_analytics_companies(1, $1)', [org]);
      expect(companies.columns).toEqual(COMPANIES_COLUMNS);
      for (const r of [...members.rows, ...companies.rows]) {
        for (const v of Object.values(r)) {
          expect(String(v instanceof Date ? v.toISOString() : v)).not.toContain('@');
        }
      }
      const paying = await asConsole('SELECT * FROM admin_analytics_paying_employers()');
      expect(paying.columns).toEqual(PAYING_COLUMNS);
    });
  });

  // ── 8. Read through 139's policies (the 088 defect) ───────────────

  const MEMBERS_139: [string, string] = ['organization_members_admin_analytics_read', 'organization_members'];
  const MEMBERS_LOOKUP_118: [string, string] = ['organization_members_name_lookup', 'organization_members'];

  /**
   * In one rolled-back superuser transaction: drop the given policies (each
   * [policy, table]), clear the name-lookup gate (which also opens
   * organization_members to jale_admin), and call as the console.
   */
  async function withoutPolicy<T>(policies: Array<[string, string]>, fn: (c: Client) => Promise<T>): Promise<T> {
    const c = new Client({ connectionString: databaseUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      try {
        for (const [policy, table] of policies) await c.query(`DROP POLICY ${policy} ON public.${table}`);
        await c.query(`SELECT set_config('app.employer_name_lookup', '', true)`);
        await c.query('SET LOCAL ROLE jale_admin_console');
        return await fn(c);
      } finally {
        await c.query('ROLLBACK');
      }
    } finally {
      await c.end();
    }
  }

  itInProfiles(['standard', 'request'], 'reads organization_members through organization_members_admin_analytics_read', async () => {
    // With the policy present the company is found (asserted above); without
    // it no member is visible to the definer, so neither the company nor the
    // grouping of a foreman's job under its owner survives.
    // Each call gets its own transaction: a display-name lookup inside one
    // call would leave the name-lookup gate on for the next. company_members
    // has its own proof below.
    expect(await company(ids.seatsOrg)).toBeDefined();
    expect((await slowest()).filter((r) => r.employer_id === ids.slowOwner && Number(r.applications) === 6)).toHaveLength(1);
    const companyRows = await withoutPolicy([MEMBERS_139], async (c) =>
      (await c.query('SELECT * FROM admin_analytics_companies(1, $1)', [ids.seatsOrg])).rows);
    expect(companyRows).toEqual([]);
    const slowestRows = await withoutPolicy([MEMBERS_139], async (c) =>
      (await c.query('SELECT * FROM admin_analytics_slowest_employers(4, 100)')).rows);
    expect(slowestRows.filter((r: Row) => r.employer_id === ids.slowOwner && Number(r.applications) === 6)).toEqual([]);
  });

  itInProfiles(['standard', 'request'], 'company_members reads its members through 139\'s policy, never only through the name gate', async () => {
    // company_members turns the name-lookup gate on for contact names, and
    // 118's organization_members_name_lookup then opens organization_members
    // to jale_admin as well. The member ids are read before that, so:
    //  - without 118's lookup policy, 139's policy alone lists every member;
    //  - without 139's policy, nothing is listed even though the gate opens;
    //  - without both, nothing is listed.
    const membersWithout = (policies: Array<[string, string]>) => withoutPolicy(policies, async (c) =>
      (await c.query('SELECT user_id FROM admin_analytics_company_members($1)', [ids.membersOrg])).rows
        .map((r: Row) => r.user_id as string));
    const all = (await consoleRows('SELECT user_id FROM admin_analytics_company_members($1)', [ids.membersOrg]))
      .map((r) => r.user_id as string);
    expect(all).toHaveLength(5);
    expect(await membersWithout([MEMBERS_LOOKUP_118])).toEqual(all);
    expect(await membersWithout([MEMBERS_139])).toEqual([]);
    expect(await membersWithout([MEMBERS_LOOKUP_118, MEMBERS_139])).toEqual([]);
  });

  itInProfiles(['standard', 'request'], 'reads organization_invites through organization_invites_admin_analytics_read', async () => {
    expect(seats((await company(ids.seatsOrg))!).seats_pending).toBe(1);
    const rows = await withoutPolicy([['organization_invites_admin_analytics_read', 'organization_invites']], async (c) => ({
      company: (await c.query('SELECT * FROM admin_analytics_companies(1, $1)', [ids.seatsOrg])).rows,
      paying: (await c.query('SELECT * FROM admin_analytics_paying_employers()')).rows
        .filter((r: Row) => r.organization_id === ids.seatsOrg),
    }));
    expect(rows.company).toHaveLength(1);
    expect(Number(rows.company[0].seats_pending)).toBe(0);
    expect(rows.paying).toHaveLength(1);
    expect(Number(rows.paying[0].seats_pending)).toBe(0);
  });

  // ── 9. Argument rejection ─────────────────────────────────────────

  it('rejects bad arguments with the analytics error codes', async () => {
    expect(await consoleError('SELECT * FROM admin_analytics_companies(0)')).toBe('admin_analytics_invalid_limit');
    expect(await consoleError('SELECT * FROM admin_analytics_companies(501)')).toBe('admin_analytics_invalid_limit');
    expect(await consoleError('SELECT * FROM admin_analytics_companies($1::integer)', [null])).toBe('admin_analytics_invalid_limit');
    // Ruling 3: the page bound is checked with an organization too.
    expect(await consoleError('SELECT * FROM admin_analytics_companies(0, $1)', [ids.seatsOrg])).toBe('admin_analytics_invalid_limit');
    expect(await consoleError('SELECT * FROM admin_analytics_companies($1::integer, $2)', [null, ids.seatsOrg]))
      .toBe('admin_analytics_invalid_limit');
    expect(await consoleError('SELECT * FROM admin_analytics_company_members($1::uuid)', [null]))
      .toBe('admin_analytics_invalid_organization');
    expect(await consoleError('SELECT * FROM admin_analytics_slowest_employers(4, 101)')).toBe('admin_analytics_invalid_limit');
    // The bounds themselves are accepted.
    expect(await consoleError('SELECT * FROM admin_analytics_companies(500)')).toBeNull();
    expect(await consoleError('SELECT * FROM admin_analytics_slowest_employers(4, 100)')).toBeNull();
  });
});
