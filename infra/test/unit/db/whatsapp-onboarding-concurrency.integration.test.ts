/**
 * whatsapp-onboarding-concurrency.integration.test.ts (Task C9)
 *
 * PostgreSQL-backed gate exercising the REAL WhatsApp v2 onboarding modules
 * (worker-delivery-gateway, outbox, onboarding-repository, worker-ready-release)
 * against REAL PostgreSQL 16 with migrations 001-042 applied. No `pg` mock.
 *
 * Set JALE_TEST_DATABASE_URL to a superuser connection string for an isolated,
 * disposable database (see psql-migration-testbed). The connecting user must be
 * able to SET ROLE jale_whatsapp so fixtures can be created bypassing RLS (as
 * superuser) while behavior is exercised under the real jale_whatsapp role and
 * FORCE RLS, per BINDING decision #4.
 *
 * Two-connection concurrency (scenarios 3, 4, 5) always uses two independent
 * `pg.Client` connections with an explicit barrier — never `Promise.all` over
 * one client — following entitlement-concurrency.integration.test.ts.
 */
import { randomUUID, createHash } from 'node:crypto';
import { Client, type PoolClient } from 'pg';

import {
  enqueueWorkerMessage,
  registerCategoryRenderer,
} from '../../../lambda/whatsapp/lib/worker-delivery-gateway';
import { insertAuthorizedIntentOutbox } from '../../../lambda/whatsapp/lib/outbox';
import {
  completeOnboarding,
  loadPreAuthStateForUpdate,
  savePreAuthState,
} from '../../../lambda/whatsapp/lib/onboarding-repository';
import { releaseWorkerReady } from '../../../lambda/whatsapp/worker-ready-release';
import { setInternalUserRlsContext } from '../../../lambda/lib/db';
import type {
  ReleaseRenderRequest,
  ReleaseRenderedMessage,
  WorkerMessageIntentInput,
} from '../../../lambda/whatsapp/lib/onboarding-types';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('CONCERN: whatsapp-onboarding-concurrency (C9) PostgreSQL gate was not run', () => {
    // eslint-disable-next-line no-console
    console.warn(
      '[whatsapp-onboarding-concurrency] DONE_WITH_CONCERNS: set JALE_TEST_DATABASE_URL ' +
        'to a disposable PostgreSQL 16 database with migrations 001-042 applied to run the ' +
        'real-PostgreSQL RLS/idempotency/lease/concurrency gate.',
    );
    expect(databaseUrl).toBeUndefined();
  });
}

function maybeDescribe(name: string, fn: () => void): void {
  if (databaseUrl) describe(name, fn);
  else describe.skip(name, fn);
}

/**
 * The immutable migration-020 policy recursively re-enters users through
 * jobs/job_applications for jale_admin. Mirror the established
 * billing-rls.integration / whatsapp-support-039 testbed repair, in case any
 * scenario here trips it. This mutates only the disposable local database.
 */
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

function hex64(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

/**
 * The real modules under test type their client parameter as `PoolClient`
 * (they use it identically to a plain `Client` — query/BEGIN/COMMIT — and
 * never call pool-only methods like `release()`). This suite intentionally
 * uses plain `pg.Client` connections (per the two-connection concurrency
 * requirement), so this is a structural cast, not a behavioral difference.
 */
function pc(client: Client): PoolClient {
  return client as unknown as PoolClient;
}

/** Superuser connection for fixture setup/verification (bypasses RLS). */
async function withSuperuser<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Opens a connection, begins a transaction, and SETs ROLE jale_whatsapp — the
 * real application role under FORCE RLS, per BINDING decision #4. When
 * `workerId` is given, also sets the internal-user RLS GUC. Caller owns
 * COMMIT/ROLLBACK and client.end().
 */
async function connectAsWhatsapp(workerId?: string): Promise<Client> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query('BEGIN');
  await client.query('SET LOCAL ROLE jale_whatsapp');
  if (workerId) {
    await setInternalUserRlsContext(client, workerId);
  }
  return client;
}

/** Exact deterministic renderer construction from worker-ready-release.test.ts (~L221-228). */
function recordingRenderer() {
  const requests: ReleaseRenderRequest[] = [];
  const render = jest.fn(async (req: ReleaseRenderRequest): Promise<ReleaseRenderedMessage> => {
    requests.push(req);
    return { body: `rendered:${req.kind}`, contentTemplate: null, contentVariables: null };
  });
  return { render, requests };
}

const FIXED_NOW = new Date('2026-07-22T12:00:00.000Z');

async function enableDeferredDelivery(): Promise<void> {
  await withSuperuser((c) =>
    c.query(
      `UPDATE whatsapp_runtime_controls SET enabled = true, global_enabled = true WHERE control_key = 'deferred_delivery_enabled'`,
    ),
  );
}

