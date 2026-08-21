import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../lib/db';
import { queueEmail } from '../lib/email-outbox';
import { listEmployerCandidates } from '../lib/employer-candidate-ranking';
import {
  DIGEST_MAX_CANDIDATES_PER_JOB,
  renderEmployerDigest,
  type DigestCandidate,
  type DigestJob,
  type DigestLanguage,
  type DigestScoreBand,
} from '../lib/employer-digest-template';
import { errorMessage, requireAbsoluteBaseUrl } from '../lib/http';
import { mintUnsubscribeToken } from '../lib/unsubscribe-token';

/**
 * Employer daily-digest producer. EventBridge, every 15 minutes,
 * reservedConcurrentExecutions: 1. Runs as jale_admin.
 *
 * ── Who is due ───────────────────────────────────────────────────
 * Answered entirely by jale_digest_internal.due_digest_employers(now())
 * (migration 080), a SECURITY DEFINER function owned by the NOLOGIN
 * jale_digest_enumerator role. This Lambda has NO employer identity when it
 * asks, and deliberately holds no cross-tenant read of its own: the function
 * is the only place that sees every employer's row, and it hands back exactly
 * the fields needed to render, address, and unsubscribe from one digest --
 * including unsubscribe_token_version, so minting the link needs no second
 * query back through that privilege boundary.
 *
 * Re-implementing the hour/timezone/watermark predicate here would be a
 * correctness fork of the migration's carefully-fenced SQL (see its notes on
 * MATERIALIZED and on `AT TIME ZONE` raising for unlisted zones). Don't.
 *
 * ── At-most-once per local day ───────────────────────────────────
 * The hour predicate is true for up to FOUR consecutive 15-minute sweeps. The
 * thing that makes the digest at-most-once is the committed last_sent_at
 * watermark, so the watermark UPDATE and the email_outbox INSERT are in ONE
 * transaction. Belt and braces on top of that: the idempotency key is keyed on
 * the employer's LOCAL calendar date, so a same-day concurrent run either
 * dedupes byte-identically (queueEmail returns the existing row) or throws
 * email_outbox_idempotency_conflict, which the per-employer catch turns into a
 * rollback for that employer only.
 *
 * ── Deliberately NOT here: candidate reranking ───────────────────
 * listEmployerCandidates() returns shouldEnqueueRerank, and
 * api/employer-job-candidates.ts acts on it. This Lambda IGNORES it, and takes
 * no rerank queue env var at all, for two reasons:
 *   1. The API handler enqueues because a live employer is looking at the
 *      screen, which justifies spending a Bedrock call on fresher scores. A
 *      15-minute sweep across every due employer's every active job has no
 *      such reader and would flood employerCandidateRerankQueue.
 *   2. The flag is `deterministic && !useCache`, and the cache read is scoped
 *      by source hash on rows the employer's own view populates. From here it
 *      is effectively always true, so acting on it would enqueue forever
 *      rather than converge.
 *
 * ── Quiet days ───────────────────────────────────────────────────
 * If no active job has a new applicant, the transaction COMMITs WITHOUT
 * advancing the watermark. No mail on a quiet day, and the next real send
 * measures its window from the last REAL send rather than from a silent sweep.
 */

/** email_outbox recipient_email CHECK: length BETWEEN 3 AND 320 AND position('@') > 1. */
const MAX_EMAIL_LENGTH = 320;

interface DueEmployerRow {
  employer_id: string;
  cognito_sub: string;
  email: string | null;
  send_hour_local: number;
  timezone: string;
  language: string;
  last_sent_at: string | Date | null;
  unsubscribe_token_version: number;
}

interface ActiveJobRow {
  id: string;
  title: string;
}

export interface DigestRunSummary {
  due: number;
  queued: number;
  skipped: number;
  failed: number;
}

function toEpochMs(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

/**
 * Same shape as the billing processor's employer-email guard
 * (lambda/billing/processor.ts): a value that cannot satisfy email_outbox's
 * recipient_email CHECK must be caught here, not become a 23514 that aborts
 * the transaction.
 */
function isSendableEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_EMAIL_LENGTH && value.includes('@');
}

function digestLanguage(value: unknown): DigestLanguage {
  return value === 'es' ? 'es' : 'en';
}

function scoreBand(value: unknown): DigestScoreBand {
  return value === 'strong' || value === 'good' || value === 'fair' ? value : 'fair';
}

