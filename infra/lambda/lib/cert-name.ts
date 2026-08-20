// Shared cert_name validation for the worker-document upload/confirm lambdas
// (BE-T3, job-flow redesign). cert_name labels a certification_doc upload
// (e.g. "OSHA 30", "Forklift cert") -- see
// 078_worker_documents_cert_name.sql for the column and its two DB CHECKs,
// which this module mirrors at the app layer so a malformed request 400s
// before ever reaching Postgres:
//   worker_documents_cert_name_valid   -- cert_name is only meaningful on
//                                         certification_doc rows; every other
//                                         doc_type must leave it NULL.
//   worker_documents_cert_name_length  -- <=200 chars.
//
// Deliberately NOT in job-fields.ts: that file belongs to another task on
// this sprint, and job-fields.ts's own MAX_CERTIFICATION_LENGTH (a different
// column's bound) is already module-private for the same reason -- keep
// these small, single-purpose validators out of the shared constants file.
export const MAX_CERT_NAME_LENGTH = 200;

export type CertNameValidation =
  | { ok: true; certName: string | null }
  | { ok: false; error: 'missing_cert_name' | 'invalid_cert_name' };

/**
 * Validates a client-supplied `cert_name` against `doc_type`.
 *
 * `required` governs whether an absent/blank cert_name is an error when
 * `doc_type === 'certification_doc'`:
 *   - upload-url endpoints call this with `required: false` -- no current
 *     frontend caller sends cert_name at presign time (it's supplied later,
 *     at confirm), so requiring it here would 400 every certification
 *     upload before the file is even PUT to S3.
 *   - confirm endpoints call this with `required: true` -- cert_name is
 *     mandatory on a certification_doc confirm (the frontend's
 *     `confirmAuthUpload(..., cert_name)` call site supplies it).
 * `required` has no effect when `doc_type !== 'certification_doc'`: cert_name
 * is simply never required there, mirroring `worker_documents_cert_name_valid`.
 */
export function validateCertName(
  docType: string,
  raw: unknown,
  required: boolean,
): CertNameValidation {
  const isCertification = docType === 'certification_doc';

  // undefined, null, and a whitespace-only string all collapse to "nothing
  // supplied" -- the frontend's `confirmAuthUpload` omits the key entirely
  // when the caller passes no cert_name, but some callers may still send
  // `cert_name: null` explicitly, and both must be treated identically.
  const isBlank =
    raw === undefined ||
    raw === null ||
    (typeof raw === 'string' && raw.trim().length === 0);

  if (!isCertification) {
    if (isBlank) return { ok: true, certName: null };
    // A non-blank cert_name on any doc_type other than certification_doc is
    // rejected outright -- mirrors worker_documents_cert_name_valid
    // (cert_name IS NULL OR doc_type = 'certification_doc'). Malformed type
    // (e.g. a number) falls into this branch too, same error.
    return { ok: false, error: 'invalid_cert_name' };
  }

  if (isBlank) {
    return required
      ? { ok: false, error: 'missing_cert_name' }
      : { ok: true, certName: null };
  }

  if (typeof raw !== 'string') {
    return { ok: false, error: 'invalid_cert_name' };
  }

  const trimmed = raw.trim();
  if (trimmed.length > MAX_CERT_NAME_LENGTH) {
    return { ok: false, error: 'invalid_cert_name' };
  }

  return { ok: true, certName: trimmed };
}
