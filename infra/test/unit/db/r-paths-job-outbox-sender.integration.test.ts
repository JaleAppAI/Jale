/**
 * r-paths-job-outbox-sender.integration.test.ts
 *
 * The employer-message sender, sendPendingJobMessageOutbox (lib/job-messaging.ts),
 * runs under two logins: jale_api inside the employer conversation endpoints,
 * and jale_whatsapp in the WhatsApp processor and the outbox sweeper. On a
 * real PostgreSQL 16 bed, against seeded data, this suite proves that each
 * caller flushes only its own rows:
 *
 *   - jale_api: an employer flushing one conversation sends that
 *     conversation's rows only; without a conversation id the flush is still
 *     confined to the employer's own conversations.
 *   - jale_whatsapp: a worker flush sends that worker's rows across
 *     employers and nothing of another worker's; the sweeper does the same per
 *     stale worker.
 *   - owner-unrestricted: the explicit caller predicate in the sender's SQL
 *     confines the flush. This half is the load-bearing one for the
 *     predicate; elsewhere the worker and employer policies are defence in
 *     depth.
 *   - the flush leaves the client idle with no caller context behind it.
 *
 * Twilio is replaced by a recorder; the database is real.
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { World } from './r-paths-world';
import { currentDbProfile, describeInProfiles, loginPool } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

const sent: Array<{ to: string; body: string | null }> = [];
/** Runs once, inside the next send, before that send returns: another flush overlapping it. */
let mockDuringNextSend: (() => Promise<void>) | undefined;
jest.mock('../../../lambda/whatsapp/lib/outbox', () => {
  const actual = jest.requireActual('../../../lambda/whatsapp/lib/outbox');
  return {
    ...actual,
    sendTwilioWhatsAppMessage: jest.fn(async (to: string, row: { body: string | null }) => {
      sent.push({ to, body: row.body });
      const during = mockDuringNextSend;
      mockDuringNextSend = undefined;
      if (during) await during();
      return `fake-sid-${randomUUID()}`;
    }),
  };
});

let sweeperPool: Pool | undefined;
jest.mock('../../../lambda/lib/db', () => {
  const actual = jest.requireActual('../../../lambda/lib/db');
  return { ...actual, getDbPool: async () => sweeperPool };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sendPendingJobMessageOutbox } = require('../../../lambda/lib/job-messaging');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler: sweeperHandler } = require('../../../lambda/whatsapp/job-message-outbox-sweeper');

/** Calls the sender with whatever options shape the code under test takes. */
async function flush(client: PoolClient, options: Record<string, unknown>): Promise<void> {
  await (sendPendingJobMessageOutbox as (c: PoolClient, o: Record<string, unknown>) => Promise<void>)(client, options);
}

