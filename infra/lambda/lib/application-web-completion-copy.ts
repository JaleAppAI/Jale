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
 * copy lives HERE, in a leaf, and both renderers import it. Its runtime
 * imports are the fallback-body key from `whatsapp/lib/outbox.ts` and the
 * link helper in `whatsapp/lib/worker-application-url.ts`, neither of which
 * imports anything on that chain. Duplicating the string instead would let
 * the two paths drift -- and the deferred path is exactly the one nobody
 * looks at.
 *
 * ── ONE MESSAGE, TWO SHAPES (sprint 28, F28) ─────────────────────────
 * The words are always the approved `application_web_completed_<lang>`
 * body, naming the job's trade and linking the application
 * (`buildWebCompletionBody`). Inside WhatsApp's 24-hour window they go
 * free-form. Outside it a free-form body is refused, so they go as that
 * template (`buildWebCompletionTemplateMessage`). The enqueue decides which,
 * and the payload carries the decision (`shape: 'template'`) with the trade
 * and the link, so a DEFERRED intent is rendered later exactly as it was
 * queued.
 */
import type { PreferredLanguage } from '../whatsapp/lib/onboarding-types';
import { FALLBACK_BODY_KEY } from '../whatsapp/lib/outbox';
import { workerApplicationUrl } from '../whatsapp/lib/worker-application-url';

/**
 * `worker_message_intents.source_type` and the payload's `kind`. Both
 * renderers refuse a payload whose `kind` is not this, so a foreign payload
 * degrades to a null render rather than to the wrong copy.
 */
export const WEB_COMPLETION_SOURCE_TYPE = 'application_web_completion';

/** `job_applications.id` / `whatsapp_conversations.id` are v4 UUIDs. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The closing line's words, in both shapes. Pure: no clock, no client, no
 * network.
 *
 * ── BYTE-IDENTICAL TO THE SEEDED TEMPLATE. Edit both, or neither. ──
 * The text is the approved `application_web_completed_<lang>` body in
 * `scripts/seed-whatsapp-twilio-templates.mjs` with `{{1}}` (the trade) and
 * `{{2}}` (the link) substituted; `seed-whatsapp-twilio-templates.test.ts`
 * derives its expected strings from this module. The approved Spanish says
 * "aqu\u00ed", so this copy is not ASCII-only; the accent is written as an
 * escape so this file stays ASCII.
 *
 * Inside the window it is the free-form `Body` (the sender sends `Body`
 * whenever `content_template` is null). Outside it, it is the template's
 * `__fallback_body`.
 */
export function buildWebCompletionBody(
  lang: PreferredLanguage,
  input: { trade: string; url: string },
): string {
  const trade = singleLine(input.trade);
  const { url } = input;
  return lang === 'en'
    ? `You completed your application for the ${trade} job on the web. `
      + `See its status at ${url} and we'll let you know here when the employer responds.`
    : `Completaste tu solicitud para el trabajo de ${trade} en la web. `
      + `Revisa su estado en ${url} y te avisamos por aqu\u00ed cuando el empleador responda.`;
}

/** The payload `shape` of an intent queued as the template. */
export const WEB_COMPLETION_TEMPLATE_SHAPE = 'template';

/** `application_web_completed_es` / `_en`, seeded by scripts/seed-whatsapp-twilio-templates.mjs. */
export function webCompletionTemplateName(lang: PreferredLanguage): string {
  return `application_web_completed_${lang}`;
}

/**
 * The job's trade in the worker's language, for the template's `{{1}}`
 * ("the {{1}} job"). Mirrors the frontend's `trade.*` catalogue for the 077
 * `jobs.trade_category` tokens; `other` uses the employer's own words.
 */
const JOB_TRADE_LABELS: Record<string, Record<PreferredLanguage, string>> = {
  electrician: { en: 'Electrician', es: 'Electricista' },
  plumber: { en: 'Plumber', es: 'Plomero' },
  carpenter: { en: 'Carpenter', es: 'Carpintero' },
  concrete: { en: 'Concrete', es: 'Concreto' },
  painting: { en: 'Painting', es: 'Pintura' },
  drywall: { en: 'Drywall', es: 'Drywall' },
  general_labor: { en: 'General labor', es: 'Ayudante general' },
};

