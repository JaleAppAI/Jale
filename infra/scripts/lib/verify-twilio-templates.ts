// Verifies every Content Template SID in the jale/whatsapp/twilio secret
// against Twilio's Content API. Three groups must exist AND be WhatsApp-approved:
//   - the employer-message templates, which have NO freeform fallback
//     (outbox.ts throws instead);
//   - the v2 admin support-reply templates, the only way an admin reply
//     reaches a worker outside the 24-hour window (the admin dispatcher holds
//     the reply until the worker writes or the template is approved);
//   - since sprint 28, the web completion pair, the only way that line
//     reaches a worker outside the 24-hour window.
// The v2 support replies and the web completion pair must also be filed by
// WhatsApp under the UTILITY category: they carry transactional messages, and
// a template filed as MARKETING is not one. For the employer templates a
// category other than UTILITY is a notice rather than a failure.
// The unversioned admin_support_reply_<lang> keys are retired and must not be
// mapped: admin replies use admin_support_reply_v2_<lang>. A mapped one is
// removed with `seed-whatsapp-twilio-templates.mjs --unset-template <key>`.
// Under `beforeDeploy` (`--verify-templates --before-deploy`) a mapped one is
// a notice rather than a failure.
// Everything else is reported informationally. This is step 0/5 of the
// employer-messaging runbook.
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

export interface TemplateVerification {
  key: string;
  sid: string;
  exists: boolean;
  whatsappStatus: string | null;
  /**
   * The WhatsApp CATEGORY Meta currently has the template filed under
   * (UTILITY / MARKETING / AUTHENTICATION), or null when the approval read
   * failed or the template was never submitted.
   *
   * Status alone is not enough. On 2026-09-04 three of the four pending
   * `application_*` templates had been silently recategorised by Meta to
   * MARKETING, and a MARKETING template cannot carry a transactional
   * notification outside the 24-hour session window -- the only window an
   * employer-triggered stage notification lands in. Every one of them still
   * reported `pending`, so this command showed nothing wrong.
   */
  whatsappCategory: string | null;
}

export interface VerifyTemplatesResult {
  rows: TemplateVerification[];
  failures: string[];
  /**
   * Reported but not failing: a retired key still mapped (under
   * `beforeDeploy`), and an employer template whose category is not UTILITY.
   */
  notices: string[];
}

const EMPLOYER_PREFIX = 'employer_message_';
const REQUIRED_EMPLOYER_KEYS = [
  'employer_message_invite_es',
  'employer_message_invite_en',
  'employer_message_resume_es',
  'employer_message_resume_en',
] as const;
const REQUIRED_SUPPORT_REPLY_KEYS = [
  'admin_support_reply_v2_es',
  'admin_support_reply_v2_en',
] as const;
/** Sprint 28 (F28): the web completion line outside the 24-hour window. */
const REQUIRED_WEB_COMPLETION_KEYS = [
  'application_web_completed_es',
  'application_web_completed_en',
] as const;
const REQUIRED_KEYS: ReadonlySet<string> = new Set([
  ...REQUIRED_EMPLOYER_KEYS,
  ...REQUIRED_SUPPORT_REPLY_KEYS,
  ...REQUIRED_WEB_COMPLETION_KEYS,
]);
/** Must be filed as UTILITY: a non-UTILITY category, or none, fails the run. */
const UTILITY_REQUIRED_KEYS: ReadonlySet<string> = new Set([
  ...REQUIRED_SUPPORT_REPLY_KEYS,
  ...REQUIRED_WEB_COMPLETION_KEYS,
]);
const UTILITY_CATEGORY = 'UTILITY';
/** Superseded by the v2 pair; never to be mapped. */
const RETIRED_SUPPORT_REPLY_KEYS = ['admin_support_reply_es', 'admin_support_reply_en'] as const;

