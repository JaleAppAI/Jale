import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

/**
 * Shared OTP-Twilio helpers used by both the worker custom-auth challenge
 * (create-auth-challenge) and the Twilio delivery-status callback
 * (otp-status-callback): a cached read of the `jale/whatsapp/otp-twilio`
 * secret and a CloudWatch EMF metric emitter. Kept in one place so secret
 * rotation behavior and the `Jale/OTP` metric format cannot drift between the
 * send path and the delivery-status path.
 */

export interface OtpTwilioSecret {
  accountSid: string;
  authToken: string;
}

// ── Module-level Secrets Manager client + 5-minute cache ──────────────────
// Secrets Manager credentials rotate on a schedule, so a 5-minute TTL lets a
// warm Lambda container pick up a new value within 5 minutes of rotation
// instead of holding stale creds until cold-start.
const secretsManager = new SecretsManagerClient({});
let cachedSecret: OtpTwilioSecret | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function getOtpTwilioSecret(): Promise<OtpTwilioSecret> {
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

export function emitOtpMetric(metricName: string, dimensions: Record<string, string> = {}): void {
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
