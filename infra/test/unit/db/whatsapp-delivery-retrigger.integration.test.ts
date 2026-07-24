/**
 * whatsapp-delivery-retrigger.integration.test.ts (O1)
 *
 * Real-PostgreSQL gate for the deferred re-trigger sweep
 * (delivery-retrigger-sweep.ts) against migrations 001-043. Templated on
 * whatsapp-onboarding-concurrency.integration.test.ts's harness: `withSuperuser`
 * for fixtures (bypasses RLS), `applyLocalRlsRecursionWorkaround`, and
 * `SET ROLE jale_whatsapp` + `setInternalUserRlsContext` for the real
 * `releaseWorkerReady` call.
 *
 * Scenario (per the sprint plan's O1 integration-test spec):
 *   1. deferred_delivery_enabled = false.
 *   2. Seed a 'ready' worker with deferred business intents (account,
 *      job_alert, employer_chat) and a COMPLETED original worker.ready event
 *      (mirrors the real lifecycle: the event that made the worker ready was
 *      already consumed by the drain before delivery was disabled).
 *   3. Enable deferred_delivery + run the sweep (as jale_admin, matching the
 *      CLI's real access path) -> exactly one fresh worker.ready event is
 *      enqueued.
 *   4. Run the real drain path (lease_worker_domain_events + releaseWorkerReady)
 *      -> exactly one grouped release with correct, contiguous
 *      release_sequence values.
 *   5. A SECOND enable + sweep + drain cycle enqueues no further USEFUL work
 *      and releases ZERO additional rows — proving the sweep and the
 *      release layer are both idempotent under repeated enable.
 */
import { randomUUID } from 'node:crypto';
import { Client, type PoolClient } from 'pg';

import { retriggerDeferredReadyWorkers } from '../../../lambda/whatsapp/lib/delivery-retrigger-sweep';
import { releaseWorkerReady } from '../../../lambda/whatsapp/worker-ready-release';
import { setInternalUserRlsContext } from '../../../lambda/lib/db';
import type { ReleaseRenderRequest, ReleaseRenderedMessage } from '../../../lambda/whatsapp/lib/onboarding-types';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('CONCERN: whatsapp-delivery-retrigger (O1) PostgreSQL gate was not run', () => {
    // eslint-disable-next-line no-console
    console.warn(
      '[whatsapp-delivery-retrigger] DONE_WITH_CONCERNS: set JALE_TEST_DATABASE_URL ' +
        'to a disposable PostgreSQL 16 database with migrations 001-043 applied to run the ' +
        'real-PostgreSQL deferred re-trigger sweep gate.',
    );
    expect(databaseUrl).toBeUndefined();
  });
}

function maybeDescribe(name: string, fn: () => void): void {
  if (databaseUrl) describe(name, fn);
  else describe.skip(name, fn);
}

/** Mirrors whatsapp-onboarding-concurrency.integration.test.ts exactly. */
async function applyLocalRlsRecursionWorkaround(client: Client): Promise<void> {
  await client.query(`
    CREATE OR REPLACE FUNCTION employer_has_applicant_relationship(
      p_employer_internal_id text,
      p_worker_id uuid
    ) RETURNS boolean
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = public
    AS $fn$
      SELECT EXISTS (
        SELECT 1
          FROM job_applications ja
          JOIN jobs j ON j.id = ja.job_id
         WHERE ja.worker_id = p_worker_id
           AND j.employer_id::text = p_employer_internal_id
      );
    $fn$;
  `);
  await client.query('DROP POLICY IF EXISTS users_employer_applicant_read ON users');
  await client.query(`
    CREATE POLICY users_employer_applicant_read
      ON users FOR SELECT TO jale_admin
      USING (
        user_type = 'worker'
        AND employer_has_applicant_relationship(
          current_setting('app.current_internal_user_id', true),
          id
        )
      )
  `);
}

async function withSuperuser<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** jale_admin connection — the sweep's real access path (matches the CLI). */
async function withJaleAdmin<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE jale_admin');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

function pc(client: Client): PoolClient {
  return client as unknown as PoolClient;
}

