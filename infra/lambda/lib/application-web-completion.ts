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
 * ── THE 24-HOUR WINDOW ───────────────────────────────────────────────
 * A free-form WhatsApp body is only deliverable inside Meta's 24-hour
 * customer-service window, which is opened by an INBOUND message. Outside
 * it Twilio answers 63016, and because this send carries no content
 * template, `isTemplatePendingRejection` (whatsapp/lib/outbox.ts) is false
 * for it -- the row would land in `recordFailure` as an ordinary `failed`
 * and burn its five attempts. So the window is checked before enqueueing.
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
import { PROMPT_LANE_SCRUB_KEYS } from '../whatsapp/lib/application-prompts';
import {
  enqueueWorkerMessage,
  registerCategoryRenderer,
} from '../whatsapp/lib/worker-delivery-gateway';
import type {
  CategoryRenderer,
  PreferredLanguage,
} from '../whatsapp/lib/onboarding-types';

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
 * Meta's window, and therefore this intent's whole lifetime. Measured from
 * `last_inbound_at`, NOT from now: `evaluateDelivery` DEFERS an intent whose
 * worker is mid-onboarding or whose `deferred_delivery_enabled` control is
 * off, and a deferred intent is not materialized until the worker-ready
 * release picks it up (`outbox_id IS NULL`, whatsapp/worker-ready-release.ts).
 * A 24-hours-from-now expiry on a window that opened 23 hours ago would let
 * that path send a free-form body ~47 hours after the last inbound -- a
 * Twilio 63016 which, because `content_template` is null, is NOT the 093
 * defer branch but an ordinary `recordFailure` burning five attempts and
 * emitting WorkerIntentOutboxFailure. Anchoring the expiry to the inbound
 * instant makes the window guard itself, by construction.
 */
const CLOSING_LINE_EXPIRY_MS = 24 * 60 * 60 * 1000;

