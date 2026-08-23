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
import { getUnsubscribeSecret } from '../lib/unsubscribe-secret';
import { mintUnsubscribeToken } from '../lib/unsubscribe-token';

/**
 * Employer daily-digest producer. EventBridge, every 15 minutes,
 * reservedConcurrentExecutions: 1. Runs as jale_admin.
 *
 * ── Who is due ───────────────────────────────────────────────────
 * Answered entirely by jale_digest_internal.due_digest_employers(now())
 * (migration 082), a SECURITY DEFINER function owned by the NOLOGIN
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
 * transaction -- and the UPDATE's rowCount is VERIFIED before that transaction
 * commits, because employer_digest_settings is FORCE RLS and an RLS-filtered
 * UPDATE matching zero rows raises nothing at all.
 *
 * Belt and braces on top of that: the idempotency key is keyed on the
 * employer's LOCAL calendar date, so a same-day concurrent run either dedupes
 * byte-identically (queueEmail returns the existing row) or throws
 * email_outbox_idempotency_conflict, which the per-employer catch turns into a
 * rollback for that employer only.
 *
 * Every timestamp in that reasoning -- applied_at, last_sent_at, and the cutoff
 * they are compared against -- comes from the DATABASE clock. See the clock
 * read inside the loop for why Node's would be a silent-loss bug.
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
 *
 * ── Observability ────────────────────────────────────────────────
 * Every due employer ends in exactly one of five states, and the returned
 * summary counts all five: queued, quiet, skipped (unusable address), or failed
 * (anything thrown, including the watermark check). due === queued + quiet +
 * skipped + failed is an invariant a test asserts.
 *
 * Both silent states emit a structured single-string log line that
 * NotificationsStack turns into a CloudWatch metric, because both return
 * NORMALLY -- Lambda's Errors metric and the DLQ can see neither:
 *   digest_skipped_invalid_email  -> EmployerDigestSkippedInvalidEmail
 *   digest_employer_failed        -> EmployerDigestEmployerFailed
 */

/** email_outbox recipient_email CHECK: length BETWEEN 3 AND 320 AND position('@') > 1. */
const MIN_EMAIL_LENGTH = 3;
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
  /** Committed with nothing to say: no active job had a new applicant. */
  quiet: number;
  skipped: number;
  failed: number;
}

