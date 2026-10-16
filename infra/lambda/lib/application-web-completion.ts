/**
 * application-web-completion.ts -- releasing the WhatsApp bot's arm when the
 * WEB finishes what the bot was in the middle of asking.
 *
 * ── THE BUG THIS CLOSES ──────────────────────────────────────────────
 * The bot arms itself on a conversation row when it starts collecting an
 * application: `armFill` writes `state_context.fill_application_id`
 * (whatsapp/lib/application-fill.ts) and `armPromptLane` writes
 * `state_context.prompt_application_id`
 * (whatsapp/lib/application-prompts.ts). The processor's dispatch tail then
 * re-sends the pending question after ANY inbound message for as long as
 * either key is a string (`processor.ts`'s
 * `typeof tailState?.fill_application_id === 'string'` ->
 * `maybeRepromptFill`, and the `prompt_application_id` sibling ->
 * `repromptPromptLane`).
 *
 * Only the bot ever DISARMED it: CANCELAR, the exit prompts, or the
 * completion path. The WEB door (`api/worker-application-details.ts`) writes
 * the same answers through the same engine (`lib/application-requirements.ts`)
 * and never touched the conversation row -- so a worker who finished the
 * details stage in a browser got "Paso 3 de 4" on their next unrelated
 * "hola". This module is the web door's release.
 *
 * Owner ruling (2026-09-08): clear the arm AND send exactly one closing
 * line. Employer-driven stage notifications
 * (`lib/application-stage-notify.ts`) are untouched by this file.
 *
 * ── WHY IT IS SAFE TO CALL FROM THE WEB DOOR ─────────────────────────
 * The handler runs as `jale_whatsapp` (see its file header). That role holds
 * `GRANT ALL ON whatsapp_conversations` (004:102) under the
 * `wa_conv_full ... USING (true)` policy (004:139-141), so RLS proves
 * NOTHING about ownership here: every statement below carries the worker id
 * the handler already proved through `resolve_worker_internal_id` plus its
 * own `worker_id = $2` SELECT. `worker_message_intents` is the opposite
 * case -- `worker_message_intents_worker` (042:224) keys on the GUC
 * `app.current_internal_user_id`, which the handler has already set to this
 * worker, so the intent INSERT is admitted for this worker and no other.
 *
 * ── WHY THERE ARE TWO SAVEPOINTS ─────────────────────────────────────
 * "Never fail the web response because WhatsApp bookkeeping failed" is NOT
 * achieved by a try/catch. A SQL error (a grant that moved, a constraint, a
 * definer's RAISE) aborts the enclosing transaction, and every later
 * statement -- `buildState`, then COMMIT -- fails 25P02. A successful answer
 * merge would answer 500, which is precisely what the ruling forbids. So
 * every statement here sits inside a savepoint, the same device and for the
 * same reason as `withSizeGuard` in `application-requirements.ts`.
 *
 * There are TWO of them, in sequence, because the two halves are not equally
 * important. The SCRUB is the fix; the closing line is a courtesy. One shared
 * savepoint would let a failed render or a rejected intent roll the scrub
 * back with it -- and the bot would go on re-prompting a form the worker
 * already finished, because a WhatsApp message failed. So the scrub's
 * savepoint is released BEFORE the send's is taken:
 *
 *   scrub fails           -> nothing released, transaction still usable
 *   scrub ok, send fails  -> ARM CLEARED, no line (the degraded outcome)
 *   both ok               -> arm cleared, exactly one line queued
 *
 * ── ACCEPTED RESIDUAL: THE DOUBLE FAULT ──────────────────────────────
 * `rollbackTo` logs instead of throwing when the ROLLBACK TO SAVEPOINT
 * itself fails. If BOTH the original statement and its rollback fail, this
 * module still returns a result and the caller still tries to COMMIT -- and
 * that COMMIT will fail 25P02, so the web request 500s after all.
 *
 * Accepted, not fixed. `ROLLBACK TO SAVEPOINT` on an aborted transaction is
 * the one statement Postgres is contractually required to accept, so the
 * only ways it fails are a dropped connection or a savepoint that was never
 * established -- and in both of those the transaction is already
 * unrecoverable, with or without this module. Escalating here would trade a
 * 500 for a 500 and lose the log line that says which statement started it.
 * The `WhatsAppLaneReleaseRollbackFailed` metric is the signal to look for
 * if a 500 ever appears on this door.
 *
 * ── THE 24-HOUR WINDOW ───────────────────────────────────────────────
 * A free-form WhatsApp body is only deliverable inside Meta's 24-hour
 * customer-service window, which is opened by an INBOUND message. Outside
 * it Twilio answers 63016, and because a free-form send carries no content
 * template, `isTemplatePendingRejection` (whatsapp/lib/outbox.ts) is false
 * for it -- the row would land in `recordFailure` as an ordinary `failed`
 * and burn its five attempts. So the window is checked before enqueueing:
 * inside it the line goes out free-form; outside it (sprint 28, F28) the
 * same words go as the `application_web_completed_<lang>` TEMPLATE. Both
 * name the job's trade and link the application. Until that template's
 * ContentSid is mapped the sender falls back to its `__fallback_body`,
 * Twilio refuses it, and `isTemplatePendingRejection` -- which matches the
 * `application_` prefix -- parks the row rather than failing it.
 *
 * `whatsapp_conversations.updated_at` is NOT the signal. Its
 * `wa_conversations_updated_at` trigger fires on every write, including the
 * bot's own OUTBOUND turn bookkeeping, so it reads "inside the window" for
 * sessions that have really lapsed. `whatsapp_processed_messages` is the
 * inbound log: `processor.ts` inserts one row per inbound MessageSid
 * (:411, :658), `first_seen_at` defaults to `now()`, migrations 088/089
 * define "WhatsApp inbound" as exactly that column, nothing prunes the
 * table, and `idx_wa_processed_number (whatsapp_number, first_seen_at DESC)`
 * serves the lookup. Its one gap: neither INSERT populates
 * `conversation_id`, so the join is by `whatsapp_number` and a worker whose
 * number changed has no history under the new one. That reads as NULL, which
 * is treated as OUTSIDE the window -- a missed courtesy line rather than a
 * failed send.
 *
 * The comparison is done in SQL against the database clock. Comparing a JS
 * `Date.now()` to a Postgres timestamp would buy a skew bug that no mocked
 * test can see.
 */