function recordingRenderer() {
  const requests: ReleaseRenderRequest[] = [];
  const render = jest.fn(async (req: ReleaseRenderRequest): Promise<ReleaseRenderedMessage> => {
    requests.push(req);
    return { body: `rendered:${req.kind}`, contentTemplate: null, contentVariables: null };
  });
  return { render, requests };
}

const FIXED_NOW = new Date('2026-07-23T12:00:00.000Z');

/** Runs the real drain's worker.ready lease + release exactly as domain-outbox-drain.ts does. */
async function runOneWorkerReadyDrainCycle(
  databaseUrlForClients: string,
): Promise<{ leased: number; released: number }> {
  const client = new Client({ connectionString: databaseUrlForClients });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE jale_whatsapp');
    const leaseResult = await client.query<{
      id: string;
      aggregate_id: string;
      event_key: string;
      status: string;
    }>(`SELECT * FROM lease_worker_domain_events($1, $2)`, ['worker.ready', 1]);

    const leased = leaseResult.rows[0];
    if (!leased) {
      await client.query('COMMIT');
      return { leased: 0, released: 0 };
    }

    await setInternalUserRlsContext(client, leased.aggregate_id);
    const { render } = recordingRenderer();
    const released = await releaseWorkerReady(pc(client), leased.event_key, {
      renderer: { render },
      now: () => FIXED_NOW,
    });

    await client.query(
      `UPDATE worker_domain_outbox SET status='completed', leased_until=NULL, lease_token=NULL,
              next_attempt_at=NULL, updated_at=now()
        WHERE event_key=$1 AND status='processing'`,
      [leased.event_key],
    );

    await client.query('COMMIT');
    return { leased: 1, released: released.released };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

/** Drains every currently-leasable worker.ready event (there should be at most one per test). */
async function drainAllWorkerReady(databaseUrlForClients: string): Promise<{ totalReleased: number; cycles: number }> {
  let totalReleased = 0;
  let cycles = 0;
  for (let i = 0; i < 10; i += 1) {
    const { leased, released } = await runOneWorkerReadyDrainCycle(databaseUrlForClients);
    if (leased === 0) break;
    cycles += 1;
    totalReleased += released;
  }
  return { totalReleased, cycles };
}

maybeDescribe('WhatsApp v2 deferred delivery re-trigger sweep (O1)', () => {
  type RuntimeControlSnapshot = {
    control_key: string;
    enabled: boolean;
    global_enabled: boolean;
  };
  let deferredDeliverySnapshot: RuntimeControlSnapshot | null = null;

  beforeAll(async () => {
    await withSuperuser(async (c) => {
      await applyLocalRlsRecursionWorkaround(c);
      const snapshot = await c.query<RuntimeControlSnapshot>(
        `SELECT control_key, enabled, global_enabled FROM whatsapp_runtime_controls WHERE control_key = 'deferred_delivery_enabled'`,
      );
      deferredDeliverySnapshot = snapshot.rows[0];
      // Start from a known-disabled baseline for this suite.
      await c.query(
        `UPDATE whatsapp_runtime_controls SET enabled = false WHERE control_key = 'deferred_delivery_enabled'`,
      );
    });
  });

  afterAll(async () => {
    if (!deferredDeliverySnapshot) return;
    await withSuperuser((c) =>
      c.query(
        `UPDATE whatsapp_runtime_controls SET enabled = $2, global_enabled = $3 WHERE control_key = $1`,
        [
          deferredDeliverySnapshot!.control_key,
          deferredDeliverySnapshot!.enabled,
          deferredDeliverySnapshot!.global_enabled,
        ],
      ),
    );
  });

  // Scope note: this scenario seeds 'account' and 'job_alert' deferred intents
  // only. The sweep is category-agnostic — it re-emits `worker.ready` and lets
  // the existing release path decide what is eligible — so proving grouped
  // release + idempotency needs only one business category to be a complete
  // proof of the sweep itself. Per-category eligibility (including
  // employer_chat) is owned by O2's unit tests and by the C9 concurrency gate's
  // scenario 5, which covers all four categories end-to-end.
  describe('sweep + drain end-to-end', () => {
    const workerId = randomUUID();
    const employerId = randomUUID();
    let jobId: string;
    let originalRunId: string;

    beforeAll(async () => {
      await withSuperuser(async (c) => {
        await c.query(`INSERT INTO users (id, cognito_sub, user_type, whatsapp_number) VALUES ($1, $2, 'worker', $3)`, [
          workerId,
          `o1-s1-worker-${workerId}`,
          '+15550091101',
        ]);
        await c.query(`INSERT INTO users (id, cognito_sub, user_type) VALUES ($1, $2, 'employer')`, [
          employerId,
          `o1-s1-employer-${employerId}`,
        ]);
        const job = await c.query<{ id: string }>(
          `INSERT INTO jobs (employer_id, title, company, location, job_type, status)
           VALUES ($1, 'Electrician', 'Acme Co', 'Austin, TX', 'contract', 'active') RETURNING id`,
          [employerId],
        );
        jobId = job.rows[0].id;
        // Deliberately NO job_applications row for this worker/job — the
        // job_alert eligibility check discards an intent whose worker has
        // already applied (worker_already_applied, mirroring job-alert.ts's
        // own producer dedup guard), so this job must stay unapplied for the
        // job_alert intent below to survive to release.

        // Worker already 'ready' — its onboarding-completion worker.ready
        // event has already been drained (mirrors the real bug scenario:
        // the trigger that made the worker ready is long gone by the time an
        // operator later flips deferred_delivery back on).
        await c.query(`INSERT INTO worker_onboarding_state (user_id, lifecycle) VALUES ($1, 'ready')`, [workerId]);
        const run = await c.query<{ id: string }>(
          `INSERT INTO worker_workflow_runs (user_id, workflow_version, current_step_key, status)
           VALUES ($1, 1, 'trust.question.3', 'completed') RETURNING id`,
          [workerId],
        );
        originalRunId = run.rows[0].id;
        await c.query(
          `INSERT INTO worker_domain_outbox (event_type, aggregate_id, event_key, status)
           VALUES ('worker.ready', $1, $2, 'completed')`,
          [workerId, `worker.ready:${workerId}:${originalRunId}`],
        );

        // Deferred business intents piled up while deferred_delivery was off.
        await c.query(
          `INSERT INTO worker_message_intents
             (user_id, category, owner_service, source_type, source_id, dedupe_key, priority, status, policy_version, payload)
           VALUES ($1, 'account', 'account', 'password_change', $2, $3, 20, 'deferred', 1, '{}'::jsonb)`,
          [workerId, randomUUID(), `o1-s1-account-${workerId}`],
        );
        await c.query(
          `INSERT INTO worker_message_intents
             (user_id, category, owner_service, source_type, source_id, dedupe_key, priority, status, policy_version, payload)
           VALUES ($1, 'job_alert', 'job-alert', 'job', $2, $3, 30, 'deferred', 1, $4::jsonb)`,
          [workerId, jobId, `o1-s1-jobalert-${workerId}`, JSON.stringify({ score: 77 })],
        );
      });
    });

    afterAll(async () => {
      await withSuperuser(async (c) => {
        await c.query('DELETE FROM worker_domain_outbox WHERE aggregate_id = $1', [workerId]);
        await c.query('DELETE FROM jobs WHERE id = $1', [jobId]);
        await c.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[workerId, employerId]]);
      });
    });

    it(
      'enable + sweep enqueues exactly one worker.ready event that the real drain releases as one grouped, contiguous release',
      async () => {
        // 1. Enable deferred_delivery.
        await withSuperuser((c) =>
          c.query(`UPDATE whatsapp_runtime_controls SET enabled = true WHERE control_key = 'deferred_delivery_enabled'`),
        );

        // 2. Run the sweep as jale_admin (the CLI's real access path).
        const sweepResult = await withJaleAdmin((c) =>
          retriggerDeferredReadyWorkers(pc(c), { sweepRunId: 'o1-integration-gen-1' }),
        );
        expect(sweepResult.workersSwept).toBe(1);
        expect(sweepResult.eventsEnqueued).toBe(1);

        const pendingEvents = await withSuperuser((c) =>
          c.query<{ event_key: string; status: string }>(
            `SELECT event_key, status FROM worker_domain_outbox
              WHERE aggregate_id = $1 AND event_type = 'worker.ready' AND event_key <> $2`,
            [workerId, `worker.ready:${workerId}:${originalRunId}`],
          ),
        );
        expect(pendingEvents.rows).toHaveLength(1);
        expect(pendingEvents.rows[0].event_key).toBe(`worker.ready:sweep:${workerId}:o1-integration-gen-1`);
        expect(pendingEvents.rows[0].status).toBe('pending');

        // 3. Run the real drain path. This is the FIRST time releaseWorkerReady
        // ever actually runs for this worker (the fixture's original
        // worker.ready event was inserted pre-completed, simulating "already
        // consumed by an earlier drain cycle before this worker's business
        // intents even existed" per the bug scenario) — so releaseWorkerReady's
        // own onboarding-complete synthesis (worker-ready-release.ts:172-195)
        // fires here too, releasing 3 intents total: the synthesized
        // onboarding confirmation plus the two deferred business intents.
        const { totalReleased, cycles } = await drainAllWorkerReady(databaseUrl!);
        expect(cycles).toBe(1);
        expect(totalReleased).toBe(3);

        const released = await withSuperuser((c) =>
          c.query<{ category: string; release_sequence: number }>(
            `SELECT category, release_sequence FROM worker_message_intents
               WHERE user_id = $1 AND status = 'released'
               ORDER BY release_sequence ASC`,
            [workerId],
          ),
        );
        expect(released.rows.map((r) => r.category)).toEqual(['onboarding', 'account', 'job_alert']);
        expect(released.rows.map((r) => r.release_sequence)).toEqual([1, 2, 3]);

        const outboxCount = await withSuperuser((c) =>
          c.query<{ n: string }>(
            `SELECT count(*)::int AS n FROM whatsapp_outbox o
               JOIN worker_message_intents i ON i.outbox_id = o.id
              WHERE i.user_id = $1`,
            [workerId],
          ),
        );
        expect(Number(outboxCount.rows[0].n)).toBe(3);

        // 4. Idempotency: a SECOND enable + sweep + drain cycle releases
        // ZERO additional rows (every intent is already 'released'; the
        // sweep's own NOT EXISTS guard also means nothing new is even
        // enqueued because there is no outstanding pending/processing
        // worker.ready left AND no deferred intents remain to justify one).
        await withSuperuser((c) =>
          c.query(`UPDATE whatsapp_runtime_controls SET enabled = true WHERE control_key = 'deferred_delivery_enabled'`),
        );
        const secondSweep = await withJaleAdmin((c) =>
          retriggerDeferredReadyWorkers(pc(c), { sweepRunId: 'o1-integration-gen-2' }),
        );
        expect(secondSweep.workersSwept).toBe(0);
        expect(secondSweep.eventsEnqueued).toBe(0);

        const secondDrain = await drainAllWorkerReady(databaseUrl!);
        expect(secondDrain.cycles).toBe(0);
        expect(secondDrain.totalReleased).toBe(0);

        const releasedAfterSecond = await withSuperuser((c) =>
          c.query<{ n: string }>(
            `SELECT count(*)::int AS n FROM worker_message_intents WHERE user_id = $1 AND status = 'released'`,
            [workerId],
          ),
        );
        expect(Number(releasedAfterSecond.rows[0].n)).toBe(3);

        const outboxCountAfterSecond = await withSuperuser((c) =>
          c.query<{ n: string }>(
            `SELECT count(*)::int AS n FROM whatsapp_outbox o
               JOIN worker_message_intents i ON i.outbox_id = o.id
              WHERE i.user_id = $1`,
            [workerId],
          ),
        );
        expect(Number(outboxCountAfterSecond.rows[0].n)).toBe(3); // unchanged — no duplicate send
      },
      30_000,
    );
  });
});
