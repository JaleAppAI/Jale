import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

/**
 * Google Indexing API service-account key fetch, for visibility-outbox-drain.ts.
 *
 * Mirrors the TTL-cached fetch in referral-secrets.ts's getVisitorSalt(). The
 * key lives in Secrets Manager (named by GOOGLE_INDEXING_SECRET_NAME) rather
 * than an env var for the same reason: an env var lands in the CloudFormation
 * template, cdk diff output, and every lambda:GetFunctionConfiguration
 * response, and this key can call the Indexing API as Jale's service account.
 */

export interface GoogleServiceAccountKey {
  client_email: string;
  private_key: string;
  [key: string]: unknown;
}

let cachedKey: GoogleServiceAccountKey | null | undefined;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const smClient = new SecretsManagerClient({});

/**
 * Returns the service-account key, or null when unconfigured, unreadable, or
 * malformed. Null rather than a throw: the caller (visibility-outbox-drain)
 * must skip its cycle cleanly rather than fail the whole Lambda invocation.
 * The key contents are never logged.
 */
export async function getGoogleIndexingServiceAccountKey(): Promise<GoogleServiceAccountKey | null> {
  if (cachedKey !== undefined && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedKey;
  }

  const secretName = process.env.GOOGLE_INDEXING_SECRET_NAME;
  if (!secretName) {
    cachedKey = null;
    cachedAt = Date.now();
    return null;
  }

  try {
    const result = await smClient.send(new GetSecretValueCommand({ SecretId: secretName }));
    if (!result.SecretString) {
      cachedKey = null;
    } else {
      const parsed = JSON.parse(result.SecretString) as Partial<GoogleServiceAccountKey>;
      cachedKey = parsed.client_email && parsed.private_key ? (parsed as GoogleServiceAccountKey) : null;
    }
  } catch {
    // Log a static code only -- never the secret name's account id or any secret shape.
    console.error(JSON.stringify({ metric: 'GoogleIndexingSecretFetchFailed' }));
    cachedKey = null;
  }
  cachedAt = Date.now();
  return cachedKey;
}

/** Test hook -- clears the module cache. */
export function clearGoogleIndexingSecretCache(): void {
  cachedKey = undefined;
  cachedAt = 0;
}