import type { PoolClient } from 'pg';

import { FILL_SCRUB_KEYS } from '../whatsapp/lib/application-fill';
import { workerApplicationUrl } from '../whatsapp/lib/worker-application-url';
import { PROMPT_LANE_SCRUB_KEYS } from '../whatsapp/lib/application-prompts';
import {
  enqueueWorkerMessage,
  registerCategoryRenderer,
} from '../whatsapp/lib/worker-delivery-gateway';
import type {
  CategoryRenderer,
  PreferredLanguage,
} from '../whatsapp/lib/onboarding-types';
import {
  WEB_COMPLETION_SOURCE_TYPE,
  WEB_COMPLETION_TEMPLATE_SHAPE,
  buildWebCompletionBody,
  buildWebCompletionPayloadMessage,
  webCompletionTradeLabel,
} from './application-web-completion-copy';

/**
 * Re-exported so callers and tests have one import site for this lane. The
 * definition lives in the leaf copy module because
 * `whatsapp/lib/onboarding-renderers.ts` needs it too and cannot import this
 * file -- see that module's header for the cycle.
 */
export { buildWebCompletionBody };

/**
 * TWO savepoint scopes, in sequence, and the split is load-bearing.
 *
 * The SCRUB is the fix; the closing line is a courtesy. Sharing one savepoint
 * would let a failed render or a rejected intent roll the scrub back with it
 * -- the bot would keep re-prompting a form the worker already finished,
 * because a WhatsApp send failed. That inverts the lane's whole priority: a
 * silent scrub is the acceptable degraded outcome, silently doing nothing is
 * not. So the scrub's savepoint is RELEASED before the send's is taken, and a
 * send failure can only ever roll back the send.
 *
 * Fixed names, following `application_requirements_merge` in
 * `application-requirements.ts`. Exported so the tests assert the rollbacks
 * themselves rather than merely that the promise resolved -- the un-poisoning
 * is the whole point, and a `try/catch` alone would pass a "does not throw"
 * assertion while still killing the caller's COMMIT.
 */
