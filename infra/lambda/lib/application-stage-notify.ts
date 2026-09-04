/**
 * application-stage-notify.ts -- the worker-facing WhatsApp ping the
 * employer's application-stage changes produce.
 *
 * Sprint 23 splits an application into "apply" and "details" stages. Two
 * employer actions must reach the worker off-app:
 *   - `details_requested`: the employer wants the stage-2 answers.
 *   - `hired`: the employer selected the worker.
 *
 * Ownership: everything under `lambda/whatsapp/**` belongs to the WhatsApp
 * lane. This module IMPORTS from it (`enqueueWorkerMessage`,
 * `registerCategoryRenderer`, the shared types) and never edits it. Two
 * things it duplicates rather than imports are flagged here with a comment
 * and a follow-up note: the `__fallback_body` content-variable key
 * (`whatsapp/lib/outbox.ts:20`) and the verified-recipient lookup
 * (`whatsapp/lib/onboarding-renderers.ts`'s `loadVerifiedRecipient`). Both
 * are exported now, so both duplicates are deletable.
 *
 * Delivery: no wake-queue wiring. The outbox row this produces is drained by
 * the existing minute drain -- the locked sprint decision.
 *
 * ── RLS CONTRACT (binding) ───────────────────────────────────────
 * `enqueueApplicationStageNotification` sets NO GUC and restores none. The
 * CALLER must already have, for the whole transaction:
 *   * `app.current_user_id`          = the employer's Cognito sub
 *                                      (`setRlsContext`, db.ts:58)
 *   * `app.current_internal_user_id` = the EMPLOYER's `users.id`
 *                                      (`setInternalUserRlsContext`, db.ts:70)
 *
 * The second one is load-bearing and counter-intuitive: this runs as
 * jale_admin, and every read/write the enqueue performs is admitted under
 * that pair.
 *   1. `users_employer_applicant_read` (020b:261-269, repaired by 038) --
 *      jale_admin's ONLY SELECT policy over a worker row, matching on
 *      `employer_has_applicant_relationship(app.current_internal_user_id,
 *      users.id)`. `loadVerifiedRecipient` below reads the worker's phone
 *      through it. Point that GUC at the WORKER (the shape
 *      `job-messaging.ts:505-529` uses, which only ever runs on the
 *      non-rendering deferred branch) and the SELECT returns zero rows: the
 *      renderer returns null, the gateway rejects the intent
 *      `renderer_unavailable`, and the notification is silently dropped.
 *   2. `worker_message_intents_definer` (043) -- USING (true) for the definer
 *      path, so the INSERT/UPDATE need no worker identity.
 *   3. `whatsapp_outbox` is ENABLE (not FORCE) RLS, so the owning role writes
 *      it directly.
 *   4. `worker_onboarding_state` / `worker_workflow_runs` `*_definer`
 *      policies (042) admit the gate and language reads.
 */
import type { PoolClient } from 'pg';
import {
  enqueueWorkerMessage,
  registerCategoryRenderer,
} from '../whatsapp/lib/worker-delivery-gateway';
import type {
  CategoryRenderer,
  DeliveryDecision,
  PreferredLanguage,
} from '../whatsapp/lib/onboarding-types';

export type ApplicationStageKind = 'details_requested' | 'hired';

/**
 * Duplicates `FALLBACK_BODY_KEY` from `whatsapp/lib/outbox.ts:20`.
 * `sendTwilioWhatsAppMessage` strips this key before sending ContentVariables
 * and falls back to its value as a plain `Body` when the content template has
 * no ContentSid (outbox.ts:130-145).
 *
 * That fallback is a SECRET-CONTENTS condition, not a type-level one: all four
 * names below ARE declared in `TwilioSecret['templates']`
 * (twilio.ts:159-162, added with the renderers in c1cb451a), and the plain
 * `Body` is used only for as long as no ContentSid is actually seeded under
 * those keys -- which is what made the 2026-09-04 63016s a template-approval
 * wait rather than a code bug (see the defer branch in
 * `whatsapp/lib/outbox.ts` and migration 093).
 *
 * FOLLOW-UP (Ivan / WhatsApp lane): the constant is already exported; import
 * it here instead of restating the literal.
 */
const FALLBACK_BODY_KEY = '__fallback_body';