if (!databaseUrl) {
  test('CONCERN: the job outbox sender DB suite was not run (JALE_TEST_DATABASE_URL unset)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}

interface Scene {
  world: World;
  employerA: string;
  employerB: string;
  worker1: string;
  worker2: string;
  /** conversation (employer A, worker 1) */
  convA1: string;
  /** conversation (employer A, worker 2) */
  convA2: string;
  /** conversation (employer B, worker 1) */
  convB1: string;
  outbox: Record<'A1' | 'A2' | 'B1', string>;
  messages: Record<'A1' | 'A2' | 'B1', string>;
}

async function scene(options: { stale?: boolean } = {}): Promise<Scene> {
  const world = new World(databaseUrl!);
  await world.connect();
  const employerA = (await world.employer({ companyName: 'Fixture Co A' })).id;
  const employerB = (await world.employer({ companyName: 'Fixture Co B' })).id;
  const w1 = await world.worker();
  const w2 = await world.worker();
  const jobA = (await world.job(employerA)).id;
  const jobB = (await world.job(employerB)).id;
  const appA1 = await world.application(jobA, w1.id);
  const appA2 = await world.application(jobA, w2.id);
  const appB1 = await world.application(jobB, w1.id);
  const convA1 = await world.conversation({ jobId: jobA, employerId: employerA, workerId: w1.id, applicationId: appA1 });
  const convA2 = await world.conversation({ jobId: jobA, employerId: employerA, workerId: w2.id, applicationId: appA2 });
  const convB1 = await world.conversation({ jobId: jobB, employerId: employerB, workerId: w1.id, applicationId: appB1 });
  const messages = {
    A1: await world.message(convA1, 'fixture body A1'),
    A2: await world.message(convA2, 'fixture body A2'),
    B1: await world.message(convB1, 'fixture body B1'),
  };
  const outbox = {
    A1: await world.outbox(convA1, messages.A1, w1.phone!, 'fixture body A1'),
    A2: await world.outbox(convA2, messages.A2, w2.phone!, 'fixture body A2'),
    B1: await world.outbox(convB1, messages.B1, w1.phone!, 'fixture body B1'),
  };
  if (options.stale) {
    await world.su.query(
      `UPDATE job_message_outbox SET created_at = now() - interval '10 minutes' WHERE id = ANY($1::uuid[])`,
      [Object.values(outbox)],
    );
  }
  return {
    world, employerA, employerB, worker1: w1.id, worker2: w2.id, convA1, convA2, convB1, outbox, messages,
  };
}

async function statuses(s: Scene): Promise<Record<'A1' | 'A2' | 'B1', { outbox: string; message: string }>> {
  const { rows } = await s.world.su.query<{ id: string; status: string; message_status: string }>(
    `SELECT o.id, o.status, m.status AS message_status
       FROM job_message_outbox o JOIN job_conversation_messages m ON m.id = o.message_id
      WHERE o.id = ANY($1::uuid[])`,
    [Object.values(s.outbox)],
  );
  const byId = new Map(rows.map((r) => [r.id, { outbox: r.status, message: r.message_status }]));
  return {
    A1: byId.get(s.outbox.A1)!,
    A2: byId.get(s.outbox.A2)!,
    B1: byId.get(s.outbox.B1)!,
  };
}

const SENT = { outbox: 'sent', message: 'sent' };
const PENDING = { outbox: 'pending', message: 'queued' };

async function withLogin<T>(login: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = loginPool(login, { max: 1 });
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
    await pool.end();
  }
}

async function leftoverContext(client: PoolClient): Promise<string | null> {
  const { rows } = await client.query<{ v: string | null }>(
    `SELECT current_setting('app.current_internal_user_id', true) AS v`,
  );
  return rows[0].v;
}

describeInProfiles(['standard', 'request', 'owner-unrestricted'], 'sendPendingJobMessageOutbox on its real logins', () => {
  let s: Scene;
  beforeEach(async () => {
    sent.length = 0;
    s = await scene();
  });
  afterEach(async () => {
    await s.world.cleanup();
    await s.world.end();
  });

  it('jale_api: an employer flushing one conversation sends only that conversation', async () => {
    await withLogin('jale_api', async (client) => {
      await flush(client, { conversationId: s.convA1, actorUserId: s.employerA, actorKind: 'employer' });
      expect(client.getTransactionStatus()).toBe('I');
      expect([null, ''].includes(await leftoverContext(client))).toBe(true);
    });
    expect(await statuses(s)).toEqual({ A1: SENT, A2: PENDING, B1: PENDING });
    expect(sent.map((x) => x.body)).toEqual(['fixture body A1']);
  });

  it('jale_api: an employer flush with no conversation id stays inside the employer\'s own conversations', async () => {
    await withLogin('jale_api', (client) => flush(client, { actorUserId: s.employerA, actorKind: 'employer' }));
    expect(await statuses(s)).toEqual({ A1: SENT, A2: SENT, B1: PENDING });
  });

  it('jale_whatsapp: a worker flush sends that worker\'s rows across employers and nothing of another worker', async () => {
    await withLogin('jale_whatsapp', async (client) => {
      await flush(client, { actorUserId: s.worker1, actorKind: 'worker' });
      expect(client.getTransactionStatus()).toBe('I');
      expect([null, ''].includes(await leftoverContext(client))).toBe(true);
    });
    expect(await statuses(s)).toEqual({ A1: SENT, A2: PENDING, B1: SENT });
  });

  it('jale_whatsapp: a worker flush of one conversation sends only that conversation', async () => {
    await withLogin('jale_whatsapp', (client) =>
      flush(client, { conversationId: s.convB1, actorUserId: s.worker1, actorKind: 'worker' }));
    expect(await statuses(s)).toEqual({ A1: PENDING, A2: PENDING, B1: SENT });
  });
});

describeInProfiles(['standard', 'request', 'owner-unrestricted'], 'overlapping flushes send each row once', () => {
  let s: Scene;
  beforeEach(async () => {
    sent.length = 0;
    s = await scene();
  });
  afterEach(async () => {
    mockDuringNextSend = undefined;
    await s.world.cleanup();
    await s.world.end();
  });

  it('a worker flush that runs while an employer flush is sending a row never sends that row again', async () => {
    // The employer flush on jale_api is inside its send of the row for
    // worker 1 when that worker's own flush runs on jale_whatsapp, as the
    // processor or the sweeper would: the worker flush sends the worker's
    // row from the other employer and must leave the row in flight alone.
    mockDuringNextSend = () => withLogin('jale_whatsapp', (client) =>
      flush(client, { actorUserId: s.worker1, actorKind: 'worker' }));
    await withLogin('jale_api', (client) =>
      flush(client, { conversationId: s.convA1, actorUserId: s.employerA, actorKind: 'employer' }));

    expect(mockDuringNextSend).toBeUndefined();
    expect(sent.map((x) => x.body).sort()).toEqual(['fixture body A1', 'fixture body B1']);
    expect(await statuses(s)).toEqual({ A1: SENT, A2: PENDING, B1: SENT });
  });

  it('a row that another flush claims after this flush read it is skipped, never sent twice', async () => {
    // The worker's flush on jale_whatsapp reads both of the worker's rows.
    // Inside its first send, the employer of the other row flushes that
    // conversation on jale_api and sends that row; the worker flush then
    // finds the row already taken and leaves it.
    mockDuringNextSend = () => {
      const other = sent[0].body === 'fixture body A1'
        ? { conversationId: s.convB1, actorUserId: s.employerB }
        : { conversationId: s.convA1, actorUserId: s.employerA };
      return withLogin('jale_api', (client) => flush(client, { ...other, actorKind: 'employer' }));
    };
    await withLogin('jale_whatsapp', (client) =>
      flush(client, { actorUserId: s.worker1, actorKind: 'worker' }));

    expect(mockDuringNextSend).toBeUndefined();
    expect(sent.map((x) => x.body).sort()).toEqual(['fixture body A1', 'fixture body B1']);
    expect(await statuses(s)).toEqual({ A1: SENT, A2: PENDING, B1: SENT });
  });
});

describeInProfiles(['standard', 'request', 'owner-unrestricted'], 'the outbox sweeper on jale_whatsapp', () => {
  let s: Scene;
  beforeEach(async () => {
    sent.length = 0;
    s = await scene({ stale: true });
    sweeperPool = loginPool('jale_whatsapp', { max: 1 });
  });
  afterEach(async () => {
    await sweeperPool?.end();
    sweeperPool = undefined;
    await s.world.cleanup();
    await s.world.end();
  });

  it('flushes every stale worker, each confined to its own rows', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await sweeperHandler();
    } finally {
      log.mockRestore();
    }
    expect(await statuses(s)).toEqual({ A1: SENT, A2: SENT, B1: SENT });
  });
});