export const handler = async (): Promise<DigestRunSummary> => {
  // Fail closed before opening a connection: an unsubscribe or dashboard link
  // without an origin is dead the moment it lands in an inbox.
  const baseUrl = requireAbsoluteBaseUrl(process.env.PUBLIC_SITE_BASE_URL);
  if (!baseUrl) throw new Error('digest_public_site_base_url_missing');

  const pool = await getDbPool();
  const client = await pool.connect();
  const summary: DigestRunSummary = { due: 0, queued: 0, skipped: 0, failed: 0 };

  try {
    const due = await client.query<DueEmployerRow>(
      'SELECT * FROM jale_digest_internal.due_digest_employers(now())',
    );
    summary.due = due.rows.length;

    for (const row of due.rows) {
      try {
        await client.query('BEGIN');
        // Both GUCs, in this order, exactly as api/employer-job-candidates.ts
        // does. They are not redundant: employer_digest_settings' self policy
        // keys on app.current_user_id (the Cognito sub), while the job and
        // application tables listEmployerCandidates reads key on the internal
        // users.id. Both are transaction-local and reset at COMMIT.
        await setRlsContext(client, row.cognito_sub);
        await setInternalUserRlsContext(client, row.employer_id);

        // One cutoff per employer, captured before any read, so an applicant
        // who applies mid-render is not both excluded from this digest and
        // skipped by the next one.
        const cutoff = new Date();

        if (!isSendableEmail(row.email)) {
          // A structured warn line, not a throw: this is a data problem for
          // one employer, and NotificationsStack turns this exact literal into
          // an alarmable metric via a log MetricFilter. No watermark advance --
          // when the address is fixed, the backlog is still owed.
          console.warn(JSON.stringify({
            metric: 'digest_skipped_invalid_email',
            employerId: row.employer_id,
          }));
          await client.query('COMMIT');
          summary.skipped += 1;
          continue;
        }

        const language = digestLanguage(row.language);

        // The employer's LOCAL calendar date, derived by PostgreSQL rather
        // than by Intl in Node. Deliberate: this is the same engine, and the
        // same zone string, that due_digest_employers() used to decide the row
        // was due, so the key cannot disagree with the due-check. It also
        // cannot raise -- the due list only returns zones that joined
        // pg_timezone_names successfully.
        const localDateResult = await client.query<{ local_date: string }>(
          'SELECT (($1::timestamptz) AT TIME ZONE $2)::date::text AS local_date',
          [cutoff.toISOString(), row.timezone],
        );
        const localCalendarDate = localDateResult.rows[0]?.local_date;
        if (!localCalendarDate) throw new Error('digest_local_date_unresolved');

        const activeJobs = await client.query<ActiveJobRow>(
          "SELECT id, title FROM jobs WHERE employer_id = $1 AND status = 'active'",
          [row.employer_id],
        );

        const watermarkMs = toEpochMs(row.last_sent_at);
        const cutoffMs = cutoff.getTime();
        const digestJobs: DigestJob[] = [];

        for (const job of activeJobs.rows) {
          // Literal 100: MAX_API_LIMIT is not exported, and `limit: 0` is
          // silently coerced to 100 by listEmployerCandidates anyway -- being
          // explicit keeps the intent readable. Consequence worth knowing: a
          // job with more than 100 new applicants in one window under-reports
          // its count, which is a display inaccuracy, not a missed digest.
          const ranked = await listEmployerCandidates(client, job.id, { limit: 100, includeContact: true });
          // shouldEnqueueRerank / sourceHash intentionally unused -- see the
          // module header.

          const fresh = ranked.response.candidates.filter((candidate) => {
            const appliedMs = toEpochMs(candidate.applied_at);
            if (appliedMs === null) return false;
            if (watermarkMs !== null && appliedMs <= watermarkMs) return false;
            return appliedMs <= cutoffMs;
          });
          if (fresh.length === 0) continue;

          digestJobs.push({
            jobId: job.id,
            title: job.title,
            jobUrl: `${baseUrl}/${language}/employer/jobs/${job.id}`,
            newApplicantCount: fresh.length,
            // Already ranked best -> lowest by listEmployerCandidates.
            candidates: fresh.slice(0, DIGEST_MAX_CANDIDATES_PER_JOB).map((candidate): DigestCandidate => ({
              displayName: candidate.display_name,
              matchScore: candidate.match_score,
              scoreBand: scoreBand(candidate.score_band),
              location: candidate.location,
            })),
          });
        }

        if (digestJobs.length === 0) {
          await client.query('COMMIT');
          continue;
        }

        const token = await mintUnsubscribeToken(row.employer_id, row.unsubscribe_token_version);
        const rendered = renderEmployerDigest({
          language,
          jobs: digestJobs,
          dashboardUrl: `${baseUrl}/${language}/employer/dashboard`,
          // NEVER built from props.api.url / the API Gateway URL: that is a
          // synth cycle (see the note at whatsapp-stack.ts:174-183) and would
          // also mail an API origin to a human.
          unsubscribeUrl: `${baseUrl}/${language}/digest-unsubscribe?token=${token}`,
        });

        await queueEmail(client, {
          recipientEmail: row.email,
          subject: rendered.subject,
          bodyText: rendered.bodyText,
          bodyHtml: rendered.bodyHtml,
          sourceType: 'employer_digest',
          sourceId: row.employer_id,
          idempotencyKey: `employer-digest:${row.employer_id}:${localCalendarDate}`,
        });

        await client.query(
          'UPDATE employer_digest_settings SET last_sent_at = $2 WHERE employer_id = $1',
          [row.employer_id, cutoff.toISOString()],
        );

        await client.query('COMMIT');
        summary.queued += 1;
      } catch (error) {
        // One bad employer must not starve the rest, so this catch is per
        // employer and the loop continues. The ROLLBACK itself is guarded:
        // the pool is max:1, and a throwing ROLLBACK would otherwise take the
        // single connection -- and therefore every remaining employer -- down
        // with it.
        try { await client.query('ROLLBACK'); } catch { /* connection already unusable */ }
        summary.failed += 1;
        console.error('employer-digest-producer employer failed', {
          employerId: row.employer_id,
          error: errorMessage(error),
        });
      }
    }
  } finally {
    client.release();
  }

  console.info(JSON.stringify({ metric: 'employer_digest_run', ...summary }));
  return summary;
};
