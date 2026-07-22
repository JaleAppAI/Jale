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
}

function buildJobAlertDigestMessage(
  lang: Lang,
  jobsIn: ReadonlyArray<DigestJob>,
): ReleaseRenderedMessage {
  const jobs = jobsIn.slice(0, JOB_ALERT_DIGEST_CAP);
  const lines = jobs.map((j, i) => `${i + 1}. ${j.title} - ${j.companyName}`);
  const header =
    lang === 'es'
      ? `Tenemos ${jobs.length} trabajo(s) para ti:`
      : `We have ${jobs.length} job(s) for you:`;
  const footer =
    lang === 'es'
      ? 'Responde TRABAJOS (JOBS) para ver la lista completa.'
      : 'Reply JOBS to see the full list.';
  const body = [header, ...lines, footer].join('\n');
  return { body, contentTemplate: null, contentVariables: null };
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

const renderOnboarding: CategoryRenderer = async (client, input) => {
  const recipient = await loadVerifiedRecipient(client, input.workerId);
  if (!recipient) return null;
  const message = buildOnboardingCompleteMessage(toLang(recipient.language));
  return { whatsappNumber: recipient.whatsappNumber, ...message };
};

const renderSecurity: CategoryRenderer = async (client, input) => {
  const recipient = await loadVerifiedRecipient(client, input.workerId);
  if (!recipient) return null;
  const message = buildSecurityNoticeMessage(toLang(recipient.language));
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
