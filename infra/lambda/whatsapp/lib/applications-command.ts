/**
 * applications-command.ts -- the `aplicaciones` / `applications` /
 * `solicitudes` command (sprint 23).
 *
 * One of the three doors into stage 2 (the other two being the
 * `application:start:app-<uuid>` button on the details-requested template and
 * the idle fallback). It lists the worker's applications, marks the ones the
 * employer is waiting on, and turns a bare digit reply into exactly the same
 * dispatch the Start button performs.
 *
 * ── ONE SELECT, AND WHERE employer_display_name SITS ─────────────
 * The listing is a single statement. `employer_display_name(j.employer_id)`
 * (031) is a SECURITY DEFINER lookup whose body flips a transaction-local
 * `app.employer_name_lookup` GUC that widens `employer_profiles` reads until
 * COMMIT -- which is why worker-jobs-detail.ts:44-46 requires it to be the
 * last query before COMMIT in an API handler running as jale_admin. Two
 * things make it safe here:
 *   1. this lane runs as jale_whatsapp, which holds NO table grant on
 *      `employer_profiles` at all (031's header), so the widened policy has
 *      nothing to widen;
 *   2. it is nonetheless the LAST query this module issues -- everything
 *      after it in the turn is a reply/state write, never an
 *      `employer_profiles` read.
 * Same precedent as conversation-router.ts:566, which already calls it
 * mid-turn from this processor.
 *
 * ── RLS ──────────────────────────────────────────────────────────
 * `jobapp_whatsapp_select` (028) is `USING (true)`, so worker scoping is NOT
 * automatic: the `WHERE ja.worker_id = $1` predicate is what keeps one
 * worker from listing another's applications, and it is load-bearing. The
 * caller must also have set `app.current_internal_user_id` so migration 070's
 * `jobs_worker_read_applied` policy admits the non-active jobs in the join
 * (same idiom as worker-applications-list.ts:33-41).
 */
import type { PoolClient } from 'pg';
import { t, type Lang } from './templates';

export interface ApplicationsDeps {
  queueReplyText(client: PoolClient, inboundSid: string, to: string, body: string): Promise<void>;
  /** Same binding contract as the fill lane's: persist the spread-merged
   * patch AND mutate `ctx.stateContext` in place. */
  updateStateContext(client: PoolClient, conversationId: string, patch: Record<string, unknown>): Promise<void>;
  nowMs(): number;
}

export interface ApplicationsContext {
  conversationId: string;
  workerId: string;
  lang: Lang;
  stateContext: Record<string, unknown>;
}

export interface ApplicationSummary {
  applicationId: string;
  jobTitle: string;
  companyName: string;
  /** Already normalized to the worker-facing vocabulary. */
  status: string;
  needsDetails: boolean;
}

/** At most ten rows -- a WhatsApp body has to stay readable on a phone. */
export const APPLICATIONS_LIST_LIMIT = 10;

/**
 * Needs-details first, then most recently applied. The ordering key is the
 * same boolean the list marks rows with, so what is at the top is exactly
 * what the footer invites the worker to answer.
 *
 * `reviewed`/`rejected` are legacy status spellings still present on old
 * rows; they are folded to the current vocabulary here exactly as
 * worker-applications-list.ts does, so the two surfaces never disagree.
 */
const APPLICATIONS_SQL = `SELECT ja.id,
            j.title,
            CASE ja.status
              WHEN 'reviewed' THEN 'contacted'
              WHEN 'rejected' THEN 'not_interested'
              ELSE ja.status
            END AS status,
            (ja.details_requested_at IS NOT NULL AND ja.details_completed_at IS NULL) AS needs_details,
            employer_display_name(j.employer_id) AS company_name
       FROM job_applications ja JOIN jobs j ON j.id = ja.job_id
      WHERE ja.worker_id = $1
      ORDER BY (ja.details_requested_at IS NOT NULL AND ja.details_completed_at IS NULL) DESC,
               ja.applied_at DESC
      LIMIT ${APPLICATIONS_LIST_LIMIT}`;

export async function loadWorkerApplications(
  client: PoolClient,
  workerId: string,
): Promise<ApplicationSummary[]> {
  const res = await client.query<{
    id: string;
    title: string | null;
    status: string;
    needs_details: boolean;
    company_name: string | null;
  }>(APPLICATIONS_SQL, [workerId]);
  return res.rows.map((row) => ({
    applicationId: row.id,
    jobTitle: row.title ?? '',
    companyName: row.company_name ?? 'Jale',
    status: row.status,
    needsDetails: row.needs_details === true,
  }));
}