export const LANE_RELEASE_SAVEPOINT = 'whatsapp_lane_release';
export const LANE_SEND_SAVEPOINT = 'whatsapp_lane_release_send';

/** `whatsapp_conversations.id` and `job_applications.id` are v4 UUIDs. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The free-form line's lifetime: Meta's window, measured from
 * `last_inbound_at`, NOT from now, so the intent's `expires_at` is the
 * instant the window closes. Three places refuse to send past it: the
 * enqueue itself and the worker-ready release (a DEFERRED intent, materialized
 * later by whatsapp/worker-ready-release.ts) through `evaluateDelivery`, and
 * the drain, whose lease skips an outbox row whose intent has expired and
 * whose expiry pass (`expire_worker_intent_outbox`, migration 126) ends it
 * unsent. A 24-hours-from-now expiry on a window that opened 23 hours ago
 * would let any of them send the body after the window closed, where Twilio
 * refuses it (63016).
 */
const CLOSING_LINE_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * The TEMPLATE shape's lifetime (sprint 28, F28), measured from now: a
 * template is deliverable whatever the window, so the lapsed inbound clock
 * says nothing about it. 48 hours: a courtesy line older than that is not
 * worth sending (the same span 093 gives an `application_*` row parked while
 * its template awaits approval, though 093 counts from the outbox row's
 * creation). Enforced like the free-form line's: at enqueue, at release and
 * by the drain (migration 126).
 */
const CLOSING_TEMPLATE_EXPIRY_MS = 48 * 60 * 60 * 1000;

/** `$1` = the application id, `$2` = the caller-proven worker id. */
const JOB_TRADE_READ_SQL = `SELECT j.title, j.trade_category, j.trade_category_other
       FROM job_applications ja
       JOIN jobs j ON j.id = ja.job_id
      WHERE ja.id = $1
        AND ja.worker_id = $2`;

