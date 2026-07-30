// infra/lambda/whatsapp/lib/onboarding-renderers.ts
//
// C4 category renderers + the release renderer for the WhatsApp v2
// onboarding lane. Pure content builders live at module scope and are
// shared between the category renderers (invoked by
// `enqueueWorkerMessage` through the C4 registry) and the release renderer
// (invoked when a worker's held messages are released). Neither path makes
// a network call, reads the clock, enqueues, or sends — category renderers
// only perform parameterized SELECTs through the caller-supplied
// `PoolClient` to resolve the verified recipient (WhatsApp number) and
// preferred language; release rendering is pure over its request.
//
// Ownership: `registerOnboardingRenderers()` registers only the categories
// `evaluateDelivery` (delivery-policy.ts) treats as privileged to this
// lane — 'onboarding' (owner 'onboarding-v2') and 'security' (owner
// 'identity'). The other categories ('account', 'job_alert',
// 'employer_chat') are exported on `categoryRenderers` for completeness and
// testing, but are registered by their own owning lanes, not here.

import type { PoolClient } from 'pg';
import type {
  CategoryRenderer,
  MessageCategory,
  PreferredLanguage,
  ReleaseRenderedMessage,
  ReleaseRenderer,
  ReleaseRenderRequest,
} from './onboarding-types';
import { registerCategoryRenderer } from './worker-delivery-gateway';
import { t, type Lang } from './templates';

/**
 * Single exported source of truth for the canonical `MessageCategory`
 * union's members. `categoryRenderers` below is typed
 * `Record<MessageCategory, CategoryRenderer>`, so a category added to the
 * shared union without a corresponding entry here fails the TypeScript
 * build; this array lets tests assert the same coverage at runtime.
 */
export const ALL_MESSAGE_CATEGORIES: readonly MessageCategory[] = [
  'onboarding',
  'security',
  'account',
  'job_alert',
  'employer_chat',
];

/** Job-alert digests never render more than this many entries per message. */
const JOB_ALERT_DIGEST_CAP = 10;

// ── Recipient resolution (category renderers only) ──

interface RecipientRow {
  whatsapp_number: string | null;
  preferred_language: PreferredLanguage;
}

interface VerifiedRecipient {
  whatsappNumber: string;
  language: PreferredLanguage;
}

/**
 * Resolves the verified WhatsApp number and preferred language for a
 * worker via a single parameterized SELECT. Returns null when there is no
 * verified number to send to — callers must not fabricate one.
 */
