import { releaseWorkerReady } from '../../../../lambda/whatsapp/worker-ready-release';
import type { ReleaseRenderRequest, ReleaseRenderedMessage } from '../../../../lambda/whatsapp/lib/onboarding-types';

const WORKER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const EVENT_KEY = 'worker.ready:aaaaaaaa-0000-0000-0000-000000000001:1';
const NOW = new Date('2026-07-22T12:00:00.000Z');

interface IntentRow {
  id: string;
  category: string;
  owner_service: string;
  source_type: string;
  source_id: string;
  priority: number;
  payload: Record<string, unknown>;
  expires_at: Date | string | null;
  created_at: Date | string;
  status: string;
}

interface JobRow { id: string; status: string; title: string; company: string }
interface ChatSourceRow {
  message_id: string;
  conversation_id: string;
  conversation_status: string;
  job_title: string;
  company_name: string;
}

/**
 * A fake PoolClient that dispatches by SQL substring (not call order),
 * mirroring worker-delivery-gateway.test.ts's scriptedClient. It tracks
 * worker_message_intents row status/decision_reason/release_sequence
 * mutations and whatsapp_outbox inserts so assertions can inspect final
 * state as well as the exact call sequence.
 *
 * releaseWorkerReady is caller-owned-transaction (it issues no
 * BEGIN/COMMIT/ROLLBACK of its own — see the RLS review fix) so this fake
 * client intentionally does NOT special-case those statement texts; if the
 * function under test ever issued one, it would fall through to the
 * catch-all branch below and be visible in `calls` for the "no BEGIN/COMMIT"
 * assertions to catch.
 */