/** `job_applications.id` is a v4 UUID; anything else is a programming error. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The stage notification is worthless a week later; let the intent expire. */
const STAGE_NOTIFY_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Below the 40 the employer_chat intent uses: a stage change is real news but
 * never more urgent than an employer typing at the worker right now.
 */
const STAGE_NOTIFY_PRIORITY = 30;

export interface ApplicationStageMessageInput {
  kind: ApplicationStageKind;
  jobTitle: string;
  companyName: string;
  applicationId: string;
  url: string;
}

export interface ApplicationStageMessage {
  contentTemplate: string;
  contentVariables: Record<string, string>;
  body: string;
}

/**
 * Builds the worker-facing copy. Pure: no clock, no client, no network.
 *
 * ASCII-only, unaccented, informal-"tu" Spanish, matching the convention in
 * `whatsapp/lib/templates.ts` and the renderers in `onboarding-renderers.ts`.
 *
 * ── BYTE-IDENTICAL TO THE SEEDED TEMPLATES. Edit both, or neither. ──
 *
 * Each body below is the corresponding `QUICK_REPLY_DEFINITIONS` body in
 * `scripts/seed-whatsapp-twilio-templates.mjs` with {{1}} {{2}} {{3}} {{4}}
 * substituted. The template is what a worker sees OUTSIDE WhatsApp's 24-hour
 * session window; this string travels as `__fallback_body` and is what they
 * see INSIDE it. If the two drift, one notification reads two different ways
 * depending on when the employer happened to trigger it.
 * `test/unit/scripts/seed-whatsapp-twilio-templates.test.ts` asserts the
 * equality by deriving the expected string from THIS function, so a change on
 * either side fails there.
 *
 * The wording is deliberately, flatly transactional (2026-09-04, D6): Meta
 * recategorised the first submission to MARKETING off the back of the old
 * "Good news:" / "Buenas noticias:" openings, and a MARKETING template cannot
 * be sent outside the session window at all -- which is the only window this
 * lane ever sends in. So: a fixed opening that names the job, a statement of
 * fact, and the two ways to respond. No promotional register, no exclamation
 * marks, and no variable at the very start or end of the string (Meta rejects
 * that outright). Those rules are enforced by the same test file.
 */
export function buildApplicationStageMessage(
  lang: PreferredLanguage,
  input: ApplicationStageMessageInput,
): ApplicationStageMessage {
  if (!UUID_REGEX.test(input.applicationId)) {
    throw new Error(`application_stage_invalid_application_id: ${input.applicationId}`);
  }

  const { jobTitle, companyName, url } = input;
  const body =
    input.kind === 'details_requested'
      ? lang === 'es'
        ? `Actualizacion de tu aplicacion para ${jobTitle}: ${companyName} solicito algunos datos adicionales `
          + `para continuar con la revision. Escribe "aplicaciones" para responder aqui, `
          + `o abre ${url} para completarlos en linea.`
        : `Application update for ${jobTitle}: ${companyName} requested additional details `
          + `before continuing the review. Reply "applications" to answer here, `
          + `or open ${url} to submit them online.`
      : lang === 'es'
        ? `Actualizacion del estado de tu aplicacion para ${jobTitle}: ${companyName} te selecciono `
          + `para este puesto. Tu referencia de aplicacion es app-${input.applicationId}. `
          + `Abre ${url} para ver los detalles y los siguientes pasos.`
        : `Application status update for ${jobTitle}: ${companyName} selected you for this position. `
          + `Your application reference is app-${input.applicationId}. `
          + `Open ${url} to review the details and the next steps.`;

  const contentTemplate =
    input.kind === 'details_requested' ? `application_update_${lang}` : `application_hired_${lang}`;

  return {
    contentTemplate,
    contentVariables: {
      '1': jobTitle,
      '2': companyName,
      '3': `app-${input.applicationId}`,
      '4': url,
      [FALLBACK_BODY_KEY]: body,
    },
    body,
  };
}

/**
 * `${frontendBaseUrl}/${lang}/worker/applications/${applicationId}`, built
 * through `URL` so a base with or without a trailing slash yields exactly one
 * separator and the id is percent-encoded. The id is asserted to be a UUID
 * (so it can never inject a path segment) before it is used.
 */
