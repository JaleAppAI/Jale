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
 * lane. This module imports only its shared types. It restates one constant
 * rather than importing it, flagged below: the `__fallback_body`
 * content-variable key (`whatsapp/lib/outbox.ts:20`).
 *
 * Delivery: no wake-queue wiring. The outbox row this produces is drained by
 * the existing minute drain -- the locked sprint decision.
 *
 * ── CALLER CONTRACT (binding) ────────────────────────────────────
 * `enqueueApplicationStageNotification` runs inside the CALLER's transaction
 * and sets no session setting. The caller must already have, for the whole
 * transaction:
 *   * `app.current_user_id`          = the employer's Cognito sub
 *                                      (`setRlsContext`)
 *   * `app.current_internal_user_id` = the EMPLOYER's `users.id`
 *                                      (`setInternalUserRlsContext`)
 *
 * The request login holds no rights on the worker lane's tables. Two
 * capability functions in schema `jale_cap` do the worker-lane work (see
 * `employer-worker-lane.ts`), and each re-checks the caller in SQL against
 * `app.current_internal_user_id`:
 *   1. `employer_stage_recipient(application)` -- the worker behind an
 *      application on one of the caller's jobs, the worker's language and
 *      whether they have a usable WhatsApp number. Any other application
 *      raises 42501.
 *   2. `employer_claim_worker_intent(worker, 'application_stage',
 *      application, payload, message)` -- the intent claim, the onboarding
 *      gate, the runtime controls, the delivery decision and the outbox
 *      insert, in one call. It derives the category, owner, priority, expiry
 *      and the per-change dedupe key from the application, and sends to the
 *      worker's own number.
 * The copy is rendered here, before the claim, in the recipient's language.
 * The claim uses it only when delivery is allowed now; a deferred intent is
 * rendered again when the worker's held messages are released.
 */
import type { PoolClient } from 'pg';
import type { DeliveryDecision, PreferredLanguage } from '../whatsapp/lib/onboarding-types';
import {
  claimWorkerIntent,
  isRendererUnavailable,
  loadStageRecipient,
  type ClaimMessage,
  type StageRecipient,
} from './employer-worker-lane';

export type ApplicationStageKind = 'details_requested' | 'hired';

/**
 * Duplicates `FALLBACK_BODY_KEY` from `whatsapp/lib/outbox.ts:20`.
 * `sendTwilioWhatsAppMessage` strips this key before sending ContentVariables
 * and falls back to its value as a plain `Body` when the content template has
 * no ContentSid (outbox.ts:131-145).
 *
 * That fallback is a SECRET-CONTENTS condition, not a type-level one: all four
 * names below ARE declared in `TwilioSecret['templates']`
 * (twilio.ts:160-163, added with the renderers in c1cb451a), and the plain
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

// ── Rendering ──
//
// The claim takes the message pre-rendered. "Nothing to send" is NULL: a
// worker with no usable number, or a payload the copy cannot be built from.
// Every field is checked BEFORE `buildApplicationStageMessage` runs, because
// that function throws on a non-UUID application id.

function renderApplicationStage(
  recipient: StageRecipient,
  input: ApplicationStageNotifyInput,
): ClaimMessage | null {
  if (!recipient.hasWhatsappNumber) return null;
  if (input.kind !== 'details_requested' && input.kind !== 'hired') return null;
  const { applicationId, jobTitle, companyName, frontendBaseUrl } = input;
  if (
    typeof applicationId !== 'string' || !UUID_REGEX.test(applicationId)
    || typeof jobTitle !== 'string' || jobTitle.length === 0
    || typeof companyName !== 'string' || companyName.length === 0
    || typeof frontendBaseUrl !== 'string' || frontendBaseUrl.length === 0
  ) {
    return null;
  }

  const lang = recipient.language;
  const message = buildApplicationStageMessage(lang, {
    kind: input.kind,
    jobTitle,
    companyName,
    applicationId,
    url: buildApplicationStageUrl(frontendBaseUrl, lang, applicationId),
  });
  // Template-first: the body travels as the fallback content variable so the
  // send still works before the ContentSid is seeded. See FALLBACK_BODY_KEY.
  return { content_template: message.contentTemplate, content_variables: message.contentVariables };
}

export interface ApplicationStageNotifyInput {
  applicationId: string;
  workerId: string;
  kind: ApplicationStageKind;
  jobId?: string | null;
  jobTitle: string;
  companyName: string;
  frontendBaseUrl: string;
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
 * Enqueues the worker-facing stage notification inside the CALLER's
 * transaction. No BEGIN/COMMIT/ROLLBACK here, no Twilio call, no fetch.
 *
 * One notification per (application, status, updated_at): the claim derives
 * that key from the application row, so a retry of the same request claims
 * the same intent and never adds a second outbox row, while a later stage
 * change is a new notification.
 *
 * A `renderer_unavailable` outcome (no usable number -- the worker never
 * finished WhatsApp onboarding) is a normal, non-fatal answer: the claim
 * returns it rather than raising, the rejected intent is kept, and the
 * caller may commit the status change anyway. Every error propagates. A
 * `defer` decision (worker mid-onboarding) is a plain success: the intent
 * sits until the worker.ready release.
 */
export async function enqueueApplicationStageNotification(
  client: PoolClient,
  input: ApplicationStageNotifyInput,
): Promise<ApplicationStageNotifyResult> {
  const recipient = await loadStageRecipient(client, input.applicationId);
  const claim = await claimWorkerIntent(client, {
    workerId: input.workerId,
    kind: 'application_stage',
    sourceId: input.applicationId,
    payload: {
      kind: 'application_stage',
      status: input.kind,
      applicationId: input.applicationId,
      jobId: input.jobId ?? null,
      jobTitle: input.jobTitle,
      companyName: input.companyName,
      frontendBaseUrl: input.frontendBaseUrl,
    },
    message: renderApplicationStage(recipient, input),
  });
  if (isRendererUnavailable(claim.decision)) {
    return { outcome: 'renderer_unavailable', reason: 'renderer_unavailable' };
  }
  return {
    outcome: 'enqueued',
    intentId: claim.intentId,
    decision: claim.decision,
    outboxMaterialized: claim.outboxMaterialized,
  };
}