function scriptedClient(opts: {
  eventStatus?: string | null;
  eventType?: string;
  intents: IntentRow[];
  jobs?: JobRow[];
  chats?: ChatSourceRow[];
  lifecycle?: string;
  preferredLanguage?: string;
  whatsappNumber?: string | null;
  maxExistingSequence?: number | null;
}) {
  const intents = new Map(opts.intents.map((i) => [i.id, { ...i }]));
  const jobsById = new Map((opts.jobs ?? []).map((j) => [j.id, j]));
  const chatsByMessageId = new Map((opts.chats ?? []).map((c) => [c.message_id, c]));
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const outboxRows: Array<{ id: string; intentId: string; params: unknown[] }> = [];
  // Mirrors the worker_message_intent_dedupe UNIQUE constraint: the
  // onboarding-complete synthesis INSERT is idempotent on dedupe_key.
  const dedupeKeysMaterialized = new Set<string>();
  let outboxSeq = 0;
  let syntheticSeq = 0;

  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });

    if (/FROM worker_domain_outbox/.test(sql)) {
      if (opts.eventStatus === null || opts.eventStatus === undefined) {
        return { rows: [] };
      }
      return {
        rows: [{
          id: 'event-1',
          aggregate_id: WORKER_ID,
          event_type: opts.eventType ?? 'worker.ready',
          status: opts.eventStatus,
        }],
      };
    }

    if (/INSERT INTO worker_message_intents/.test(sql)) {
      const [userId, dedupeKey, , payloadJson] = params as [string, string, number, string];
      if (!dedupeKeysMaterialized.has(dedupeKey)) {
        dedupeKeysMaterialized.add(dedupeKey);
        syntheticSeq += 1;
        const id = `synthetic-onboarding-${syntheticSeq}`;
        intents.set(id, {
          id,
          category: 'onboarding',
          owner_service: 'onboarding-v2',
          source_type: 'onboarding_complete',
          source_id: userId,
          priority: 1,
          payload: JSON.parse(payloadJson),
          expires_at: null,
          created_at: NOW,
          status: 'eligible',
        });
      }
      return { rows: [], rowCount: 0 };
    }

    if (/FROM worker_message_intents/.test(sql) && /FOR UPDATE SKIP LOCKED/.test(sql)) {
      const rows = [...intents.values()].filter(
        (i) => (i.status === 'deferred' || i.status === 'eligible'),
      );
      return { rows };
    }

    if (/UPDATE worker_message_intents/.test(sql) && /status = 'leased'/.test(sql)) {
      const ids = params[0] as string[];
      for (const id of ids) {
        const row = intents.get(id);
        if (row) row.status = 'leased';
      }
      return { rowCount: ids.length, rows: [] };
    }

    if (/FROM worker_onboarding_state/.test(sql)) {
      return {
        rows: [{
          user_id: WORKER_ID,
          lifecycle: opts.lifecycle ?? 'ready',
          run_id: null,
          workflow_version: null,
          current_step_key: null,
          status: null,
          preferred_language: opts.preferredLanguage ?? 'es',
          lock_version: null,
        }],
      };
    }

    if (/FROM whatsapp_runtime_controls/.test(sql)) {
      return {
        rows: [{
          control_key: 'deferred_delivery_enabled',
          enabled: true,
          phone_hashes: [],
          global_enabled: false,
        }],
      };
    }

    if (/FROM jobs WHERE id = ANY/.test(sql)) {
      const ids = params[0] as string[];
      return { rows: ids.map((id) => jobsById.get(id)).filter(Boolean) as JobRow[] };
    }

    if (/FROM job_conversation_messages jcm/.test(sql)) {
      const ids = params[0] as string[];
      return { rows: ids.map((id) => chatsByMessageId.get(id)).filter(Boolean) as ChatSourceRow[] };
    }

    if (/SET status = \$1, decision_reason = \$2/.test(sql)) {
      const [status, reason, id] = params as [string, string, string];
      const row = intents.get(id);
      if (row) {
        row.status = status;
        (row as any).decision_reason = reason;
      }
      return { rowCount: 1, rows: [] };
    }

    if (/SELECT MAX\(release_sequence\)/.test(sql)) {
      return { rows: [{ max: opts.maxExistingSequence ?? null }] };
    }

    if (/SELECT whatsapp_number FROM users/.test(sql)) {
      return { rows: [{ whatsapp_number: opts.whatsappNumber ?? '+15125551234' }] };
    }

    if (/SELECT status FROM worker_message_intents WHERE id = \$1/.test(sql)) {
      const row = intents.get(params[0] as string);
      return { rows: row ? [{ status: row.status }] : [] };
    }

    if (/INSERT INTO whatsapp_outbox/.test(sql)) {
      outboxSeq += 1;
      const outboxId = `outbox-${outboxSeq}`;
      // params: [whatsappNumber, body, contentTemplate, contentVariables, intentId]
      outboxRows.push({ id: outboxId, intentId: params[4] as string, params });
      return { rows: [{ id: outboxId }] };
    }

    if (/SET status = 'released', release_sequence = \$1/.test(sql)) {
      const [sequence, outboxId, id] = params as [number, string | null, string];
      const row = intents.get(id);
      if (row) {
        row.status = 'released';
        (row as any).release_sequence = sequence;
        (row as any).outbox_id = outboxId;
      }
      return { rowCount: 1, rows: [] };
    }

    return { rows: [], rowCount: 0 };
  });

  return { client: { query } as any, calls, intents, outboxRows };
}

function intentRow(overrides: Partial<IntentRow>): IntentRow {
  return {
    id: 'intent-default',
    category: 'job_alert',
    owner_service: 'job-alert',
    source_type: 'job',
    source_id: 'job-1',
    priority: 30,
    payload: {},
    expires_at: null,
    created_at: NOW,
    status: 'eligible',
    ...overrides,
  };
}

function recordingRenderer() {
  const requests: ReleaseRenderRequest[] = [];
  const render = jest.fn(async (request: ReleaseRenderRequest): Promise<ReleaseRenderedMessage> => {
    requests.push(request);
    return { body: `rendered:${request.kind}`, contentTemplate: null, contentVariables: null };
  });
  return { render, requests };
}