export function buildApplicationStageUrl(
  frontendBaseUrl: string,
  lang: PreferredLanguage,
  applicationId: string,
): string {
  if (!UUID_REGEX.test(applicationId)) {
    throw new Error(`application_stage_invalid_application_id: ${applicationId}`);
  }
  const base = frontendBaseUrl.endsWith('/') ? frontendBaseUrl : `${frontendBaseUrl}/`;
  return new URL(
    `${lang}/worker/applications/${encodeURIComponent(applicationId)}`,
    base,
  ).toString();
}

// ── Recipient resolution ──
//
// Copied verbatim from `loadVerifiedRecipient` in
// `whatsapp/lib/onboarding-renderers.ts:108`. Kept identical so a worker with
// no verified number is resolved the same way on every category.
//
// FOLLOW-UP (Ivan / WhatsApp lane): onboarding-renderers.ts already exports
// both `loadVerifiedRecipient` (:108) and `toLang` (:377), so this duplicate
// can be deleted -- it is a copy of live code, not a stand-in for a private
// one, and the two will drift.

interface VerifiedRecipient {
  whatsappNumber: string;
  language: PreferredLanguage;
}

async function loadVerifiedRecipient(
  client: PoolClient,
  workerId: string,
): Promise<VerifiedRecipient | null> {
  const result = await client.query<{
    whatsapp_number: string | null;
    preferred_language: PreferredLanguage;
  }>(
    `SELECT COALESCE(u.whatsapp_number, u.phone) AS whatsapp_number,
            COALESCE(r.preferred_language, 'es') AS preferred_language
       FROM users u
       LEFT JOIN LATERAL (
         SELECT preferred_language
           FROM worker_workflow_runs
          WHERE user_id = u.id
          ORDER BY created_at DESC
          LIMIT 1
       ) r ON true
      WHERE u.id = $1`,
    [workerId],
  );
  const row = result.rows[0];
  if (!row || !row.whatsapp_number) return null;
  return { whatsappNumber: row.whatsapp_number, language: row.preferred_language };
}

// ── Category renderer ──
//
// The "unavailable" convention the gateway understands is returning null:
// `enqueueWorkerMessage` (worker-delivery-gateway.ts:147-160) flips the
// intent to rejected/'renderer_unavailable' and throws
// `renderer_unavailable:<category>`. Never throw from in here.

const renderApplicationStage: CategoryRenderer = async (client, input) => {
  const payload = input.payload as Record<string, unknown>;
  if (payload.kind !== 'application_stage') return null;

  const status = payload.status;
  if (status !== 'details_requested' && status !== 'hired') return null;

  const applicationId = payload.applicationId;
  const jobTitle = payload.jobTitle;
  const companyName = payload.companyName;
  const frontendBaseUrl = payload.frontendBaseUrl;
  if (
    typeof applicationId !== 'string' || !UUID_REGEX.test(applicationId)
    || typeof jobTitle !== 'string' || jobTitle.length === 0
    || typeof companyName !== 'string' || companyName.length === 0
    || typeof frontendBaseUrl !== 'string' || frontendBaseUrl.length === 0
  ) {
    return null;
  }

  const recipient = await loadVerifiedRecipient(client, input.workerId);
  if (!recipient) return null;

  const lang = recipient.language;
  const message = buildApplicationStageMessage(lang, {
    kind: status,
    jobTitle,
    companyName,
    applicationId,
    url: buildApplicationStageUrl(frontendBaseUrl, lang, applicationId),
  });

  return {
    whatsappNumber: recipient.whatsappNumber,
    // Template-first: `body` travels as the fallback content variable so the
    // send still works before the ContentSid is seeded. See FALLBACK_BODY_KEY.
    body: null,
    contentTemplate: message.contentTemplate,
    contentVariables: message.contentVariables,
  };
};

/**
 * Claims the 'account' category for this lane. Called at enqueue time (the
 * job-messaging.ts:506 precedent) rather than at module load, so the
 * registration cannot be lost to a test-only `_clearCategoryRenderersForTests`
 * and is trivially idempotent -- `registerCategoryRenderer` sets one Map key.
 *
 * Nothing else registers 'account' in this process; the lane's own
 * `renderAccount` exists on `categoryRenderers` but is registered by no one
 * (onboarding-renderers.ts:466-469 registers only 'onboarding'/'security').
 */
