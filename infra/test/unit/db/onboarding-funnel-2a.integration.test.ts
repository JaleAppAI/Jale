/**
 * onboarding-funnel-2a.integration.test.ts
 *
 * PostgreSQL-backed tests for migration 113 (roadmap 2a): weekly onboarding
 * cohorts by first-contact door, the stalled-run snapshot, and the verified
 * columns on admin_analytics_signups / admin_analytics_totals.
 *
 * The functions aggregate the whole database, so every assertion compares a
 * baseline call (before fixtures) with a call after them. Fixtures are
 * inserted as the superuser with session_replication_role = replica so no
 * trigger adds rows stamped now().
 *
 * Connection: set JALE_TEST_DATABASE_URL to a disposable Postgres 16 with the
 * full chain applied, as a superuser. When absent the suite is explicitly
 * skipped and says so (Rule 11: no silent skips).
 *   bash infra/db/local/bootstrap-testbed.sh --ephemeral --keep --no-tests --ref none
 *   then: cd infra && JALE_TEST_DATABASE_URL=<printed url> npx jest --runInBand test/unit/db/onboarding-funnel-2a.integration.test.ts
 *
 * Always pass --runInBand: the assertions are whole-database deltas, so
 * another suite inserting users in a parallel worker would break them.
 *
 * The launch-week fixtures (P0, P22, P23) assume no otp_verified / web_start
 * transition older than the 30-day marker below exists, which holds on a
 * fresh testbed.
 */

import { Client } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { hashNormalizedPhone } from '../../../lambda/whatsapp/lib/runtime-controls';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const OPERATOR = 'it-2a';

const COUNTERS = [
  'started', 'code_requested', 'verified', 'accepted_terms', 'finished_profile',
  'ready', 'declined', 'in_progress', 'abandoned',
] as const;
type Counter = (typeof COUNTERS)[number];
type Counts = Record<Counter, number>;

const zero = (): Counts => Object.fromEntries(COUNTERS.map((c) => [c, 0])) as Counts;

async function setServiceRolePasswords(superuserUrl: string): Promise<void> {
  const client = new Client({ connectionString: superuserUrl });
  await client.connect();
  try {
    await client.query(`ALTER ROLE jale_whatsapp WITH PASSWORD 'test-whatsapp-pw'`);
    await client.query(`ALTER ROLE jale_admin_console WITH PASSWORD 'test-adminconsole-pw'`);
  } finally {
    await client.end();
  }
}

function urlForRole(baseUrl: string, user: string, password: string): string {
  const u = new URL(baseUrl);
  u.username = user;
  u.password = password;
  return u.toString();
}

async function withClient<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Monday 00:00 UTC of the week containing `d` (Postgres date_trunc('week', d, 'UTC')). */
function isoWeekStart(d: Date): string {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  return new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY).toISOString();
}

/** A random +52 664 number; a hoisted declaration because describe bodies run at collection. */
function freshPhone(): string {
  return `+52664${String(1_000_000 + (randomBytes(3).readUIntBE(0, 3) % 9_000_000))}`;
}

async function cohortCounts(url: string, weeks = 4): Promise<Map<string, Counts>> {
  const rows = await withClient(url, async (c) =>
    (await c.query('SELECT * FROM admin_analytics_onboarding_cohorts($1)', [weeks])).rows);
  const byKey = new Map<string, Counts>();
  for (const r of rows) {
    const counts = zero();
    for (const k of COUNTERS) counts[k] = Number(r[k]);
    byKey.set(`${new Date(r.cohort_week).toISOString()}|${r.door}`, counts);
  }
  return byKey;
}

async function stalledCounts(url: string): Promise<Map<string, number>> {
  const rows = await withClient(url, async (c) =>
    (await c.query('SELECT * FROM admin_analytics_onboarding_stalled(7)')).rows);
  return new Map(rows.map((r) => [`${r.door}|${r.step_key}`, Number(r.workers)]));
}

const maybeDescribe = databaseUrl ? describe : describe.skip;
if (!databaseUrl) {
  // eslint-disable-next-line no-console
  console.warn('JALE_TEST_DATABASE_URL not set — skipping 2a onboarding funnel integration tests');
}