/** `timestamptz` arrives as a Date from `pg`, but tolerate a string. */
function toMillis(value: Date | string | null): number | null {
  if (value === null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * ASCENDING = SENT FIRST. `withinGroupOrder` in
 * `whatsapp/worker-ready-release.ts` sorts `a.priority - b.priority` and
 * allocates `release_sequence` in that order, and
 * `lease_worker_intent_outbox` (043) drains strictly by
 * `COALESCE(release_sequence, 2147483647)`. So a LOWER number goes out
 * EARLIER -- the opposite of what an earlier comment here claimed, which had
 * this line jumping the queue ahead of everything that matters.
 *
 * 45 puts it last among the numbers in use: security/OTP (1), onboarding
 * steps (5), job alerts and stage changes (30,
 * `application-stage-notify.ts`), employer chat (40,
 * `lib/job-messaging.ts`). This line tells the worker nothing they do not
 * already know -- they just finished the form themselves -- so it must be
 * last.
 *
 * WHAT THIS ACTUALLY BUYS, precisely: priority orders intents only WITHIN a
 * render group. Cross-category order on the release path is fixed by
 * `renderPlan.push` (onboarding_complete, referred_job, account_notice,
 * job_alert_digest, employer_chat), so an `account` intent precedes employer
 * chat at any priority. The comparison this number decides is therefore
 * against the OTHER 'account' intents -- above all a stage change at 30,
 * which must reach the worker before a line about a form they just filled in
 * themselves. On the non-deferred path there is no `release_sequence` at all
 * and the lease falls back to `created_at`, so priority is inert there.
 */
const CLOSING_LINE_PRIORITY = 45;

export interface ReleaseWhatsAppLanesInput {
  workerId: string;
  applicationId: string;
  jobTitle: string | null;
  /**
   * The caller's best guess. The conversation row's own `language` WINS when
   * it is one we render (it is `NOT NULL DEFAULT 'es'`, and it is the
   * language the bot has actually been speaking to this worker); this is the
   * fallback for a row carrying something else.
   */
  lang: PreferredLanguage;
}

export interface ReleasePromptLaneInput {
  workerId: string;
  applicationId: string;
}

/** The fill-lane release takes the same two ids as the prompt-lane one. */
export type ReleaseFillLaneInput = ReleasePromptLaneInput;

/** Which release ran, for the log line and the failure metrics. */
type LaneName = 'all' | 'prompt' | 'fill';

/**
 * The marker `releaseFillLaneForApplication` leaves on a conversation row
 * (sprint 28, F29): the WEB took this application over from the bot on its
 * first write. The bot never reads it -- every one of its readers gates on
 * its OWN keys (`fill_application_id`, `prompt_application_id`, ...) being a
 * string -- so it arms nothing. Its one reader is the completion release
 * below: the arm keys are gone by the time the web finishes, and without
 * this the finished application would no longer be tied to the conversation
 * it started on, so the closing line would never be sent. The completion
 * release removes it.
 *
 * ONE KEY PER APPLICATION (`released_to_web:<application id>`, value true): a
 * worker can hand two applications to the web from the same conversation,
 * and each must keep its own marker until its own completion.
 */
export const RELEASED_TO_WEB_KEY_PREFIX = 'released_to_web:';

/** The marker key for one application. */
export function releasedToWebKey(applicationId: string): string {
  return `${RELEASED_TO_WEB_KEY_PREFIX}${applicationId}`;
}

export interface LaneReleaseResult {
  /** At least one conversation row was armed for this application. */
  armed: boolean;
  /** How many conversation rows the scrub cleared. */
  scrubbed: number;
  /** One closing line reached the delivery gateway. */
  closingLineQueued: boolean;
}

/** Nothing was released. Also the answer on every swallowed failure. */
const NOTHING_RELEASED: LaneReleaseResult = {
  armed: false, scrubbed: 0, closingLineQueued: false,
};

// ── Category renderer ──

/**
 * Claims the 'account' category, following the enqueue-time registration
 * `registerApplicationStageRenderer` uses (and for the same reason: the map
 * is module-scope, so a load-time registration can be lost to a test-only
 * `_clearCategoryRenderersForTests`).
 *
 * `renderers` holds ONE renderer per category, and
 * `lib/application-stage-notify.ts` claims 'account' too. Both lanes register
 * immediately before their own `enqueueWorkerMessage` call, and both refuse a
 * payload that is not theirs -- so last-register-wins is correct, and either
 * mismatch degrades to a null render (an intent rejected
 * `renderer_unavailable`) rather than to the WRONG copy on a real send.
 *
 * This renderer only ever runs on the `allow` branch. The DEFERRED branch is
 * materialized later by `whatsapp/worker-ready-release.ts` through the
 * release renderer in `whatsapp/lib/onboarding-renderers.ts`, which has its
 * own `application_web_completion` arm over the SAME
 * `buildWebCompletionPayloadMessage`. Both paths must keep producing the same
 * line, which is why the copy lives in the shared leaf module.
 *
 * The gateway's "unavailable" convention is returning null; never throw.
 */
const renderWebCompletion: CategoryRenderer = async (client, input) => {
  const payload = input.payload as Record<string, unknown>;
  // 'es' is only reached if the payload's own `lang` is unreadable; the
  // payload always carries the conversation row's language.
  const message = buildWebCompletionPayloadMessage('es', payload);
  if (!message) return null;

  const conversationId = payload.conversationId;
  if (typeof conversationId !== 'string' || !UUID_REGEX.test(conversationId)) return null;

  // The recipient is re-read here rather than carried in the payload:
  // `worker_message_intents.payload` is a durable jsonb column, and a phone
  // number does not belong in one. Scoped to the worker for the reason in the
  // header -- `wa_conv_full` is USING (true).
  const recipient = await client.query<{ whatsapp_number: string | null }>(
    `SELECT whatsapp_number
       FROM whatsapp_conversations
      WHERE id = $1 AND user_id = $2`,
    [conversationId, input.workerId],
  );
  const whatsappNumber = recipient.rows[0]?.whatsapp_number;
  if (typeof whatsappNumber !== 'string' || whatsappNumber.length === 0) return null;

  return { whatsappNumber, ...message };
};

// ── The arm read ──

interface ArmedConversationRow {
  id: string;
  whatsapp_number: string | null;
  language: string | null;
  updated_at: Date | string | null;
  last_inbound_at: Date | string | null;
  within_session_window: boolean | null;
}

/**
 * `$1` = the worker's `users.id`, `$2` = the application id.
 *
 * `updated_at` is projected even though it does not decide the send: it
 * orders the rows (`user_id` is not unique -- only `whatsapp_number` is, so
 * one worker can own several conversation rows) and it is the value an
 * operator reads when asking why a line was or was not sent.
 */
const ARM_READ_COLUMNS = `c.id,
            c.whatsapp_number,
            c.language,
            c.updated_at,
            inbound.last_inbound_at,
            (inbound.last_inbound_at IS NOT NULL
               AND inbound.last_inbound_at > now() - interval '24 hours')
              AS within_session_window`;

const ARM_READ_INBOUND_JOIN = `LEFT JOIN LATERAL (
             SELECT max(p.first_seen_at) AS last_inbound_at
               FROM whatsapp_processed_messages p
              WHERE p.whatsapp_number = c.whatsapp_number
           ) inbound ON true`;

/** Every lane this application could have armed. */
const FULL_ARM_READ_SQL = `SELECT ${ARM_READ_COLUMNS}
       FROM whatsapp_conversations c
       ${ARM_READ_INBOUND_JOIN}
      WHERE c.user_id = $1
        AND (   c.state_context->>'fill_application_id'       = $2
             OR c.state_context->>'fill_offer_application_id' = $2
             OR c.state_context->>'prompt_application_id'     = $2)
      ORDER BY c.updated_at DESC`;

/**
 * The completion release's read: every live arm, plus a conversation whose
 * arm the first web write already released (this application's
 * `releasedToWebKey`).
 */
const COMPLETION_ARM_READ_SQL = `SELECT ${ARM_READ_COLUMNS}
       FROM whatsapp_conversations c
       ${ARM_READ_INBOUND_JOIN}
      WHERE c.user_id = $1
        AND (   c.state_context->>'fill_application_id'       = $2
             OR c.state_context->>'fill_offer_application_id' = $2
             OR c.state_context->>'prompt_application_id'     = $2
             OR c.state_context ? ('${RELEASED_TO_WEB_KEY_PREFIX}' || $2))
      ORDER BY c.updated_at DESC`;

/**
 * The prompt lane ALONE. A worker who answered a pre-application prompt on
 * the web has not necessarily finished the details-stage fill, so this must
 * not match -- or clear -- a fill arm.
 */
const PROMPT_ARM_READ_SQL = `SELECT ${ARM_READ_COLUMNS}
       FROM whatsapp_conversations c
       ${ARM_READ_INBOUND_JOIN}
      WHERE c.user_id = $1
        AND c.state_context->>'prompt_application_id' = $2
      ORDER BY c.updated_at DESC`;

/**
 * `-` on jsonb with a text[] REMOVES those keys. The bot clears by MERGING
 * `{key: null}` instead, but only because its `updateStateContext` is a
 * jsonb `||`, which cannot express removal -- and every reader of these keys
 * gates on `typeof ... === 'string'`, so an absent key and a JSON null are
 * the same disarmed state to all of them. Removal is preferred here because
 * it leaves no residue for a later reader to misread.
 *
 * `COALESCE` because `state_context` is nullable (004:83 has a DEFAULT, not
 * a NOT NULL) and `NULL - text[]` is NULL, which would silently write the
 * whole context away.
 */
const SCRUB_SQL = `UPDATE whatsapp_conversations
        SET state_context = COALESCE(state_context, '{}'::jsonb) - $3::text[]
      WHERE id = ANY($1::uuid[])
        AND user_id = $2`;

/**
 * `SCRUB_SQL`, then the marker for `$4` (the application id). Any other
 * application's marker on the row is left as it is.
 */
const SCRUB_AND_MARK_SQL = `UPDATE whatsapp_conversations
        SET state_context = (COALESCE(state_context, '{}'::jsonb) - $3::text[])
                            || jsonb_build_object('${RELEASED_TO_WEB_KEY_PREFIX}' || $4::text, true)
      WHERE id = ANY($1::uuid[])
        AND user_id = $2`;

/**
 * The completion release's scrub, for `$4` (the application id). A row can
 * be matched by this application's marker alone while the bot is collecting
 * ANOTHER application on it (the worker went back to WhatsApp and started
 * one), so the bot's keys `$3` are removed only from a row whose live arm
 * names this application. This application's marker is removed either way;
 * any other application's marker stays.
 */
const COMPLETION_SCRUB_SQL = `UPDATE whatsapp_conversations
        SET state_context = (CASE
              WHEN state_context->>'fill_application_id'       = $4::text
                OR state_context->>'fill_offer_application_id' = $4::text
                OR state_context->>'prompt_application_id'     = $4::text
              THEN COALESCE(state_context, '{}'::jsonb) - $3::text[]
              ELSE COALESCE(state_context, '{}'::jsonb)
            END) - ('${RELEASED_TO_WEB_KEY_PREFIX}' || $4::text)
      WHERE id = ANY($1::uuid[])
        AND user_id = $2`;

/** How a release clears the rows it read. */
type ScrubMode =
  /** Remove the keys (the prompt-lane release). */
  | 'plain'
  /** Remove the keys and leave this application's marker (the first web write). */
  | 'mark'
  /** Remove the keys where the arm is this application's, and its marker (completion). */
  | 'completion';

function normalizeLang(
  raw: string | null | undefined,
  fallback: PreferredLanguage,
): PreferredLanguage {
  return raw === 'en' || raw === 'es' ? raw : fallback;
}

/**
 * Metadata only -- ids, counts and reason codes. Never a phone number, never
 * a message body, never an answer.
 */
function logRelease(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ metric: 'WhatsAppLaneReleased', ...fields }));
}