export function registerApplicationStageRenderer(): void {
  registerCategoryRenderer('account', renderApplicationStage);
}

export interface ApplicationStageNotifyInput {
  applicationId: string;
  workerId: string;
  kind: ApplicationStageKind;
  jobId?: string | null;
  jobTitle: string;
  companyName: string;
  frontendBaseUrl: string;
  /** `job_applications.updated_at` from the UPDATE's RETURNING clause. */
  updatedAt: Date | string | number | null | undefined;
}

export type ApplicationStageNotifyResult =
  | {
      outcome: 'enqueued';
      intentId: string;
      decision: DeliveryDecision;
      outboxMaterialized: boolean;
    }
  | { outcome: 'renderer_unavailable'; reason: 'renderer_unavailable' };

/**
 * One notification per (application, kind, updated_at). A retry of the same
 * request re-derives the same key and the gateway's ON CONFLICT keeps it to
 * one outbox row; a later stage change carries a new `updated_at` and is a
 * new notification. An unparseable timestamp degrades to its own string form
 * rather than to `NaN`, so the key stays stable and distinct.
 */
function dedupeStamp(updatedAt: ApplicationStageNotifyInput['updatedAt']): string {
  if (updatedAt === null || updatedAt === undefined) return 'unknown';
  const ms = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime();
  return Number.isFinite(ms) ? String(ms) : String(updatedAt);
}

/**
 * The gateway signals "the renderer could not build a message" by throwing a
 * bare `Error('renderer_unavailable:<category>')`
 * (worker-delivery-gateway.ts:158). Matching on the message prefix is the only
 * contract available today.
 *
 * FOLLOW-UP (Ivan / WhatsApp lane, highest priority of the three here): export
 * a `RendererUnavailableError` class or an `isRendererUnavailable(err)`
 * predicate. If that message string ever changes, every stage PATCH for a
 * worker with no verified phone silently flips from 200-with-metric to
 * 500-with-rollback, and nothing in this lane's tests goes red.
 */
function isRendererUnavailable(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('renderer_unavailable:');
}

/**
 * Enqueues the worker-facing stage notification inside the CALLER's
 * transaction. No BEGIN/COMMIT/ROLLBACK here, no Twilio call, no fetch.
 *
 * A `renderer_unavailable` outcome (no verified phone -- the worker never
 * finished WhatsApp onboarding) is a normal, non-fatal answer: the gateway
 * throws it after ordinary queries, so the transaction is NOT poisoned and
 * the caller may commit the status change anyway. Every other error
 * propagates. A `defer` decision (worker mid-onboarding) is a plain success:
 * the intent sits until the worker.ready release.
 */
export async function enqueueApplicationStageNotification(
  client: PoolClient,
  input: ApplicationStageNotifyInput,
): Promise<ApplicationStageNotifyResult> {
  registerApplicationStageRenderer();

  // No GUC switching here -- see the RLS CONTRACT in the header. The
  // employer's users.id must already be in `app.current_internal_user_id`,
  // and switching it to the worker is precisely the bug this contract exists
  // to prevent.
  try {
    const result = await enqueueWorkerMessage(client, {
      workerId: input.workerId,
      category: 'account',
      ownerService: 'account',
      sourceType: 'application_stage',
      sourceId: input.applicationId,
      dedupeKey: `application-stage:${input.applicationId}:${input.kind}:${dedupeStamp(input.updatedAt)}`,
      priority: STAGE_NOTIFY_PRIORITY,
      expiresAt: new Date(Date.now() + STAGE_NOTIFY_EXPIRY_MS),
      payload: {
        kind: 'application_stage',
        status: input.kind,
        applicationId: input.applicationId,
        jobId: input.jobId ?? null,
        jobTitle: input.jobTitle,
        companyName: input.companyName,
        frontendBaseUrl: input.frontendBaseUrl,
      },
    });
    return { outcome: 'enqueued', ...result };
  } catch (err) {
    if (isRendererUnavailable(err)) {
      return { outcome: 'renderer_unavailable', reason: 'renderer_unavailable' };
    }
    throw err;
  }
}