function toEpochMs(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

/**
 * Mirrors email_outbox's recipient_email CHECK exactly:
 *   length(recipient_email) BETWEEN 3 AND 320 AND position('@' IN recipient_email) > 1
 * (migration 037). A value that cannot satisfy it must be caught HERE and
 * reported as the alarmed skip, not become a 23514 that aborts the transaction
 * and surfaces as an anonymous per-employer failure.
 *
 * `indexOf('@') > 0` is the JS spelling of `position('@') > 1`: present, and not
 * the first character. Both halves matter — '@bc' passes a naive includes('@')
 * check and then violates the CHECK.
 *
 * NOTE lambda/billing/processor.ts has the looser version of this guard and the
 * same gap. Deliberately not touched here: it is outside this change's scope.
 */
function isSendableEmail(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= MIN_EMAIL_LENGTH
    && value.length <= MAX_EMAIL_LENGTH
    && value.indexOf('@') > 0;
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

  // Warm the signing secret HERE, not lazily inside mintUnsubscribeToken.
  // Fetched in the loop it would be a Secrets-Manager-over-VPC round trip
  // INSIDE an open email_outbox-writing transaction on a cold container, and a
  // failure would land in the per-employer catch below -- which returns
  // normally, so metricErrors would not see it and the DLQ would stay empty.
  // Up here a missing or unreadable secret fails the whole run loudly, before
  // any connection is opened. The lib caches, so the in-loop calls are free.
  await getUnsubscribeSecret();

  const pool = await getDbPool();
  const client = await pool.connect();
  const summary: DigestRunSummary = { due: 0, queued: 0, quiet: 0, skipped: 0, failed: 0 };

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

        // ── One clock, and it is the DATABASE's ──────────────────
        // Both values this employer's window is measured against --
        // applications.applied_at and employer_digest_settings.last_sent_at --
        // are written by PostgreSQL. Taking the cutoff from Node instead would
        // introduce Lambda-vs-RDS clock skew into the comparison: if Lambda ran
        // δ behind RDS, every applicant who applied inside δ would be excluded
        // from THIS digest (applied_at > cutoff) and then from the NEXT one
        // (applied_at <= the advanced watermark) -- silently dropped forever.
        //
        // now() is transaction_timestamp(), so this is stable for the whole
        // employer transaction, and the same call supplies the LOCAL calendar
        // date for the idempotency key -- one round trip, and by construction
        // the key cannot disagree with the cutoff it was derived from. The
        // explicit ::text on the zone parameter is belt and braces on
        // unknown-parameter resolution for AT TIME ZONE.
        //
        // The zone cannot raise here: due_digest_employers() only returns rows
        // whose timezone joined pg_timezone_names successfully.
        const clock = await client.query<{ cutoff: string | Date; local_date: string }>(
          'SELECT now() AS cutoff, (now() AT TIME ZONE $1::text)::date::text AS local_date',
          [row.timezone],
        );
        const cutoffMs = toEpochMs(clock.rows[0]?.cutoff);
        const localCalendarDate = clock.rows[0]?.local_date;
        // Fail this employer CLOSED. A null cutoff would make every candidate
        // fail the `appliedMs <= cutoffMs` test, which looks exactly like a
        // quiet day and would COMMIT -- turning a broken clock read into a
        // silent mass non-delivery instead of an alarmable failure.
        if (cutoffMs === null) throw new Error('digest_cutoff_unresolved');
        if (!localCalendarDate) throw new Error('digest_local_date_unresolved');

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

        const activeJobs = await client.query<ActiveJobRow>(
          "SELECT id, title FROM jobs WHERE employer_id = $1 AND status = 'active'",
          [row.employer_id],
        );

        const watermarkMs = toEpochMs(row.last_sent_at);
        const digestJobs: DigestJob[] = [];

        for (const job of activeJobs.rows) {
          // Literal 100: MAX_API_LIMIT is not exported, and `limit: 0` is
          // silently coerced to 100 by listEmployerCandidates anyway -- being
          // explicit keeps the intent readable.
          //
          // KNOWN LIMITATION of reusing the ranking helper here. It shortlists
          // the 150 MOST RECENT applications, scores them, then keeps the top
          // 100 BY SCORE. Two consequences on a busy job:
          //   * more than 100 new applicants in one window under-reports the
          //     count (a display inaccuracy), and
          //   * a NEW but LOW-SCORING applicant can be displaced out of that
          //     top-100 by older high-scoring ones, in which case they are
          //     never mentioned -- and because a job that yields zero new
          //     applicants commits WITHOUT advancing the watermark only when
          //     EVERY job is empty, a later sweep will not surface them
          //     either. Silent under-reporting, never a missed digest.
          // Accepted deliberately: sharing this helper is what keeps the digest
          // ordering identical to what the employer sees on the candidates
          // screen. Fixing it properly needs an applied_at-windowed query of
          // its own, which is a change to the ranking lib (out of scope here).
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
          // Counted, not merely skipped over: without this a run reporting
          // {due: 40, queued: 1} is indistinguishable from one silently
          // walking 39 rows and doing nothing it meant to do.
          summary.quiet += 1;
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

        // The watermark stores the EXACT cutoff the candidate filter used, so no
        // applicant can fall into a gap between "counted in this digest" and
        // "still new next time".
        const advanced = await client.query(
          'UPDATE employer_digest_settings SET last_sent_at = $2 WHERE employer_id = $1',
          [row.employer_id, clock.rows[0].cutoff],
        );
        // employer_digest_settings is FORCE RLS and employer_id is its PRIMARY
        // KEY, so this is 1 or 0 -- and an RLS-filtered UPDATE that matches
        // ZERO rows raises NOTHING. Committing on 0 would send the digest with
        // an unadvanced watermark, which re-mails the same backlog every day
        // forever, silently. Throwing here puts the queued email in the same
        // ROLLBACK. Not constructible under today's schema (the jobs read above
        // fails first on the same GUC), but at-most-once is the whole feature.
        if (advanced.rowCount !== 1) throw new Error('digest_watermark_not_advanced');

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
        // TWO log lines, deliberately.
        //
        // 1. The alarmable one. This catch returns normally, so metricErrors
        //    never fires and the DLQ stays empty -- a 23514, an
        //    email_outbox_idempotency_conflict, or a Secrets Manager throttle
        //    mid-loop would otherwise be completely invisible. It MUST be a
        //    single JSON string argument: a second object argument is formatted
        //    separately by the Lambda runtime, and no filter pattern can match
        //    across that boundary. NotificationsStack matches the literal
        //    "digest_employer_failed" -- keep the two in step.
        console.error(JSON.stringify({
          metric: 'digest_employer_failed',
          employerId: row.employer_id,
        }));
        // 2. The human-readable one, carrying the cause for the operator who
        //    goes looking after the alarm above fires. Not alarmable, and not
        //    expected to be.
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
