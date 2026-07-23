import type { PoolClient } from 'pg';
import type {
  IntentStatus,
  MessageCategory,
  PreferredLanguage,
  ReleaseRenderRequest,
  ReleaseRenderedMessage,
  ReleaseRenderer,
} from './lib/onboarding-types';
import { DELIVERY_POLICY_VERSION } from './lib/onboarding-types';
import { loadWorkerGate, type WorkerGate } from './lib/onboarding-repository';
import { loadRuntimeControls } from './lib/runtime-controls';
import { evaluateDelivery } from './lib/delivery-policy';
import { insertAuthorizedIntentOutbox } from './lib/outbox';

// Renderer contracts (ReleaseRenderRequest/ReleaseRenderedMessage/ReleaseRenderer) are
// owned by C2 in onboarding-types.ts per Binding Resolution #6. This module imports
// them and never redeclares or defaults any worker-facing copy — see the plan's
// "Renderer ownership decision (binding)".

/** Codex-owned: the shape of one job inside a job_alert_digest render request. */
export interface ReleaseJobSummary {
  jobId: string;
  title: string;
  companyName: string;
  score: number;
}

export interface ReleaseDeps {
  renderer: ReleaseRenderer;
  now?: () => Date;
}

const LEASE_DURATION_MS = 5 * 60 * 1000;
const JOB_ALERT_DIGEST_CAP = 10;
const GROUPED_CATEGORIES: MessageCategory[] = ['onboarding', 'account', 'job_alert', 'employer_chat'];

interface LeasedIntentRow {
  id: string;
  category: MessageCategory;
  owner_service: string;
  source_type: string;
  source_id: string;
  priority: number;
  payload: Record<string, unknown> | null;
  expires_at: Date | string | null;
  created_at: Date | string;
}

interface WorkingIntent {
  id: string;
  category: MessageCategory;
  ownerService: string;
  sourceType: string;
  sourceId: string;
  priority: number;
  payload: Record<string, unknown>;
  expiresAt: Date | null;
  createdAt: Date;
}

function readJobAlertScore(intent: WorkingIntent): number {
  const jobs = intent.payload.jobs;
  if (Array.isArray(jobs)) {
    const matchingJob = jobs.find(
      (candidate): candidate is Record<string, unknown> =>
        typeof candidate === 'object'
        && candidate !== null
        && candidate.jobId === intent.sourceId,
    );
    if (matchingJob && typeof matchingJob.score === 'number') {
      return matchingJob.score;
    }
  }

  // Preserve compatibility with intents queued before the canonical jobs[] payload.
  return typeof intent.payload.score === 'number' ? intent.payload.score : 0;
}

// evaluateDelivery's 'allow' action is handled separately (the intent survives);
// this maps its other three actions onto the corresponding worker_message_intents
// status.
const STATUS_BY_NON_ALLOW_ACTION: Record<'defer' | 'reject' | 'expire', IntentStatus> = {
  defer: 'deferred',
  reject: 'rejected',
  expire: 'expired',
};

// The eligibility reload's "worker still ready" predicate (job_alert,
// employer_chat). `WorkerLifecycle` is exactly 'onboarding' | 'ready' |
// 'suspended' (onboarding-types.ts). 'onboarding' is intentionally exempted
// here — that transient pre-ready state is already handled by
// evaluateDelivery's own `lifecycle === 'onboarding'` -> defer/'worker_onboarding'
// path (see the "marks a survivor no longer allowed as deferred" test), so a
// worker mid-onboarding must keep deferring, not get permanently superseded.
// This predicate only fires for a genuinely non-ready, non-transient state:
// 'suspended', or no gate row at all (gate === null).
function isWorkerNotReadyForRelease(gate: WorkerGate | null): boolean {
  const lifecycle = gate?.lifecycle;
  return lifecycle !== 'ready' && lifecycle !== 'onboarding';
}

function toDate(value: Date | string | null): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}

function withinGroupOrder(list: WorkingIntent[]): WorkingIntent[] {
  return [...list].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
}

interface RenderPlanEntry {
  request: ReleaseRenderRequest;
  intents: WorkingIntent[];
}