describe('releaseWorkerReady', () => {
  it('rejects a wrong-type event before any intent is touched', async () => {
    const { client, calls } = scriptedClient({ intents: [], eventStatus: 'processing', eventType: 'assessment.requested' });
    const { render } = recordingRenderer();

    await expect(releaseWorkerReady(client, EVENT_KEY, { renderer: { render }, now: () => NOW }))
      .rejects.toThrow();

    expect(calls.some((c) => /FROM worker_message_intents/.test(c.sql))).toBe(false);
    expect(render).not.toHaveBeenCalled();
  });

  it('rejects a non-processing event before any intent is touched', async () => {
    const { client, calls } = scriptedClient({ intents: [], eventStatus: 'pending' });
    const { render } = recordingRenderer();

    await expect(releaseWorkerReady(client, EVENT_KEY, { renderer: { render }, now: () => NOW }))
      .rejects.toThrow();

    expect(calls.some((c) => /FROM worker_message_intents/.test(c.sql))).toBe(false);
  });

  it('rejects an unknown event key before any intent is touched', async () => {
    const { client, calls } = scriptedClient({ intents: [], eventStatus: undefined });
    const { render } = recordingRenderer();

    await expect(releaseWorkerReady(client, EVENT_KEY, { renderer: { render }, now: () => NOW }))
      .rejects.toThrow();

    expect(calls.some((c) => /FROM worker_message_intents/.test(c.sql))).toBe(false);
  });

  it('discards a closed job and an expired employer message with recorded reasons', async () => {
    const intents = [
      intentRow({ id: 'ja-closed', category: 'job_alert', source_id: 'job-closed', payload: { score: 5 } }),
      intentRow({
        id: 'ec-expired', category: 'employer_chat', owner_service: 'job-messaging',
        source_type: 'job_conversation_message', source_id: 'msg-expired', priority: 40,
        expires_at: new Date(NOW.getTime() - 1000),
      }),
    ];
    const { client, intents: finalIntents } = scriptedClient({
      eventStatus: 'processing',
      intents,
      jobs: [{ id: 'job-closed', status: 'closed', title: 'T', company: 'C' }],
      chats: [{ message_id: 'msg-expired', conversation_id: 'conv-1', conversation_status: 'open', job_title: 'T', company_name: 'C' }],
    });
    const { render } = recordingRenderer();

    const result = await releaseWorkerReady(client, EVENT_KEY, { renderer: { render }, now: () => NOW });

    // Every valid call also synthesizes and releases the sole group-1
    // onboarding-complete confirmation (see the "always emits" test below) —
    // that accounts for the one `released` here.
    expect(result).toEqual({ released: 1, expired: 1, superseded: 1, failed: 0 });
    expect(finalIntents.get('ja-closed')?.status).toBe('superseded');
    expect((finalIntents.get('ja-closed') as any).decision_reason).toBe('job_not_active');
    expect(finalIntents.get('ec-expired')?.status).toBe('expired');
    expect((finalIntents.get('ec-expired') as any).decision_reason).toBe('intent_expired');
    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith(expect.objectContaining({ kind: 'onboarding_complete' }));
  });

  it('collapses twelve valid job alerts into one job_alert_digest carrying exactly ten jobs, superseding two', async () => {
    const intents = Array.from({ length: 12 }, (_, i) =>
      intentRow({
        id: `ja-${i}`,
        category: 'job_alert',
        source_id: `job-${i}`,
        payload: { score: 12 - i }, // job-0 strongest .. job-11 weakest
        created_at: new Date(NOW.getTime() - i * 1000),
      }));
    const jobs: JobRow[] = Array.from({ length: 12 }, (_, i) => ({
      id: `job-${i}`, status: 'active', title: `Job ${i}`, company: 'ACME',
    }));
    const { client, intents: finalIntents } = scriptedClient({ eventStatus: 'processing', intents, jobs });
    const { render, requests } = recordingRenderer();

    const result = await releaseWorkerReady(client, EVENT_KEY, { renderer: { render }, now: () => NOW });

    // released also includes the one synthesized onboarding-complete intent.
    expect(result.superseded).toBe(2);
    expect(result.released).toBe(11);
    const digestRequests = requests.filter((r) => r.kind === 'job_alert_digest');
    expect(digestRequests).toHaveLength(1);
    const digest = digestRequests[0];
    if (digest.kind === 'job_alert_digest') {
      expect(digest.jobs).toHaveLength(10);
      expect(digest.jobs.map((j) => j.jobId)).toEqual([
        'job-0', 'job-1', 'job-2', 'job-3', 'job-4', 'job-5', 'job-6', 'job-7', 'job-8', 'job-9',
      ]);
    }
    // The two weakest (job-10, job-11) are superseded, not released.
    expect(finalIntents.get('ja-10')?.status).toBe('superseded');
    expect(finalIntents.get('ja-11')?.status).toBe('superseded');
    for (let i = 0; i < 10; i++) {
      expect(finalIntents.get(`ja-${i}`)?.status).toBe('released');
    }
  });

  it('ranks job alerts by the score in the canonical payload jobs array', async () => {
    const intents = [
      intentRow({
        id: 'ja-low',
        source_id: 'job-low',
        payload: {
          jobs: [{
            jobId: 'job-low',
            title: 'Low match',
            companyName: 'ACME',
            score: 1,
          }],
        },
        created_at: new Date(NOW.getTime() + 1000),
      }),
      intentRow({
        id: 'ja-high',
        source_id: 'job-high',
        payload: {
          jobs: [{
            jobId: 'job-high',
            title: 'High match',
            companyName: 'ACME',
            score: 99,
          }],
        },
        created_at: new Date(NOW.getTime() - 1000),
      }),
    ];
    const jobs: JobRow[] = [
      { id: 'job-low', status: 'active', title: 'Low match', company: 'ACME' },
      { id: 'job-high', status: 'active', title: 'High match', company: 'ACME' },
    ];
    const { client } = scriptedClient({ eventStatus: 'processing', intents, jobs });
    const { render, requests } = recordingRenderer();

    await releaseWorkerReady(client, EVENT_KEY, { renderer: { render }, now: () => NOW });

    const digest = requests.find((request) => request.kind === 'job_alert_digest');
    expect(digest).toMatchObject({
      kind: 'job_alert_digest',
      jobs: [
        expect.objectContaining({ jobId: 'job-high', score: 99 }),
        expect.objectContaining({ jobId: 'job-low', score: 1 }),
      ],
    });
  });

  it('renders employer_chat_single for one unread conversation', async () => {
    const intents = [
      intentRow({
        id: 'ec-1', category: 'employer_chat', owner_service: 'job-messaging',
        source_type: 'job_conversation_message', source_id: 'msg-1', priority: 40,
      }),
    ];
    const chats = [{ message_id: 'msg-1', conversation_id: 'conv-1', conversation_status: 'open', job_title: 'Plomero', company_name: 'ACME' }];
    const { client } = scriptedClient({ eventStatus: 'processing', intents, chats });
    const { render, requests } = recordingRenderer();

    await releaseWorkerReady(client, EVENT_KEY, { renderer: { render }, now: () => NOW });

    const singleRequests = requests.filter((r) => r.kind === 'employer_chat_single');
    expect(singleRequests).toHaveLength(1);
    const single = singleRequests[0];
    if (single.kind === 'employer_chat_single') {
      expect(single.conversationId).toBe('conv-1');
      expect(single.companyName).toBe('ACME');
      expect(single.jobTitle).toBe('Plomero');
    }
  });

  it('renders exactly one employer_chat_summary with conversationCount 3 for three unread conversations, never a single', async () => {
    const intents = [1, 2, 3].map((n) =>
      intentRow({
        id: `ec-${n}`, category: 'employer_chat', owner_service: 'job-messaging',
        source_type: 'job_conversation_message', source_id: `msg-${n}`, priority: 40,
      }));
    const chats = [1, 2, 3].map((n) => ({
      message_id: `msg-${n}`, conversation_id: `conv-${n}`, conversation_status: 'open',
      job_title: 'Plomero', company_name: 'ACME',
    }));
    const { client, intents: finalIntents } = scriptedClient({ eventStatus: 'processing', intents, chats });
    const { render, requests } = recordingRenderer();

    await releaseWorkerReady(client, EVENT_KEY, { renderer: { render }, now: () => NOW });

    const summaries = requests.filter((r) => r.kind === 'employer_chat_summary');
    const singles = requests.filter((r) => r.kind === 'employer_chat_single');
    expect(summaries).toHaveLength(1);
    expect(singles).toHaveLength(0);
    if (summaries[0].kind === 'employer_chat_summary') {
      expect(summaries[0].conversationCount).toBe(3);
    }
    const correlatedOutboxIds = intents.map((intent) => (finalIntents.get(intent.id) as any).outbox_id);
    expect(correlatedOutboxIds).toHaveLength(3);
    expect(new Set(correlatedOutboxIds)).toEqual(new Set(['outbox-2']));
  });

  it('records render requests in group order: onboarding -> account -> job digest -> employer', async () => {
    // No 'onboarding'-category intent is injected here — releaseWorkerReady
    // synthesizes the sole group-1 confirmation itself (see the dedicated
    // synthesis test above), matching production where completeOnboarding
    // never creates a worker_message_intents row for it.
    const intents = [
      intentRow({
        id: 'acct-1', category: 'account', owner_service: 'account',
        source_type: 'trust_result', source_id: 'trust-1', priority: 20,
        created_at: new Date(NOW.getTime() - 8000),
      }),
      intentRow({
        id: 'ja-1', category: 'job_alert', source_id: 'job-1', priority: 30,
        payload: { score: 1 }, created_at: new Date(NOW.getTime() - 7000),
      }),
      intentRow({
        id: 'ec-1', category: 'employer_chat', owner_service: 'job-messaging',
        source_type: 'job_conversation_message', source_id: 'msg-1', priority: 40,
        created_at: new Date(NOW.getTime() - 6000),
      }),
    ];
    const jobs = [{ id: 'job-1', status: 'active', title: 'Electricista', company: 'ACME' }];
    const chats = [{ message_id: 'msg-1', conversation_id: 'conv-1', conversation_status: 'open', job_title: 'Electricista', company_name: 'ACME' }];
    const { client } = scriptedClient({ eventStatus: 'processing', intents, jobs, chats });
    const { render, requests } = recordingRenderer();

    await releaseWorkerReady(client, EVENT_KEY, { renderer: { render }, now: () => NOW });

    expect(requests.map((r) => r.kind)).toEqual([
      'onboarding_complete', 'account_notice', 'job_alert_digest', 'employer_chat_single',
    ]);
  });

  it('allocates contiguous, strictly increasing release_sequence values across the whole release', async () => {
    const intents = [
      intentRow({ id: 'ja-1', category: 'job_alert', source_id: 'job-1', priority: 30, payload: { score: 5 } }),
      intentRow({ id: 'ja-2', category: 'job_alert', source_id: 'job-2', priority: 30, payload: { score: 3 } }),
      intentRow({
        id: 'ec-1', category: 'employer_chat', owner_service: 'job-messaging',
        source_type: 'job_conversation_message', source_id: 'msg-1', priority: 40,
      }),
    ];
    const jobs = [
      { id: 'job-1', status: 'active', title: 'A', company: 'C' },
      { id: 'job-2', status: 'active', title: 'B', company: 'C' },
    ];
    const chats = [{ message_id: 'msg-1', conversation_id: 'conv-1', conversation_status: 'open', job_title: 'A', company_name: 'C' }];
    const { client, intents: finalIntents } = scriptedClient({ eventStatus: 'processing', intents, jobs, chats, maxExistingSequence: 5 });
    const { render } = recordingRenderer();

    await releaseWorkerReady(client, EVENT_KEY, { renderer: { render }, now: () => NOW });

    const onboardingId = [...finalIntents.values()].find((i) => i.category === 'onboarding')!.id;
    const sequences = [onboardingId, 'ja-1', 'ja-2', 'ec-1'].map((id) => (finalIntents.get(id) as any).release_sequence);
    expect(sequences).toEqual([6, 7, 8, 9]);
  });

  it('propagates a renderer throw without committing, so the caller\'s transaction rolls back every mutation', async () => {
    // releaseWorkerReady is caller-owned-transaction: it never issues
    // BEGIN/COMMIT/ROLLBACK itself. When a renderer throws, the contract is
    // that this function simply propagates the error and stops — it is the
    // caller's already-open transaction, rolled back by the caller on catch,
    // that actually undoes every worker_message_intents/whatsapp_outbox
    // mutation made here. That real-Postgres rollback behavior is exercised
    // by C9's concurrency/RLS integration suite; this fake-client test can
    // only prove the two things it CAN observe: the error propagates, and no
    // COMMIT (or BEGIN/ROLLBACK) is ever issued by this function, and no
    // outbox/intent mutation happens for any render group after the throw.
    //
    // The synthesized onboarding-complete confirmation renders first
    // (succeeds); the job_alert digest renders second and throws.
    const intents = [
      intentRow({ id: 'ja-1', category: 'job_alert', source_id: 'job-1', priority: 30, payload: { score: 5 } }),
    ];
    const jobs = [{ id: 'job-1', status: 'active', title: 'A', company: 'C' }];
    const { client, calls, intents: finalIntents } = scriptedClient({ eventStatus: 'processing', intents, jobs });
    const render = jest.fn()
      .mockResolvedValueOnce({ body: 'ok', contentTemplate: null, contentVariables: null })
      .mockRejectedValueOnce(new Error('renderer exploded'));

    await expect(releaseWorkerReady(client, EVENT_KEY, { renderer: { render }, now: () => NOW }))
      .rejects.toThrow('renderer exploded');

    expect(calls.some((c) => c.sql === 'BEGIN')).toBe(false);
    expect(calls.some((c) => c.sql === 'COMMIT')).toBe(false);
    expect(calls.some((c) => c.sql === 'ROLLBACK')).toBe(false);
    expect(render).toHaveBeenCalledTimes(2);
    // The job_alert intent never reached 'released' — its group's render
    // threw before the follow-up status update ran, and no outbox insert
    // happened for it either.
    expect(finalIntents.get('ja-1')?.status).toBe('leased');
    const jobAlertOutboxInsert = calls.find((c) =>
      /INSERT INTO whatsapp_outbox/.test(c.sql) && c.params[4] === 'ja-1');
    expect(jobAlertOutboxInsert).toBeUndefined();
  });

  it('issues no BEGIN/COMMIT/ROLLBACK query on the success path either — the caller owns the transaction', async () => {
    const intents = [
      intentRow({ id: 'ja-1', category: 'job_alert', source_id: 'job-1', priority: 30, payload: { score: 5 } }),
    ];
    const jobs = [{ id: 'job-1', status: 'active', title: 'A', company: 'C' }];
    const { client, calls } = scriptedClient({ eventStatus: 'processing', intents, jobs });
    const { render } = recordingRenderer();

    await releaseWorkerReady(client, EVENT_KEY, { renderer: { render }, now: () => NOW });

    expect(calls.some((c) => c.sql === 'BEGIN')).toBe(false);
    expect(calls.some((c) => c.sql === 'COMMIT')).toBe(false);
    expect(calls.some((c) => c.sql === 'ROLLBACK')).toBe(false);
  });

  it('marks a survivor no longer allowed as deferred instead of releasing it', async () => {
    // lifecycle 'onboarding' (not yet 'ready') still allows the synthesized
    // onboarding-complete confirmation — evaluateDelivery treats 'onboarding'
    // category as always-allow, independent of lifecycle — but defers the
    // job_alert intent, which requires lifecycle 'ready'.
    const intents = [
      intentRow({ id: 'ja-1', category: 'job_alert', source_id: 'job-1', priority: 30, payload: { score: 5 } }),
    ];
    const jobs = [{ id: 'job-1', status: 'active', title: 'A', company: 'C' }];
    const { client, intents: finalIntents } = scriptedClient({
      eventStatus: 'processing', intents, jobs, lifecycle: 'onboarding',
    });
    const { render } = recordingRenderer();

    const result = await releaseWorkerReady(client, EVENT_KEY, { renderer: { render }, now: () => NOW });

    expect(result).toEqual({ released: 1, expired: 0, superseded: 0, failed: 0 });
    expect(finalIntents.get('ja-1')?.status).toBe('deferred');
    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith(expect.objectContaining({ kind: 'onboarding_complete' }));
  });

  it('synthesizes exactly one onboarding-complete intent per event, idempotent on retry', async () => {
    const { client, intents: finalIntents } = scriptedClient({ eventStatus: 'processing', intents: [] });
    const { render, requests } = recordingRenderer();

    const result = await releaseWorkerReady(client, EVENT_KEY, { renderer: { render }, now: () => NOW });

    expect(result).toEqual({ released: 1, expired: 0, superseded: 0, failed: 0 });
    expect(requests.map((r) => r.kind)).toEqual(['onboarding_complete']);
    const onboardingIntents = [...finalIntents.values()].filter((i) => i.category === 'onboarding');
    expect(onboardingIntents).toHaveLength(1);
    expect(onboardingIntents[0].status).toBe('released');
  });
});