/**
 * The send half, in its OWN savepoint so a failure here can never roll the
 * scrub back. Returns whether the line was queued; NEVER throws.
 *
 * The gateway signals "no message could be built" by throwing
 * `renderer_unavailable:<category>` after ordinary queries, so that one does
 * NOT poison the transaction -- but a rejected intent INSERT, a constraint on
 * `whatsapp_outbox`, or `unauthorized_worker_outbox_row` all do, which is why
 * this needs a savepoint of its own rather than just a catch.
 */
async function sendClosingLine(
  client: PoolClient,
  opts: {
    workerId: string;
    applicationId: string;
    lane: LaneName;
    conversationId: string;
    lang: PreferredLanguage;
    jobTitle: string | null;
    lastInboundMs: number | null;
    /** Inside Meta's 24h window: the free-form line. Outside it: the template. */
    withinWindow: boolean;
  },
): Promise<boolean> {
  await client.query(`SAVEPOINT ${LANE_SEND_SAVEPOINT}`);
  try {
    // One message inside or outside the window (sprint 28, F28): it names
    // the job's trade and links the application either way. The job is read
    // here, scoped to the worker the caller proved.
    const job = await client.query<{
      title: string | null; trade_category: string | null; trade_category_other: string | null;
    }>(JOB_TRADE_READ_SQL, [opts.applicationId, opts.workerId]);
    const row = job.rows[0];
    const trade = row
      ? webCompletionTradeLabel(opts.lang, {
          tradeCategory: row.trade_category,
          tradeCategoryOther: row.trade_category_other,
          title: row.title,
        })
      : null;
    if (trade === null) {
      // Nothing to name the job by: no line, rather than one with a blank
      // where the trade goes.
      await client.query(`RELEASE SAVEPOINT ${LANE_SEND_SAVEPOINT}`);
      return false;
    }
    let payload: Record<string, unknown> = {
      kind: WEB_COMPLETION_SOURCE_TYPE,
      applicationId: opts.applicationId,
      conversationId: opts.conversationId,
      jobTitle: opts.jobTitle,
      lang: opts.lang,
      trade,
      // The same link the bot's own "finish it on the web" note uses:
      // PUBLIC_SITE_BASE_URL, else the production site.
      url: workerApplicationUrl(opts.lang, opts.applicationId),
    };
    let expiresAt: Date;
    if (opts.withinWindow) {
      // Free-form. Anchored to the INBOUND instant, not to now: see
      // CLOSING_LINE_EXPIRY_MS.
      expiresAt = new Date((opts.lastInboundMs ?? Date.now()) + CLOSING_LINE_EXPIRY_MS);
    } else {
      // Outside the window: the same words as the template.
      payload = { ...payload, shape: WEB_COMPLETION_TEMPLATE_SHAPE };
      expiresAt = new Date(Date.now() + CLOSING_TEMPLATE_EXPIRY_MS);
    }

    registerCategoryRenderer('account', renderWebCompletion);
    await enqueueWorkerMessage(client, {
      workerId: opts.workerId,
      category: 'account',
      ownerService: 'account',
      sourceType: WEB_COMPLETION_SOURCE_TYPE,
      sourceId: opts.applicationId,
      // ONE line per application, forever, whichever shape it takes.
      // `markDetailsCompleteIfDone` only ever flips `details_completed_at`
      // while it `IS NULL` (application-requirements.ts), so the caller fires
      // this once by construction; this key is what makes a retried request
      // idempotent.
      dedupeKey: `application-web-completion:${opts.applicationId}`,
      priority: CLOSING_LINE_PRIORITY,
      expiresAt,
      payload,
    });
    await client.query(`RELEASE SAVEPOINT ${LANE_SEND_SAVEPOINT}`);
    return true;
  } catch (err) {
    await rollbackTo(client, LANE_SEND_SAVEPOINT, opts);
    // Deliberately NOT rethrown and deliberately NOT fatal to the scrub. The
    // scrub is the fix; this line is a courtesy, and a courtesy must never
    // take the fix down with it.
    console.error(JSON.stringify({
      metric: 'WhatsAppLaneClosingLineFailed',
      lane: opts.lane,
      applicationId: opts.applicationId,
      error: err instanceof Error ? err.message : String(err),
    }));
    return false;
  }
}

