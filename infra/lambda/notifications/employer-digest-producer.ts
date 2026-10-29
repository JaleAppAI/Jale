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
import { renderHireDetailsNudgeEmail } from '../lib/hire-details-nudge-template';
import { mintUnsubscribeToken } from '../lib/unsubscribe-token';

/**
 * Employer daily-digest producer. EventBridge, every 15 minutes,
 * reservedConcurrentExecutions: 1. Runs on its own job login, jale_job_digest.
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
 * summary counts all five: queued, quiet, skipped (unusable address, or not an
 * active member of a company), or failed (anything thrown, including the
 * watermark check). Employers the run stopped before, to stay inside its time
 * budget, are counted as deferred (logged once as digest_run_deadline).
 * due === queued + quiet + skipped + failed + deferred is an invariant a test
 * asserts.
 *
 * ── Companies (Phase 3) ──────────────────────────────────────────
 * An active owner's digest covers every member's active jobs
 * (jale_internal.org_owner_scope; 135 gives this login the owner policies);
 * a foreman's covers their own. A suspended or removed member gets none and
 * logs digest_skipped_inactive_member (info: an expected state, not an alarm).
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
  /**
   * Not reached: the run stopped before them to stay inside the function's
   * time budget. Their watermark is untouched, so a later sweep inside their
   * send hour picks them up; past it, the next day's digest covers the window.
   */
  deferred: number;
}

/**
 * No employer is started with less than this left: an owner's digest ranks
 * up to the company's whole active-job limit, and a run cut off by the Lambda
 * timeout would lose the nudge sweep and the run summary as well.
 */
const DIGEST_MIN_REMAINING_MS = 15_000;

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

/** Claims per sweep; a sweep runs every 15 minutes. */
const HIRE_NUDGE_BATCH = 25;
/**
 * The sweep starts, and starts each row, only while at least this much of the
 * function's time is left: the digest loop runs first on the same 120 s
 * budget, and a row cut off mid-way would roll back with the batch anyway.
 */
const HIRE_NUDGE_MIN_REMAINING_MS = 20_000;
const HIRE_NUDGE_SAVEPOINT = 'hire_details_nudge';

interface HireNudgeRow {
  application_id: string;
  employer_email: string | null;
  worker_name: string | null;
  job_title: string;
  kind: string;
  requested_at: string | Date | null;
}

/**
 * F19 (sprint 28, K4.4): the hire-details nudge, on the same sweep.
 *
 * AT LEAST ONCE. `jale_cap.claim_hire_details_nudges` returns the due hires
 * and locks them; it stamps nothing. Each row is rendered, queued and only
 * then stamped (`jale_cap.mark_hire_details_nudged`), inside ONE transaction
 * with a savepoint per row. A row that fails rolls back to its savepoint and
 * stays unstamped; a timeout or a lost connection rolls the whole batch back.
 * Either way the next sweep claims those rows again, which is safe because
 * `queueEmail` dedupes on the idempotency key (stable per application, and
 * per reminder time for a reminder).
 *
 * A row whose address cannot be sent to is skipped and NOT stamped, as the
 * digest loop leaves its watermark: it is claimed again once the address is
 * fixed. The sweep runs after the digest loop, outside its transactions, and
 * never throws.
 */