maybeDescribe('2a onboarding funnel (113)', () => {
  let superUrl = '';
  let consoleUrl = '';
  let whatsappUrl = '';
  const now = new Date();
  const ago = (ms: number): Date => new Date(now.getTime() - ms);
  const monday = new Date(isoWeekStart(now));
  const p0Start = ago(40 * DAY);
  const phones: string[] = [];

  let cohortsBefore = new Map<string, Counts>();
  let stalledBefore = new Map<string, number>();
  let signupsBefore = { workers: 0, verified: 0 };
  let totalsBefore = { workers: 0, verified: 0 };
  const expected = new Map<string, Counts>();

  /** Adds one person's expected contribution to its (week, door) key. */
  function expect1(door: 'whatsapp' | 'web', startedAt: Date, stages: Counter[]): void {
    const key = `${isoWeekStart(startedAt)}|${door}`;
    const counts = expected.get(key) ?? zero();
    counts.started += 1;
    for (const s of stages) counts[s] += 1;
    expected.set(key, counts);
  }

  async function signupSums(url: string): Promise<{ workers: number; verified: number }> {
    const rows = await withClient(url, async (c) =>
      (await c.query(`SELECT * FROM admin_analytics_signups(now() - interval '14 days', 'day')`)).rows);
    return {
      workers: rows.reduce((n, r) => n + Number(r.worker_signups), 0),
      verified: rows.reduce((n, r) => n + Number(r.worker_signups_verified), 0),
    };
  }

  async function totals(url: string): Promise<{ workers: number; verified: number }> {
    const row = await withClient(url, async (c) => (await c.query('SELECT * FROM admin_analytics_totals()')).rows[0]);
    return { workers: Number(row.total_workers), verified: Number(row.total_verified_workers) };
  }

  /** Runs `fn` in one superuser transaction with triggers suppressed. */
  async function seed(fn: (c: Client) => Promise<void>): Promise<void> {
    await withClient(superUrl, async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await fn(c);
      await c.query('COMMIT');
    });
  }

  const user = async (c: Client, createdAt: Date, phone: string | null = null): Promise<string> =>
    (await c.query(
      `INSERT INTO users (cognito_sub, user_type, phone, created_at, updated_at)
       VALUES ($1, 'worker', $2, $3, $3) RETURNING id`,
      [`${OPERATOR}-${randomBytes(6).toString('hex')}`, phone, createdAt],
    )).rows[0].id;

  const conversation = async (
    c: Client, phone: string, createdAt: Date, userId: string | null, updatedAt: Date = createdAt,
  ): Promise<void> => {
    phones.push(phone);
    await c.query(
      `INSERT INTO whatsapp_conversations (whatsapp_number, user_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4)`,
      [phone, userId, createdAt, updatedAt],
    );
  };

  const challenge = async (c: Client, phone: string, step: string, status: string, at: Date): Promise<void> => {
    await c.query(
      `INSERT INTO worker_identity_challenges (phone_hash, current_step_key, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4)`,
      [hashNormalizedPhone(phone), step, status, at],
    );
  };

  const run = async (c: Client, userId: string, step: string, status: string, createdAt: Date, updatedAt: Date): Promise<string> =>
    (await c.query(
      `INSERT INTO worker_workflow_runs (user_id, workflow_version, current_step_key, status, created_at, updated_at)
       VALUES ($1, 1, $2, $3, $4, $5) RETURNING id`,
      [userId, step, status, createdAt, updatedAt],
    )).rows[0].id;

  const transition = async (c: Client, runId: string, from: string | null, to: string, reason: string, at: Date): Promise<void> => {
    await c.query(
      `INSERT INTO worker_workflow_transitions (run_id, from_step_key, to_step_key, reason, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [runId, from, to, reason, at],
    );
  };

  const state = async (c: Client, userId: string, readyAt: Date | null): Promise<void> => {
    await c.query(
      `INSERT INTO worker_onboarding_state (user_id, lifecycle, ready_at) VALUES ($1, $2, $3)`,
      [userId, readyAt ? 'ready' : 'onboarding', readyAt],
    );
  };

  const reset = async (c: Client, userId: string, phoneHash: string, dryRun: boolean): Promise<void> => {
    await c.query(
      `INSERT INTO worker_reset_audit (user_id, phone_hash, operator, reason, dry_run)
       VALUES ($1, $2, $3, 'it-2a fixture', $4)`,
      [userId, phoneHash, OPERATOR, dryRun],
    );
  };

  beforeAll(async () => {
    superUrl = databaseUrl!;
    await setServiceRolePasswords(superUrl);
    consoleUrl = urlForRole(superUrl, 'jale_admin_console', 'test-adminconsole-pw');
    whatsappUrl = urlForRole(superUrl, 'jale_whatsapp', 'test-whatsapp-pw');

    // A stable launch marker BEFORE the baseline: an excluded (reset) account
    // whose web_start is 30 days old. The window's launch week then cannot
    // move between the baseline and the assertions.
    await seed(async (c) => {
      const u = await user(c, ago(30 * DAY));
      const r = await run(c, u, 'legal.review', 'completed', ago(30 * DAY), ago(30 * DAY));
      await transition(c, r, null, 'legal.review', 'web_start', ago(30 * DAY));
      await reset(c, u, hashNormalizedPhone(freshPhone()), false);
    });

    cohortsBefore = await cohortCounts(consoleUrl);
    stalledBefore = await stalledCounts(consoleUrl);
    signupsBefore = await signupSums(consoleUrl);
    totalsBefore = await totals(consoleUrl);

    // P5: web worker stuck in profile for 9 days -> abandoned, and stalled.
    const p5Start = ago(12 * DAY);
    await seed(async (c) => {
      const u = await user(c, p5Start);
      const r = await run(c, u, 'profile.location', 'active', p5Start, ago(9 * DAY));
      await transition(c, r, null, 'legal.review', 'web_start', p5Start);
      await transition(c, r, 'legal.review', 'profile.name', 'legal_accept', ago(11 * DAY));
      await transition(c, r, 'profile.name', 'profile.location', 'profile_name_set', ago(9 * DAY));
      await state(c, u, null);
    });
    expect1('web', p5Start, ['code_requested', 'verified', 'accepted_terms', 'abandoned']);

    // P1: WhatsApp worker who reached ready.
    const p1Start = ago(10 * DAY);
    await seed(async (c) => {
      const phone = freshPhone();
      const u = await user(c, new Date(p1Start.getTime() + 5 * MIN));
      await conversation(c, phone, p1Start, u);
      await challenge(c, phone, 'identity.verify_otp', 'verified', new Date(p1Start.getTime() + 5 * MIN));
      const r = await run(c, u, 'trust.question.3', 'completed', new Date(p1Start.getTime() + 5 * MIN), ago(9 * DAY));
      await transition(c, r, 'identity.verify_otp', 'legal.review', 'otp_verified', new Date(p1Start.getTime() + 5 * MIN));
      await transition(c, r, 'legal.review', 'profile.name', 'legal_accept', new Date(p1Start.getTime() + 10 * MIN));
      await transition(c, r, 'profile.availability', 'trust.question.1', 'profile_availability_set', new Date(p1Start.getTime() + 30 * MIN));
      await transition(c, r, 'trust.question.3', 'trust.question.3', 'onboarding_complete', ago(9 * DAY));
      await state(c, u, ago(9 * DAY));
    });
    expect1('whatsapp', p1Start, ['code_requested', 'verified', 'accepted_terms', 'finished_profile', 'ready']);

    // P2: WhatsApp contact who requested a code but never verified (10 days quiet).
    const p2Start = ago(10 * DAY);
    await seed(async (c) => {
      const phone = freshPhone();
      await conversation(c, phone, p2Start, null);
      await challenge(c, phone, 'identity.verify_otp', 'expired', p2Start);
    });
    expect1('whatsapp', p2Start, ['code_requested', 'abandoned']);

    // P3: WhatsApp contact still at the language step (2 days ago).
    const p3Start = ago(2 * DAY);
    await seed(async (c) => {
      const phone = freshPhone();
      await conversation(c, phone, p3Start, null);
      await challenge(c, phone, 'start.choose_language', 'pending', p3Start);
    });
    expect1('whatsapp', p3Start, ['in_progress']);

    // P4: web sign-up that never verified (10 days quiet).
    const p4Start = ago(10 * DAY);
    await seed(async (c) => { await user(c, p4Start); });
    expect1('web', p4Start, ['code_requested', 'abandoned']);

    // P6: WhatsApp worker who declined the terms.
    const p6Start = ago(3 * DAY);
    await seed(async (c) => {
      const phone = freshPhone();
      const u = await user(c, new Date(p6Start.getTime() + MIN));
      await conversation(c, phone, p6Start, u);
      await challenge(c, phone, 'identity.verify_otp', 'verified', new Date(p6Start.getTime() + MIN));
      const r = await run(c, u, 'legal.review', 'declined', new Date(p6Start.getTime() + MIN), new Date(p6Start.getTime() + 2 * MIN));
      await transition(c, r, 'identity.verify_otp', 'legal.review', 'otp_verified', new Date(p6Start.getTime() + MIN));
      await transition(c, r, 'legal.review', 'legal.review', 'legal_decline', new Date(p6Start.getTime() + 2 * MIN));
      await state(c, u, null);
    });
    expect1('whatsapp', p6Start, ['code_requested', 'verified', 'declined']);

    // P7: web sign-up who later messaged WhatsApp -> counted once, as web.
    const p7Start = ago(6 * DAY);
    await seed(async (c) => {
      const phone = freshPhone();
      const u = await user(c, p7Start);
      const r = await run(c, u, 'profile.name', 'active', p7Start, ago(5 * DAY));
      await transition(c, r, null, 'legal.review', 'web_start', p7Start);
      await transition(c, r, 'legal.review', 'profile.name', 'legal_accept', ago(5 * DAY));
      await conversation(c, phone, ago(5 * DAY), u);
      await state(c, u, null);
    });
    expect1('web', p7Start, ['code_requested', 'verified', 'accepted_terms', 'in_progress']);

    // P8: a reset phone (no account) -> excluded.
    await seed(async (c) => {
      const phone = freshPhone();
      await conversation(c, phone, ago(4 * DAY), null);
      await reset(c, randomUUID(), hashNormalizedPhone(phone), false);
    });

    // P9: a reset account -> excluded. P9b: a dry-run reset -> still counted.
    await seed(async (c) => {
      const u = await user(c, ago(4 * DAY));
      await reset(c, u, hashNormalizedPhone(freshPhone()), false);
    });
    const p9bStart = ago(4 * DAY);
    await seed(async (c) => {
      const u = await user(c, p9bStart);
      await reset(c, u, hashNormalizedPhone(freshPhone()), true);
    });
    expect1('web', p9bStart, ['code_requested', 'in_progress']);

    // P10: a 053 bypass account (ready with no real onboarding) -> excluded.
    await seed(async (c) => {
      const u = await user(c, ago(4 * DAY));
      const r = await run(c, u, 'legal.review', 'completed', ago(4 * DAY), ago(4 * DAY));
      await transition(c, r, null, 'legal.review', 'web_worker_bypass', ago(4 * DAY));
      await state(c, u, ago(4 * DAY));
    });

    // P11: WhatsApp worker progressing yesterday -> in progress, not stalled.
    const p11Start = ago(1 * DAY);
    await seed(async (c) => {
      const phone = freshPhone();
      const u = await user(c, new Date(p11Start.getTime() + MIN));
      await conversation(c, phone, p11Start, u);
      await challenge(c, phone, 'identity.verify_otp', 'verified', new Date(p11Start.getTime() + MIN));
      const r = await run(c, u, 'profile.trade', 'active', new Date(p11Start.getTime() + MIN), new Date(p11Start.getTime() + 20 * MIN));
      await transition(c, r, 'identity.verify_otp', 'legal.review', 'otp_verified', new Date(p11Start.getTime() + MIN));
      await transition(c, r, 'legal.review', 'profile.name', 'legal_accept', new Date(p11Start.getTime() + 5 * MIN));
      await transition(c, r, 'profile.location', 'profile.trade', 'profile_location_confirmed', new Date(p11Start.getTime() + 20 * MIN));
      await state(c, u, null);
    });
    expect1('whatsapp', p11Start, ['code_requested', 'verified', 'accepted_terms', 'in_progress']);

    // P12 / P13: the week edge. Monday 00:00:00.000 UTC belongs to the new
    // week, one second earlier to the previous one. Recent conversation
    // activity keeps both in progress whatever day the suite runs.
    await seed(async (c) => { await conversation(c, freshPhone(), monday, null, ago(DAY)); });
    expect1('whatsapp', monday, ['in_progress']);
    const p13Start = new Date(monday.getTime() - 1000);
    await seed(async (c) => { await conversation(c, freshPhone(), p13Start, null, ago(DAY)); });
    expect1('whatsapp', p13Start, ['in_progress']);

    // P0: a contact before the launch week -> never returned (see its test).
    await seed(async (c) => { await conversation(c, freshPhone(), p0Start, null); });

    // P14: WhatsApp worker stalled at Terms for 9 days -> whatsapp|legal.review.
    const p14Start = ago(9 * DAY);
    await seed(async (c) => {
      const phone = freshPhone();
      const verifiedAt = new Date(p14Start.getTime() + MIN);
      const u = await user(c, verifiedAt);
      await conversation(c, phone, p14Start, u);
      await challenge(c, phone, 'identity.verify_otp', 'verified', verifiedAt);
      const r = await run(c, u, 'legal.review', 'active', verifiedAt, verifiedAt);
      await transition(c, r, 'identity.verify_otp', 'legal.review', 'otp_verified', verifiedAt);
      await state(c, u, null);
    });
    expect1('whatsapp', p14Start, ['code_requested', 'verified', 'abandoned']);

    // P15: web run created and its Terms skipped in ONE transaction, so both
    // transitions share created_at -> still web|profile.name, never 'other'.
    const p15Start = ago(9 * DAY);
    await seed(async (c) => {
      const u = await user(c, p15Start);
      const r = await run(c, u, 'profile.name', 'active', p15Start, p15Start);
      await transition(c, r, null, 'legal.review', 'web_start', p15Start);
      await transition(c, r, 'legal.review', 'profile.name', 'legal_already_accepted', p15Start);
      await state(c, u, null);
    });
    expect1('web', p15Start, ['code_requested', 'verified', 'accepted_terms', 'abandoned']);

    // P16: an adopted run with no creating transition -> other|profile.name.
    const p16Start = ago(9 * DAY);
    await seed(async (c) => {
      const u = await user(c, p16Start);
      const r = await run(c, u, 'profile.name', 'active', p16Start, p16Start);
      await transition(c, r, 'legal.review', 'profile.name', `operator_repair: ${OPERATOR}`, p16Start);
      await state(c, u, null);
    });
    expect1('web', p16Start, ['code_requested', 'verified', 'accepted_terms', 'abandoned']);

    // P17: WhatsApp first (code never verified there), then a web sign-up
    // with the same phone -> ONE person, in the WhatsApp door.
    const p17Start = ago(5 * DAY);
    await seed(async (c) => {
      const phone = freshPhone();
      await conversation(c, phone, p17Start, null);
      await challenge(c, phone, 'identity.verify_otp', 'expired', p17Start);
      const u = await user(c, ago(4 * DAY), phone);
      const r = await run(c, u, 'profile.name', 'active', ago(4 * DAY), ago(4 * DAY));
      await transition(c, r, null, 'legal.review', 'web_start', ago(4 * DAY));
      await transition(c, r, 'legal.review', 'profile.name', 'legal_accept', new Date(ago(4 * DAY).getTime() + MIN));
      await state(c, u, null);
    });
    expect1('whatsapp', p17Start, ['code_requested', 'verified', 'accepted_terms', 'in_progress']);

    // P18: web sign-up first, then WhatsApp without verifying -> ONE person,
    // in the web door.
    const p18Start = ago(6 * DAY);
    await seed(async (c) => {
      const phone = freshPhone();
      await user(c, p18Start, phone);
      await conversation(c, phone, ago(5 * DAY), null);
      await challenge(c, phone, 'start.choose_language', 'pending', ago(5 * DAY));
    });
    expect1('web', p18Start, ['code_requested', 'in_progress']);

    // P19: like P3, plus a DRY-RUN reset row for the phone -> still counted
    // (only real resets exclude a phone).
    const p19Start = ago(2 * DAY);
    await seed(async (c) => {
      const phone = freshPhone();
      await conversation(c, phone, p19Start, null);
      await challenge(c, phone, 'start.choose_language', 'pending', p19Start);
      await reset(c, randomUUID(), hashNormalizedPhone(phone), true);
    });
    expect1('whatsapp', p19Start, ['in_progress']);

    // P20: worker B matches the phone only through users.phone (whatsapp_number
    // NULL) and is OLDER than the unlinked conversation; worker A matches
    // through whatsapp_number and is NEWER. The router prefers the
    // whatsapp_number match, so the conversation belongs to A (who is newer
    // than it): one WhatsApp person, and B stays a web person with no
    // conversation of its own. A NULL-first ordering would hand the
    // conversation to B and flip both counts.
    const p20BStart = ago(4 * DAY);
    const p20ConvStart = ago(3 * DAY);
    const p20AStart = new Date(p20ConvStart.getTime() + MIN);
    await seed(async (c) => {
      const phone = freshPhone();
      await user(c, p20BStart, phone);
      await conversation(c, phone, p20ConvStart, null);
      await c.query(
        `INSERT INTO users (cognito_sub, user_type, whatsapp_number, created_at, updated_at)
         VALUES ($1, 'worker', $2, $3, $3)`,
        [`${OPERATOR}-${randomBytes(6).toString('hex')}`, phone, p20AStart],
      );
    });
    expect1('whatsapp', p20ConvStart, ['in_progress']);
    expect1('web', p20BStart, ['code_requested', 'in_progress']);

    // P21: WhatsApp worker active and NOT ready, exactly at the finished-profile
    // threshold (furthest step trust.question.1). It progressed yesterday, so
    // it is in progress and not stalled.
    const p21Start = ago(2 * DAY);
    await seed(async (c) => {
      const phone = freshPhone();
      const u = await user(c, new Date(p21Start.getTime() + MIN));
      await conversation(c, phone, p21Start, u);
      await challenge(c, phone, 'identity.verify_otp', 'verified', new Date(p21Start.getTime() + MIN));
      const r = await run(c, u, 'trust.question.1', 'active', new Date(p21Start.getTime() + MIN), ago(1 * DAY));
      await transition(c, r, 'identity.verify_otp', 'legal.review', 'otp_verified', new Date(p21Start.getTime() + MIN));
      await transition(c, r, 'legal.review', 'profile.name', 'legal_accept', new Date(p21Start.getTime() + 5 * MIN));
      await transition(c, r, 'profile.availability', 'trust.question.1', 'profile_availability_set', ago(1 * DAY));
      await state(c, u, null);
    });
    expect1('whatsapp', p21Start, ['code_requested', 'verified', 'accepted_terms', 'finished_profile', 'in_progress']);

    // P22: a returning pre-v2 contact who onboards on WhatsApp after launch. A
    // number keeps one conversation row forever, so this one (40 days old,
    // before the launch week) is now linked to the new account. Its start is
    // the first challenge since the launch week, not the old row's created_at.
    // Five quiet days: in progress, under the 7-day stalled cut.
    const p22Start = ago(5 * DAY);
    await seed(async (c) => {
      const phone = freshPhone();
      const u = await user(c, new Date(p22Start.getTime() + MIN));
      await conversation(c, phone, ago(40 * DAY), u, new Date(p22Start.getTime() + MIN));
      await challenge(c, phone, 'identity.verify_otp', 'verified', p22Start);
      const r = await run(c, u, 'legal.review', 'active', new Date(p22Start.getTime() + MIN), new Date(p22Start.getTime() + MIN));
      await transition(c, r, 'identity.verify_otp', 'legal.review', 'otp_verified', new Date(p22Start.getTime() + MIN));
      await state(c, u, null);
    });
    expect1('whatsapp', p22Start, ['code_requested', 'verified', 'in_progress']);

    // P23: a web sign-up whose phone matches a pre-v2 orphan conversation (40
    // days old, never linked, no challenge since the launch). That contact
    // never entered the funnel, so it must not hide the web sign-up.
    const p23Start = ago(6 * DAY);
    await seed(async (c) => {
      const phone = freshPhone();
      await conversation(c, phone, ago(40 * DAY), null);
      await user(c, p23Start, phone);
    });
    expect1('web', p23Start, ['code_requested', 'in_progress']);
  }, 120_000);

  afterAll(async () => {
    if (!databaseUrl) return;
    await withClient(superUrl, async (su) => {
      await su.query(`DELETE FROM whatsapp_conversations WHERE whatsapp_number = ANY($1::text[])`, [phones]);
      await su.query(`DELETE FROM worker_identity_challenges WHERE phone_hash = ANY($1::text[])`, [phones.map(hashNormalizedPhone)]);
      await su.query(`DELETE FROM worker_reset_audit WHERE operator = $1`, [OPERATOR]);
      await su.query(`DELETE FROM users WHERE cognito_sub LIKE $1`, [`${OPERATOR}-%`]);
    });
  }, 60_000);

  it('counts every fixture in its first-contact week and door, and nothing else', async () => {
    const after = await cohortCounts(consoleUrl);
    const keys = new Set([...cohortsBefore.keys(), ...after.keys(), ...expected.keys()]);
    for (const key of keys) {
      const before = cohortsBefore.get(key) ?? zero();
      const now2 = after.get(key) ?? zero();
      const delta = Object.fromEntries(COUNTERS.map((c) => [c, now2[c] - before[c]]));
      expect({ key, delta }).toEqual({ key, delta: expected.get(key) ?? zero() });
    }
  });

  it('keeps every row consistent: outcomes sum to started, stages never grow', async () => {
    const after = await cohortCounts(consoleUrl);
    expect(after.size).toBeGreaterThan(0);
    for (const [key, r] of after) {
      expect({ key, sum: r.ready + r.declined + r.in_progress + r.abandoned }).toEqual({ key, sum: r.started });
      expect(r.code_requested).toBeLessThanOrEqual(r.started);
      expect(r.verified).toBeLessThanOrEqual(r.code_requested);
      expect(r.accepted_terms).toBeLessThanOrEqual(r.verified);
      expect(r.finished_profile).toBeLessThanOrEqual(r.accepted_terms);
      expect(r.ready).toBeLessThanOrEqual(r.finished_profile);
    }
  });

  it('groups stalled runs by the door that created them and their step', async () => {
    const expectedStalled = new Map([
      ['web|profile.location', 1], // P5
      ['whatsapp|legal.review', 1], // P14
      ['web|profile.name', 1], // P15: same-timestamp creation and Terms skip
      ['other|profile.name', 1], // P16: no creating transition
    ]);
    const after = await stalledCounts(consoleUrl);
    const keys = new Set([...stalledBefore.keys(), ...after.keys(), ...expectedStalled.keys()]);
    for (const key of keys) {
      const delta = (after.get(key) ?? 0) - (stalledBefore.get(key) ?? 0);
      expect({ key, delta }).toEqual({ key, delta: expectedStalled.get(key) ?? 0 });
    }
  });

  it('never returns weeks before the funnel launched', async () => {
    const preLaunchWeek = isoWeekStart(p0Start);
    const after = await cohortCounts(consoleUrl, 12);
    expect([...after.keys()].filter((key) => key.startsWith(preLaunchWeek))).toEqual([]);
  });

  it('reads through the gate: the funnel is not silently empty (the 088 defect)', async () => {
    const after = await cohortCounts(consoleUrl);
    const p1Key = [...expected.keys()].find((key) => (expected.get(key)?.ready ?? 0) > 0)!;
    expect(after.get(p1Key)?.ready ?? 0).toBeGreaterThan(0);
  });

  it('adds verified columns to signups and totals', async () => {
    // Accounts created by the fixtures after the baseline: P1 P4 P5 P6 P7 P9
    // P9b P10 P11 P14 P15 P16 P17 P18 P20a P20b P21 P22 P23 = 19; with a run:
    // P1 P5 P6 P7 P10 P11 P14 P15 P16 P17 P21 P22 = 12 (signups and totals are
    // not funnel-filtered; the launch marker is older than the window and
    // already in the baseline).
    const signups = await signupSums(consoleUrl);
    expect(signups.workers - signupsBefore.workers).toBe(19);
    expect(signups.verified - signupsBefore.verified).toBe(12);
    const t = await totals(consoleUrl);
    expect(t.workers - totalsBefore.workers).toBe(19);
    expect(t.verified - totalsBefore.verified).toBe(12);
  });

  it('rejects out-of-range windows', async () => {
    for (const weeks of [0, 27]) {
      await expect(withClient(consoleUrl, (c) => c.query('SELECT * FROM admin_analytics_onboarding_cohorts($1)', [weeks])))
        .rejects.toThrow(/admin_analytics_invalid_weeks/);
    }
    for (const days of [0, 91]) {
      await expect(withClient(consoleUrl, (c) => c.query('SELECT * FROM admin_analytics_onboarding_stalled($1)', [days])))
        .rejects.toThrow(/admin_analytics_invalid_days/);
    }
  });

  it('is callable by the console role only, including the two recreated functions', async () => {
    for (const sql of [
      'SELECT * FROM admin_analytics_onboarding_cohorts(4)',
      'SELECT * FROM admin_analytics_onboarding_stalled(7)',
      `SELECT * FROM admin_analytics_signups(now(), 'day')`,
      'SELECT * FROM admin_analytics_totals()',
    ]) {
      await expect(withClient(whatsappUrl, (c) => c.query(sql))).rejects.toThrow(/permission denied/);
    }
  });
});
