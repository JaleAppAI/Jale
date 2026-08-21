import type { PoolClient } from 'pg';

// Merge-only upsert into worker_application_defaults
// (079_worker_application_defaults.sql) -- the worker's most-recently-
// submitted questionnaire answers, offered back as pre-fill defaults on a
// future application.
//
// Surface-agnostic: this is a second entry point Ivan's WhatsApp fill-flow
// is expected to call IDENTICALLY once it lands (same function, same
// argument shape, no web-only types). Two things that flow must still do
// itself before it can:
//   1. Add the follow-up migration 079's header describes:
//        GRANT SELECT, INSERT, UPDATE ON worker_application_defaults TO jale_whatsapp;
//      jale_whatsapp holds NO grant on this table as of 079 -- calling this
//      function over that role today gets a bare "permission denied for
//      table worker_application_defaults" (42501), not a graceful error.
//   2. Strip the reserved 'certifications' key from `answers` first, same
//      as the web caller does (see applications.ts) -- this table holds
//      only the free-form questionnaire answer keys
//      (REQUIRED_FIELD_TYPES / job-fields.ts), never certification claims.
//      This function does not strip it itself and trusts the caller.
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
  await client.query(
    `INSERT INTO worker_application_defaults (worker_id, answers, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (worker_id) DO UPDATE
       SET answers = worker_application_defaults.answers || EXCLUDED.answers,
           updated_at = now()`,
    [workerId, JSON.stringify(answers)],
  );
}
