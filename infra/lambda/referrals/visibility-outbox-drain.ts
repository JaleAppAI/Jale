// infra/lambda/referrals/visibility-outbox-drain.ts
//
// EventBridge-scheduled drain of job_visibility_events (SEO indexing layer).
// employer-jobs-update.ts, employer-job-public-listing.ts, and
// employer-jobs-delete.ts enqueue a row here (via the SECURITY DEFINER
// enqueue_job_visibility_event()) whenever a job's effective public
// visibility (status = 'active' AND public_listing_enabled) flips. This
// Lambda notifies Google's Indexing API so a newly public/removed job page
// gets crawled promptly instead of waiting on organic discovery.
//
// Runs as jale_admin (the app DB secret) -- job_visibility_events is
// RLS default-deny, and jale_admin has the direct SELECT/UPDATE policies for
// draining (per the schema contract).
//
// Never logs the service-account key, the OAuth assertion, or the access
// token -- only static metric codes and HTTP status codes.
import * as crypto from 'node:crypto';
import { getDbPool } from '../lib/db';
import { requireAbsoluteBaseUrl } from '../lib/http';
import { getGoogleIndexingServiceAccountKey } from '../lib/google-indexing-secret';

const MAX_ATTEMPTS = 8;
const BATCH_SIZE = 25;
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const INDEXING_ENDPOINT = 'https://indexing.googleapis.com/v3/urlNotifications:publish';
const INDEXING_SCOPE = 'https://www.googleapis.com/auth/indexing';
const TOKEN_TTL_SECONDS = 5 * 60;

interface ClaimedRow {
  id: string;
  job_id: string;
  public_code: string;
  event_kind: 'published' | 'removed';
  attempt_count: number;
}

interface OAuthTokenResponse {
  access_token?: string;
}

interface DbPoolLike {
  connect(): Promise<{
    query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;
    release: () => void;
  }>;
}