maybeDescribe('WhatsApp v2 RLS / idempotency / lease / concurrency gate (C9)', () => {
  type RuntimeControlSnapshot = {
    control_key: string;
    enabled: boolean;
    phone_hashes: string[];
    global_enabled: boolean;
    updated_by: string | null;
    updated_at: string;
  };
  let runtimeControlSnapshot: RuntimeControlSnapshot[] | null = null;

  beforeAll(async () => {
    await withSuperuser(async (c) => {
      await applyLocalRlsRecursionWorkaround(c);
      const snapshot = await c.query<RuntimeControlSnapshot>(`
        SELECT control_key, enabled, phone_hashes, global_enabled, updated_by,
               updated_at::text AS updated_at
          FROM whatsapp_runtime_controls
         WHERE control_key = ANY($1::text[])
         ORDER BY control_key
      `, [['deferred_delivery_enabled', 'voice_intake_enabled']]);
      expect(snapshot.rows).toHaveLength(2);
      runtimeControlSnapshot = snapshot.rows;
    });
  });

  afterAll(async () => {
    if (!runtimeControlSnapshot) return;
    await withSuperuser(async (c) => {
      await c.query('BEGIN');
      try {
        for (const control of runtimeControlSnapshot!) {
          const restored = await c.query(`
            UPDATE whatsapp_runtime_controls
               SET enabled=$2, phone_hashes=$3, global_enabled=$4,
                   updated_by=$5, updated_at=$6::timestamptz
             WHERE control_key=$1
          `, [
            control.control_key, control.enabled, control.phone_hashes,
            control.global_enabled, control.updated_by, control.updated_at,
          ]);
          expect(restored.rowCount).toBe(1);
        }
        await c.query('COMMIT');
      } catch (error) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
      const verified = await c.query<RuntimeControlSnapshot>(`
        SELECT control_key, enabled, phone_hashes, global_enabled, updated_by,
               updated_at::text AS updated_at
          FROM whatsapp_runtime_controls
         WHERE control_key = ANY($1::text[])
         ORDER BY control_key
      `, [['deferred_delivery_enabled', 'voice_intake_enabled']]);
      expect(verified.rows).toEqual(runtimeControlSnapshot);
    });
  });

  // ── Scenario 0: Pre-auth RLS boundary ──────────────────────────────────
  describe('scenario 0: pre-auth RLS boundary', () => {
    const hashValid = hex64('c9-scenario0-valid');
    const hashOther = hex64('c9-scenario0-other');

    beforeAll(async () => {
      await withSuperuser((c) =>
        c.query(
          `INSERT INTO worker_identity_challenges (phone_hash, status, preferred_language) VALUES ($1, 'pending', 'es')`,
          [hashValid],
        ),
      );
    });

    afterAll(async () => {
      await withSuperuser((c) =>
        c.query('DELETE FROM worker_identity_challenges WHERE phone_hash = ANY($1::text[])', [[hashValid, hashOther]]),
      );
    });

    it('loads pre-auth state for the one validated phone hash via the exact-hash function', async () => {
      const client = await connectAsWhatsapp();
      try {
        const state = await loadPreAuthStateForUpdate(pc(client), hashValid);
        expect(state).not.toBeNull();
        expect(state?.phoneHash).toBe(hashValid);
        await client.query('COMMIT');
      } finally {
        await client.end();
      }
    });

    it('returns null (not another hash\'s row) for a non-matching phone hash', async () => {
      const client = await connectAsWhatsapp();
      try {
        const state = await loadPreAuthStateForUpdate(pc(client), hashOther);
        expect(state).toBeNull();
        await client.query('COMMIT');
      } finally {
        await client.end();
      }
    });

    it('saves an allow-listed patch for the exact hash via the exact-hash function', async () => {
      const client = await connectAsWhatsapp();
      try {
        const saved = await savePreAuthState(pc(client), hashValid, { attempts: 1 });
        expect(saved.phoneHash).toBe(hashValid);
        expect(saved.attempts).toBe(1);
        await client.query('COMMIT');
      } finally {
        await client.end();
      }
    });

    it('denies direct table access to worker_identity_challenges', async () => {
      const client = await connectAsWhatsapp();
      try {
        await expect(
          client.query('SELECT * FROM worker_identity_challenges WHERE phone_hash = $1', [hashValid]),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        await client.end();
      }
    });
  });

  // ── Scenario 1: Cross-worker RLS ───────────────────────────────────────
  describe('scenario 1: cross-worker RLS', () => {
    const workerA = randomUUID();
    const workerB = randomUUID();
    const intentBDedupe = `c9-s1-intent-b-${randomUUID()}`;
    const hashB = hex64(`c9-scenario1-${workerB}`);

    beforeAll(async () => {
      await withSuperuser(async (c) => {
        await c.query(
          `INSERT INTO users (id, cognito_sub, user_type) VALUES ($1, $2, 'worker'), ($3, $4, 'worker')`,
          [workerA, `c9-s1-a-${workerA}`, workerB, `c9-s1-b-${workerB}`],
        );
        await c.query(
          `INSERT INTO worker_onboarding_state (user_id, lifecycle) VALUES ($1, 'onboarding'), ($2, 'onboarding')`,
          [workerA, workerB],
        );
        await c.query(
          `INSERT INTO worker_workflow_runs (user_id, workflow_version, current_step_key)
           VALUES ($1, 1, 'legal.review'), ($2, 1, 'legal.review')`,
          [workerA, workerB],
        );
        await c.query(
          `INSERT INTO worker_message_intents
             (user_id, category, owner_service, source_type, source_id, dedupe_key, priority, status, policy_version)
           VALUES ($1, 'account', 'account', 'x', $2, $3, 10, 'deferred', 1)`,
          [workerB, randomUUID(), intentBDedupe],
        );
        await c.query(
          `INSERT INTO worker_identity_challenges (phone_hash, status, candidate_user_id) VALUES ($1, 'pending', $2)`,
          [hashB, workerB],
        );
      });
    });

    afterAll(async () => {
      await withSuperuser(async (c) => {
        await c.query('DELETE FROM worker_identity_challenges WHERE phone_hash = $1', [hashB]);
        await c.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[workerA, workerB]]);
      });
    });

    it('reads of worker B state/runs/intents as worker A return zero rows', async () => {
      const client = await connectAsWhatsapp(workerA);
      try {
        const onboarding = await client.query('SELECT * FROM worker_onboarding_state WHERE user_id = $1', [workerB]);
        expect(onboarding.rowCount).toBe(0);
        const runs = await client.query('SELECT * FROM worker_workflow_runs WHERE user_id = $1', [workerB]);
        expect(runs.rowCount).toBe(0);
        const intents = await client.query('SELECT * FROM worker_message_intents WHERE user_id = $1', [workerB]);
        expect(intents.rowCount).toBe(0);
        await client.query('COMMIT');
      } finally {
        await client.end();
      }
    });

    it('direct read of worker_identity_challenges is denied regardless of context', async () => {
      const client = await connectAsWhatsapp(workerA);
      try {
        await expect(
          client.query('SELECT * FROM worker_identity_challenges WHERE phone_hash = $1', [hashB]),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        await client.end();
      }
    });

    it('an UPDATE targeting worker B rows as worker A affects zero rows', async () => {
      const client = await connectAsWhatsapp(workerA);
      try {
        const result = await client.query(
          `UPDATE worker_message_intents SET status = 'rejected' WHERE user_id = $1`,
          [workerB],
        );
        expect(result.rowCount).toBe(0);
        await client.query('COMMIT');
      } finally {
        await client.end();
      }

      const stillDeferred = await withSuperuser((c) =>
        c.query<{ status: string }>('SELECT status FROM worker_message_intents WHERE dedupe_key = $1', [intentBDedupe]),
      );
      expect(stillDeferred.rows[0].status).toBe('deferred');
    });

    it('an UPDATE of whatsapp_runtime_controls is denied', async () => {
      const client = await connectAsWhatsapp(workerA);
      try {
        await expect(
          client.query(`UPDATE whatsapp_runtime_controls SET enabled = true WHERE control_key = 'voice_intake_enabled'`),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        await client.end();
      }
    });
  });

  // ── Scenario 2: Inbound idempotency ────────────────────────────────────
  describe('scenario 2: inbound idempotency', () => {
    const workerId = randomUUID();
    const messageSid = `SMtestonly${randomUUID().replace(/-/g, '').slice(0, 22)}`;
    const dedupeKey = `c9-s2-dedupe-${randomUUID()}`;

    beforeAll(async () => {
      await withSuperuser((c) =>
        c.query(`INSERT INTO users (id, cognito_sub, user_type) VALUES ($1, $2, 'worker')`, [
          workerId,
          `c9-s2-${workerId}`,
        ]),
      );
    });

    afterAll(async () => {
      await withSuperuser(async (c) => {
        await c.query('DELETE FROM whatsapp_processed_messages WHERE message_sid = $1', [messageSid]);
        await c.query('DELETE FROM users WHERE id = $1', [workerId]);
      });
    });

    it('a second insert of the same inbound MessageSid violates the unique constraint', async () => {
      const client = await connectAsWhatsapp();
      try {
        await client.query(
          `INSERT INTO whatsapp_processed_messages (message_sid, whatsapp_number) VALUES ($1, $2)`,
          [messageSid, '+15550002001'],
        );
        await expect(
          client.query(`INSERT INTO whatsapp_processed_messages (message_sid, whatsapp_number) VALUES ($1, $2)`, [
            messageSid,
            '+15550002001',
          ]),
        ).rejects.toMatchObject({ code: '23505' });
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        await client.end();
      }

      // The first (valid) insert never committed above (aborted transaction) — insert it now
      // for real, on its own transaction, to keep the constraint assertion self-contained.
      const client2 = await connectAsWhatsapp();
      try {
        await client2.query(
          `INSERT INTO whatsapp_processed_messages (message_sid, whatsapp_number) VALUES ($1, $2)`,
          [messageSid, '+15550002001'],
        );
        await client2.query('COMMIT');
      } finally {
        await client2.end();
      }
    });

    it('a second enqueueWorkerMessage with the same dedupeKey yields exactly one intent row', async () => {
      const client = await connectAsWhatsapp(workerId);
      try {
        registerCategoryRenderer('onboarding', async () => ({
          whatsappNumber: '+15550002002',
          body: 'onboarding complete',
          contentTemplate: null,
          contentVariables: null,
        }));
        const input: WorkerMessageIntentInput = {
          workerId,
          category: 'onboarding',
          ownerService: 'onboarding-v2',
          sourceType: 'onboarding_step',
          sourceId: randomUUID(),
          dedupeKey,
          priority: 10,
          expiresAt: null,
          payload: {},
        };
        const first = await enqueueWorkerMessage(pc(client), input);
        const second = await enqueueWorkerMessage(pc(client), input);
        expect(second.intentId).toBe(first.intentId);
        const rows = await client.query<{ n: string }>(
          `SELECT count(*)::int AS n FROM worker_message_intents WHERE dedupe_key = $1`,
          [dedupeKey],
        );
        expect(Number(rows.rows[0].n)).toBe(1);
        await client.query('COMMIT');
      } finally {
        await client.end();
      }
    });
  });

  // ── Scenario 3: One active workflow ────────────────────────────────────
  describe('scenario 3: one active workflow', () => {
    const workerId = randomUUID();

    beforeAll(async () => {
      await withSuperuser((c) =>
        c.query(`INSERT INTO users (id, cognito_sub, user_type) VALUES ($1, $2, 'worker')`, [
          workerId,
          `c9-s3-${workerId}`,
        ]),
      );
    });

    afterAll(async () => {
      await withSuperuser((c) => c.query('DELETE FROM users WHERE id = $1', [workerId]));
    });

    it(
      'exactly one of two concurrent active-run inserts commits; the other fails on worker_workflow_one_active',
      async () => {
        const c1 = new Client({ connectionString: databaseUrl });
        const c2 = new Client({ connectionString: databaseUrl });
        await c1.connect();
        await c2.connect();
        try {
          await c1.query('BEGIN');
          await c1.query('SET LOCAL ROLE jale_whatsapp');
          await setInternalUserRlsContext(c1, workerId);
          await c2.query('BEGIN');
          await c2.query('SET LOCAL ROLE jale_whatsapp');
          await setInternalUserRlsContext(c2, workerId);

          // c1 inserts the active run first but does not commit yet.
          await c1.query(
            `INSERT INTO worker_workflow_runs (user_id, workflow_version, current_step_key) VALUES ($1, 1, 'legal.review')`,
            [workerId],
          );

          // c2's insert races the same partial unique index; it blocks on c1's
          // uncommitted row until c1 resolves (explicit barrier via row lock,
          // not a fake single-client interleave).
          const c2Insert = c2.query(
            `INSERT INTO worker_workflow_runs (user_id, workflow_version, current_step_key) VALUES ($1, 1, 'legal.review')`,
            [workerId],
          );

          await c1.query('COMMIT');

          await expect(c2Insert).rejects.toMatchObject({ code: '23505', constraint: 'worker_workflow_one_active' });
          await c2.query('ROLLBACK').catch(() => undefined);

          const active = await withSuperuser((c) =>
            c.query<{ n: string }>(
              `SELECT count(*)::int AS n FROM worker_workflow_runs WHERE user_id = $1 AND status = 'active'`,
              [workerId],
            ),
          );
          expect(Number(active.rows[0].n)).toBe(1);
        } finally {
          await c1.end();
          await c2.end();
        }
      },
      20_000,
    );
  });

  // ── Scenario 4: Release lease ──────────────────────────────────────────
  describe('scenario 4: release lease', () => {
    const workerId = randomUUID();
    let runId: string;
    let eventKey: string;

    beforeAll(async () => {
      await enableDeferredDelivery();
      await withSuperuser(async (c) => {
        await c.query(
          `INSERT INTO users (id, cognito_sub, user_type, whatsapp_number) VALUES ($1, $2, 'worker', $3)`,
          [workerId, `c9-s4-${workerId}`, '+15550004001'],
        );
        await c.query(`INSERT INTO worker_onboarding_state (user_id, lifecycle) VALUES ($1, 'onboarding')`, [
          workerId,
        ]);
        const run = await c.query<{ id: string }>(
          `INSERT INTO worker_workflow_runs (user_id, workflow_version, current_step_key, status)
           VALUES ($1, 1, 'trust.question.3', 'active') RETURNING id`,
          [workerId],
        );
        runId = run.rows[0].id;
      });

      const setupClient = await connectAsWhatsapp(workerId);
      await completeOnboarding(pc(setupClient), {
        workerId,
        runId,
        expectedLockVersion: 0,
        assessmentProvenance: { source: 'c9-scenario4' },
      });
      await setupClient.query('COMMIT');
      await setupClient.end();
      eventKey = `worker.ready:${workerId}:${runId}`;
    });

    afterAll(async () => {
      await withSuperuser(async (c) => {
        await c.query('DELETE FROM worker_domain_outbox WHERE aggregate_id = $1', [workerId]);
        await c.query('DELETE FROM users WHERE id = $1', [workerId]);
      });
    });

    it(
      'exactly one of two concurrent leases claims the worker.ready event; only the winner releases',
      async () => {
        const c1 = new Client({ connectionString: databaseUrl });
        const c2 = new Client({ connectionString: databaseUrl });
        await c1.connect();
        await c2.connect();
        try {
          await c1.query('BEGIN');
          await c1.query('SET LOCAL ROLE jale_whatsapp');
          await c2.query('BEGIN');
          await c2.query('SET LOCAL ROLE jale_whatsapp');

          // Two independent connections race the SECURITY DEFINER lease function
          // concurrently (FOR UPDATE SKIP LOCKED) — genuine two-connection
          // concurrency, not a fake single-client interleave.
          const [lease1, lease2] = await Promise.all([
            c1.query<{ id: string; aggregate_id: string; event_key: string; status: string }>(
              `SELECT * FROM lease_worker_domain_events($1, $2)`,
              ['worker.ready', 1],
            ),
            c2.query<{ id: string; aggregate_id: string; event_key: string; status: string }>(
              `SELECT * FROM lease_worker_domain_events($1, $2)`,
              ['worker.ready', 1],
            ),
          ]);

          expect(lease1.rows.length + lease2.rows.length).toBe(1);

          const winnerIsC1 = lease1.rows.length === 1;
          const winnerClient = winnerIsC1 ? c1 : c2;
          const loserClient = winnerIsC1 ? c2 : c1;
          const winnerRow = winnerIsC1 ? lease1.rows[0] : lease2.rows[0];
          const loserRows = winnerIsC1 ? lease2.rows : lease1.rows;

          expect(loserRows.length).toBe(0);
          expect(winnerRow.event_key).toBe(eventKey);
          expect(winnerRow.status).toBe('processing');

          // Design B (BINDING): caller sets internal-user RLS context inside its
          // own open transaction BEFORE calling releaseWorkerReady.
          await setInternalUserRlsContext(winnerClient, winnerRow.aggregate_id);
          const { render } = recordingRenderer();
          const released = await releaseWorkerReady(pc(winnerClient), winnerRow.event_key, {
            renderer: { render },
            now: () => FIXED_NOW,
          });
          expect(released.released).toBe(1);

          await winnerClient.query('COMMIT');
          await loserClient.query('COMMIT');

          const outboxCount = await withSuperuser((c) =>
            c.query<{ n: string }>(
              `SELECT count(*)::int AS n
                 FROM whatsapp_outbox o
                 JOIN worker_message_intents i ON i.outbox_id = o.id
                WHERE i.user_id = $1`,
              [workerId],
            ),
          );
          // Total authorized outbox rows equal the single-run count (1) — the
          // losing lease attempt performed no release and produced no rows.
          expect(Number(outboxCount.rows[0].n)).toBe(1);
        } finally {
          await c1.end();
          await c2.end();
        }
      },
      20_000,
    );
  });

  // ── Scenario 5: Outbound sequence ──────────────────────────────────────
  describe('scenario 5: outbound sequence ordering', () => {
    const workerId = randomUUID();
    const employerId = randomUUID();
    let runId: string;
    let jobId: string;
    // A SECOND job, used only by the job_alert intent. The employer_chat
    // fixture below needs a job_applications row (job_conversations.application_id
    // is NOT NULL REFERENCES job_applications), but release-time job_alert
    // eligibility now discards an alert whose worker has ALREADY APPLIED to that
    // job ('worker_already_applied' — it re-evaluates the producer's own match
    // predicate in job-alert.ts, which excludes applicants). Those two states
    // never co-occur in production for the same job, so the alert uses its own
    // unapplied job. This keeps the scenario's real subject — release_sequence
    // ordering across all four categories — exactly as before.
    let alertJobId: string;
    let applicationId: string;
    let conversationId: string;
    let messageId: string;
    let eventKey: string;

    beforeAll(async () => {
      await enableDeferredDelivery();
      await withSuperuser(async (c) => {
        await c.query(
          `INSERT INTO users (id, cognito_sub, user_type, whatsapp_number) VALUES ($1, $2, 'worker', $3)`,
          [workerId, `c9-s5-worker-${workerId}`, '+15550005001'],
        );
        await c.query(`INSERT INTO users (id, cognito_sub, user_type) VALUES ($1, $2, 'employer')`, [
          employerId,
          `c9-s5-employer-${employerId}`,
        ]);
        const job = await c.query<{ id: string }>(
          `INSERT INTO jobs (employer_id, title, company, location, job_type, status)
           VALUES ($1, 'Framer', 'Acme Co', 'Austin, TX', 'contract', 'active') RETURNING id`,
          [employerId],
        );
        jobId = job.rows[0].id;
        const alertJob = await c.query<{ id: string }>(
          `INSERT INTO jobs (employer_id, title, company, location, job_type, status)
           VALUES ($1, 'Roofer', 'Acme Co', 'Austin, TX', 'contract', 'active') RETURNING id`,
          [employerId],
        );
        alertJobId = alertJob.rows[0].id;
        const application = await c.query<{ id: string }>(
          `INSERT INTO job_applications (job_id, worker_id, status) VALUES ($1, $2, 'pending') RETURNING id`,
          [jobId, workerId],
        );
        applicationId = application.rows[0].id;
        const conversation = await c.query<{ id: string }>(
          `INSERT INTO job_conversations (job_id, employer_id, worker_id, application_id, status)
           VALUES ($1, $2, $3, $4, 'open') RETURNING id`,
          [jobId, employerId, workerId, applicationId],
        );
        conversationId = conversation.rows[0].id;
        const message = await c.query<{ id: string }>(
          `INSERT INTO job_conversation_messages (conversation_id, sender_type, direction, body, status)
           VALUES ($1, 'employer', 'outbound', 'You are hired!', 'sent') RETURNING id`,
          [conversationId],
        );
        messageId = message.rows[0].id;

        await c.query(`INSERT INTO worker_onboarding_state (user_id, lifecycle) VALUES ($1, 'onboarding')`, [
          workerId,
        ]);
        const run = await c.query<{ id: string }>(
          `INSERT INTO worker_workflow_runs (user_id, workflow_version, current_step_key, status)
           VALUES ($1, 1, 'trust.question.3', 'active') RETURNING id`,
          [workerId],
        );
        runId = run.rows[0].id;

        await c.query(
          `INSERT INTO worker_message_intents
             (user_id, category, owner_service, source_type, source_id, dedupe_key, priority, status, policy_version, payload)
           VALUES ($1, 'account', 'account', 'password_change', $2, $3, 20, 'deferred', 1, '{}'::jsonb)`,
          [workerId, randomUUID(), `c9-s5-account-${workerId}`],
        );
        await c.query(
          `INSERT INTO worker_message_intents
             (user_id, category, owner_service, source_type, source_id, dedupe_key, priority, status, policy_version, payload)
           VALUES ($1, 'job_alert', 'job-alert', 'job', $2, $3, 30, 'deferred', 1, $4::jsonb)`,
          [workerId, alertJobId, `c9-s5-jobalert-${workerId}`, JSON.stringify({ score: 88 })],
        );
        await c.query(
          `INSERT INTO worker_message_intents
             (user_id, category, owner_service, source_type, source_id, dedupe_key, priority, status, policy_version)
           VALUES ($1, 'employer_chat', 'job-messaging', 'job_conversation_message', $2, $3, 40, 'deferred', 1)`,
          [workerId, messageId, `c9-s5-chat-${workerId}`],
        );
      });

      const setupClient = await connectAsWhatsapp(workerId);
      await completeOnboarding(pc(setupClient), {
        workerId,
        runId,
        expectedLockVersion: 0,
        assessmentProvenance: { source: 'c9-scenario5' },
      });
      await setupClient.query('COMMIT');
      await setupClient.end();
      eventKey = `worker.ready:${workerId}:${runId}`;
    });

    afterAll(async () => {
      await withSuperuser(async (c) => {
        await c.query('DELETE FROM worker_domain_outbox WHERE aggregate_id = $1', [workerId]);
        await c.query('DELETE FROM job_conversation_messages WHERE conversation_id = $1', [conversationId]);
        await c.query('DELETE FROM job_conversations WHERE id = $1', [conversationId]);
        await c.query('DELETE FROM job_applications WHERE id = $1', [applicationId]);
        await c.query('DELETE FROM jobs WHERE id = ANY($1::uuid[])', [[jobId, alertJobId]]);
        await c.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[workerId, employerId]]);
      });
    });

    it(
      'produces unique, contiguous release_sequence values ordered onboarding -> account -> job_alert -> employer_chat',
      async () => {
        const c1 = new Client({ connectionString: databaseUrl });
        const c2 = new Client({ connectionString: databaseUrl });
        await c1.connect();
        await c2.connect();
        try {
          await c1.query('BEGIN');
          await c1.query('SET LOCAL ROLE jale_whatsapp');
          await c2.query('BEGIN');
          await c2.query('SET LOCAL ROLE jale_whatsapp');

          const [lease1, lease2] = await Promise.all([
            c1.query<{ id: string; aggregate_id: string; event_key: string }>(
              `SELECT * FROM lease_worker_domain_events($1, $2)`,
              ['worker.ready', 1],
            ),
            c2.query<{ id: string; aggregate_id: string; event_key: string }>(
              `SELECT * FROM lease_worker_domain_events($1, $2)`,
              ['worker.ready', 1],
            ),
          ]);
          expect(lease1.rows.length + lease2.rows.length).toBe(1);
          const winnerIsC1 = lease1.rows.length === 1;
          const winnerClient = winnerIsC1 ? c1 : c2;
          const loserClient = winnerIsC1 ? c2 : c1;

          await setInternalUserRlsContext(winnerClient, workerId);
          const { render } = recordingRenderer();
          const released = await releaseWorkerReady(pc(winnerClient), eventKey, {
            renderer: { render },
            now: () => FIXED_NOW,
          });
          expect(released.released).toBe(4);

          await winnerClient.query('COMMIT');
          await loserClient.query('COMMIT');

          const rows = await withSuperuser((c) =>
            c.query<{ category: string; release_sequence: number }>(
              `SELECT category, release_sequence FROM worker_message_intents
                WHERE user_id = $1 AND release_sequence IS NOT NULL
                ORDER BY release_sequence ASC`,
              [workerId],
            ),
          );
          expect(rows.rows.map((r) => r.release_sequence)).toEqual([1, 2, 3, 4]);
          expect(rows.rows.map((r) => r.category)).toEqual(['onboarding', 'account', 'job_alert', 'employer_chat']);
        } finally {
          await c1.end();
          await c2.end();
        }
      },
      20_000,
    );
  });

  // ── Scenario 6: Atomic readiness ───────────────────────────────────────
  describe('scenario 6: atomic readiness', () => {
    const workerRolledBack = randomUUID();
    const workerCommitted = randomUUID();
    let rolledBackRunId: string;
    let committedRunId: string;

    beforeAll(async () => {
      await withSuperuser(async (c) => {
        await c.query(
          `INSERT INTO users (id, cognito_sub, user_type) VALUES ($1, $2, 'worker'), ($3, $4, 'worker')`,
          [workerRolledBack, `c9-s6-rb-${workerRolledBack}`, workerCommitted, `c9-s6-ok-${workerCommitted}`],
        );
        await c.query(
          `INSERT INTO worker_onboarding_state (user_id, lifecycle) VALUES ($1, 'onboarding'), ($2, 'onboarding')`,
          [workerRolledBack, workerCommitted],
        );
        const runA = await c.query<{ id: string }>(
          `INSERT INTO worker_workflow_runs (user_id, workflow_version, current_step_key, status)
           VALUES ($1, 1, 'trust.question.3', 'active') RETURNING id`,
          [workerRolledBack],
        );
        rolledBackRunId = runA.rows[0].id;
        const runB = await c.query<{ id: string }>(
          `INSERT INTO worker_workflow_runs (user_id, workflow_version, current_step_key, status)
           VALUES ($1, 1, 'trust.question.3', 'active') RETURNING id`,
          [workerCommitted],
        );
        committedRunId = runB.rows[0].id;
      });
    });

    afterAll(async () => {
      await withSuperuser(async (c) => {
        await c.query('DELETE FROM worker_domain_outbox WHERE aggregate_id = ANY($1::uuid[])', [
          [workerRolledBack, workerCommitted],
        ]);
        await c.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[workerRolledBack, workerCommitted]]);
      });
    });

    it('a rolled-back completeOnboarding leaves lifecycle onboarding and inserts no domain event', async () => {
      const client = await connectAsWhatsapp(workerRolledBack);
      try {
        await completeOnboarding(pc(client), {
          workerId: workerRolledBack,
          runId: rolledBackRunId,
          expectedLockVersion: 0,
          assessmentProvenance: { source: 'c9-scenario6-rollback' },
        });
        await client.query('ROLLBACK');
      } finally {
        await client.end();
      }

      const state = await withSuperuser((c) =>
        c.query<{ lifecycle: string }>('SELECT lifecycle FROM worker_onboarding_state WHERE user_id = $1', [
          workerRolledBack,
        ]),
      );
      expect(state.rows[0].lifecycle).toBe('onboarding');

      const events = await withSuperuser((c) =>
        c.query<{ n: string }>('SELECT count(*)::int AS n FROM worker_domain_outbox WHERE aggregate_id = $1', [
          workerRolledBack,
        ]),
      );
      expect(Number(events.rows[0].n)).toBe(0);
    });

    it('committed, completeOnboarding produces exactly one row per event_key even when called twice', async () => {
      const client1 = await connectAsWhatsapp(workerCommitted);
      let firstResult;
      try {
        firstResult = await completeOnboarding(pc(client1), {
          workerId: workerCommitted,
          runId: committedRunId,
          expectedLockVersion: 0,
          assessmentProvenance: { source: 'c9-scenario6-first' },
        });
        await client1.query('COMMIT');
      } finally {
        await client1.end();
      }

      const state = await withSuperuser((c) =>
        c.query<{ lifecycle: string }>('SELECT lifecycle FROM worker_onboarding_state WHERE user_id = $1', [
          workerCommitted,
        ]),
      );
      expect(state.rows[0].lifecycle).toBe('ready');

      const afterFirst = await withSuperuser((c) =>
        c.query<{ n: string }>('SELECT count(*)::int AS n FROM worker_domain_outbox WHERE aggregate_id = $1', [
          workerCommitted,
        ]),
      );
      expect(Number(afterFirst.rows[0].n)).toBe(2);

      // Retry with the run's actual current lock_version (simulating a caller
      // retrying after an ambiguous outcome). The event_key is unchanged
      // (same workerId + runId), so the idempotent domain-event insert must
      // not create a second row per key.
      const client2 = await connectAsWhatsapp(workerCommitted);
      let secondResult;
      try {
        const lockRow = await client2.query<{ lock_version: number }>(
          'SELECT lock_version FROM worker_workflow_runs WHERE id = $1',
          [committedRunId],
        );
        secondResult = await completeOnboarding(pc(client2), {
          workerId: workerCommitted,
          runId: committedRunId,
          expectedLockVersion: lockRow.rows[0].lock_version,
          assessmentProvenance: { source: 'c9-scenario6-retry' },
        });
        await client2.query('COMMIT');
      } finally {
        await client2.end();
      }

      expect(secondResult.assessmentEventId).toBe(firstResult.assessmentEventId);
      expect(secondResult.workerReadyEventId).toBe(firstResult.workerReadyEventId);

      const afterSecond = await withSuperuser((c) =>
        c.query<{ n: string }>('SELECT count(*)::int AS n FROM worker_domain_outbox WHERE aggregate_id = $1', [
          workerCommitted,
        ]),
      );
      expect(Number(afterSecond.rows[0].n)).toBe(2);
    });
  });

  // ── Scenario 7: Gate under contention ──────────────────────────────────
  describe('scenario 7: gate under contention', () => {
    const workerId = randomUUID();

    beforeAll(async () => {
      await withSuperuser((c) =>
        c.query(`INSERT INTO users (id, cognito_sub, user_type) VALUES ($1, $2, 'worker')`, [
          workerId,
          `c9-s7-${workerId}`,
        ]),
      );
      // No worker_onboarding_state row -> loadWorkerGate returns null ->
      // enqueueWorkerMessage treats the worker as lifecycle 'onboarding'.
    });

    afterAll(async () => {
      await withSuperuser((c) => c.query('DELETE FROM users WHERE id = $1', [workerId]));
    });

    it('ten concurrent enqueueWorkerMessage calls across two business categories create zero whatsapp_outbox rows', async () => {
      const inputs: WorkerMessageIntentInput[] = [];
      for (let i = 0; i < 5; i += 1) {
        inputs.push({
          workerId,
          category: 'account',
          ownerService: 'account',
          sourceType: 'account_notice',
          sourceId: randomUUID(),
          dedupeKey: `c9-s7-account-${i}-${randomUUID()}`,
          priority: 10,
          expiresAt: null,
          payload: {},
        });
      }
      for (let i = 0; i < 5; i += 1) {
        inputs.push({
          workerId,
          category: 'job_alert',
          ownerService: 'job-alert',
          sourceType: 'job',
          sourceId: randomUUID(),
          dedupeKey: `c9-s7-jobalert-${i}-${randomUUID()}`,
          priority: 10,
          expiresAt: null,
          payload: { score: 50 + i },
        });
      }

      // Ten genuinely independent connections, each on its own transaction,
      // racing concurrently — not ten pipelined queries sharing one Client
      // (pg deprecates/serializes that, and it obscures true concurrency).
      const clients = await Promise.all(Array.from({ length: inputs.length }, () => connectAsWhatsapp(workerId)));
      let results: Array<{ intentId: string; decision: { action: string } }>;
      try {
        results = await Promise.all(
          inputs.map((input, i) => enqueueWorkerMessage(pc(clients[i]), input)),
        );
        expect(results.every((r) => r.decision.action === 'defer')).toBe(true);
        await Promise.all(clients.map((c) => c.query('COMMIT')));
      } finally {
        await Promise.all(clients.map((c) => c.end()));
      }

      const intentIds = results.map((r) => r.intentId);
      const outboxCount = await withSuperuser((c) =>
        c.query<{ n: string }>(
          `SELECT count(*)::int AS n FROM whatsapp_outbox WHERE source_type = 'worker_intent' AND source_id = ANY($1::uuid[])`,
          [intentIds],
        ),
      );
      expect(Number(outboxCount.rows[0].n)).toBe(0);
    });
  });

  // ── Scenario 8: Unauthorized outbox ────────────────────────────────────
  describe('scenario 8: unauthorized outbox', () => {
    const workerId = randomUUID();

    beforeAll(async () => {
      await withSuperuser((c) =>
        c.query(`INSERT INTO users (id, cognito_sub, user_type) VALUES ($1, $2, 'worker')`, [
          workerId,
          `c9-s8-${workerId}`,
        ]),
      );
    });

    afterAll(async () => {
      await withSuperuser((c) => c.query('DELETE FROM users WHERE id = $1', [workerId]));
    });

    it('insertAuthorizedIntentOutbox rejects a deferred (unauthorized) intent', async () => {
      const client = await connectAsWhatsapp(workerId);
      try {
        const input: WorkerMessageIntentInput = {
          workerId,
          category: 'account',
          ownerService: 'account',
          sourceType: 'account_notice',
          sourceId: randomUUID(),
          dedupeKey: `c9-s8-dedupe-${randomUUID()}`,
          priority: 10,
          expiresAt: null,
          payload: {},
        };
        const { intentId, decision } = await enqueueWorkerMessage(pc(client), input);
        expect(decision.action).toBe('defer'); // lifecycle 'onboarding' (no gate row) -> deferred, not authorized

        await expect(
          insertAuthorizedIntentOutbox(pc(client), intentId, {
            whatsappNumber: '+15550008001',
            body: 'unauthorized direct send',
            contentTemplate: null,
            contentVariables: null,
          }),
        ).rejects.toThrow('unauthorized_worker_outbox_row');

        const outboxRows = await client.query<{ n: string }>(
          `SELECT count(*)::int AS n FROM whatsapp_outbox WHERE source_type = 'worker_intent' AND source_id = $1`,
          [intentId],
        );
        expect(Number(outboxRows.rows[0].n)).toBe(0);
        await client.query('COMMIT');
      } finally {
        await client.end();
      }
    });
  });
});