async function sweepHireDetailsNudges(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
  baseUrl: string,
  remainingMs: () => number,
): Promise<void> {
  const counts = { claimed: 0, queued: 0, skipped: 0, failed: 0, deferred: 0 };
  if (remainingMs() < HIRE_NUDGE_MIN_REMAINING_MS) {
    console.info(JSON.stringify({ metric: 'hire_details_nudge_run', ...counts, outOfTime: true }));
    return;
  }
  try {
    await client.query('BEGIN');
    const claimed = await client.query(
      'SELECT application_id, employer_email, worker_name, job_title, kind, requested_at FROM jale_cap.claim_hire_details_nudges($1)',
      [HIRE_NUDGE_BATCH],
    );
    const rows = claimed.rows as HireNudgeRow[];
    counts.claimed = rows.length;
    for (const [index, row] of rows.entries()) {
      if (remainingMs() < HIRE_NUDGE_MIN_REMAINING_MS) {
        counts.deferred = rows.length - index;
        break;
      }
      if (!isSendableEmail(row.employer_email)) {
        counts.skipped += 1;
        console.warn(JSON.stringify({ metric: 'hire_details_nudge_skipped_invalid_email', applicationId: row.application_id }));
        continue;
      }
      await client.query(`SAVEPOINT ${HIRE_NUDGE_SAVEPOINT}`);
      try {
        const remind = row.kind === 'remind';
        const rendered = renderHireDetailsNudgeEmail({
          kind: remind ? 'remind' : 'auto',
          workerName: row.worker_name,
          jobTitle: row.job_title,
          englishUrl: `${baseUrl}/en/employer/applicants`,
          spanishUrl: `${baseUrl}/es/employer/applicants`,
        });
        const requestedMs = toEpochMs(row.requested_at);
        await queueEmail(client as never, {
          recipientEmail: row.employer_email,
          subject: rendered.subject,
          bodyText: rendered.bodyText,
          bodyHtml: rendered.bodyHtml,
          sourceType: 'hire_details_nudge',
          sourceId: row.application_id,
          idempotencyKey: remind
            ? `hire-details-remind:${row.application_id}:${requestedMs ?? 0}`
            : `hire-details-nudge:${row.application_id}`,
        });
        await client.query('SELECT jale_cap.mark_hire_details_nudged($1) AS marked', [row.application_id]);
        await client.query(`RELEASE SAVEPOINT ${HIRE_NUDGE_SAVEPOINT}`);
        counts.queued += 1;
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${HIRE_NUDGE_SAVEPOINT}`);
        counts.failed += 1;
        console.error(JSON.stringify({
          metric: 'hire_details_nudge_failed', applicationId: row.application_id, error: errorMessage(error),
        }));
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* connection already unusable */ }
    console.error(JSON.stringify({ metric: 'hire_details_nudge_run_failed', error: errorMessage(error) }));
  }
  console.info(JSON.stringify({ metric: 'hire_details_nudge_run', ...counts }));
}

/** The part of the Lambda context the sweep reads; absent in tests and local runs. */
interface RemainingTime {
  getRemainingTimeInMillis?: () => number;
}

export const handler = async (_event?: unknown, context?: RemainingTime): Promise<DigestRunSummary> => {
  const remainingMs = (): number => context?.getRemainingTimeInMillis?.() ?? Number.POSITIVE_INFINITY;
  // Fail closed before opening a connection: an unsubscribe or dashboard link
  // without an origin is dead the moment it lands in an inbox.
  const baseUrl = requireAbsoluteBaseUrl(process.env.PUBLIC_SITE_BASE_URL);
  if (!baseUrl) throw new Error('digest_public_site_base_url_missing');

  /**
   * TWO unsubscribe URLs, on purpose, and they are not interchangeable.
   *
   * `${baseUrl}/${language}/digest-unsubscribe?token=` is the HUMAN one: a
   * Next.js page with a button, reached by an employer clicking a link in the
   * footer. Its GET is deliberately inert (see the page's header) because mail
   * scanners follow links.
   *
   * The RFC 8058 `List-Unsubscribe` header needs the opposite thing: an
   * endpoint a MAIL PROVIDER can POST to unattended. That is the API route,
   * which CloudFront serves at `<site>/api/*` -- the same origin
   * NEXT_PUBLIC_API_BASE_URL is baked to in frontend-stack.ts, and the same
   * reason this is derived from PUBLIC_SITE_BASE_URL rather than from
   * props.api.url: an API Gateway URL in a Lambda env var is the synth cycle
   * documented at whatsapp-stack.ts:174-183.
   *
   * PUBLIC_API_BASE_URL overrides the derivation for a deployment whose API
   * does not live behind the site origin. Absent and underivable => no header,
   * which is exactly today's behaviour.
   */
  const apiBaseUrl = requireAbsoluteBaseUrl(process.env.PUBLIC_API_BASE_URL) ?? `${baseUrl}/api`;

  // Warm the signing secret HERE, not lazily inside mintUnsubscribeToken.
  // Fetched in the loop on a cold container, a failure would land in the
  // per-employer catch below -- which returns normally, so metricErrors would
  // not see it and the DLQ would stay empty. Up here a missing or unreadable
  // secret fails the whole run loudly, before any connection is opened. The
  // lib caches for five minutes; a longer run refreshes it from the loop, and
  // the loop mints each token before that employer's transaction opens.
  await getUnsubscribeSecret();

  const pool = await getDbPool();
  const client = await pool.connect();
  const summary: DigestRunSummary = { due: 0, queued: 0, quiet: 0, skipped: 0, failed: 0, deferred: 0 };

  try {
    const due = await client.query<DueEmployerRow>(
      'SELECT * FROM jale_digest_internal.due_digest_employers(now())',
    );
    summary.due = due.rows.length;

    for (const [index, row] of due.rows.entries()) {
      // The time budget, checked between employers (never inside one's
      // transaction). The rest stay due and unwatermarked; one log line.
      if (remainingMs() < DIGEST_MIN_REMAINING_MS) {
        summary.deferred = due.rows.length - index;
        console.warn(JSON.stringify({ metric: 'digest_run_deadline', deferred: summary.deferred }));
        break;
      }

      // Minted BEFORE this employer's transaction opens. Minting reads the
      // signing secret, and once the cache above is older than its TTL that is
      // a Secrets Manager round trip -- which must never run inside an open
      // transaction. A failure is held and raised where the token is needed,
      // so an employer with nothing to send still counts as quiet (or
      // skipped), exactly as when the token was minted in place.
      let minted: { ok: true; token: string } | { ok: false; error: unknown };
      try {
        minted = { ok: true, token: await mintUnsubscribeToken(row.employer_id, row.unsubscribe_token_version) };
      } catch (error) {
        minted = { ok: false, error };
      }

      try {
        await client.query('BEGIN');
        // Both GUCs, in this order, exactly as api/employer-job-candidates.ts
        // does. They are not redundant: employer_digest_settings' self policy
        // keys on app.current_user_id (the Cognito sub), while the job and
        // application tables listEmployerCandidates reads key on the internal
        // users.id. Both are transaction-local and reset at COMMIT.
        await setRlsContext(client, row.cognito_sub);
        await setInternalUserRlsContext(client, row.employer_id);

        // ── Only an active member gets a digest (Phase 3) ────────
        // A billing-suspended or removed foreman keeps their digest settings
        // and their jobs' RLS reach (135 did not close their own-row
        // policies), but must not be mailed about jobs they can no longer
        // open. org_member_scope is '{}' for anyone who is not an active
        // member of a company. Skipped like an unusable address: committed,
        // counted, and NO watermark advance -- if they are restored, the
        // backlog is still owed.
        const membership = await client.query<{ active: boolean }>(
          'SELECT cardinality(jale_internal.org_member_scope($1::text)) > 0 AS active',
          [row.employer_id],
        );
        if (membership.rows[0]?.active !== true) {
          console.info(JSON.stringify({
            metric: 'digest_skipped_inactive_member',
            employerId: row.employer_id,
          }));
          await client.query('COMMIT');
          summary.skipped += 1;
          continue;
        }

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

        // Whose jobs this digest covers: an active owner's is every member's
        // (any status, as the owner's screens list them; 135's digest
        // policies give the reach), anyone else's is their own. The company's
        // active-job limit bounds the owner's list, so the per-job ranking
        // below stays within what one Phase 2 employer could already hold.
        const scopeRes = await client.query<{ scope: string[] | null }>(
          'SELECT jale_internal.org_owner_scope($1::text, false) AS scope',
          [row.employer_id],
        );
        const ownerScope = scopeRes.rows[0]?.scope ?? [];
        const scopeUserIds = ownerScope.length > 0 ? ownerScope : [row.employer_id];

        const activeJobs = await client.query<ActiveJobRow>(
          "SELECT id, title FROM jobs WHERE employer_id = ANY($1::uuid[]) AND status = 'active'",
          [scopeUserIds],
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
          //
          // KNOWN LIMITATION (Phase 3): the watermark is per PERSON, not per
          // job. When a job moves between members (reassign, or remove with
          // reassign), its applicants are measured against the new holder's
          // watermark: one who applied between the two people's last sends can
          // be missed by both (up to about a day's window) or mailed to both.
          // The owner's company digest sees every member's job either way. A
          // real fix needs a per-job watermark; out of scope here.
          // Accepted in Phase 4: the owner's company digest covers every member's job (Open decision 7).
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

        if (!minted.ok) throw minted.error;
        const token = minted.token;
        const oneClickUnsubscribeUrl =
          `${apiBaseUrl}/public/employer-digest/unsubscribe?token=${encodeURIComponent(token)}`;
        const rendered = renderEmployerDigest({
          language,
          jobs: digestJobs,
          dashboardUrl: `${baseUrl}/${language}/employer/dashboard`,
          // NEVER built from props.api.url / the API Gateway URL: that is a
          // synth cycle (see the note at whatsapp-stack.ts:174-183) and would
          // also mail an API origin to a human.
          unsubscribeUrl: `${baseUrl}/${language}/digest-unsubscribe?token=${token}`,
          settingsUrl: `${baseUrl}/${language}/employer/profile`,
          // The SAME null watermark the candidate filter branched on above, so
          // the intro sentence can never describe a window the query did not
          // use. Deriving it from row.last_sent_at a second time would let the
          // two drift if the watermark handling ever changes.
          firstDigest: watermarkMs === null,
        });

        await queueEmail(client, {
          recipientEmail: row.email,
          subject: rendered.subject,
          bodyText: rendered.bodyText,
          bodyHtml: rendered.bodyHtml,
          sourceType: 'employer_digest',
          sourceId: row.employer_id,
          idempotencyKey: `employer-digest:${row.employer_id}:${localCalendarDate}`,
          // Digest mail only. The billing-pause producer queues no headers:
          // a transactional notice about a suspended account is not something
          // an employer may opt out of, and offering a one-click header on it
          // would advertise an opt-out that does not exist.
          headers: { unsubscribe_url: oneClickUnsubscribeUrl },
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

    await sweepHireDetailsNudges(client, baseUrl, remainingMs);
  } finally {
    client.release();
  }

  console.info(JSON.stringify({ metric: 'employer_digest_run', ...summary }));
  return summary;
};