const STATUS_WORDS: Record<string, { en: string; es: string }> = {
  pending: { en: 'Sent', es: 'Enviada' },
  contacted: { en: 'Under review', es: 'En revision' },
  talking: { en: 'In conversation', es: 'En conversacion' },
  hired: { en: 'Hired', es: 'Contratado' },
  not_interested: { en: 'Closed', es: 'Cerrada' },
  details_requested: { en: 'Details requested', es: 'Datos solicitados' },
};

function statusWord(status: string, lang: Lang): string {
  return STATUS_WORDS[status]?.[lang] ?? status;
}

const NEEDS_DETAILS_MARK: Record<Lang, string> = {
  en: 'Details needed',
  es: 'Faltan datos',
};

/**
 * `1) {title} - {company} - {status word}`, with the needs-details rows
 * carrying an extra marker. The footer is appended ONLY when at least one
 * row is actually actionable -- inviting a number when nothing can be
 * answered would send the worker into the `application_already_complete` /
 * `application_not_requested_yet` copy for no reason.
 */
export function buildApplicationsList(lang: Lang, rows: ApplicationSummary[]): string {
  const lines = rows.map((row, index) => {
    const base = `${index + 1}) ${row.jobTitle} - ${row.companyName} - ${statusWord(row.status, lang)}`;
    return row.needsDetails ? `${base} - ${NEEDS_DETAILS_MARK[lang]}` : base;
  });
  let body = `${t('applications_header', lang)}\n\n${lines.join('\n')}`;
  if (rows.some((row) => row.needsDetails)) {
    body += `\n\n${t('applications_footer', lang)}`;
  }
  return body;
}

export interface ApplicationsListResult {
  /** Ids in DISPLAY order -- index N of this array is the worker's "N+1)". */
  ids: string[];
  /** True when at least one listed application is awaiting stage-2 answers. */
  anyNeedsDetails: boolean;
}

/**
 * Sends the list and arms the ONE-SHOT numbered menu. Every id is stored,
 * not just the actionable ones, so picking a finished or not-yet-requested
 * row gets the specific explanation rather than a bare "unknown number".
 *
 * The menu is cleared by every arm write in both lanes (`FILL_SCRUB` /
 * `PROMPT_ARM_SCRUB`) and is never consulted while `pending_picker` is set
 * (see `parseApplicationsMenuPick`).
 */
export async function sendApplicationsList(
  client: PoolClient,
  ctx: ApplicationsContext,
  inboundSid: string,
  from: string,
  deps: ApplicationsDeps,
): Promise<ApplicationsListResult> {
  const rows = await loadWorkerApplications(client, ctx.workerId);
  return sendApplicationsListRows(client, ctx, rows, inboundSid, from, deps);
}

/** The send half, for a caller that has ALREADY loaded the rows (the idle
 * fallback tests `anyNeedsDetails` first and must not re-run the SELECT). */
export async function sendApplicationsListRows(
  client: PoolClient,
  ctx: ApplicationsContext,
  rows: ApplicationSummary[],
  inboundSid: string,
  from: string,
  deps: ApplicationsDeps,
): Promise<ApplicationsListResult> {
  if (rows.length === 0) {
    await deps.updateStateContext(client, ctx.conversationId, { applications_menu: null });
    await deps.queueReplyText(client, inboundSid, from, t('applications_none', ctx.lang));
    return { ids: [], anyNeedsDetails: false };
  }

  const ids = rows.map((row) => row.applicationId);
  await deps.updateStateContext(client, ctx.conversationId, {
    applications_menu: { ids, at: deps.nowMs() },
  });
  await deps.queueReplyText(client, inboundSid, from, buildApplicationsList(ctx.lang, rows));
  return { ids, anyNeedsDetails: rows.some((row) => row.needsDetails) };
}

/** True when the worker has at least one application the employer is waiting
 * on -- the idle fallback uses this to send the list instead of `idle_help`. */
export function anyNeedsDetails(rows: ApplicationSummary[]): boolean {
  return rows.some((row) => row.needsDetails);
}

/**
 * A bare 1..N digit resolved against the armed menu. Returns null (so the
 * turn falls through to ordinary routing) when no menu is armed, when a
 * `pending_picker` owns the worker's next reply, or when the number is out
 * of range.
 */
export function parseApplicationsMenuPick(
  stateContext: Record<string, unknown> | null | undefined,
  body: string | undefined,
): string | null {
  if (!stateContext) return null;
  if (stateContext.pending_picker) return null;
  const menu = stateContext.applications_menu as { ids?: unknown } | null | undefined;
  const ids = menu?.ids;
  if (!Array.isArray(ids) || ids.length === 0) return null;
  const m = (body ?? '').trim().match(/^(\d{1,2})$/);
  if (!m) return null;
  const index = Number(m[1]) - 1;
  const id = ids[index];
  return typeof id === 'string' ? id : null;
}