async function loadVerifiedRecipient(
  client: PoolClient,
  workerId: string,
): Promise<VerifiedRecipient | null> {
  const result = await client.query<RecipientRow>(
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

// ── Pure content builders (shared by category + release renderers) ──
//
// ASCII-only, unaccented Spanish, matching the convention in templates.ts.
// None of these read a payload's OTP or raw inbound body, and none embed a
// raw phone number.

function buildOnboardingCompleteMessage(lang: Lang): ReleaseRenderedMessage {
  return { body: t('v2_ready', lang), contentTemplate: null, contentVariables: null };
}

function buildSecurityNoticeMessage(lang: Lang): ReleaseRenderedMessage {
  const body =
    lang === 'es'
      ? 'Aviso de seguridad: detectamos actividad en tu cuenta. Si no fuiste tu, contacta soporte.'
      : 'Security notice: we detected activity on your account. If this was not you, contact support.';
  return { body, contentTemplate: null, contentVariables: null };
}

function buildAccountNoticeMessage(lang: Lang, sourceType: string): ReleaseRenderedMessage {
  const body =
    lang === 'es'
      ? `Actualizacion de cuenta (${sourceType}). Abre la app de Jale para ver los detalles.`
      : `Account update (${sourceType}). Open the Jale app for details.`;
  return { body, contentTemplate: null, contentVariables: null };
}

interface DigestJob {
  jobId: string;
  title: string;
  companyName: string;
  score: number;
  /** Optional because pre-existing deferred intents (enqueued before the
   * producer started sending them) lack these; the renderer degrades to
   * the plain-text digest for those. */
  location?: string;
  pay?: string;
}

function buildJobAlertDigestText(lang: Lang, jobs: ReadonlyArray<DigestJob>): string {
  const lines = jobs.map((j, i) => `${i + 1}. ${j.title} - ${j.companyName}`);
  const header =
    lang === 'es'
      ? `Tenemos ${jobs.length} trabajo(s) para ti:`
      : `We have ${jobs.length} job(s) for you:`;
  const footer =
    lang === 'es'
      ? 'Responde TRABAJOS (JOBS) para ver la lista completa.'
      : 'Reply JOBS to see the full list.';
  return [header, ...lines, footer].join('\n');
}

/**
 * The job a worker was referred to (migration 055), sent as a second message
 * after the welcome.
 *
 * Plain text, deliberately. Buttons on WhatsApp require an approved content
 * template, and the existing `job_alert_*` template has fixed variable slots —
 * referral framing cannot be injected into it without a new Meta-approved
 * template, which is external lead time rather than a code change. Freeform is
 * deliverable here for the same reason the multi-job digest below is: the
 * worker.ready release fires moments after the worker's own message, so we are
 * always inside WhatsApp's 24h customer-service window. So we carry the
 * referral framing and point at the JOBS/TRABAJOS keyword the processor already
 * handles, rather than inventing a button payload no handler receives.
 */
function buildReferredJobMessage(
  lang: Lang,
  job: { jobId: string; title: string; companyName: string; location: string | null; pay: string | null } | null,
): ReleaseRenderedMessage {
  if (!job) {
    const body =
      lang === 'es'
        ? 'El trabajo al que te recomendaron ya se ocupo, pero tenemos otros como ese. Escribe TRABAJOS para verlos.'
        : 'The job you were referred to has been filled, but we have others like it. Reply JOBS to see them.';
    return { body, contentTemplate: null, contentVariables: null };
  }

  // title/companyName/location are employer free text — rendered as stored,
  // never translated. pay and location are both nullable (migration 003), so
  // each is omitted rather than rendered as a dangling separator.
  const headline = [job.title, job.companyName].filter((p) => p && p.length > 0).join(' - ');
  const detail = [job.location, job.pay].filter((p) => p && p.length > 0).join(' - ');
  const body =
    lang === 'es'
      ? `Un amigo te recomendo este trabajo:\n\n${headline}${detail ? `\n${detail}` : ''}\n\nEscribe TRABAJOS para postularte o ver otros.`
      : `A friend referred you to this job:\n\n${headline}${detail ? `\n${detail}` : ''}\n\nReply JOBS to apply or see others.`;
  return { body, contentTemplate: null, contentVariables: null };
}

function buildJobAlertDigestMessage(
  lang: Lang,
  jobsIn: ReadonlyArray<DigestJob>,
): ReleaseRenderedMessage {
  const jobs = jobsIn.slice(0, JOB_ALERT_DIGEST_CAP);

  // 2026-07-27 parity-audit fix: a SINGLE job alert renders v1's approved
  // `job_alert_*` content template (same variables and `job-<id>` button
  // payload contract as job-alert.ts's legacy branch, matching
  // parseButtonPayload in flows.ts). This is the alert that reaches a
  // DORMANT ready worker — outside WhatsApp's 24h customer-service window
  // Meta rejects freeform sends, so the plain-text version silently never
  // arrived, and it also had no Accept/Decline/Info buttons. The
  // multi-job digest keeps plain text: it is only produced by the
  // worker.ready release, moments after the worker's own message, so it is
  // always inside the window.
  //
  // `jobs.pay` is nullable (migration 003) and a pre-existing deferred
  // intent may carry no `location` either — the template must still render
  // (a missing pay/location must never fall back to the plain-text digest,
  // which Twilio rejects outside the 24h window, defeating the whole point
  // of this branch). A bilingual placeholder substitutes for whichever of
  // the two is missing; only `jobId`/`title`/`companyName` are required.
  const single = jobs.length === 1 ? jobs[0] : null;
  if (
    single
    && typeof single.jobId === 'string' && single.jobId.length > 0
    && typeof single.title === 'string' && single.title.length > 0
    && typeof single.companyName === 'string' && single.companyName.length > 0
  ) {
    const location = typeof single.location === 'string' && single.location.length > 0
      ? single.location
      : (lang === 'en' ? 'Location not specified' : 'Ubicacion no especificada');
    const pay = typeof single.pay === 'string' && single.pay.length > 0
      ? single.pay
      : (lang === 'en' ? 'Pay not specified' : 'Pago no especificado');
    return {
      body: null,
      contentTemplate: lang === 'en' ? 'job_alert_en' : 'job_alert_es',
      contentVariables: {
        '1': single.title,
        '2': single.companyName,
        '3': location,
        '4': pay,
        '5': `job-${single.jobId}`,
        [FALLBACK_BODY_KEY]: buildJobAlertDigestText(lang, jobs),
      },
    };
  }

  return { body: buildJobAlertDigestText(lang, jobs), contentTemplate: null, contentVariables: null };
}

function buildEmployerChatSingleMessage(
  lang: Lang,
  companyName: string,
  jobTitle: string,
): ReleaseRenderedMessage {
  const body =
    lang === 'es'
      ? `${companyName} quiere hablar contigo sobre el trabajo de ${jobTitle}. Responde MENSAJES para abrir el chat.`
      : `${companyName} wants to chat with you about the ${jobTitle} job. Reply CHATS to open the chat.`;
  return { body, contentTemplate: null, contentVariables: null };
}

function buildEmployerChatSummaryMessage(
  lang: Lang,
  conversationCount: number,
): ReleaseRenderedMessage {
  const body =
    lang === 'es'
      ? `${conversationCount} empleadores quieren hablar contigo. Responde MENSAJES para ver tus chats (Ver Chats).`
      : `${conversationCount} employers are trying to reach you. Reply CHATS to open View Chats.`;
  return { body, contentTemplate: null, contentVariables: null };
}

// ── Category renderers (one per canonical MessageCategory member) ──

function toLang(language: PreferredLanguage): Lang {
  return language;
}

function isDigestJobArray(value: unknown): value is DigestJob[] {
  return (
    Array.isArray(value) &&
    value.every(
      (j) =>
        j &&
        typeof j === 'object' &&
        typeof (j as Record<string, unknown>).title === 'string' &&
        typeof (j as Record<string, unknown>).companyName === 'string',
    )
  );
}

/** Reserved `content_variables` key `sendTwilioWhatsAppMessage` (outbox.ts)
 * reads for the plain-text fallback when a `content_template` has no
 * registered Twilio ContentSid; stripped before the real Twilio send when a
 * ContentSid is found. `queueInteractivePrompt` (processor.ts, the pre-auth
 * path) has always paired every templated send with this key. */
const FALLBACK_BODY_KEY = '__fallback_body';

/**
 * Renders the message the enqueuing lane actually asked for, when the
 * intent payload carries one. `sendStepPrompt` (onboarding-v2.ts) enqueues
 * step prompts as `{ templateName, variables, fallbackBody, lang }`;
 * `sendTemplateMessage` enqueues plain text as `{ body, lang }`. Returns
 * null when the payload carries no message copy, so the category's default
 * copy applies (the pre-payload behavior).
 *
 * Ignoring the payload here is what shipped originally — every post-bind
 * step prompt (legal.review, profile.*, trust.*) was delivered as the
 * terminal "profile is ready" copy, dead-ending onboarding right after OTP
 * verification.
 */
function buildPayloadMessage(payload: Record<string, unknown>): ReleaseRenderedMessage | null {
  // whatsapp_outbox enforces `body_or_template`: a row carries EITHER body
  // OR (content_template + content_variables), never both. Real interactive
  // prompts (buildV2OtpPrompt et al.) always populate templateName and
  // fallbackBody together, so templateName must win outright — sending both
  // trips the DB check constraint (23514) and drops the message silently
  // from the worker's point of view.
  const contentTemplate =
    typeof payload.templateName === 'string' && payload.templateName !== ''
      ? payload.templateName
      : null;
  if (contentTemplate) {
    let contentVariables: Record<string, string> = {};
    if (payload.variables && typeof payload.variables === 'object') {
      const entries = Object.entries(payload.variables as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      );
      contentVariables = Object.fromEntries(entries);
    }
    // Without this, an unregistered/renamed Twilio ContentSid hard-fails the
    // send (outbox.ts throws 'Twilio template missing') instead of degrading
    // to plain text, even though the prompt builder always supplies one.
    if (typeof payload.fallbackBody === 'string' && payload.fallbackBody !== '') {
      contentVariables = { ...contentVariables, [FALLBACK_BODY_KEY]: payload.fallbackBody };
    }
    return { body: null, contentTemplate, contentVariables };
  }
  const body =
    typeof payload.fallbackBody === 'string' && payload.fallbackBody !== ''
      ? payload.fallbackBody
      : typeof payload.body === 'string' && payload.body !== ''
        ? payload.body
        : null;
  if (body === null) return null;
  return { body, contentTemplate: null, contentVariables: null };
}

const renderOnboarding: CategoryRenderer = async (client, input) => {
  const recipient = await loadVerifiedRecipient(client, input.workerId);
  if (!recipient) return null;
  const message =
    buildPayloadMessage(input.payload) ?? buildOnboardingCompleteMessage(toLang(recipient.language));
  return { whatsappNumber: recipient.whatsappNumber, ...message };
};

const renderSecurity: CategoryRenderer = async (client, input) => {
  const recipient = await loadVerifiedRecipient(client, input.workerId);
  if (!recipient) return null;
  const message =
    buildPayloadMessage(input.payload) ?? buildSecurityNoticeMessage(toLang(recipient.language));
  return { whatsappNumber: recipient.whatsappNumber, ...message };
};

const renderAccount: CategoryRenderer = async (client, input) => {
  const recipient = await loadVerifiedRecipient(client, input.workerId);
  if (!recipient) return null;
  const message = buildAccountNoticeMessage(toLang(recipient.language), input.sourceType);
  return { whatsappNumber: recipient.whatsappNumber, ...message };
};

const renderJobAlert: CategoryRenderer = async (client, input) => {
  const jobsPayload = (input.payload as Record<string, unknown>).jobs;
  if (!isDigestJobArray(jobsPayload) || jobsPayload.length === 0) return null;
  const recipient = await loadVerifiedRecipient(client, input.workerId);
  if (!recipient) return null;
  const message = buildJobAlertDigestMessage(toLang(recipient.language), jobsPayload);
  return { whatsappNumber: recipient.whatsappNumber, ...message };
};

const renderEmployerChat: CategoryRenderer = async (client, input) => {
  const payload = input.payload as Record<string, unknown>;
  const conversationCount = payload.conversationCount;
  const companyName = payload.companyName;
  const jobTitle = payload.jobTitle;

  let message: ReleaseRenderedMessage | null = null;
  const recipient = await loadVerifiedRecipient(client, input.workerId);
  if (!recipient) return null;
  const lang = toLang(recipient.language);

  if (typeof conversationCount === 'number' && conversationCount > 1) {
    message = buildEmployerChatSummaryMessage(lang, conversationCount);
  } else if (typeof companyName === 'string' && typeof jobTitle === 'string') {
    message = buildEmployerChatSingleMessage(lang, companyName, jobTitle);
  }

  if (!message) return null;
  return { whatsappNumber: recipient.whatsappNumber, ...message };
};

export const categoryRenderers: Record<MessageCategory, CategoryRenderer> = {
  onboarding: renderOnboarding,
  security: renderSecurity,
  account: renderAccount,
  job_alert: renderJobAlert,
  employer_chat: renderEmployerChat,
};

// ── Registration (idempotent across warm Lambda initializations) ──

/**
 * Registers this lane's privileged category renderers ('onboarding',
 * owned by 'onboarding-v2', and 'security', owned by 'identity' — see
 * delivery-policy.ts's owner check) with the C4 registry. Safe to call on
 * every warm Lambda init, and safe to call again after a test suite calls
 * `_clearCategoryRenderersForTests()`: idempotency is not tracked with
 * separate module state here (that would desynchronize from the registry
 * itself, e.g. across a test-only clear). `registerCategoryRenderer` sets
 * the same Map key on every call, so registering twice is idempotent by
 * construction and a repeat call after a clear still repopulates the
 * registry correctly.
 */
export function registerOnboardingRenderers(): void {
  registerCategoryRenderer('onboarding', categoryRenderers.onboarding);
  registerCategoryRenderer('security', categoryRenderers.security);
}

// ── Release renderer (pure; covers all five ReleaseRenderRequest kinds) ──

export function createReleaseRenderer(): ReleaseRenderer {
  return {
    async render(request: ReleaseRenderRequest): Promise<ReleaseRenderedMessage> {
      switch (request.kind) {
        case 'onboarding_complete':
          return buildOnboardingCompleteMessage(request.language);
        case 'account_notice':
          return buildAccountNoticeMessage(request.language, request.sourceType);
        case 'referred_job':
          return buildReferredJobMessage(request.language, request.job);
        case 'job_alert_digest':
          return buildJobAlertDigestMessage(request.language, request.jobs);
        case 'employer_chat_single':
          return buildEmployerChatSingleMessage(
            request.language,
            request.companyName,
            request.jobTitle,
          );
        case 'employer_chat_summary':
          return buildEmployerChatSummaryMessage(request.language, request.conversationCount);
        default: {
          const exhaustiveCheck: never = request;
          throw new Error(`Unhandled release kind: ${JSON.stringify(exhaustiveCheck)}`);
        }
      }
    },
  };
}
