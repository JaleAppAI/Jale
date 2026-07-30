import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

/**
 * Visitor-salt fetch for the public job page (migration 055's visitor_hash).
 *
 * The salt lives in Secrets Manager rather than a Lambda environment variable
 * because it is the only thing making hashVisitor(salt, ip, userAgent)
 * non-invertible: the IP+UA input space is small enough to brute-force once
 * the salt is known, and an env var lands in the CloudFormation template,
 * cdk diff output, and every lambda:GetFunctionConfiguration response.
 *
 * Mirrors the TTL-cached fetch in lib/db.ts (getDbSecret).
 */

let cachedSalt: string | null | undefined;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const smClient = new SecretsManagerClient({});

/**
 * Returns the salt, or null when unconfigured or unreadable. Null rather than
 * a throw: a missing salt must degrade to an unhashed (null) visitor_hash —
 * the page under-deduplicates, which is recoverable; breaking the public page
 * is not. The value itself is never logged.
 */
export async function getVisitorSalt(): Promise<string | null> {
  if (cachedSalt !== undefined && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedSalt;
  }

  const secretArn = process.env.REFERRAL_VISITOR_SALT_SECRET_ARN;
  if (!secretArn) {
    cachedSalt = null;
    cachedAt = Date.now();
    return null;
  }

  try {
    const result = await smClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
    const value = result.SecretString?.trim();
    cachedSalt = value && value.length > 0 ? value : null;
  } catch {
    // Log a static code only — never the ARN's account id or any secret shape.
    console.error(JSON.stringify({ metric: 'VisitorSaltFetchFailed' }));
    cachedSalt = null;
  }
  cachedAt = Date.now();
  return cachedSalt;
}

/** Test hook — clears the module cache. */
export function clearVisitorSaltCache(): void {
  cachedSalt = undefined;
  cachedAt = 0;
}
