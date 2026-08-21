/**
 * DB-derived progress engine for the WhatsApp application-fill flow (spec:
 * docs/superpowers/specs/2026-08-19-whatsapp-application-fill-design.md
 * §5/§9).
 *
 * `computeNextStep` is the ONLY source of truth for "what does this worker
 * need to answer/upload next" -- it re-derives the answer from the DB on
 * every call rather than trusting any cached fill-flow state, so a job's
 * `required_fields`/`required_docs` can widen or narrow mid-fill (an
 * employer editing requirements) and the very next turn reflects it. This
 * file intentionally exports ONLY `computeNextStep` and `NextStep` for now
 * -- later tasks add the fill-flow dispatcher here.
 *
 * Lifecycle exits (§9): the DB enums are the source of truth, not a
 * hand-maintained mirror --
 *   - jobs.status: 'active' | 'paused' | 'filled' | 'closed'
 *     (JOB_STATUSES, job-fields.ts) -- 'active'/'paused' continue the fill,
 *     'filled'/'closed' exit as `job_inactive`.
 *   - job_applications.status: 'pending' | 'contacted' | 'talking' |
 *     'hired' | 'not_interested' (APPLICATION_STATUSES, job-fields.ts) --
 *     'hired'/'not_interested' exit as `application_closed`, the other
 *     three continue.
 *   - A vanished application row (deleted, or its job CASCADE-deleted)
 *     exits as `application_gone`.
 */
import type { PoolClient } from 'pg';
import { setInternalUserRlsContext } from '../../lib/db';
import { DOC_TYPES } from '../../lib/job-fields';
import type { FillFieldKey, CollectableDocType } from './application-fill-prompts';

export type NextStep =
  | { kind: 'field'; key: FillFieldKey; uncollectable: string[] }
  | { kind: 'doc'; docType: CollectableDocType; uncollectable: string[] }
  | { kind: 'exit'; reason: 'job_inactive' | 'application_gone' | 'application_closed'; uncollectable: string[] }
  | { kind: 'complete'; uncollectable: string[] };

// DOC_TYPES (job-fields.ts) already excludes 'ssn' -- legacy rows may still
// carry it (kept in DB CHECK constraints for that reason), but it can never
// be collected through this flow. See job-fields.ts's DOC_TYPES comment.
const COLLECTABLE = new Set<string>(DOC_TYPES);

/**
 * Computes the next unanswered required field, then the next missing
 * required doc, for a worker's job application -- or an exit/complete
 * verdict. Field keys are walked in `required_fields` array order using
 * `hasOwnProperty` presence (a stored `false`/`null` answer counts as
 * answered -- only an ABSENT key is unanswered), so re-ordering or widening
 * `required_fields` on the job takes effect on the very next call. Docs are
 * only checked once every field is answered, matching the design's
 * fields-before-docs ordering.
 */
export async function computeNextStep(client: PoolClient, applicationId: string): Promise<NextStep> {
  const appRes = await client.query(
    `SELECT ja.worker_id, ja.job_id, ja.status AS application_status,
            ja.application_answers, j.status AS job_status,
            j.required_fields, j.required_docs
       FROM job_applications ja JOIN jobs j ON j.id = ja.job_id
      WHERE ja.id = $1`,
    [applicationId],
  );
  if (appRes.rows.length === 0) {
    return { kind: 'exit', reason: 'application_gone', uncollectable: [] };
  }
  const row = appRes.rows[0];
  const uncollectable: string[] = (row.required_docs ?? []).filter(
    (d: string) => !COLLECTABLE.has(d),
  );

  if (row.job_status === 'filled' || row.job_status === 'closed') {
    return { kind: 'exit', reason: 'job_inactive', uncollectable };
  }
  if (row.application_status === 'hired' || row.application_status === 'not_interested') {
    return { kind: 'exit', reason: 'application_closed', uncollectable };
  }

  const answers = row.application_answers ?? {};
  for (const key of row.required_fields ?? []) {
    if (!Object.prototype.hasOwnProperty.call(answers, key)) {
      return { kind: 'field', key, uncollectable };
    }
  }

  // worker_documents is FORCE ROW LEVEL SECURITY (005_document_vault.sql):
  // its SELECT policy requires app.current_internal_user_id = worker_id.
  // Without this, the query below silently returns zero rows and every
  // required doc reads as missing forever. Same house pattern as
  // applyWorkerToJob (../../lib/applications.ts).
  await setInternalUserRlsContext(client, row.worker_id);
  const docRes = await client.query(
    `SELECT DISTINCT doc_type FROM worker_documents
      WHERE worker_id = $1 AND (job_id IS NULL OR job_id = $2)`,
    [row.worker_id, row.job_id],
  );
  const have = new Set(docRes.rows.map((r: { doc_type: string }) => r.doc_type));
  for (const docType of row.required_docs ?? []) {
    if (!COLLECTABLE.has(docType)) continue;
    if (!have.has(docType)) return { kind: 'doc', docType, uncollectable };
  }

  return { kind: 'complete', uncollectable };
}
