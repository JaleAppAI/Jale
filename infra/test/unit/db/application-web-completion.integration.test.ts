import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { PoolClient } from 'pg';

import {
  releasePromptLaneForApplication,
  releaseWhatsAppLanesForApplication,
} from '../../../lambda/lib/application-web-completion';
import { FILL_SCRUB_KEYS } from '../../../lambda/whatsapp/lib/application-fill';
import { PROMPT_LANE_SCRUB_KEYS } from '../../../lambda/whatsapp/lib/application-prompts';
import { _clearCategoryRenderersForTests } from '../../../lambda/whatsapp/lib/worker-delivery-gateway';

/**
 * Sprint 24 round 2, lane 1.5 -- the web door's WhatsApp lane release against
 * REAL PostgreSQL 16 with migrations 001-095 applied.
 *
 * WHY THIS SUITE EXISTS
 *   Four of the five things this module promises are facts only a real
 *   database can settle, and a mocked pool reports all four as success:
 *
 *   1. `state_context - text[]` REMOVES the keys. The scrub's whole purpose
 *      is that `state_context ? 'fill_application_id'` becomes false -- which
 *      is exactly the predicate `processor.ts`'s dispatch tail evaluates
 *      (`typeof tailState?.fill_application_id === 'string'`). No planner, no
 *      jsonb operator, no proof.
 *
 *   2. `wa_conv_full` is `USING (true)` for jale_whatsapp (004:139-141), so
 *      RLS enforces NO ownership here. The `user_id = $2` in the scrub's
 *      WHERE is the only thing standing between one worker's web submission
 *      and another worker's conversation row. Case (b) is that proof, and it
 *      is a zero-row policy/predicate fact a mock cannot have.
 *
 *   3. The 24-hour window comes from `whatsapp_processed_messages.first_seen_at`
 *      (the inbound log) and NOT from `whatsapp_conversations.updated_at`.
 *      Case (d) backdates the inbound clock 30 hours while the
 *      `wa_conversations_updated_at` trigger holds `updated_at` at now() --
 *      the exact shape a bot OUTBOUND turn produces. Only real SQL and a real
 *      trigger can distinguish those two columns.
 *
 *   4. A SQL failure inside the release must not kill the caller's
 *      transaction. Case (f) provokes a genuine 42501 (jale_ai holds no grant
 *      on whatsapp_conversations) and then proves the SAME transaction still
 *      executes a statement and COMMITs. A `try/catch` alone passes a
 *      "does not throw" assertion and still leaves every later statement --
 *      `buildState`, then COMMIT -- failing 25P02. Only Postgres raises
 *      25P02, so only Postgres can falsify the savepoint.
 *
 * WHAT IS REAL AND WHAT IS STUBBED
 *   Everything is real except Twilio, which is never reached: the release
 *   writes a `worker_message_intents` row and a `whatsapp_outbox` row and
 *   stops. The drain is deliberately NOT driven -- `lease_worker_intent_outbox`
 *   (043) is global by design and advances `attempt_count` on any fixture row
 *   another suite left behind (the reason the 093 entry runs last in
 *   `run-whatsapp-v2-db-tests.sh`). The outbox row itself is asserted instead.
 *
 * CONNECTION
 *   `JALE_TEST_DATABASE_URL` must be a SUPERUSER connection string for a
 *   disposable PostgreSQL 16 database with 001-095 applied (see
 *   db/local/bootstrap-testbed.sh). Fixtures and verification reads use it
 *   directly; every RELEASE call runs on its own transaction under
 *   `SET LOCAL ROLE jale_whatsapp` with the worker's
 *   `app.current_internal_user_id`, which is the exact session shape
 *   `api/worker-application-details.ts` hands the module in production.
 */

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: the web-completion lane-release PostgreSQL gate was not run', () => {
    console.warn('[application-web-completion] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

maybeDescribe('web completion releases the WhatsApp lanes', () => {
  let setup: Client;
  let originalDeferredDeliveryEnabled: boolean | null = null;

  const employerId = randomUUID();

  /** One worker + conversation + application per case; ids are per-run. */
  interface Case {
    workerId: string;
    conversationId: string;
    number: string;
    applicationId: string;
    jobId: string;
  }
  const mkCase = (suffix: number): Case => ({
    workerId: randomUUID(),
    conversationId: randomUUID(),
    number: `+1512555${String(9000 + suffix).slice(0, 4)}`,
    applicationId: randomUUID(),
    jobId: randomUUID(),
  });

  // (a) armed, inbound 1h ago -> scrub + one closing line.
  const fresh = mkCase(1);
  // (b) a DIFFERENT worker whose conversation names the SAME application id.
  //     Must survive untouched: `wa_conv_full` proves no ownership.
  const bystander = mkCase(2);
  // (c) armed, inbound 30h ago -> scrub only.
  const stale = mkCase(3);
  // (d) inbound 30h ago but `updated_at` freshened by a later write.
  const bumped = mkCase(4);
  // (e) the prompt lane alone.
  const promptOnly = mkCase(5);
  // (f) the savepoint: a real 42501 must leave the transaction usable.
  const denied = mkCase(6);

  const cases = [fresh, bystander, stale, bumped, promptOnly, denied];
  const workerIds = cases.map((c) => c.workerId);
  const conversationIds = cases.map((c) => c.conversationId);
  const applicationIds = cases.map((c) => c.applicationId);
  const jobIds = cases.map((c) => c.jobId);

  /**
   * The session shape `api/worker-application-details.ts` produces: role
   * jale_whatsapp, `app.current_internal_user_id` = the worker's users.id
   * (which is what `worker_message_intents_worker` (042:224) keys on), inside
   * an open transaction the release must not be allowed to poison.
   */
  async function openWorkerDoor(workerId: string, role = 'jale_whatsapp'): Promise<Client> {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [workerId]);
    return client;
  }

  /** The armed `state_context` the bot writes, plus unrelated keys to keep. */
  const armedContext = (applicationId: string) => ({
    fill_application_id: applicationId,
    fill_pending: 'work_authorization',
    fill_last_prompt_at: 1757000000000,
    prompt_application_id: applicationId,
    applications_menu: ['app-x'],
    // NOT a lane key. Must survive every scrub: a jsonb `-` that took the
    // whole context would leave the worker's language preference behind too.
    preferred_language: 'es',
  });

  /** Exactly the predicate the processor's dispatch tail evaluates. */
  async function readArmKeys(conversationId: string) {
    const res = await setup.query<{
      has_fill: boolean; has_prompt: boolean; has_pending: boolean;
      has_menu: boolean; kept: string | null;
    }>(
      `SELECT state_context ? 'fill_application_id'   AS has_fill,
              state_context ? 'prompt_application_id' AS has_prompt,
              state_context ? 'fill_pending'          AS has_pending,
              state_context ? 'applications_menu'     AS has_menu,
              state_context->>'preferred_language'    AS kept
         FROM whatsapp_conversations WHERE id = $1`,
      [conversationId],
    );
    return res.rows[0];
  }

  async function readOutbox(applicationId: string) {
    const res = await setup.query(
      `SELECT o.whatsapp_number, o.body, o.content_template, o.content_variables,
              o.source_type, o.status, i.status AS intent_status, i.priority,
              i.category, i.owner_service, i.source_type AS intent_source_type,
              i.dedupe_key
         FROM worker_message_intents i
         LEFT JOIN whatsapp_outbox o ON o.id = i.outbox_id
        WHERE i.source_id = $1`,
      [applicationId],
    );
    return res.rows;
  }

  beforeAll(async () => {
    setup = new Client({ connectionString: databaseUrl });
    await setup.connect();

    await setup.query(
      `INSERT INTO users (id, cognito_sub, user_type) VALUES ($1, $2, 'employer')`,
      [employerId, `r2-employer-${employerId}`],
    );
    // No `phone` and no `whatsapp_number` on ANY worker, deliberately. The
    // closing line's recipient comes from the CONVERSATION row, so it must
    // work for a worker `loadVerifiedRecipient`
    // (application-stage-notify.ts) would have refused outright.
    await setup.query(
      `INSERT INTO users (id, cognito_sub, user_type)
       SELECT id, 'r2-worker-' || id::text, 'worker' FROM unnest($1::uuid[]) AS id`,
      [workerIds],
    );
    await setup.query(
      `INSERT INTO jobs (id, employer_id, title, location, job_type, status)
       SELECT id, $2, 'Concrete Finisher', 'Austin', 'full-time', 'active'
         FROM unnest($1::uuid[]) AS id`,
      [jobIds, employerId],
    );
    await setup.query(
      `INSERT INTO job_applications (id, job_id, worker_id, status)
       SELECT id, job_id, worker_id, 'details_requested'
         FROM unnest($1::uuid[], $2::uuid[], $3::uuid[]) AS t(id, job_id, worker_id)`,
      [applicationIds, jobIds, workerIds],
    );
    await setup.query(
      `INSERT INTO worker_onboarding_state (user_id, lifecycle)
       SELECT id, 'ready' FROM unnest($1::uuid[]) AS id`,
      [workerIds],
    );

    // The bystander's row names the FRESH case's application on purpose.
    for (const c of cases) {
      const named = c === bystander ? fresh.applicationId : c.applicationId;
      await setup.query(
        `INSERT INTO whatsapp_conversations
           (id, user_id, whatsapp_number, language, conversation_state, state_context)
         VALUES ($1, $2, $3, $4, 'idle', $5::jsonb)`,
        [
          c.conversationId, c.workerId, c.number,
          c === promptOnly ? 'en' : 'es',
          JSON.stringify(armedContext(named)),
        ],
      );
    }

    // The inbound clock. `first_seen_at` is what opens Meta's 24h window.
    const inbound: [Case, string][] = [
      [fresh, '1 hour'],
      [bystander, '1 hour'],
      [stale, '30 hours'],
      [bumped, '30 hours'],
      [promptOnly, '1 hour'],
      [denied, '1 hour'],
    ];
    for (const [c, ago] of inbound) {
      await setup.query(
        `INSERT INTO whatsapp_processed_messages
           (message_sid, whatsapp_number, status, first_seen_at)
         VALUES ($1, $2, 'completed', now() - $3::interval)`,
        [`SM-r2-${c.conversationId}`.slice(0, 50), c.number, ago],
      );
    }

    // Case (d): a LATER write bumps `updated_at` to now() through 004's
    // `wa_conversations_updated_at` trigger, exactly as a bot outbound turn
    // does, while the inbound clock stays 30 hours stale.
    await setup.query(
      `UPDATE whatsapp_conversations SET conversation_state = 'idle' WHERE id = $1`,
      [bumped.conversationId],
    );

    // evaluateDelivery defers every non-onboarding/security intent while
    // deferred_delivery_enabled is false (delivery-policy.ts).
    const control = await setup.query<{ enabled: boolean }>(
      `SELECT enabled FROM whatsapp_runtime_controls WHERE control_key = 'deferred_delivery_enabled'`,
    );
    originalDeferredDeliveryEnabled = control.rows[0]?.enabled ?? null;
    await setup.query(
      `UPDATE whatsapp_runtime_controls SET enabled = true WHERE control_key = 'deferred_delivery_enabled'`,
    );
  });

  afterEach(() => {
    _clearCategoryRenderersForTests();
  });

  afterAll(async () => {
    if (!databaseUrl) return;
    if (originalDeferredDeliveryEnabled !== null) {
      await setup.query(
        `UPDATE whatsapp_runtime_controls SET enabled = $1 WHERE control_key = 'deferred_delivery_enabled'`,
        [originalDeferredDeliveryEnabled],
      );
    }
    await setup.query(
      `DELETE FROM whatsapp_outbox
        WHERE id IN (SELECT outbox_id FROM worker_message_intents
                      WHERE source_id = ANY($1::uuid[]) AND outbox_id IS NOT NULL)`,
      [applicationIds],
    );
    await setup.query('DELETE FROM worker_message_intents WHERE source_id = ANY($1::uuid[])', [applicationIds]);
    await setup.query('DELETE FROM whatsapp_processed_messages WHERE whatsapp_number = ANY($1::text[])',
      [cases.map((c) => c.number)]);
    await setup.query('DELETE FROM whatsapp_conversations WHERE id = ANY($1::uuid[])', [conversationIds]);
    await setup.query('DELETE FROM worker_onboarding_state WHERE user_id = ANY($1::uuid[])', [workerIds]);
    await setup.query('DELETE FROM job_applications WHERE id = ANY($1::uuid[])', [applicationIds]);
    await setup.query('DELETE FROM jobs WHERE id = ANY($1::uuid[])', [jobIds]);
    await setup.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[employerId, ...workerIds]]);
    await setup.end();
  });

  it('(a) removes every lane key and queues one body-only closing line inside the 24h window', async () => {
    const client = await openWorkerDoor(fresh.workerId);
    let result;
    try {
      result = await releaseWhatsAppLanesForApplication(client as unknown as PoolClient, {
        workerId: fresh.workerId,
        applicationId: fresh.applicationId,
        jobTitle: 'Concrete Finisher',
        companyName: null,
        lang: 'es',
      });
      await client.query('COMMIT');
    } finally {
      await client.end();
    }

    expect(result).toEqual({ armed: true, scrubbed: 1, closingLineQueued: true });

    // The dispatch tail's own predicate, now false. This is the assertion the
    // whole lane exists for: `maybeRepromptFill` and the `routeMessage` tail
    // are module-private, so the guard's INPUT is asserted rather than the
    // processor driven -- `processor.test.ts` carries the behavioural pin.
    const keys = await readArmKeys(fresh.conversationId);
    expect(keys.has_fill).toBe(false);
    expect(keys.has_prompt).toBe(false);
    expect(keys.has_pending).toBe(false);
    expect(keys.has_menu).toBe(false);
    // jsonb `-` removed the listed keys and nothing else.
    expect(keys.kept).toBe('es');

    const rows = await readOutbox(fresh.applicationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      intent_status: 'eligible',
      category: 'account',
      owner_service: 'account',
      intent_source_type: 'application_web_completion',
      priority: 20,
      dedupe_key: `application-web-completion:${fresh.applicationId}`,
      source_type: 'worker_intent',
      status: 'pending',
      whatsapp_number: fresh.number,
    });
    // FREE-FORM: `sendTwilioWhatsAppMessage` sends `Body` only when
    // `content_template` is null, and `lease_worker_intent_outbox` (043)
    // projects `body` for it to use.
    expect(rows[0].content_template).toBeNull();
    expect(rows[0].content_variables).toBeNull();
    expect(rows[0].body).toBe(
      'Completaste tu solicitud para Concrete Finisher en la web. Te avisamos por aqui cuando el empleador responda.',
    );
  });

  it("(b) leaves another worker's identically armed row untouched", async () => {
    // The bystander's `state_context` names `fresh.applicationId` and case (a)
    // has already run. `wa_conv_full` is USING (true), so nothing but the
    // `user_id = $2` predicate protects this row.
    const keys = await readArmKeys(bystander.conversationId);
    expect(keys.has_fill).toBe(true);
    expect(keys.has_prompt).toBe(true);
    expect(keys.has_pending).toBe(true);
  });

  it('(c) scrubs but sends nothing when the last inbound message is 30h old', async () => {
    const client = await openWorkerDoor(stale.workerId);
    let result;
    try {
      result = await releaseWhatsAppLanesForApplication(client as unknown as PoolClient, {
        workerId: stale.workerId,
        applicationId: stale.applicationId,
        jobTitle: 'Concrete Finisher',
        companyName: null,
        lang: 'es',
      });
      await client.query('COMMIT');
    } finally {
      await client.end();
    }

    expect(result).toEqual({ armed: true, scrubbed: 1, closingLineQueued: false });
    expect((await readArmKeys(stale.conversationId)).has_fill).toBe(false);
    // A free-form body outside the window is a Twilio 63016, and because this
    // send carries no content template `isTemplatePendingRejection` is false
    // for it -- the row would burn five attempts as an ordinary failure.
    expect(await readOutbox(stale.applicationId)).toHaveLength(0);
  });

  it('(d) ignores a freshened conversation updated_at when the inbound clock is stale', async () => {
    const before = await setup.query<{ updated_recent: boolean; inbound_stale: boolean }>(
      `SELECT c.updated_at > now() - interval '1 hour' AS updated_recent,
              (SELECT max(p.first_seen_at) FROM whatsapp_processed_messages p
                WHERE p.whatsapp_number = c.whatsapp_number)
                < now() - interval '24 hours' AS inbound_stale
         FROM whatsapp_conversations c WHERE c.id = $1`,
      [bumped.conversationId],
    );
    // The fixture really is the ambiguous shape: a mock keyed on `updated_at`
    // would send here, and the send would fail 63016.
    expect(before.rows[0]).toEqual({ updated_recent: true, inbound_stale: true });

    const client = await openWorkerDoor(bumped.workerId);
    let result;
    try {
      result = await releaseWhatsAppLanesForApplication(client as unknown as PoolClient, {
        workerId: bumped.workerId,
        applicationId: bumped.applicationId,
        jobTitle: null,
        companyName: null,
        lang: 'es',
      });
      await client.query('COMMIT');
    } finally {
      await client.end();
    }

    expect(result.closingLineQueued).toBe(false);
    expect(await readOutbox(bumped.applicationId)).toHaveLength(0);
  });

  it('(e) the prompt-lane release clears only the prompt keys and sends nothing', async () => {
    const client = await openWorkerDoor(promptOnly.workerId);
    let result;
    try {
      result = await releasePromptLaneForApplication(client as unknown as PoolClient, {
        workerId: promptOnly.workerId,
        applicationId: promptOnly.applicationId,
      });
      await client.query('COMMIT');
    } finally {
      await client.end();
    }

    expect(result).toEqual({ armed: true, scrubbed: 1, closingLineQueued: false });

    const keys = await readArmKeys(promptOnly.conversationId);
    expect(keys.has_prompt).toBe(false);
    expect(keys.has_menu).toBe(false);
    // The FILL arm survives: finishing the pre-application prompts on the web
    // says nothing about a details-stage question the bot is still owed.
    expect(keys.has_fill).toBe(true);
    expect(keys.has_pending).toBe(true);
    expect(await readOutbox(promptOnly.applicationId)).toHaveLength(0);
  });

  it('(f) a real 42501 inside the release leaves the caller transaction COMMITtable', async () => {
    // jale_ai holds no grant on whatsapp_conversations, so the arm read
    // raises 42501 and Postgres aborts the transaction. Without the module's
    // savepoint every later statement -- `buildState`, then COMMIT -- fails
    // 25P02, and a successful answer merge would answer 500.
    const client = await openWorkerDoor(denied.workerId, 'jale_ai');
    try {
      const result = await releaseWhatsAppLanesForApplication(client as unknown as PoolClient, {
        workerId: denied.workerId,
        applicationId: denied.applicationId,
        jobTitle: 'Concrete Finisher',
        companyName: null,
        lang: 'es',
      });
      expect(result).toEqual({ armed: false, scrubbed: 0, closingLineQueued: false });

      // THE assertion: the transaction is still alive.
      const alive = await client.query<{ ok: number }>('SELECT 1 AS ok');
      expect(alive.rows[0].ok).toBe(1);
      await client.query('COMMIT');
    } finally {
      await client.end();
    }

    // Nothing was released and nothing was sent.
    expect((await readArmKeys(denied.conversationId)).has_fill).toBe(true);
    expect(await readOutbox(denied.applicationId)).toHaveLength(0);
  });

  it('(g) a release on an already-cleared row is a no-op', async () => {
    // Case (a) already cleared the keys, so the arm read finds nothing and
    // the function returns before it can enqueue. This is the ordinary retry
    // shape (`markDetailsCompleteIfDone` only flips `details_completed_at`
    // while it IS NULL, so the caller fires once by construction).
    const client = await openWorkerDoor(fresh.workerId);
    let result;
    try {
      result = await releaseWhatsAppLanesForApplication(client as unknown as PoolClient, {
        workerId: fresh.workerId,
        applicationId: fresh.applicationId,
        jobTitle: 'Concrete Finisher',
        companyName: null,
        lang: 'es',
      });
      await client.query('COMMIT');
    } finally {
      await client.end();
    }

    expect(result).toEqual({ armed: false, scrubbed: 0, closingLineQueued: false });
    expect(await readOutbox(fresh.applicationId)).toHaveLength(1);
  });

  it('(h) the dedupe key holds even when the row is RE-armed', async () => {
    // The case (g) no-op is the scrub's doing, not the dedupe key's -- so the
    // key gets its own test. Re-arm the row (the bot legitimately does this
    // if the worker starts the flow again) and release a second time: the
    // scrub runs, the enqueue is reached, and `worker_message_intent_dedupe`
    // plus the gateway's `RETURNING outbox_id` must still produce exactly ONE
    // outbox row. A second one is a duplicate WhatsApp message.
    await setup.query(
      `UPDATE whatsapp_conversations SET state_context = $2::jsonb WHERE id = $1`,
      [fresh.conversationId, JSON.stringify(armedContext(fresh.applicationId))],
    );

    const client = await openWorkerDoor(fresh.workerId);
    let result;
    try {
      result = await releaseWhatsAppLanesForApplication(client as unknown as PoolClient, {
        workerId: fresh.workerId,
        applicationId: fresh.applicationId,
        jobTitle: 'Concrete Finisher',
        companyName: null,
        lang: 'es',
      });
      await client.query('COMMIT');
    } finally {
      await client.end();
    }

    // The arm really was found and cleared again...
    expect(result.armed).toBe(true);
    expect(result.scrubbed).toBe(1);
    expect((await readArmKeys(fresh.conversationId)).has_fill).toBe(false);
    // ...and still exactly one intent and one outbox row for this application.
    const rows = await readOutbox(fresh.applicationId);
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupe_key).toBe(`application-web-completion:${fresh.applicationId}`);
  });

  it('exports key sets that actually cover the guards the bot reads', () => {
    // The web door and the bot must agree by CONSTRUCTION, not by comment.
    expect(FILL_SCRUB_KEYS).toEqual(expect.arrayContaining([
      'fill_application_id', 'fill_offer_application_id',
      'prompt_application_id', 'applications_menu',
    ]));
    expect(PROMPT_LANE_SCRUB_KEYS).toEqual(expect.arrayContaining([
      'prompt_application_id', 'prompt_last_prompt_at', 'applications_menu',
    ]));
    for (const key of PROMPT_LANE_SCRUB_KEYS) {
      expect(FILL_SCRUB_KEYS).toContain(key);
    }
  });
});
