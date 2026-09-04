import type { PoolClient } from 'pg';
import { isReusableField } from './job-fields';

/**
 * The REUSE FILTER (sprint 24 L3, decision D2) -- keeps only the keys
 * `FIELD_REUSE_POLICY` marks 'stable' (job-fields.ts).
 *
 * This table has ONE row per worker and no job or employer dimension
 * (079_worker_application_defaults.sql), so anything stored here is offered
 * to every future employer. A per_application answer (`date_available`,
 * `desired_pay`, `worked_here_before`, `emergency_contact`) must therefore
 * never land in it -- the 2026-09-04 incident is exactly what that looks
 * like from the employer's side.
 *
 * Built on a null-prototype object and gated on `isReusableField`, so a
 * hostile key off a JSONB blob (`__proto__`, `constructor`, `toString`)
 * neither survives the filter nor reaches `Object.prototype`.
 */
export function filterReusableDefaults(
  answers: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (answers === null || answers === undefined) return out;
  for (const key of Object.keys(answers)) {
    if (!isReusableField(key)) continue;
    out[key] = answers[key];
  }
  return out;
}

// Merge-only upsert into worker_application_defaults
// (079_worker_application_defaults.sql) -- the worker's most-recently-
// submitted questionnaire answers, offered back as pre-fill defaults on a
// future application.
//
// Surface-agnostic, and as of sprint 23 there is exactly ONE caller for
// both surfaces: `mergeFieldAnswers` (lib/application-requirements.ts)
// writes the defaults back after every successful stage-2 field merge,
// whether the worker is on web or on WhatsApp. The apply path no longer
// touches this table at all -- stage 1 collects no questionnaire answers.
//
// GRANT STATUS -- 081's deferral is now CLOSED: 079 granted nothing to
// jale_whatsapp and 081 granted SELECT only, so this upsert used to fail
// with 42501 over that role, which is why the WhatsApp fill flow
// deliberately did not write defaults back. 091_application_stages.sql adds
//   GRANT INSERT, UPDATE ON worker_application_defaults TO jale_whatsapp;
// plus the own-worker write policy `worker_application_defaults_whatsapp_write`
// (USING + WITH CHECK on the app.current_internal_user_id GUC), because the
// shared engine now runs as jale_whatsapp for BOTH doors. This table is
// FORCE RLS, so the CALLER must have set that GUC
// (`setInternalUserRlsContext`) before calling either function here.
//
// REUSE FILTER (sprint 24 L3) -- this function no longer trusts the caller
// with WHICH keys may be stored. Everything written goes through
// `filterReusableDefaults` above, so:
//   - a per_application answer can never accumulate here, whichever surface
//     or future caller sends it (defence in depth; `mergeFieldAnswers`
//     filters too, and the incident's single guard being caller-side is why
//     it failed);
//   - the reserved 'certifications' key is DROPPED here rather than left to
//     the caller, since it is not a REQUIRED_FIELD_TYPES key at all. (In
//     practice `mergeFieldAnswers` cannot even receive it: it rejects any
//     key outside the job's required/optional field lists, and the 073/074
//     CHECKs keep 'certifications' out of both.)
//   - a write whose keys are ALL filtered out issues no statement at all,
//     rather than merging an empty object and bumping updated_at.
//
// MERGE semantics via the jsonb `||` operator, NEVER a replace: an existing
// key in the stored `answers` that the new write does not mention survives
// untouched. This lets a worker build up their defaults incrementally
// across separate applications (e.g. home_address answered on one job,
// education answered on a later one) without a partial, out-of-order
// write clobbering an earlier answer. `||` is a shallow merge -- a key
// present in both objects takes the NEW value whole (no deep-merging of
// nested objects like home_address), which matches "the latest answer for
// a given field wins" and is the only sane semantic for a field like
// desired_pay that isn't meaningfully mergeable at all.
//
// Caller contract: `answers` must already be validated, per-key data (the
// same shape validateApplicationAnswers produces). This module does no
// shape validation of its own.
export async function upsertWorkerApplicationDefaults(
  client: PoolClient,
  workerId: string,
  answers: Record<string, unknown>,
): Promise<void> {
  const reusable = filterReusableDefaults(answers);
  if (Object.keys(reusable).length === 0) return;
  await client.query(
    `INSERT INTO worker_application_defaults (worker_id, answers, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (worker_id) DO UPDATE
       SET answers = worker_application_defaults.answers || EXCLUDED.answers,
           updated_at = now()`,
    [workerId, JSON.stringify(reusable)],
  );
}

/**
 * Reads a worker's saved prefill defaults. Returns `{}` -- never null and
 * never undefined -- for a worker with no row yet (their very first
 * application) or a row whose `answers` column is NULL, so callers can walk
 * the object unconditionally.
 *
 * Does NOT set the RLS GUC: worker_application_defaults is FORCE RLS (079,
 * keyed on `app.current_internal_user_id`) and the caller owns that context
 * -- `seedAnswersFromDefaults` sets it immediately before calling this, and
 * the API doors set it once per request. Same split as
 * `upsertWorkerApplicationDefaults` above.
 */
export async function loadWorkerApplicationDefaults(
  client: PoolClient,
  workerId: string,
): Promise<Record<string, unknown>> {
  const res = await client.query<{ answers: Record<string, unknown> | null }>(
    `SELECT answers FROM worker_application_defaults WHERE worker_id = $1`,
    [workerId],
  );
  return res.rows[0]?.answers ?? {};
}