/**
 * One line of plain text: WhatsApp refuses a template variable that carries
 * a newline, a tab or a long run of spaces.
 */
function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Names the job by its trade, not its title (owner ruling for F28): the
 * catalogue label, else the employer's `trade_category_other`, else the title
 * when the job states no trade. Null when there is nothing to name, and then
 * no template is sent.
 */
export function webCompletionTradeLabel(
  lang: PreferredLanguage,
  job: { tradeCategory: string | null; tradeCategoryOther: string | null; title: string | null },
): string | null {
  const label = job.tradeCategory ? JOB_TRADE_LABELS[job.tradeCategory]?.[lang] : undefined;
  if (label) return label;
  for (const candidate of [job.tradeCategory === 'other' ? job.tradeCategoryOther : null, job.title]) {
    const text = typeof candidate === 'string' ? singleLine(candidate) : '';
    if (text.length > 0) return text;
  }
  return null;
}

/**
 * The template message, with `buildWebCompletionBody`'s text as
 * `__fallback_body`. The sender uses the fallback while no ContentSid is
 * mapped: inside the window that delivers, and outside it Twilio refuses it
 * (63016), which `isTemplatePendingRejection` in `whatsapp/lib/outbox.ts`
 * parks for an hour instead of failing, as for every `application_*`
 * template awaiting approval.
 */
export function buildWebCompletionTemplateMessage(
  lang: PreferredLanguage,
  input: { trade: string; url: string },
): WebCompletionTemplateMessage {
  const trade = singleLine(input.trade);
  const { url } = input;
  return {
    body: null,
    contentTemplate: webCompletionTemplateName(lang),
    contentVariables: { '1': trade, '2': url, [FALLBACK_BODY_KEY]: buildWebCompletionBody(lang, { trade, url }) },
  };
}

/** The body-only message shape both renderers return inside the window (minus the recipient). */
export interface WebCompletionMessage {
  body: string;
  contentTemplate: null;
  contentVariables: null;
}

/** The template message both renderers return for an intent queued outside the window. */
export interface WebCompletionTemplateMessage {
  body: null;
  contentTemplate: string;
  contentVariables: Record<string, string>;
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
): WebCompletionMessage | WebCompletionTemplateMessage | null {
  if (!payload || payload.kind !== WEB_COMPLETION_SOURCE_TYPE) return null;

  const { applicationId, jobTitle, lang } = payload;
  if (typeof applicationId !== 'string' || !UUID_REGEX.test(applicationId)) return null;
  if (jobTitle !== null && jobTitle !== undefined && typeof jobTitle !== 'string') return null;

  const resolved: PreferredLanguage = lang === 'en' || lang === 'es' ? lang : language;

  // A free-form line queued by the release before the trade and the link
  // were stored (no `shape`, no `trade`, no `url`) is named by its title,
  // the template's own last fallback, and linked the way the enqueue links.
  const queuedWithoutTradeAndLink = payload.shape === undefined
    && payload.trade === undefined && payload.url === undefined;
  const trade = queuedWithoutTradeAndLink ? jobTitle : payload.trade;
  const url = queuedWithoutTradeAndLink ? workerApplicationUrl(resolved, applicationId) : payload.url;
  if (typeof trade !== 'string' || singleLine(trade).length === 0) return null;
  if (typeof url !== 'string' || !url.startsWith('https://') || !url.endsWith(`/${applicationId}`)) return null;

  if (payload.shape === WEB_COMPLETION_TEMPLATE_SHAPE) {
    // Queued outside the window: the template, or nothing. A free-form line
    // here would be refused by Meta.
    return buildWebCompletionTemplateMessage(resolved, { trade, url });
  }

  return {
    body: buildWebCompletionBody(resolved, { trade, url }),
    contentTemplate: null,
    contentVariables: null,
  };
}
