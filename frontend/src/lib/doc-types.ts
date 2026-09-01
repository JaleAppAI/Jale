/**
 * The one place a document type gets a human name.
 *
 * Before this file the same five labels lived in five separate message
 * namespaces (`employer_dashboard.worker_profile.doc_*`, `upload_page.doc_*`,
 * `worker_home.doc_labels.*`, `worker_job_detail.doc_labels.*`,
 * `job_requirements.docs.*`), each with its own hand-written map in the
 * component that read it, and each drifting: "SSN Card" in one place and
 * "SSN Card / ITIN" in another, `work_auth_doc` present in some and missing
 * from others -- which is how a job requiring it once rendered the raw enum
 * key as a requirement chip.
 *
 * `job_requirements.docs.*` deliberately survives as the apply flow's own
 * requirement vocabulary (it is keyed by `REQUIREMENT_DOC_KEYS`, a strictly
 * narrower set with different copy needs); `public_job.doc_*` survives
 * because the unauthenticated referral page reads it.
 */

/**
 * Every doc type the app can put a name to, in the order a document list
 * shows them. `ssn` is LAST and legacy: no surface offers it as an upload
 * slot any more (migration 032 dropped it from the app-layer vocabulary), but
 * the `jobs.required_docs` CHECK still accepts it on rows written before
 * that, so those rows must still be nameable.
 */
export const DOC_TYPE_KEYS = [
  'resume',
  'driver_license',
  'work_auth_doc',
  'certification_doc',
  'ssn',
] as const;

export type DocTypeKey = (typeof DOC_TYPE_KEYS)[number];

export function isDocTypeKey(value: string): value is DocTypeKey {
  return (DOC_TYPE_KEYS as readonly string[]).includes(value);
}

/**
 * The human name for `key`, or `null` when this app has no name for it.
 *
 * Membership is checked BEFORE `t` is called, and that ordering is the
 * contract: next-intl does not return `undefined` for a missing key -- it
 * renders the key path, or throws under a strict config -- so a lookup-first
 * implementation would print `doc_types.passport` at the reader instead of
 * letting the caller say "this requirement can't be shown".
 *
 * @param t A `useTranslations('doc_types')` function.
 */
export function docTypeLabel(key: string, t: (key: string) => string): string | null {
  return isDocTypeKey(key) ? t(key) : null;
}
