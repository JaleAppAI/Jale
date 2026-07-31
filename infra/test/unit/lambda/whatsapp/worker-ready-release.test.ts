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

// location/pay are optional so fixtures predating the referred-job message keep
// passing unchanged; both are nullable on jobs (migration 003).
interface JobRow {
  id: string;
  status: string;
  title: string;
  company: string;
  location?: string | null;
  pay?: string | null;
}
interface ChatSourceRow {
  message_id: string;
  conversation_id: string;
  conversation_status: string;
  job_title: string;
  company_name: string;
  // All three default to the "still eligible" value when omitted, so
  // existing test fixtures that predate these predicates keep passing
  // unchanged.
  job_status?: string;
  application_exists?: boolean;
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
  /** job_ids the worker has already applied to (job_applications rows). */
  appliedJobIds?: string[];
  /** When true, the worker_onboarding_state lookup returns zero rows (loadWorkerGate resolves null). */
  noGateRow?: boolean;
  /** Job id of a claimed referral for this worker; omit for "no referral". */
  referredJobId?: string;
  /** Referrer on that claim. Omit for an untagged arrival (nobody referred them). */
  referrerWorkerId?: string;
}) {
  const intents = new Map(opts.intents.map((i) => [i.id, { ...i }]));
  const jobsById = new Map((opts.jobs ?? []).map((j) => [j.id, j]));
  const chatsByMessageId = new Map((opts.chats ?? []).map((c) => [c.message_id, c]));
  const appliedJobIds = new Set(opts.appliedJobIds ?? []);
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
      // Two group-1 synthesis inserts exist now (onboarding_complete and
      // referred_job) and their parameter orders differ, so key off the
      // source_type literal in the SQL rather than a positional guess.
      const isReferredJob = /'referred_job'/.test(sql);
      const userId = params[0] as string;
      const sourceType = isReferredJob ? 'referred_job' : 'onboarding_complete';
      // referred_job carries the JOB id as source_id so the existing batch
      // `FROM jobs WHERE id = ANY(...)` lookup resolves it with no extra query.
      const sourceId = isReferredJob ? (params[1] as string) : userId;
      const dedupeKey = (isReferredJob ? params[2] : params[1]) as string;
      const payloadJson = (isReferredJob ? params[4] : params[3]) as string;
      if (!dedupeKeysMaterialized.has(dedupeKey)) {
        dedupeKeysMaterialized.add(dedupeKey);
        syntheticSeq += 1;
        const id = `synthetic-${sourceType}-${syntheticSeq}`;
        intents.set(id, {
          id,
          category: 'onboarding',
          owner_service: 'onboarding-v2',
          source_type: sourceType,
          source_id: sourceId,
          priority: isReferredJob ? 2 : 1,
          payload: JSON.parse(payloadJson),
          expires_at: null,
          created_at: NOW,
          status: 'eligible',
        });
      }
      return { rows: [], rowCount: 0 };
    }

    // The referred-job claim the release reads to decide whether to synthesize
    // a second group-1 intent. Absent option => no referral => no second message.
    if (/FROM referral_pending_claims/.test(sql)) {
      return opts.referredJobId
        ? { rows: [{ job_id: opts.referredJobId, referrer_worker_id: opts.referrerWorkerId ?? null }] }
        : { rows: [] };
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
      if (opts.noGateRow) {
        return { rows: [] };
      }
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
      const rows = ids
        .map((id) => chatsByMessageId.get(id))
        .filter(Boolean)
        .map((c) => ({
          ...(c as ChatSourceRow),
          job_status: (c as ChatSourceRow).job_status ?? 'active',
          application_exists: (c as ChatSourceRow).application_exists ?? true,
        }));
      return { rows };
    }

    // job_alert's "already applied" reload — distinct from the employer_chat
    // combined query above, which embeds its own job_applications EXISTS
    // subquery but never matches this substring (no `WHERE worker_id = $1
    // AND job_id = ANY` shape there).
    if (/FROM job_applications WHERE worker_id = \$1 AND job_id = ANY/.test(sql)) {
      const ids = params[1] as string[];
      return { rows: ids.filter((id) => appliedJobIds.has(id)).map((id) => ({ job_id: id })) };
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

  // ── O2: release-time eligibility reload ──────────────────────────

  describe('referred job (migration 056)', () => {
    it('sends a second message naming the referred job when it is still active', async () => {
      const { client } = scriptedClient({
        eventStatus: 'processing',
        intents: [],
        referredJobId: 'job-ref',
        referrerWorkerId: 'maria-1',
        jobs: [{ id: 'job-ref', status: 'active', title: 'Framer', company: 'Acme', location: 'Austin, TX', pay: '$22-26/hr' }],
      });
      const { render, requests } = recordingRenderer();

      const result = await releaseWorkerReady(client, EVENT_KEY, { renderer: { render }, now: () => NOW });

      // Group 1 must now carry BOTH: the welcome and the referred job. If the
      // referred-job intent were superseded (the pre-change "at most one"
      // behaviour) the worker would never hear about the job they came for.
      expect(result.superseded).toBe(0);
      expect(requests.map((r) => r.kind)).toEqual(['onboarding_complete', 'referred_job']);
      const referred = requests.find((r) => r.kind === 'referred_job') as Extract<ReleaseRenderRequest, { kind: 'referred_job' }>;
      expect(referred.job).toMatchObject({
        jobId: 'job-ref', title: 'Framer', companyName: 'Acme', location: 'Austin, TX', pay: '$22-26/hr',
      });
      expect(referred.referred).toBe(true);
    });

    it('does not claim a friend referred them when the claim carries no referrer', async () => {
      // A visitor can open the public page with no share tag and tap Apply
      // themselves. The claim is real, the job is right, but nobody referred
      // them -- "a friend referred you" would be a lie to that person.
      const { client } = scriptedClient({
        eventStatus: 'processing',
        intents: [],
        referredJobId: 'job-organic',
        // no referrerWorkerId
        jobs: [{ id: 'job-organic', status: 'active', title: 'Framer', company: 'Acme' }],
      });
      const { render, requests } = recordingRenderer();

      await releaseWorkerReady(client, EVENT_KEY, { renderer: { render }, now: () => NOW });

      const referred = requests.find((r) => r.kind === 'referred_job') as Extract<ReleaseRenderRequest, { kind: 'referred_job' }>;
      expect(referred).toBeDefined();
      expect(referred.referred).toBe(false);
      expect(referred.job).toMatchObject({ jobId: 'job-organic' });
    });

    it('sends the honest "already taken" variant when the referred job is no longer active', async () => {
      const { client } = scriptedClient({
        eventStatus: 'processing',
        intents: [],
        referredJobId: 'job-gone',
        jobs: [{ id: 'job-gone', status: 'filled', title: 'Framer', company: 'Acme' }],
      });
      const { render, requests } = recordingRenderer();

      await releaseWorkerReady(client, EVENT_KEY, { renderer: { render }, now: () => NOW });

      const referred = requests.find((r) => r.kind === 'referred_job') as Extract<ReleaseRenderRequest, { kind: 'referred_job' }>;
      expect(referred).toBeDefined();
      // job: null is what makes the renderer choose the "filled" copy. Sending
      // nothing would leave the worker wondering what happened to the job.
      expect(referred.job).toBeNull();
    });

    it('sends only the welcome when the worker has no referral claim', async () => {
      const { client } = scriptedClient({ eventStatus: 'processing', intents: [] });
      const { render, requests } = recordingRenderer();

      await releaseWorkerReady(client, EVENT_KEY, { renderer: { render }, now: () => NOW });

      expect(requests.map((r) => r.kind)).toEqual(['onboarding_complete']);
    });

    it('still collapses two intents of the SAME source_type to one', async () => {
      // The per-source_type split must not weaken the original guarantee: a
      // duplicate onboarding_complete is still superseded, not sent twice.
      const intents = [
        intentRow({
          id: 'oc-dup', category: 'onboarding', owner_service: 'onboarding-v2',
          source_type: 'onboarding_complete', source_id: WORKER_ID, priority: 1,
          payload: { kind: 'onboarding_complete' },
        }),
      ];
      const { client, intents: finalIntents } = scriptedClient({ eventStatus: 'processing', intents });
      const { render, requests } = recordingRenderer();

      const result = await releaseWorkerReady(client, EVENT_KEY, { renderer: { render }, now: () => NOW });

      expect(requests.filter((r) => r.kind === 'onboarding_complete')).toHaveLength(1);
      expect(result.superseded).toBe(1);
      const dup = finalIntents.get('oc-dup');
      const synthetic = [...finalIntents.values()].find((i) => i.id.startsWith('synthetic-onboarding_complete'));
      // Exactly one of the two survives; the other is superseded.
      expect([dup?.status, synthetic?.status].filter((s) => s === 'superseded')).toHaveLength(1);
    });
  });

  describe('job_alert release-time eligibility', () => {
    it('discards a job_alert intent for a suspended worker with worker_not_ready, never rendering it', async () => {
      const intents = [
        intentRow({ id: 'ja-1', category: 'job_alert', source_id: 'job-1', priority: 30, payload: { score: 5 } }),
      ];
      const jobs = [{ id: 'job-1', status: 'active', title: 'A', company: 'C' }];
      const { client, intents: finalIntents, outboxRows } = scriptedClient({
        eventStatus: 'processing', intents, jobs, lifecycle: 'suspended',
      });
      const { render } = recordingRenderer();

      await releaseWorkerReady(client, EVENT_KEY, { renderer: { render }, now: () => NOW });

      expect(finalIntents.get('ja-1')?.status).toBe('superseded');
      expect((finalIntents.get('ja-1') as any).decision_reason).toBe('worker_not_ready');
      const jobAlertRequests = (render.mock.calls as any[]).map((c) => c[0]).filter((r) => r.kind === 'job_alert_digest');
      expect(jobAlertRequests).toHaveLength(0);
      expect(outboxRows.some((r) => r.intentId === 'ja-1')).toBe(false);
    });

    it('discards a job_alert intent with no gate row at all with worker_not_ready', async () => {
      const intents = [
        intentRow({ id: 'ja-1', category: 'job_alert', source_id: 'job-1', priority: 30, payload: { score: 5 } }),
      ];
      const jobs = [{ id: 'job-1', status: 'active', title: 'A', company: 'C' }];
      const { client, intents: finalIntents, outboxRows } = scriptedClient({
        eventStatus: 'processing', intents, jobs, noGateRow: true,
      });
      const { render } = recordingRenderer();

      await releaseWorkerReady(client, EVENT_KEY, { renderer: { render }, now: () => NOW });

      expect(finalIntents.get('ja-1')?.status).toBe('superseded');
      expect((finalIntents.get('ja-1') as any).decision_reason).toBe('worker_not_ready');
      expect(outboxRows.some((r) => r.intentId === 'ja-1')).toBe(false);
    });

    it('discards a job_alert intent the worker already applied to with worker_already_applied', async () => {
      const intents = [
        intentRow({ id: 'ja-1', category: 'job_alert', source_id: 'job-1', priority: 30, payload: { score: 5 } }),
      ];
      const jobs = [{ id: 'job-1', status: 'active', title: 'A', company: 'C' }];
      const { client, intents: finalIntents, outboxRows } = scriptedClient({
        eventStatus: 'processing', intents, jobs, appliedJobIds: ['job-1'],
      });
      const { render } = recordingRenderer();

      await releaseWorkerReady(client, EVENT_KEY, { renderer: { render }, now: () => NOW });

      expect(finalIntents.get('ja-1')?.status).toBe('superseded');
      expect((finalIntents.get('ja-1') as any).decision_reason).toBe('worker_already_applied');
      const jobAlertRequests = (render.mock.calls as any[]).map((c) => c[0]).filter((r) => r.kind === 'job_alert_digest');
      expect(jobAlertRequests).toHaveLength(0);
      expect(outboxRows.some((r) => r.intentId === 'ja-1')).toBe(false);
    });

    it('still releases a job_alert intent for a ready worker who has not applied (happy path)', async () => {
      const intents = [
        intentRow({ id: 'ja-1', category: 'job_alert', source_id: 'job-1', priority: 30, payload: { score: 5 } }),
      ];
      const jobs = [{ id: 'job-1', status: 'active', title: 'A', company: 'C' }];
      const { client, intents: finalIntents } = scriptedClient({
        eventStatus: 'processing', intents, jobs, lifecycle: 'ready', appliedJobIds: [],
      });
      const { render, requests } = recordingRenderer();

      await releaseWorkerReady(client, EVENT_KEY, { renderer: { render }, now: () => NOW });

      expect(finalIntents.get('ja-1')?.status).toBe('released');
      expect(requests.some((r) => r.kind === 'job_alert_digest')).toBe(true);
    });
  });

  describe('employer_chat release-time eligibility', () => {
    it('discards an employer_chat intent whose message no longer exists with message_missing', async () => {
      const intents = [
        intentRow({
          id: 'ec-1', category: 'employer_chat', owner_service: 'job-messaging',
          source_type: 'job_conversation_message', source_id: 'msg-gone', priority: 40,
        }),
      ];
      const { client, intents: finalIntents, outboxRows } = scriptedClient({ eventStatus: 'processing', intents, chats: [] });
      const { render } = recordingRenderer();

      await releaseWorkerReady(client, EVENT_KEY, { renderer: { render }, now: () => NOW });

      expect(finalIntents.get('ec-1')?.status).toBe('superseded');
      expect((finalIntents.get('ec-1') as any).decision_reason).toBe('message_missing');
      expect(render.mock.calls.some((c: any[]) => c[0].kind !== 'onboarding_complete')).toBe(false);
      expect(outboxRows.some((r) => r.intentId === 'ec-1')).toBe(false);
    });

    it('discards an employer_chat intent for a closed job with job_not_active', async () => {
      const intents = [
        intentRow({
          id: 'ec-1', category: 'employer_chat', owner_service: 'job-messaging',
          source_type: 'job_conversation_message', source_id: 'msg-1', priority: 40,
        }),
      ];
      const chats = [{
        message_id: 'msg-1', conversation_id: 'conv-1', conversation_status: 'open',
        job_title: 'Plomero', company_name: 'ACME', job_status: 'closed',
      }];
      const { client, intents: finalIntents, outboxRows } = scriptedClient({ eventStatus: 'processing', intents, chats });
      const { render } = recordingRenderer();

      await releaseWorkerReady(client, EVENT_KEY, { renderer: { render }, now: () => NOW });

      expect(finalIntents.get('ec-1')?.status).toBe('superseded');
      expect((finalIntents.get('ec-1') as any).decision_reason).toBe('job_not_active');
      expect(outboxRows.some((r) => r.intentId === 'ec-1')).toBe(false);
    });

    // Regression guard (C9 concurrency gate scenario 5): the employer_chat
    // eligibility reload must NEVER predicate on a `users` row. The drain runs
    // as `jale_whatsapp`, whose only users policy is
    // `wa_users_read USING (user_type = 'worker')`, so an employer row is
    // invisible under RLS — any users-based employer predicate is
    // unconditionally false in production and silently discards every
    // employer_chat release. Employer existence is instead guaranteed
    // structurally (job_conversations.employer_id FK ON DELETE RESTRICT,
    // jobs.employer_id FK ON DELETE CASCADE). A fake client cannot model RLS,
    // so this asserts the SQL shape directly.
    it('never joins users for employer eligibility (RLS would make it always-false)', async () => {
      const intents = [
        intentRow({
          id: 'ec-1', category: 'employer_chat', owner_service: 'job-messaging',
          source_type: 'job_conversation_message', source_id: 'msg-1', priority: 40,
        }),
      ];
      const chats = [{
        message_id: 'msg-1', conversation_id: 'conv-1', conversation_status: 'open',
        job_title: 'Plomero', company_name: 'ACME',
      }];
      const { client, calls, intents: finalIntents } = scriptedClient({ eventStatus: 'processing', intents, chats });
      const { render } = recordingRenderer();

      await releaseWorkerReady(client, EVENT_KEY, { renderer: { render }, now: () => NOW });

      const chatReload = calls.find((c) => /FROM job_conversation_messages jcm/.test(c.sql));
      expect(chatReload).toBeDefined();
      expect(chatReload!.sql).not.toMatch(/\busers\b/);
      // …and the intent still releases on the happy path.
      expect(finalIntents.get('ec-1')?.status).toBe('released');
    });

    it('discards an employer_chat intent for a suspended worker with worker_not_ready', async () => {
      const intents = [
        intentRow({
          id: 'ec-1', category: 'employer_chat', owner_service: 'job-messaging',
          source_type: 'job_conversation_message', source_id: 'msg-1', priority: 40,
        }),
      ];
      const chats = [{
        message_id: 'msg-1', conversation_id: 'conv-1', conversation_status: 'open',
        job_title: 'Plomero', company_name: 'ACME',
      }];
      const { client, intents: finalIntents, outboxRows } = scriptedClient({
        eventStatus: 'processing', intents, chats, lifecycle: 'suspended',
      });
      const { render } = recordingRenderer();

      await releaseWorkerReady(client, EVENT_KEY, { renderer: { render }, now: () => NOW });

      expect(finalIntents.get('ec-1')?.status).toBe('superseded');
      expect((finalIntents.get('ec-1') as any).decision_reason).toBe('worker_not_ready');
      expect(outboxRows.some((r) => r.intentId === 'ec-1')).toBe(false);
    });

    it('discards an employer_chat intent with no application on file with application_missing', async () => {
      const intents = [
        intentRow({
          id: 'ec-1', category: 'employer_chat', owner_service: 'job-messaging',
          source_type: 'job_conversation_message', source_id: 'msg-1', priority: 40,
        }),
      ];
      const chats = [{
        message_id: 'msg-1', conversation_id: 'conv-1', conversation_status: 'open',
        job_title: 'Plomero', company_name: 'ACME', application_exists: false,
      }];
      const { client, intents: finalIntents, outboxRows } = scriptedClient({ eventStatus: 'processing', intents, chats });
      const { render } = recordingRenderer();

      await releaseWorkerReady(client, EVENT_KEY, { renderer: { render }, now: () => NOW });

      expect(finalIntents.get('ec-1')?.status).toBe('superseded');
      expect((finalIntents.get('ec-1') as any).decision_reason).toBe('application_missing');
      expect(outboxRows.some((r) => r.intentId === 'ec-1')).toBe(false);
    });

    it('discards an employer_chat intent for a closed conversation with conversation_closed', async () => {
      const intents = [
        intentRow({
          id: 'ec-1', category: 'employer_chat', owner_service: 'job-messaging',
          source_type: 'job_conversation_message', source_id: 'msg-1', priority: 40,
        }),
      ];
      const chats = [{
        message_id: 'msg-1', conversation_id: 'conv-1', conversation_status: 'closed',
        job_title: 'Plomero', company_name: 'ACME',
      }];
      const { client, intents: finalIntents, outboxRows } = scriptedClient({ eventStatus: 'processing', intents, chats });
      const { render } = recordingRenderer();

      await releaseWorkerReady(client, EVENT_KEY, { renderer: { render }, now: () => NOW });

      expect(finalIntents.get('ec-1')?.status).toBe('superseded');
      expect((finalIntents.get('ec-1') as any).decision_reason).toBe('conversation_closed');
      expect(outboxRows.some((r) => r.intentId === 'ec-1')).toBe(false);
    });

    it('still releases an employer_chat intent when the job is active, employer exists, worker is ready, and an application is on file (happy path)', async () => {
      const intents = [
        intentRow({
          id: 'ec-1', category: 'employer_chat', owner_service: 'job-messaging',
          source_type: 'job_conversation_message', source_id: 'msg-1', priority: 40,
        }),
      ];
      const chats = [{
        message_id: 'msg-1', conversation_id: 'conv-1', conversation_status: 'open',
        job_title: 'Plomero', company_name: 'ACME',
        job_status: 'active', application_exists: true,
      }];
      const { client, intents: finalIntents } = scriptedClient({ eventStatus: 'processing', intents, chats });
      const { render, requests } = recordingRenderer();

      await releaseWorkerReady(client, EVENT_KEY, { renderer: { render }, now: () => NOW });

      expect(finalIntents.get('ec-1')?.status).toBe('released');
      expect(requests.some((r) => r.kind === 'employer_chat_single')).toBe(true);
    });
  });
});