/**
 * Groups and releases a worker's deferred/eligible business-message intents once a
 * `worker.ready` domain event has been leased by the caller (C7's scheduled drain via
 * `lease_worker_domain_events`). This function never calls that lease function itself
 * and never talks to Twilio — it only renders (via the injected `deps.renderer`) and
 * authorizes `whatsapp_outbox` rows for the existing sweepers/dispatchers to send.
 *
 * Ownership/errors: the caller owns the transaction — this function issues no
 * `BEGIN`/`COMMIT`/`ROLLBACK` of its own, matching the `completeOnboarding` /
 * `loadWorkerGate` / `insertAuthorizedIntentOutbox` convention used elsewhere in this
 * lane. On any error (including a renderer throwing) this function simply throws; it
 * is the caller's already-open transaction rolling back that undoes every intent and
 * outbox mutation made here.
 *
 * RLS precondition (required, not optional): `worker_message_intents`,
 * `worker_domain_outbox`, `worker_onboarding_state`, and `worker_workflow_runs` are
 * all under `FORCE ROW LEVEL SECURITY` with worker-scoped policies keyed on
 * `app.current_internal_user_id`. The caller MUST call
 * `setInternalUserRlsContext(client, workerId)` — with `workerId` taken from the
 * already-leased event's `aggregate_id` returned by `lease_worker_domain_events` —
 * inside its open transaction BEFORE calling this function. This function cannot set
 * that context itself: it would need `workerId` first, and even the defense-in-depth
 * event re-read below is itself RLS-gated by `aggregate_id = current_setting(...)`. If
 * the context is missing or wrong, every worker-scoped read here returns zero rows
 * (an RLS policy comparing against a NULL/absent setting matches nothing) and the
 * event re-read below fails closed with `worker_ready_event_not_claimed` — this
 * function never silently "succeeds" with zero rows leased.
 */