describeInProfiles(['owner-unrestricted'], 'the sender\'s own SQL confines the flush', () => {
  // In this profile only the sender's explicit caller predicate keeps one
  // caller's flush off another's rows.
  let s: Scene;
  beforeEach(async () => {
    sent.length = 0;
    s = await scene();
  });
  afterEach(async () => {
    await s.world.cleanup();
    await s.world.end();
  });

  it('a worker-mode flush with no conversation id sends only that worker\'s rows', async () => {
    expect(currentDbProfile()).toBe('owner-unrestricted');
    await withLogin('jale_admin', (client) => flush(client, { actorUserId: s.worker1, actorKind: 'worker' }));
    expect(await statuses(s)).toEqual({ A1: SENT, A2: PENDING, B1: SENT });
  });

  it('an employer-mode flush with no conversation id sends only that employer\'s rows', async () => {
    await withLogin('jale_admin', (client) => flush(client, { actorUserId: s.employerA, actorKind: 'employer' }));
    expect(await statuses(s)).toEqual({ A1: SENT, A2: SENT, B1: PENDING });
  });

  it('an employer naming another employer\'s conversation sends nothing', async () => {
    await withLogin('jale_admin', (client) =>
      flush(client, { conversationId: s.convB1, actorUserId: s.employerA, actorKind: 'employer' }));
    expect(await statuses(s)).toEqual({ A1: PENDING, A2: PENDING, B1: PENDING });
  });
});