/** Rolls back to `savepoint`, logging rather than throwing if even that fails. */
async function rollbackTo(
  client: PoolClient,
  savepoint: string,
  opts: { lane: LaneName; applicationId: string },
): Promise<void> {
  try {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  } catch (rollbackErr) {
    console.error(JSON.stringify({
      metric: 'WhatsAppLaneReleaseRollbackFailed',
      lane: opts.lane,
      savepoint,
      applicationId: opts.applicationId,
      error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
    }));
  }
}

/**
 * The shared core. `closing` is absent for the prompt-lane release, which
 * never sends anything.
 *
 * TWO savepoint scopes, in sequence. The scrub's is released BEFORE the
 * send's is taken, so the outcomes are independent:
 *   scrub fails            -> nothing released, transaction still usable
 *   scrub ok, send fails   -> ARM CLEARED, no line (the degraded outcome)
 *   both ok                -> arm cleared, exactly one line queued
 */
async function releaseLanes(
  client: PoolClient,
  opts: {
    workerId: string;
    applicationId: string;
    armReadSql: string;
    scrubKeys: readonly string[];
    lane: LaneName;
    closing?: { jobTitle: string | null; lang: PreferredLanguage };
    scrubMode: ScrubMode;
  },
): Promise<LaneReleaseResult> {
  // ── Scope A: the fix ──
  let primary: ArmedConversationRow;
  let scrubbed: number;
  await client.query(`SAVEPOINT ${LANE_RELEASE_SAVEPOINT}`);
  try {
    const armed = await client.query<ArmedConversationRow>(
      opts.armReadSql,
      [opts.workerId, opts.applicationId],
    );
    const rows = armed.rows;
    if (rows.length === 0) {
      await client.query(`RELEASE SAVEPOINT ${LANE_RELEASE_SAVEPOINT}`);
      return NOTHING_RELEASED;
    }

    // `ORDER BY c.updated_at DESC` makes this the most recently touched
    // armed row: the one the worker is actually talking on.
    primary = rows[0];

    const ids = rows.map((row) => row.id);
    const scrub = opts.scrubMode === 'plain'
      ? await client.query(SCRUB_SQL, [ids, opts.workerId, opts.scrubKeys])
      : await client.query(
          opts.scrubMode === 'mark' ? SCRUB_AND_MARK_SQL : COMPLETION_SCRUB_SQL,
          [ids, opts.workerId, opts.scrubKeys, opts.applicationId],
        );
    scrubbed = scrub.rowCount ?? 0;

    // Released HERE, before the send is attempted, so the scrub is committed
    // work as far as the rest of this transaction is concerned.
    await client.query(`RELEASE SAVEPOINT ${LANE_RELEASE_SAVEPOINT}`);
  } catch (err) {
    // The savepoint rollback, not the catch, is what saves the caller: a SQL
    // error has already aborted the transaction and every later statement --
    // including `buildState` and COMMIT -- would fail 25P02 without this.
    await rollbackTo(client, LANE_RELEASE_SAVEPOINT, opts);
    console.error(JSON.stringify({
      metric: 'WhatsAppLaneReleaseFailed',
      lane: opts.lane,
      applicationId: opts.applicationId,
      error: err instanceof Error ? err.message : String(err),
    }));
    return NOTHING_RELEASED;
  }

  // ── Scope B: the courtesy ──
  // Inside the window the free-form line; outside it (or with no inbound on
  // record) the template (sprint 28, F28), which used to be skipped.
  let closingLineQueued = false;
  const withinWindow = primary.within_session_window === true;
  if (opts.closing) {
    closingLineQueued = await sendClosingLine(client, {
      workerId: opts.workerId,
      applicationId: opts.applicationId,
      lane: opts.lane,
      conversationId: primary.id,
      lang: normalizeLang(primary.language, opts.closing.lang),
      jobTitle: opts.closing.jobTitle,
      lastInboundMs: toMillis(primary.last_inbound_at),
      withinWindow,
    });
  }

  logRelease({
    lane: opts.lane,
    applicationId: opts.applicationId,
    scrubbed,
    closingLineQueued,
    withinSessionWindow: withinWindow,
    closingLineShape: opts.closing ? (withinWindow ? 'session' : 'template') : null,
  });
  return { armed: true, scrubbed, closingLineQueued };
}