export async function releaseWorkerReady(
  client: PoolClient,
  eventKey: string,
  deps: ReleaseDeps,
): Promise<{ released: number; expired: number; superseded: number; failed: number }> {
  const now = deps.now ? deps.now() : new Date();

  const eventResult = await client.query<{
    id: string;
    aggregate_id: string;
    event_type: string;
    status: string;
  }>(
    `SELECT id, aggregate_id, event_type, status
       FROM worker_domain_outbox
      WHERE event_key = $1`,
    [eventKey],
  );
  const event = eventResult.rows[0];
  if (!event || event.event_type !== 'worker.ready' || event.status !== 'processing') {
    throw new Error('worker_ready_event_not_claimed');
  }
  const workerId = event.aggregate_id;

  // `completeOnboarding` (C4, onboarding-repository.ts) intentionally does
  // NOT create a worker_message_intents row for the onboarding-complete
  // confirmation — it only writes the `assessment.requested` /
  // `worker.ready` domain events (Resolution #5: "the workflow lane does
  // not enqueue a ready confirmation after answer three"). This function
  // is what emits it, synthesizing the one group-1 intent itself, gated by
  // a stable per-worker dedupe key so a retried/duplicate worker.ready
  // event can never produce a second confirmation: once this row has been
  // leased and released once, it is no longer 'deferred'/'eligible' and
  // this INSERT's ON CONFLICT DO NOTHING leaves it alone.
  await client.query(
    `INSERT INTO worker_message_intents
        (user_id, category, owner_service, source_type, source_id, dedupe_key,
         priority, status, policy_version, payload, expires_at)
     VALUES ($1, 'onboarding', 'onboarding-v2', 'onboarding_complete', $1, $2,
             1, 'eligible', $3, $4::jsonb, NULL)
     ON CONFLICT ON CONSTRAINT worker_message_intent_dedupe DO NOTHING`,
    [
      workerId,
      `onboarding-complete:${workerId}`,
      DELIVERY_POLICY_VERSION,
      JSON.stringify({ kind: 'onboarding_complete' }),
    ],
  );

  // ── Step 2: lease this worker's not-yet-materialized business intents ──
  // `outbox_id IS NULL` excludes anything enqueueWorkerMessage already rendered
  // and authorized inline (onboarding/security intents with a registered
  // CategoryRenderer never reach here). `security` is excluded outright — it is
  // not part of the grouped release per the plan's release-group table.
  const leaseResult = await client.query<LeasedIntentRow>(
    `SELECT id, category, owner_service, source_type, source_id, priority,
            payload, expires_at, created_at
       FROM worker_message_intents
      WHERE user_id = $1
        AND status IN ('deferred', 'eligible')
        AND outbox_id IS NULL
        AND category = ANY($2::text[])
      FOR UPDATE SKIP LOCKED`,
    [workerId, GROUPED_CATEGORIES],
  );

  const leasedUntil = new Date(now.getTime() + LEASE_DURATION_MS);
  if (leaseResult.rows.length > 0) {
    await client.query(
      `UPDATE worker_message_intents
          SET status = 'leased', leased_until = $2, updated_at = now()
        WHERE id = ANY($1::uuid[])`,
      [leaseResult.rows.map((r) => r.id), leasedUntil],
    );
  }

  const working: WorkingIntent[] = leaseResult.rows.map((r) => ({
    id: r.id,
    category: r.category,
    ownerService: r.owner_service,
    sourceType: r.source_type,
    sourceId: r.source_id,
    priority: r.priority,
    payload: r.payload ?? {},
    expiresAt: toDate(r.expires_at),
    createdAt: toDate(r.created_at) ?? now,
  }));

  let expired = 0;
  let superseded = 0;
  let failed = 0;

  async function discard(intent: WorkingIntent, status: IntentStatus, reason: string): Promise<void> {
    await client.query(
      `UPDATE worker_message_intents
          SET status = $1, decision_reason = $2, updated_at = now()
        WHERE id = $3`,
      [status, reason, intent.id],
    );
  }

  const gate = await loadWorkerGate(client, workerId);
  const controls = await loadRuntimeControls(client);

  // ── Step 3: reload live source rows — never trust the stored payload for
  // eligibility. ──
  const jobAlertIntents = working.filter((i) => i.category === 'job_alert');
  const jobRows = jobAlertIntents.length
    ? (
        await client.query<{ id: string; status: string; title: string; company: string }>(
          `SELECT id, status, title, company FROM jobs WHERE id = ANY($1::uuid[])`,
          [jobAlertIntents.map((i) => i.sourceId)],
        )
      ).rows
    : [];
  const jobById = new Map(jobRows.map((r) => [r.id, r]));

  // Mirrors the producer's own dedup guard (job-alert.ts:101-104): a worker
  // who has since applied to the job no longer needs the alert.
  const appliedJobRows = jobAlertIntents.length
    ? (
        await client.query<{ job_id: string }>(
          `SELECT job_id FROM job_applications WHERE worker_id = $1 AND job_id = ANY($2::uuid[])`,
          [workerId, jobAlertIntents.map((i) => i.sourceId)],
        )
      ).rows
    : [];
  const appliedJobIds = new Set(appliedJobRows.map((r) => r.job_id));

  const employerChatIntents = working.filter((i) => i.category === 'employer_chat');
  const chatRows = employerChatIntents.length
    ? (
        await client.query<{
          message_id: string;
          conversation_id: string;
          conversation_status: string;
          job_status: string;
          job_title: string;
          company_name: string;
          employer_exists: boolean;
          application_exists: boolean;
        }>(
          `SELECT jcm.id AS message_id,
                  jc.id AS conversation_id,
                  jc.status AS conversation_status,
                  j.status AS job_status,
                  j.title AS job_title,
                  employer_display_name(jc.employer_id) AS company_name,
                  (eu.id IS NOT NULL) AS employer_exists,
                  EXISTS (
                    SELECT 1 FROM job_applications ja
                     WHERE ja.job_id = jc.job_id AND ja.worker_id = $2
                  ) AS application_exists
             FROM job_conversation_messages jcm
             JOIN job_conversations jc ON jc.id = jcm.conversation_id
             JOIN jobs j ON j.id = jc.job_id
             LEFT JOIN users eu ON eu.id = jc.employer_id
            WHERE jcm.id = ANY($1::uuid[])`,
          [employerChatIntents.map((i) => i.sourceId), workerId],
        )
      ).rows
    : [];
  const chatByMessageId = new Map(chatRows.map((r) => [r.message_id, r]));

  // ── Step 3 (cont'd) / Step 4: discard ineligible source rows, then re-run
  // evaluateDelivery for the rest. ──
  const survivors: WorkingIntent[] = [];
  for (const intent of working) {
    if (intent.category === 'job_alert') {
      const job = jobById.get(intent.sourceId);
      if (!job || job.status !== 'active') {
        await discard(intent, 'superseded', 'job_not_active');
        superseded++;
        continue;
      }
      if (isWorkerNotReadyForRelease(gate)) {
        await discard(intent, 'superseded', 'worker_not_ready');
        superseded++;
        continue;
      }
      if (appliedJobIds.has(intent.sourceId)) {
        await discard(intent, 'superseded', 'worker_already_applied');
        superseded++;
        continue;
      }
    } else if (intent.category === 'employer_chat') {
      const chat = chatByMessageId.get(intent.sourceId);
      if (!chat) {
        await discard(intent, 'superseded', 'message_missing');
        superseded++;
        continue;
      }
      if (chat.job_status !== 'active') {
        await discard(intent, 'superseded', 'job_not_active');
        superseded++;
        continue;
      }
      if (!chat.employer_exists) {
        await discard(intent, 'superseded', 'employer_missing');
        superseded++;
        continue;
      }
      if (isWorkerNotReadyForRelease(gate)) {
        await discard(intent, 'superseded', 'worker_not_ready');
        superseded++;
        continue;
      }
      if (!chat.application_exists) {
        await discard(intent, 'superseded', 'application_missing');
        superseded++;
        continue;
      }
      if (chat.conversation_status !== 'open') {
        await discard(intent, 'superseded', 'conversation_closed');
        superseded++;
        continue;
      }
    }

    const decision = evaluateDelivery(
      {
        lifecycle: gate?.lifecycle ?? 'onboarding',
        category: intent.category,
        ownerService: intent.ownerService as never,
        controls,
        expiresAt: intent.expiresAt,
      },
      now,
    );

    if (decision.action === 'allow') {
      survivors.push(intent);
      continue;
    }

    const status = STATUS_BY_NON_ALLOW_ACTION[decision.action];
    await discard(intent, status, decision.reason);
    if (decision.action === 'expire') expired++;
    else if (decision.action === 'reject') failed++;
    // 'defer' intentionally does not count toward expired/superseded/failed —
    // the intent simply returns to the deferred pool for a future release.
  }

  // ── Group 1: onboarding — at most one. ──
  const onboardingSurvivors = survivors.filter((i) => i.category === 'onboarding');
  let onboardingKept: WorkingIntent[] = [];
  if (onboardingSurvivors.length > 0) {
    const sorted = withinGroupOrder(onboardingSurvivors);
    onboardingKept = [sorted[0]];
    for (const extra of sorted.slice(1)) {
      await discard(extra, 'superseded', 'onboarding_already_confirmed');
      superseded++;
    }
  }

  // ── Group 2: account — newest intent per sourceType wins. ──
  const accountSurvivors = survivors.filter((i) => i.category === 'account');
  const bySourceType = new Map<string, WorkingIntent[]>();
  for (const intent of accountSurvivors) {
    const list = bySourceType.get(intent.sourceType) ?? [];
    list.push(intent);
    bySourceType.set(intent.sourceType, list);
  }
  const accountKept: WorkingIntent[] = [];
  for (const list of bySourceType.values()) {
    const sorted = [...list].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    accountKept.push(sorted[0]);
    for (const extra of sorted.slice(1)) {
      await discard(extra, 'superseded', 'account_notice_superseded');
      superseded++;
    }
  }

  // ── Group 3: job_alert — at most the ten strongest still-valid matches. ──
  const jobAlertSurvivors = survivors.filter((i) => i.category === 'job_alert');
  const jobAlertSorted = [...jobAlertSurvivors].sort((a, b) => {
    const scoreA = readJobAlertScore(a);
    const scoreB = readJobAlertScore(b);
    if (scoreB !== scoreA) return scoreB - scoreA;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
  const jobAlertKept = jobAlertSorted.slice(0, JOB_ALERT_DIGEST_CAP);
  for (const extra of jobAlertSorted.slice(JOB_ALERT_DIGEST_CAP)) {
    await discard(extra, 'superseded', 'job_alert_capacity_exceeded');
    superseded++;
  }

  // ── Group 4: employer_chat — released last; single vs summary decided below. ──
  const employerChatKept = survivors.filter((i) => i.category === 'employer_chat');

  // ── Step 5: allocate one contiguous per-worker release_sequence block, in
  // group order, then within a group by priority then created_at. ──
  const maxSeqResult = await client.query<{ max: number | null }>(
    `SELECT MAX(release_sequence) AS max FROM worker_message_intents WHERE user_id = $1`,
    [workerId],
  );
  let nextSequence = (maxSeqResult.rows[0]?.max ?? 0) + 1;

  const orderedGroups = [
    withinGroupOrder(onboardingKept),
    withinGroupOrder(accountKept),
    withinGroupOrder(jobAlertKept),
    withinGroupOrder(employerChatKept),
  ];
  const sequenceByIntentId = new Map<string, number>();
  for (const group of orderedGroups) {
    for (const intent of group) {
      sequenceByIntentId.set(intent.id, nextSequence);
      nextSequence += 1;
    }
  }

  // ── Step 6: build the render plan in group order, then render + authorize. ──
  const language: PreferredLanguage = gate?.preferredLanguage ?? 'es';
  const renderPlan: RenderPlanEntry[] = [];

  if (onboardingKept.length > 0) {
    renderPlan.push({
      request: { kind: 'onboarding_complete', workerId, language },
      intents: withinGroupOrder(onboardingKept),
    });
  }

  for (const intent of withinGroupOrder(accountKept)) {
    renderPlan.push({
      request: {
        kind: 'account_notice',
        workerId,
        language,
        sourceType: intent.sourceType,
        sourceId: intent.sourceId,
      },
      intents: [intent],
    });
  }

  if (jobAlertKept.length > 0) {
    // The digest's `jobs` array is ordered strongest-first (jobAlertKept is
    // already sorted by score desc / created_at desc from the capacity-cap
    // step above) — a display ordering, distinct from the priority/created_at
    // ordering `withinGroupOrder` applies for release_sequence allocation.
    const jobs: ReleaseJobSummary[] = jobAlertKept.map((intent) => {
      const job = jobById.get(intent.sourceId)!;
      const score = readJobAlertScore(intent);
      return { jobId: intent.sourceId, title: job.title, companyName: job.company, score };
    });
    renderPlan.push({
      request: { kind: 'job_alert_digest', workerId, language, jobs },
      intents: withinGroupOrder(jobAlertKept),
    });
  }

  const orderedChats = withinGroupOrder(employerChatKept);
  if (orderedChats.length === 1) {
    const intent = orderedChats[0];
    const chat = chatByMessageId.get(intent.sourceId)!;
    renderPlan.push({
      request: {
        kind: 'employer_chat_single',
        workerId,
        language,
        conversationId: chat.conversation_id,
        companyName: chat.company_name,
        jobTitle: chat.job_title,
      },
      intents: [intent],
    });
  } else if (orderedChats.length > 1) {
    const distinctConversations = new Set(
      orderedChats.map((intent) => chatByMessageId.get(intent.sourceId)?.conversation_id ?? intent.sourceId),
    );
    renderPlan.push({
      request: {
        kind: 'employer_chat_summary',
        workerId,
        language,
        conversationCount: distinctConversations.size,
      },
      intents: orderedChats,
    });
  }

  let released = 0;
  if (renderPlan.length > 0) {
    const recipientResult = await client.query<{ whatsapp_number: string | null }>(
      `SELECT whatsapp_number FROM users WHERE id = $1`,
      [workerId],
    );
    const whatsappNumber = recipientResult.rows[0]?.whatsapp_number;
    if (!whatsappNumber) {
      throw new Error('worker_whatsapp_unavailable');
    }

    for (const entry of renderPlan) {
      const rendered: ReleaseRenderedMessage = await deps.renderer.render(entry.request);
      const primary = entry.intents[0];
      const { outboxId } = await insertAuthorizedIntentOutbox(client, primary.id, {
        whatsappNumber,
        body: rendered.body,
        contentTemplate: rendered.contentTemplate,
        contentVariables: rendered.contentVariables,
      });

      for (const intent of entry.intents) {
        const sequence = sequenceByIntentId.get(intent.id)!;
        await client.query(
          `UPDATE worker_message_intents
              SET status = 'released', release_sequence = $1, outbox_id = $2, updated_at = now()
            WHERE id = $3`,
          [sequence, outboxId, intent.id],
        );
        released++;
      }
    }
  }

  return { released, expired, superseded, failed };
}
