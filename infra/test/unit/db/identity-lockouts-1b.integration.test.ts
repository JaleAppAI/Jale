/**
 * identity-lockouts-1b.integration.test.ts
 *
 * PostgreSQL-backed tests for admin_identity_lockouts (migration 102, roadmap
 * 1b): which challenges are listed (lockouts in the window from 101's history,
 * workers stuck at the code step), what happened next, the masked phone, the
 * window bounds, and who may call it.
 *
 * Fixtures are inserted as the superuser with session_replication_role =
 * replica so 101's capture triggers do not add history rows stamped now();
 * each fixture writes exactly the history it needs.
 *
 * Connection: set JALE_TEST_DATABASE_URL to a disposable Postgres 16 with the
 * full chain applied, as a superuser. When absent the suite is explicitly
 * skipped and says so (Rule 11: no silent skips).
 *   bash infra/db/local/bootstrap-testbed.sh --ephemeral --ref none -- \
 *     sh -c 'cd infra && npx jest test/unit/db/identity-lockouts-1b.integration.test.ts'
 */

import { Client } from 'pg';
import { randomBytes } from 'node:crypto';
import { hashNormalizedPhone } from '../../../lambda/whatsapp/lib/runtime-controls';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

async function setServiceRolePasswords(superuserUrl: string): Promise<void> {
  const client = new Client({ connectionString: superuserUrl });
  await client.connect();
  try {
    await client.query(`ALTER ROLE jale_billing WITH PASSWORD 'test-billing-pw'`);
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

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number): string => new Date(Date.now() + ms).toISOString();

/**
 * A random +52 664 number (unique per run), its console-masked form, and the
 * hash the Lambdas store (hashNormalizedPhone = sha256(trim(number)) hex).
 * A hoisted function declaration: describe callbacks run at collection time.
 */
function freshNumber(): { number: string; masked: string; hash: string } {
  const tail = String(1_000_000 + (randomBytes(3).readUIntBE(0, 3) % 9_000_000));
  const number = `+52664${tail}`;
  return {
    number,
    masked: `+52 664 *** ${tail.slice(-4)}`,
    hash: hashNormalizedPhone(number),
  };
}

type Fixture = {
  status: 'pending' | 'verified' | 'expired' | 'locked' | 'superseded';
  attempts?: number;
  lockedUntil?: string | null;
  expiresAt?: string | null;
  updatedAt: string;
  lockEvents?: string[];
  withConversation?: boolean;
  samePhoneAs?: Inserted;
  currentStep?: 'start.choose_language' | 'identity.verify_otp';
};

type Inserted = { id: string; number: string; masked: string; hash: string };

const LIST_COLUMNS = [
  'attempts', 'challenge_id', 'kind', 'last_event_at', 'locked_until',
  'lockout_count', 'masked_phone', 'outcome', 'started_at',
];

const maybeDescribe = databaseUrl ? describe : describe.skip;
if (!databaseUrl) {
  // eslint-disable-next-line no-console
  console.warn('JALE_TEST_DATABASE_URL not set — skipping 1b identity lockout integration tests');
}

maybeDescribe('1b admin_identity_lockouts (102)', () => {
  let superUrl = '';
  let consoleUrl = '';
  let whatsappUrl = '';
  let billingUrl = '';
  const inserted: Inserted[] = [];

  async function insertChallenge(f: Fixture): Promise<Inserted> {
    const n = f.samePhoneAs
      ? { number: f.samePhoneAs.number, masked: f.samePhoneAs.masked, hash: f.samePhoneAs.hash }
      : freshNumber();
    const id = await withClient(superUrl, async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      const { rows } = await c.query(
        `INSERT INTO worker_identity_challenges
           (phone_hash, current_step_key, status, attempts, locked_until, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         RETURNING id`,
        [n.hash, f.currentStep ?? 'identity.verify_otp', f.status, f.attempts ?? 0, f.lockedUntil ?? null, f.expiresAt ?? null, f.updatedAt],
      );
      for (const at of f.lockEvents ?? []) {
        await c.query(
          `INSERT INTO worker_identity_challenge_events
             (challenge_id, from_status, to_status, attempts, locked_until, changed_at)
           VALUES ($1, 'pending', 'locked', 2, $2::timestamptz + interval '15 minutes', $2::timestamptz)`,
          [rows[0].id, at],
        );
      }
      if (!f.samePhoneAs && f.withConversation !== false) {
        await c.query(`INSERT INTO whatsapp_conversations (whatsapp_number) VALUES ($1)`, [n.number]);
      }
      await c.query('COMMIT');
      return rows[0].id as string;
    });
    const row = { id, ...n };
    inserted.push(row);
    return row;
  }

  const list = (url: string, days = 7): Promise<any[]> =>
    withClient(url, async (c) => (await c.query('SELECT * FROM admin_identity_lockouts($1)', [days])).rows);

  const byId = (rows: any[], id: string): any => rows.find((r) => r.challenge_id === id);

  let stillLocked: Inserted;
  let lockExpired: Inserted;
  let retrying: Inserted;
  let verified: Inserted;
  let superseded: Inserted;
  let stuck: Inserted;
  let freshCode: Inserted;
  let oldLockout: Inserted;
  let noConversation: Inserted;
  let stuckThenReissued: Inserted;
  let expiredStuck: Inserted;
  let lockedThenVerified: Inserted;
  let lockedThenRetrying: Inserted;
  let lockedThenRetryingNewer: Inserted;
  let retryingLockEvents: string[];
  let resendThenAbandoned: Inserted;
  let expiredThenRestarted: Inserted;
  let restartedRow: Inserted;
  let lockedThenRestarted: Inserted;
  let staleStuck: Inserted;
  let wrongStep: Inserted;

  beforeAll(async () => {
    superUrl = databaseUrl!;
    await setServiceRolePasswords(superUrl);
    consoleUrl = urlForRole(superUrl, 'jale_admin_console', 'test-adminconsole-pw');
    whatsappUrl = urlForRole(superUrl, 'jale_whatsapp', 'test-whatsapp-pw');
    billingUrl = urlForRole(superUrl, 'jale_billing', 'test-billing-pw');

    retryingLockEvents = [ago(DAY), ago(2 * DAY)];
    stillLocked = await insertChallenge({
      status: 'locked', attempts: 2, lockedUntil: ahead(10 * MIN), updatedAt: ago(5 * MIN), lockEvents: [ago(5 * MIN)],
    });
    lockExpired = await insertChallenge({
      status: 'locked', attempts: 2, lockedUntil: ago(2 * HOUR), updatedAt: ago(2 * HOUR + 15 * MIN),
      lockEvents: [ago(2 * HOUR + 15 * MIN)],
    });
    retrying = await insertChallenge({
      status: 'pending', attempts: 0, expiresAt: ahead(4 * MIN), updatedAt: ago(MIN), lockEvents: retryingLockEvents,
    });
    verified = await insertChallenge({ status: 'verified', updatedAt: ago(HOUR), lockEvents: [ago(3 * HOUR)] });
    superseded = await insertChallenge({ status: 'superseded', updatedAt: ago(HOUR), lockEvents: [ago(HOUR)] });
    stuck = await insertChallenge({ status: 'pending', expiresAt: ago(2 * HOUR), updatedAt: ago(2 * HOUR + 5 * MIN) });
    freshCode = await insertChallenge({ status: 'pending', expiresAt: ago(30 * MIN), updatedAt: ago(35 * MIN) });
    oldLockout = await insertChallenge({
      status: 'pending', expiresAt: ago(8 * DAY), updatedAt: ago(8 * DAY), lockEvents: [ago(8 * DAY)],
    });
    noConversation = await insertChallenge({
      status: 'locked', attempts: 2, lockedUntil: ahead(10 * MIN), updatedAt: ago(MIN), lockEvents: [ago(MIN)],
      withConversation: false,
    });

    // Code expired, then the worker asked again and verified on a NEW challenge.
    stuckThenReissued = await insertChallenge({ status: 'expired', expiresAt: ago(3 * HOUR), updatedAt: ago(3 * HOUR) });
    await insertChallenge({ samePhoneAs: stuckThenReissued, status: 'verified', updatedAt: ago(2 * HOUR) });
    // An 'expired' (not 'pending') challenge with no newer one is still stuck.
    expiredStuck = await insertChallenge({ status: 'expired', expiresAt: ago(2 * HOUR), updatedAt: ago(2 * HOUR) });
    // Locked, then verified on a NEW challenge after the lock ran out.
    lockedThenVerified = await insertChallenge({
      status: 'locked', attempts: 2, lockedUntil: ago(3 * HOUR), updatedAt: ago(3 * HOUR + 15 * MIN),
      lockEvents: [ago(3 * HOUR + 15 * MIN)],
    });
    await insertChallenge({ samePhoneAs: lockedThenVerified, status: 'verified', updatedAt: ago(2 * HOUR) });
    // Locked, then asked for a NEW code (fresh, not yet verified).
    lockedThenRetrying = await insertChallenge({
      status: 'locked', attempts: 2, lockedUntil: ago(3 * HOUR), updatedAt: ago(3 * HOUR + 15 * MIN),
      lockEvents: [ago(3 * HOUR + 15 * MIN)],
    });
    lockedThenRetryingNewer = await insertChallenge({
      samePhoneAs: lockedThenRetrying, status: 'pending', expiresAt: ahead(4 * MIN), updatedAt: ago(MIN),
    });

    // (a) Locked, re-sent on the SAME row, then abandoned: the code expired unused.
    resendThenAbandoned = await insertChallenge({
      status: 'pending', attempts: 0, expiresAt: ago(2 * HOUR), updatedAt: ago(2 * HOUR),
      lockEvents: [ago(2 * HOUR + 20 * MIN)],
    });
    // (b) Code expired; the next message opened a NEW row parked at the language step.
    expiredThenRestarted = await insertChallenge({ status: 'expired', expiresAt: ago(3 * HOUR), updatedAt: ago(3 * HOUR) });
    restartedRow = await insertChallenge({
      samePhoneAs: expiredThenRestarted, status: 'pending', currentStep: 'start.choose_language', updatedAt: ago(170 * MIN),
    });
    // (b) Locked, lock ran out, the next message opened a NEW row parked at the language step.
    lockedThenRestarted = await insertChallenge({
      status: 'locked', attempts: 2, lockedUntil: ago(3 * HOUR), updatedAt: ago(3 * HOUR + 15 * MIN),
      lockEvents: [ago(3 * HOUR + 15 * MIN)],
    });
    await insertChallenge({
      samePhoneAs: lockedThenRestarted, status: 'pending', currentStep: 'start.choose_language', updatedAt: ago(2 * HOUR),
    });
    // Stuck, but older than the 7-day window.
    staleStuck = await insertChallenge({ status: 'pending', expiresAt: ago(8 * DAY), updatedAt: ago(8 * DAY) });
    // Not at the code step: never stuck.
    wrongStep = await insertChallenge({ status: 'pending', currentStep: 'start.choose_language', updatedAt: ago(2 * HOUR) });
  }, 60_000);

  afterAll(async () => {
    if (!databaseUrl) return;
    await withClient(superUrl, async (su) => {
      await su.query(`DELETE FROM worker_identity_challenges WHERE id = ANY($1::uuid[])`, [inserted.map((r) => r.id)]);
      await su.query(`DELETE FROM whatsapp_conversations WHERE whatsapp_number = ANY($1::text[])`, [inserted.map((r) => r.number)]);
    });
  }, 60_000);

  it('returns exactly the nine list columns', async () => {
    const rows = await list(consoleUrl);
    expect(rows.length).toBeGreaterThan(0);
    expect(Object.keys(rows[0]).sort()).toEqual(LIST_COLUMNS);
  });

  it('classifies each challenge and reports what happened next', async () => {
    const rows = await list(consoleUrl);
    expect(byId(rows, stillLocked.id)).toMatchObject({ kind: 'lockout', outcome: 'locked', lockout_count: 1, attempts: 2 });
    expect(byId(rows, stillLocked.id).locked_until).not.toBeNull();
    expect(byId(rows, lockExpired.id)).toMatchObject({ kind: 'lockout', outcome: 'lock_expired' });
    expect(byId(rows, retrying.id)).toMatchObject({ kind: 'lockout', outcome: 'retrying', lockout_count: 2, attempts: 0 });
    expect(new Date(byId(rows, retrying.id).last_event_at).toISOString()).toBe(retryingLockEvents[0]);
    expect(byId(rows, verified.id)).toMatchObject({ kind: 'lockout', outcome: 'verified' });
    expect(byId(rows, superseded.id)).toMatchObject({ kind: 'lockout', outcome: 'superseded' });
    expect(byId(rows, stuck.id)).toMatchObject({ kind: 'stuck', outcome: 'code_expired', lockout_count: 0 });
  });

  it('leaves out a code that expired under an hour ago', async () => {
    expect(byId(await list(consoleUrl), freshCode.id)).toBeUndefined();
  });

  it('reads what happened next from newer challenges for the same phone', async () => {
    const rows = await list(consoleUrl);
    // Reissued and verified: no longer stuck.
    expect(byId(rows, stuckThenReissued.id)).toBeUndefined();
    // 'expired' with nothing newer is stuck.
    expect(byId(rows, expiredStuck.id)).toMatchObject({ kind: 'stuck', outcome: 'code_expired' });
    // The lock ran out and the worker verified on a new challenge.
    expect(byId(rows, lockedThenVerified.id)).toMatchObject({ kind: 'lockout', outcome: 'verified' });
    // The lock ran out and the worker asked for a new code (not yet verified).
    expect(byId(rows, lockedThenRetrying.id)).toMatchObject({ kind: 'lockout', outcome: 'retrying' });
    // The fresh newer challenge is neither a lockout nor stuck.
    expect(byId(rows, lockedThenRetryingNewer.id)).toBeUndefined();
  });

  it('treats only code-step rows as progress and only recent codes as retrying', async () => {
    const rows = await list(consoleUrl);
    // (a) Re-sent on the same row and abandoned.
    expect(byId(rows, resendThenAbandoned.id)).toMatchObject({ kind: 'lockout', outcome: 'code_expired' });
    // (b) A newer row parked at the language step is not progress.
    expect(byId(rows, expiredThenRestarted.id)).toMatchObject({ kind: 'stuck', outcome: 'code_expired' });
    expect(byId(rows, restartedRow.id)).toBeUndefined();
    expect(byId(rows, lockedThenRestarted.id)).toMatchObject({ kind: 'lockout', outcome: 'lock_expired' });
    // Window and step bounds for stuck rows.
    expect(byId(rows, staleStuck.id)).toBeUndefined();
    expect(byId(await list(consoleUrl, 30), staleStuck.id)).toMatchObject({ kind: 'stuck', outcome: 'code_expired' });
    expect(byId(rows, wrongStep.id)).toBeUndefined();
  });

  it('bounds the window: an 8-day-old lockout appears at 30 days, not at 7', async () => {
    expect(byId(await list(consoleUrl, 7), oldLockout.id)).toBeUndefined();
    expect(byId(await list(consoleUrl, 30), oldLockout.id)).toMatchObject({ kind: 'lockout', outcome: 'code_expired' });
  });

  it('rejects a window outside 1–30 days', async () => {
    await expect(list(consoleUrl, 0)).rejects.toThrow(/admin_identity_lockouts_invalid_days/);
    await expect(list(consoleUrl, 31)).rejects.toThrow(/admin_identity_lockouts_invalid_days/);
  });

  it('lists lockouts before stuck rows', async () => {
    const kinds = (await list(consoleUrl)).map((r) => r.kind);
    expect(kinds.lastIndexOf('lockout')).toBeLessThan(kinds.indexOf('stuck'));
  });

  it('masks the phone from the matching conversation, and returns NULL without one', async () => {
    const rows = await list(consoleUrl);
    expect(byId(rows, stillLocked.id).masked_phone).toBe(stillLocked.masked);
    expect(byId(rows, noConversation.id).masked_phone).toBeNull();
    for (const r of rows) {
      expect(String(r.masked_phone ?? '')).not.toMatch(/\d{5,}/);
    }
  });

  it('still resolves the phone when whatsapp_conversations is FORCE RLS', async () => {
    const rows = await withClient(superUrl, async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('ALTER TABLE whatsapp_conversations FORCE ROW LEVEL SECURITY');
        await c.query('SET LOCAL ROLE jale_admin_console');
        return (await c.query('SELECT * FROM admin_identity_lockouts(7)')).rows;
      } finally {
        await c.query('ROLLBACK');
      }
    });
    expect(byId(rows, stillLocked.id).masked_phone).toBe(stillLocked.masked);
  });

  it('is callable by the console role only', async () => {
    await expect(list(whatsappUrl)).rejects.toThrow(/permission denied/);
    await expect(list(billingUrl)).rejects.toThrow(/permission denied/);
    await expect(withClient(consoleUrl, (c) => c.query(`SELECT public.admin_mask_phone('+526641234567')`)))
      .rejects.toThrow(/permission denied/);
  });

  it('reads through the gate: fixtures produce rows of both kinds (guards the 088 zeros defect)', async () => {
    const rows = await list(consoleUrl);
    const mine = rows.filter((r) => inserted.some((i) => i.id === r.challenge_id));
    expect(mine.filter((r) => r.kind === 'lockout').length).toBeGreaterThanOrEqual(10);
    expect(mine.filter((r) => r.kind === 'stuck').length).toBeGreaterThanOrEqual(3);
  });
});