/**
 * The details-stage release: clear every fill AND prompt key this
 * application armed (only on a row whose live arm is this application's)
 * and the marker its first web write left, then queue exactly one closing
 * line: free-form inside the 24-hour window, the template outside it.
 *
 * Never throws, and never leaves the caller's transaction unusable. The
 * result exists for tests and for the log line; the web response does not
 * depend on it.
 */
export async function releaseWhatsAppLanesForApplication(
  client: PoolClient,
  input: ReleaseWhatsAppLanesInput,
): Promise<LaneReleaseResult> {
  return releaseLanes(client, {
    workerId: input.workerId,
    applicationId: input.applicationId,
    armReadSql: COMPLETION_ARM_READ_SQL,
    scrubKeys: FILL_SCRUB_KEYS,
    scrubMode: 'completion',
    lane: 'all',
    closing: { jobTitle: input.jobTitle, lang: input.lang },
  });
}

/**
 * The pre-application-prompt release: clear the three `PROMPT_LANE_SCRUB`
 * keys and send NOTHING. Since sprint 28 (owner decision D-P4) the door
 * calls it on the FIRST prompt answered on the web, not only the last one.
 * Answering a prompt is not the end of an application -- the details stage
 * may not even have been requested yet -- so there is nothing to close off,
 * only the bot's prompt turn to stand down.
 */