/** Must exist and be approved: the employer templates, the v2 support replies and the web completion pair. */
function mustBeApproved(key: string): boolean {
  return key.startsWith(EMPLOYER_PREFIX) || REQUIRED_KEYS.has(key);
}

export async function verifyTwilioTemplates(deps: {
  fetchImpl?: typeof fetch;
  client?: SecretsManagerClient;
  secretId?: string;
  region?: string;
  /**
   * A mapped RETIRED_SUPPORT_REPLY_KEYS entry becomes a notice instead of a
   * failure. Every other rule is unchanged.
   */
  beforeDeploy?: boolean;
} = {}): Promise<VerifyTemplatesResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const region = deps.region ?? process.env.AWS_REGION ?? 'us-east-2';
  const secretId = deps.secretId ?? process.env.TWILIO_SECRET_ID ?? 'jale/whatsapp/twilio';
  const client = deps.client ?? new SecretsManagerClient({ region });

  const secretValue = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  const secret = JSON.parse(secretValue.SecretString ?? '{}') as {
    accountSid?: string;
    authToken?: string;
    templates?: Record<string, string>;
  };
  if (!secret.accountSid || !secret.authToken) {
    throw new Error('twilio secret is missing accountSid/authToken');
  }
  const templates = secret.templates ?? {};
  const auth = Buffer.from(`${secret.accountSid}:${secret.authToken}`).toString('base64');
  const headers = { Authorization: `Basic ${auth}` };

  const rows: TemplateVerification[] = [];
  const failures: string[] = [];
  const notices: string[] = [];

  for (const required of REQUIRED_KEYS) {
    if (!templates[required]) failures.push(`${required}: missing from the secret templates map`);
  }
  for (const retired of RETIRED_SUPPORT_REPLY_KEYS) {
    if (!templates[retired]) continue;
    if (deps.beforeDeploy) {
      notices.push(
        `${retired}: still mapped; admin replies use admin_support_reply_v2_<lang>, so remove it with `
        + `seed-whatsapp-twilio-templates.mjs --unset-template ${retired}`,
      );
    } else {
      failures.push(`${retired}: must not be mapped (admin replies use admin_support_reply_v2_<lang>)`);
    }
  }

  for (const [key, sid] of Object.entries(templates)) {
    const contentRes = await fetchImpl(`https://content.twilio.com/v1/Content/${sid}`, { headers });
    if (!contentRes.ok) {
      rows.push({ key, sid, exists: false, whatsappStatus: null, whatsappCategory: null });
      if (mustBeApproved(key)) {
        failures.push(`${key}: Content SID not found (HTTP ${contentRes.status})`);
      }
      continue;
    }
    const approvalRes = await fetchImpl(`https://content.twilio.com/v1/Content/${sid}/ApprovalRequests`, { headers });
    let whatsappStatus: string | null = null;
    let whatsappCategory: string | null = null;
    if (approvalRes.ok) {
      const body = await approvalRes.json() as {
        whatsapp?: { status?: string; category?: string };
      };
      whatsappStatus = body?.whatsapp?.status ?? null;
      whatsappCategory = body?.whatsapp?.category ?? null;
    }
    rows.push({ key, sid, exists: true, whatsappStatus, whatsappCategory });
    if (mustBeApproved(key) && whatsappStatus !== 'approved') {
      failures.push(`${key}: WhatsApp approval status is '${whatsappStatus ?? 'unknown'}' (must be 'approved')`);
    }
    if (whatsappCategory !== UTILITY_CATEGORY) {
      const category = whatsappCategory ?? 'unknown';
      if (UTILITY_REQUIRED_KEYS.has(key)) {
        failures.push(`${key}: WhatsApp category is '${category}' (must be '${UTILITY_CATEGORY}')`);
      } else if (key.startsWith(EMPLOYER_PREFIX)) {
        notices.push(`${key}: WhatsApp category is '${category}', not '${UTILITY_CATEGORY}'`);
      }
    }
  }

  return { rows, failures, notices };
}
