/**
 * application-web-completion-copy.ts -- the closing line's copy, and nothing
 * else.
 *
 * ── WHY THIS IS ITS OWN FILE ─────────────────────────────────────────
 * Two renderers must produce the SAME line and they live on opposite sides of
 * an import cycle:
 *
 *   - the CATEGORY renderer in `lib/application-web-completion.ts`, which
 *     runs when `evaluateDelivery` says `allow`; and
 *   - the RELEASE renderer arm in `whatsapp/lib/onboarding-renderers.ts`,
 *     which is the ONLY path for an intent that was DEFERRED (worker not yet
 *     `ready`, or `deferred_delivery_enabled` off) and is materialized later
 *     by `whatsapp/worker-ready-release.ts`.
 *
 * `onboarding-renderers.ts` cannot import `application-web-completion.ts`:
 *
 *   onboarding-renderers -> application-web-completion -> application-fill
 *     -> conversation-router -> job-messaging -> onboarding-renderers
 *
 * That cycle is real (it is why `application-stage-notify.ts`, which has no
 * such chain, can be imported there directly and this module cannot). So the
 * copy lives HERE, in a leaf with one type-only import, and both renderers
 * import it. Duplicating the string instead would let the two paths drift --
 * and the deferred path is exactly the one nobody looks at.
 */
import type { PreferredLanguage } from '../whatsapp/lib/onboarding-types';

/**
 * `worker_message_intents.source_type` and the payload's `kind`. Both
 * renderers refuse a payload whose `kind` is not this, so a foreign payload
 * degrades to a null render rather than to the wrong copy.
 */
export const WEB_COMPLETION_SOURCE_TYPE = 'application_web_completion';

/** `job_applications.id` / `whatsapp_conversations.id` are v4 UUIDs. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
 * `lease_worker_intent_outbox` (043) already projects `body` for the drain to
 * hand it. The caller's 24-hour window check is what makes that legal.
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

/** The body-only message shape both renderers return (minus the recipient). */
export interface WebCompletionMessage {
  body: string;
  contentTemplate: null;
  contentVariables: null;
}

/**
 * Validates a stored intent payload and builds its line, or returns null so
 * the caller can fall back (the release renderer's generic notice, or the
 * category renderer's `renderer_unavailable`).
 *
 * Mirrors `buildApplicationStagePayloadMessage` in `onboarding-renderers.ts`:
 * every field is checked BEFORE any copy is built, and this never throws --
 * a renderer that throws takes a whole release batch down with it.
 *
 * `language` is the caller's context (the workflow run's language on the
 * release path). The payload's OWN `lang` wins when it is one we render,
 * because that value came from the conversation row -- the language the bot
 * has actually been speaking to this worker.
 */
export function buildWebCompletionPayloadMessage(
  language: PreferredLanguage,
  payload: Record<string, unknown> | null | undefined,
): WebCompletionMessage | null {
  if (!payload || payload.kind !== WEB_COMPLETION_SOURCE_TYPE) return null;

  const { applicationId, jobTitle, lang } = payload;
  if (typeof applicationId !== 'string' || !UUID_REGEX.test(applicationId)) return null;
  if (jobTitle !== null && jobTitle !== undefined && typeof jobTitle !== 'string') return null;

  const resolved: PreferredLanguage = lang === 'en' || lang === 'es' ? lang : language;
  return {
    body: buildWebCompletionBody(resolved, typeof jobTitle === 'string' ? jobTitle : null),
    contentTemplate: null,
    contentVariables: null,
  };
}