export async function releasePromptLaneForApplication(
  client: PoolClient,
  input: ReleasePromptLaneInput,
): Promise<LaneReleaseResult> {
  return releaseLanes(client, {
    workerId: input.workerId,
    applicationId: input.applicationId,
    armReadSql: PROMPT_ARM_READ_SQL,
    scrubKeys: PROMPT_LANE_SCRUB_KEYS,
    scrubMode: 'plain',
    lane: 'prompt',
  });
}

/**
 * The first-web-write release (sprint 28, F29; owner decision: release on
 * the first web answer, no new column). The worker answered a details-stage
 * question in the browser for an application the bot is still collecting, so
 * the bot stands down now rather than at completion: clear every fill AND
 * prompt key this application armed (the completion release's key set) and
 * send NOTHING, since nothing is finished yet.
 *
 * It leaves this application's marker (`releasedToWebKey`) on each row it
 * clears, so the completion release can still find the conversation and
 * send its one closing line when the web finishes. Its own read matches live
 * arms only, so every later web
 * write finds nothing armed and changes nothing. If the worker goes back to
 * WhatsApp, the application command or the applications menu arms the bot
 * again.
 *
 * Never throws, and never leaves the caller's transaction unusable.
 */
export async function releaseFillLaneForApplication(
  client: PoolClient,
  input: ReleaseFillLaneInput,
): Promise<LaneReleaseResult> {
  return releaseLanes(client, {
    workerId: input.workerId,
    applicationId: input.applicationId,
    armReadSql: FULL_ARM_READ_SQL,
    scrubKeys: FILL_SCRUB_KEYS,
    scrubMode: 'mark',
    lane: 'fill',
  });
}
