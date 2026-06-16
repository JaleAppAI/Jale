import type { CreateAuthChallengeTriggerEvent } from 'aws-lambda';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { checkOtpRateLimit } from './lib/otp-rate-limit';

/**
 * Generates a six-digit Cognito custom-auth challenge and sends it by SMS from
 * the dedicated A2P-approved Twilio number. Only accountSid/authToken are read
 * from `jale/whatsapp/otp-twilio`; TWILIO_FROM_NUMBER selects the SMS sender.
 * WhatsApp credentials and addressing are not used by this Lambda.
 */

// ── Module-level Secrets Manager client + 5-minute cache ──────────────────
// Secrets Manager credentials rotate on a schedule, so a 5-minute TTL lets a
// warm Lambda container pick up a new value within 5 minutes of rotation
// instead of holding stale creds until cold-start.
interface OtpTwilioSecret {
  accountSid: string;
  authToken: string;
}

const secretsManager = new SecretsManagerClient({});
let cachedSecret: OtpTwilioSecret | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getOtpTwilioSecret(): Promise<OtpTwilioSecret> {
  const now = Date.now();
  if (cachedSecret && now - cachedAt < CACHE_TTL_MS) {
    return cachedSecret;
  }
  const arn = process.env.TWILIO_SECRET_ARN;
  if (!arn) {
    throw new Error(
      'Missing TWILIO_SECRET_ARN env var; expected Secrets Manager ARN for jale/whatsapp/otp-twilio',
    );
  }
  const resp = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: arn }),
  );
  if (!resp.SecretString) {
    throw new Error('TWILIO_SECRET_ARN secret has no SecretString');
  }
  const parsed = JSON.parse(resp.SecretString) as Partial<OtpTwilioSecret>;
  if (!parsed.accountSid || !parsed.authToken) {
    throw new Error(
      'jale/whatsapp/otp-twilio secret missing required fields accountSid/authToken',
    );
  }
  cachedSecret = parsed as OtpTwilioSecret;
  cachedAt = now;
  return cachedSecret;
}

export const handler = async (
  event: CreateAuthChallengeTriggerEvent,
): Promise<CreateAuthChallengeTriggerEvent> => {
  // Only generate a new OTP on the first attempt of this session.
  // On retries, reuse the previously issued challenge so the user can
  // re-enter the same OTP they received.
  let otp: string;
  const session = event.request.session;

  if (session.length > 0 && session[session.length - 1].challengeMetadata) {
    // Reuse OTP from previous challenge (stored in challengeMetadata)
    otp = session[session.length - 1].challengeMetadata as string;
  } else {
    // Generate a new 6-digit OTP using crypto.randomInt (cryptographically secure)
    otp = generateOtp();

    // Send OTP via the dedicated Twilio SMS number.
    const phoneNumber = event.request.userAttributes.phone_number;
    if (!phoneNumber) {
      throw new Error('Missing phone_number attribute on user');
    }

    const decision = await checkOtpRateLimit(phoneNumber);
    if (!decision.allowed) {
      emitOtpMetric('WorkerOtpSendThrottled', { reason: decision.reason });
      throw new Error('Unable to send a verification code right now.');
    }
    emitOtpMetric('WorkerOtpSendAllowed');
    try {
      await sendTwilioSmsOtp(phoneNumber, `${otp} is your Jale verification code.`);
    } catch (error) {
      emitOtpMetric('WorkerOtpTwilioFailure');
      throw error;
    }
  }

  // Mask the phone number for display (e.g. "+1***1234")
  const phone = event.request.userAttributes.phone_number ?? '';
  const phoneHint = maskPhone(phone);

  event.response.publicChallengeParameters = {
    hint: `SMS sent to ${phoneHint}`,
  };
  event.response.privateChallengeParameters = {
    otp,
  };
  // challengeMetadata is included in the next session entry, enabling OTP reuse on retry
  event.response.challengeMetadata = otp;

  return event;
};

async function sendTwilioSmsOtp(to: string, body: string): Promise<void> {
  const { accountSid, authToken } = await getOtpTwilioSecret();
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!from || !/^\+[1-9]\d{7,14}$/.test(from)) {
    throw new Error('Missing or invalid TWILIO_FROM_NUMBER');
  }
  const timeoutMs = parseBoundedInteger(
    'TWILIO_REQUEST_TIMEOUT_MS',
    process.env.TWILIO_REQUEST_TIMEOUT_MS,
    500,
    4000,
  );
  const validityPeriodSeconds = parseBoundedInteger(
    'TWILIO_VALIDITY_PERIOD_SECONDS',
    process.env.TWILIO_VALIDITY_PERIOD_SECONDS,
    6,
    36000,
  );

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const body_ = new URLSearchParams({
    To: to,
    From: from,
    Body: body,
    ValidityPeriod: String(validityPeriodSeconds),
  });

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body_,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: any) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      throw new Error(`Twilio SMS OTP request timed out after ${timeoutMs}ms`);
    }
    throw err;
  }

  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { message?: string; code?: number };
    const detail = data.message ?? `HTTP ${response.status}`;
    throw new Error(`Twilio SMS OTP send failed: ${detail}`);
  }
}

function parseBoundedInteger(
  name: string,
  raw: string | undefined,
  min: number,
  max: number,
): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function generateOtp(): string {
  // 6-digit OTP using Node's built-in crypto (available in Lambda Node.js 20 runtime)
  const crypto = require('node:crypto');
  const n = crypto.randomInt(0, 1_000_000);
  return n.toString().padStart(6, '0');
}

function maskPhone(phone: string): string {
  // E.164 format like +15125551234 → "+1***1234"
  if (phone.length < 4) return '***';
  return phone.slice(0, 2) + '***' + phone.slice(-4);
}

function emitOtpMetric(metricName: string, dimensions: Record<string, string> = {}): void {
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: 'Jale/OTP',
        Dimensions: [Object.keys(dimensions)],
        Metrics: [{ Name: metricName, Unit: 'Count' }],
      }],
    },
    ...dimensions,
    [metricName]: 1,
  }));
}

// Exported only for tests — clear the module-level cache between scenarios.
export function _clearSecretCacheForTests(): void {
  cachedSecret = null;
  cachedAt = 0;
}