export interface DrainResult {
  sent: number;
  pendingRetry: number;
  failed: number;
  haltedOnQuota: boolean;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Builds and signs the RS256 JWT assertion for the Google service-account OAuth flow. */
function buildAssertion(clientEmail: string, privateKey: string): string {
  const header = { alg: 'RS256', typ: 'JWT' };
  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims = {
    iss: clientEmail,
    scope: INDEXING_SCOPE,
    aud: TOKEN_ENDPOINT,
    iat: nowSeconds,
    exp: nowSeconds + TOKEN_TTL_SECONDS,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

/** Exchanges the signed JWT assertion for a short-lived OAuth access token, or null on failure. */
async function fetchAccessToken(clientEmail: string, privateKey: string): Promise<string | null> {
  let assertion: string;
  try {
    assertion = buildAssertion(clientEmail, privateKey);
  } catch {
    console.error(JSON.stringify({ metric: 'VisibilityOutboxDrainAssertionFailed' }));
    return null;
  }

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      console.error(JSON.stringify({ metric: 'VisibilityOutboxDrainOAuthFailed', status: res.status }));
      return null;
    }
    const parsed = await res.json() as OAuthTokenResponse;
    return parsed.access_token ?? null;
  } catch {
    console.error(JSON.stringify({ metric: 'VisibilityOutboxDrainOAuthError' }));
    return null;
  }
}

async function withShortTransaction(pool: DbPoolLike, fn: (client: Awaited<ReturnType<DbPoolLike['connect']>>) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function markSent(pool: DbPoolLike, id: string): Promise<void> {
  await withShortTransaction(pool, async (client) => {
    await client.query(
      `UPDATE job_visibility_events SET status = 'sent', sent_at = now() WHERE id = $1`,
      [id],
    );
  });
}

/**
 * 429/5xx: always leaves the row 'pending' for the next drain cycle -- the failure is
 * Google's, not the row's, so (unlike markAttemptOrFail below) this never marks 'failed'.
 * Operator note: attempt_count still increments here, and the claim query's
 * `attempt_count < MAX_ATTEMPTS` filter means a row that hits enough consecutive
 * 429/5xx responses stops being claimed at all -- 'pending' forever, but
 * invisible to this drain. Watch for that (e.g. a `status='pending' AND
 * attempt_count >= 8` alert) rather than assuming every stuck row eventually
 * surfaces as 'failed'.
 */
async function markRetryPending(pool: DbPoolLike, id: string, message: string): Promise<void> {
  await withShortTransaction(pool, async (client) => {
    await client.query(
      `UPDATE job_visibility_events
          SET status = 'pending', attempt_count = attempt_count + 1, last_error = $2
        WHERE id = $1`,
      [id, message],
    );
  });
}

/** Other 4xx: bounded retry, terminal 'failed' once attempt_count reaches MAX_ATTEMPTS. */
async function markAttemptOrFail(pool: DbPoolLike, id: string, attemptCountBefore: number, message: string): Promise<'pending' | 'failed'> {
  const nextAttempt = attemptCountBefore + 1;
  const status: 'pending' | 'failed' = nextAttempt >= MAX_ATTEMPTS ? 'failed' : 'pending';
  await withShortTransaction(pool, async (client) => {
    await client.query(
      `UPDATE job_visibility_events
          SET status = $2, attempt_count = attempt_count + 1, last_error = $3
        WHERE id = $1`,
      [id, status, message],
    );
  });
  return status;
}

export async function handler(): Promise<DrainResult> {
  const result: DrainResult = { sent: 0, pendingRetry: 0, failed: 0, haltedOnQuota: false };

  // Fail fast, before ever touching the DB, on missing configuration.
  const key = await getGoogleIndexingServiceAccountKey();
  if (!key) {
    console.log(JSON.stringify({ metric: 'VisibilityOutboxDrainSkipped', reason: 'missing_secret' }));
    return result;
  }

  const base = requireAbsoluteBaseUrl(process.env.PUBLIC_SITE_BASE_URL);
  if (!base) {
    console.error(JSON.stringify({ metric: 'VisibilityOutboxDrainMisconfigured', reason: 'missing_base_url' }));
    return result;
  }

  const pool = await getDbPool() as unknown as DbPoolLike;

  // NOTE on concurrency: this claim transaction commits (releasing its row
  // locks) before any network I/O happens below. FOR UPDATE SKIP LOCKED only
  // protects against a second drain invocation racing this exact window, not
  // against one that starts after this COMMIT but before this invocation's
  // per-row UPDATEs land -- there is no intermediate "claimed"/"in-flight"
  // status in this table to hold that reservation across the dispatch loop.
  // Acceptable because this Lambda is a single EventBridge-scheduled
  // invocation, not expected to run concurrently with itself; if that
  // assumption changes, add a claimed status or a lease token (as
  // whatsapp/lib/outbox.ts's job-alert/worker-intent drains do).
  const claimClient = await pool.connect();
  let rows: ClaimedRow[];
  try {
    await claimClient.query('BEGIN');
    const claimed = await claimClient.query(
      `SELECT id, job_id, public_code, event_kind, attempt_count
         FROM job_visibility_events
        WHERE status IN ('pending', 'failed')
          AND attempt_count < $1
        ORDER BY created_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [MAX_ATTEMPTS, BATCH_SIZE],
    );
    rows = claimed.rows as ClaimedRow[];
    await claimClient.query('COMMIT');
  } catch (err) {
    await claimClient.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    claimClient.release();
  }

  if (rows.length === 0) return result;

  const accessToken = await fetchAccessToken(key.client_email, key.private_key);
  if (!accessToken) {
    console.error(JSON.stringify({ metric: 'VisibilityOutboxDrainSkipped', reason: 'oauth_failed' }));
    return result;
  }

  for (const row of rows) {
    const url = `${base}/en/j/${row.public_code}`;
    const type = row.event_kind === 'published' ? 'URL_UPDATED' : 'URL_DELETED';

    let res: Response;
    try {
      res = await fetch(INDEXING_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url, type }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = await markAttemptOrFail(pool, row.id, row.attempt_count, message);
      if (status === 'failed') result.failed += 1;
      else result.pendingRetry += 1;
      continue;
    }

    if (res.ok) {
      await markSent(pool, row.id);
      result.sent += 1;
      continue;
    }

    let errorText = '';
    try {
      errorText = await res.text();
    } catch {
      // best-effort only
    }
    const message = `Google indexing HTTP ${res.status}${errorText ? `: ${errorText.slice(0, 500)}` : ''}`;

    if (res.status === 429) {
      await markRetryPending(pool, row.id, message);
      result.pendingRetry += 1;
      result.haltedOnQuota = true;
      break; // quota exhausted -- stop the batch rather than burn through it on 429s
    }
    if (res.status >= 500) {
      await markRetryPending(pool, row.id, message);
      result.pendingRetry += 1;
      continue;
    }

    const status = await markAttemptOrFail(pool, row.id, row.attempt_count, message);
    if (status === 'failed') result.failed += 1;
    else result.pendingRetry += 1;
  }

  return result;
}
