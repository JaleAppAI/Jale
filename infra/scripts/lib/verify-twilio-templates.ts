// Verifies every Content Template SID in the jale/whatsapp/twilio secret
// against Twilio's Content API. Employer-message templates (the only ones
// with NO freeform fallback — outbox.ts throws instead) must exist AND be
// WhatsApp-approved; everything else is reported informationally. This is
// step 0/5 of the employer-messaging runbook.
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

export interface TemplateVerification {
  key: string;
  sid: string;
  exists: boolean;
  whatsappStatus: string | null;
}

export interface VerifyTemplatesResult {
  rows: TemplateVerification[];
  failures: string[];
}

const EMPLOYER_PREFIX = 'employer_message_';
const REQUIRED_EMPLOYER_KEYS = [
  'employer_message_invite_es',
  'employer_message_invite_en',
  'employer_message_resume_es',
  'employer_message_resume_en',
] as const;

export async function verifyTwilioTemplates(deps: {
  fetchImpl?: typeof fetch;
  client?: SecretsManagerClient;
  secretId?: string;
  region?: string;
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

  for (const required of REQUIRED_EMPLOYER_KEYS) {
    if (!templates[required]) failures.push(`${required}: missing from the secret templates map`);
  }

  for (const [key, sid] of Object.entries(templates)) {
    const contentRes = await fetchImpl(`https://content.twilio.com/v1/Content/${sid}`, { headers });
    if (!contentRes.ok) {
      rows.push({ key, sid, exists: false, whatsappStatus: null });
      if (key.startsWith(EMPLOYER_PREFIX)) {
        failures.push(`${key}: Content SID not found (HTTP ${contentRes.status})`);
      }
      continue;
    }
    const approvalRes = await fetchImpl(`https://content.twilio.com/v1/Content/${sid}/ApprovalRequests`, { headers });
    let whatsappStatus: string | null = null;
    if (approvalRes.ok) {
      const body = await approvalRes.json() as { whatsapp?: { status?: string } };
      whatsappStatus = body?.whatsapp?.status ?? null;
    }
    rows.push({ key, sid, exists: true, whatsappStatus });
    if (key.startsWith(EMPLOYER_PREFIX) && whatsappStatus !== 'approved') {
      failures.push(`${key}: WhatsApp approval status is '${whatsappStatus ?? 'unknown'}' (must be 'approved')`);
    }
  }

  return { rows, failures };
}