/** `timestamptz` arrives as a Date from `pg`, but tolerate a string. */
function toMillis(value: Date | string | null): number | null {
  if (value === null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Below `application-stage-notify.ts`'s 30 (a real stage change) and well
 * below job-messaging's 40 (an employer typing right now). This line tells
 * the worker nothing they do not already know -- they just finished the form
 * themselves -- so it must never be delivered ahead of news.
 */
const CLOSING_LINE_PRIORITY = 20;

/** `worker_message_intents.source_type`, and this renderer's payload tag. */
const WEB_COMPLETION_SOURCE_TYPE = 'application_web_completion';

export interface ReleaseWhatsAppLanesInput {
  workerId: string;
  applicationId: string;
  jobTitle: string | null;
  companyName: string | null;
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

// ── Copy ──
//
// ASCII-only, unaccented, informal-"tu" Spanish: the binding convention
// across `whatsapp/lib/templates.ts` and `application-fill-prompts.ts`,
// neither of which contains a single accented character. "Te avisamos por
// aqui cuando..." deliberately echoes templates.ts's existing
// "Te avisaremos aqui cuando el empleador los pida."

const GENERIC_JOB: Record<PreferredLanguage, string> = {
  es: 'este empleo',
  en: 'this job',
};

/**
 * The closing line. Pure: no clock, no client, no network.
 *
 * FREE-FORM, not a template. No Content template exists for this line and
 * none is being seeded: `sendTwilioWhatsAppMessage` (whatsapp/lib/outbox.ts)
 * sends `Body` whenever `content_template` is null, and
 * `lease_worker_intent_outbox` (043) already projects `body` for the drain
 * to hand it. The 24-hour check above is what makes a body-only send legal.
 */
export function buildWebCompletionBody(
  lang: PreferredLanguage,
  jobTitle: string | null,
): string {
  const title = jobTitle && jobTitle.trim().length > 0
    ? jobTitle.trim()
    : GENERIC_JOB[lang];
  return lang === 'en'
    ? `You completed your application for ${title} on the web. We'll let you know here when the employer responds.`
    : `Completaste tu solicitud para ${title} en la web. Te avisamos por aqui cuando el empleador responda.`;
}

// ── Category renderer ──

/**
 * Claims the 'account' category, following the enqueue-time registration
 * `registerApplicationStageRenderer` uses (and for the same reason: the map
 * is module-scope, so a load-time registration can be lost to a test-only
 * `_clearCategoryRenderersForTests`).
 *
 * `renderers` holds ONE renderer per category, and
 * `lib/application-stage-notify.ts` claims 'account' too. Both lanes
 * register immediately before their own `enqueueWorkerMessage` call, and
 * both refuse a payload that is not theirs -- so last-register-wins is
 * correct, and either mismatch degrades to a null render (an intent rejected
 * `renderer_unavailable`) rather than to the WRONG copy on a real send.
 *
 * The gateway's "unavailable" convention is returning null; never throw
 * from in here.
 */
const renderWebCompletion: CategoryRenderer = async (client, input) => {
  const payload = input.payload as Record<string, unknown>;
  if (payload.kind !== WEB_COMPLETION_SOURCE_TYPE) return null;

  const conversationId = payload.conversationId;
  const lang = payload.lang;
  const jobTitle = payload.jobTitle;
  if (typeof conversationId !== 'string' || !UUID_REGEX.test(conversationId)) return null;
  if (lang !== 'es' && lang !== 'en') return null;

  // The recipient is re-read here rather than carried in the payload:
  // `worker_message_intents.payload` is a durable jsonb column, and a phone
  // number does not belong in one. Scoped to the worker for the reason in
  // the header -- `wa_conv_full` is USING (true).
  const recipient = await client.query<{ whatsapp_number: string | null }>(
    `SELECT whatsapp_number
       FROM whatsapp_conversations
      WHERE id = $1 AND user_id = $2`,
    [conversationId, input.workerId],
  );
  const whatsappNumber = recipient.rows[0]?.whatsapp_number;
  if (typeof whatsappNumber !== 'string' || whatsappNumber.length === 0) return null;

  return {
    whatsappNumber,
    body: buildWebCompletionBody(lang, typeof jobTitle === 'string' ? jobTitle : null),
    contentTemplate: null,
    contentVariables: null,
  };
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
 * The prompt lane ALONE. A worker who answered the last pre-application
 * prompt on the web has not necessarily finished the details-stage fill, so
 * this must not match -- or clear -- a fill arm.
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
    lane: 'all' | 'prompt';
    conversationId: string;
    lang: PreferredLanguage;
    jobTitle: string | null;
    lastInboundMs: number | null;
  },
): Promise<boolean> {
  await client.query(`SAVEPOINT ${LANE_SEND_SAVEPOINT}`);
  try {
    registerCategoryRenderer('account', renderWebCompletion);
    await enqueueWorkerMessage(client, {
      workerId: opts.workerId,
      category: 'account',
      ownerService: 'account',
      sourceType: WEB_COMPLETION_SOURCE_TYPE,
      sourceId: opts.applicationId,
      // ONE line per application, forever. `markDetailsCompleteIfDone` only
      // ever flips `details_completed_at` while it `IS NULL`
      // (application-requirements.ts), so the caller fires this once by
      // construction; this key is what makes a retried request idempotent.
      dedupeKey: `application-web-completion:${opts.applicationId}`,
      priority: CLOSING_LINE_PRIORITY,
      // Anchored to the INBOUND instant, not to now. See
      // CLOSING_LINE_EXPIRY_MS: a deferred intent released later must not
      // outlive the window it was cleared against.
      expiresAt: new Date((opts.lastInboundMs ?? Date.now()) + CLOSING_LINE_EXPIRY_MS),
      payload: {
        kind: WEB_COMPLETION_SOURCE_TYPE,
        applicationId: opts.applicationId,
        conversationId: opts.conversationId,
        jobTitle: opts.jobTitle,
        lang: opts.lang,
      },
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
  opts: { lane: 'all' | 'prompt'; applicationId: string },
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
    lane: 'all' | 'prompt';
    closing?: { jobTitle: string | null; lang: PreferredLanguage };
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

    const scrub = await client.query(
      SCRUB_SQL,
      [rows.map((row) => row.id), opts.workerId, opts.scrubKeys],
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
  let closingLineQueued = false;
  if (opts.closing && primary.within_session_window === true) {
    closingLineQueued = await sendClosingLine(client, {
      workerId: opts.workerId,
      applicationId: opts.applicationId,
      lane: opts.lane,
      conversationId: primary.id,
      lang: normalizeLang(primary.language, opts.closing.lang),
      jobTitle: opts.closing.jobTitle,
      lastInboundMs: toMillis(primary.last_inbound_at),
    });
  }

  logRelease({
    lane: opts.lane,
    applicationId: opts.applicationId,
    scrubbed,
    closingLineQueued,
    withinSessionWindow: primary.within_session_window === true,
  });
  return { armed: true, scrubbed, closingLineQueued };
}

/**
 * The details-stage release: clear every fill AND prompt key this
 * application could have armed, then -- inside the 24-hour window only --
 * queue exactly one closing line.
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
    armReadSql: FULL_ARM_READ_SQL,
    scrubKeys: FILL_SCRUB_KEYS,
    lane: 'all',
    closing: { jobTitle: input.jobTitle, lang: input.lang },
  });
}

/**
 * The pre-application-prompt release: clear the three `PROMPT_LANE_SCRUB`
 * keys and send NOTHING. Answering the last prompt on the web is not the end
 * of an application -- the details stage may not even have been requested
 * yet -- so there is nothing to close off, only a stale turn to stand down.
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
    lane: 'prompt',
  });
}
