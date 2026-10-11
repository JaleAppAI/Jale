/**
 * audit-value-samples.ts -- the shared sample table for the value-span rules:
 * the database's jale_audit.redact_value_spans (migration
 * 110), the export job's scan of the reason field, and the log metric-filter
 * patterns are all tested against these samples.
 *
 * Negatives are real shapes that sit next to audit values and must never be
 * taken for a phone number, an email address or a link. Positives must
 * always be caught. Every value is synthetic: phone numbers in the fictional
 * 555-01xx range, the reserved example domains, documentation IP addresses
 * (RFC 5737) and obviously fake UUIDs.
 */

/** [label, sample] pairs that must not be changed. */
export const VALUE_SCAN_NEGATIVES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ['an engine log line prefix (%t:%r:%u@%d:[%p]:)',
    '2026-10-02 14:03:27 UTC:192.0.2.10(54321):jale_api@jale:[12345]:LOG:  connection authorized'],
  ['a canonical JSON event line',
    '{"seq" : 42, "event_id" : "00000000-0000-4000-8000-0000000000e1", "xact" : "758123", '
    + '"occurred_at" : "2026-10-02T14:03:27.123456Z", "kind" : "read", "surface" : "employer.worker_profile", '
    + '"subject_user_ids" : ["00000000-0000-4000-8000-0000000000a1"], "result_count" : 1, '
    + '"request_id" : "test-request-0001", "db_login" : "jale_api", "db_pid" : 12345}'],
  ['a UUID', '00000000-0000-4000-8000-000000000001'],
  ['a request id shaped like a UUID', 'c0ffee00-1234-4abc-8def-0123456789ab'],
  ['a test request id', 'test-request-0001'],
  ['a migration filename', '109_audit_storage.sql'],
  ['an ISO timestamp', '2026-10-02T14:03:27.123456Z'],
  ['a date and a clock time', '2026-10-02 14:03:27'],
  ['an IP address', '192.0.2.10'],
  ['a process id', '[12345]'],
  ['a long sequence number', '123456789012345678'],
  ['an xid range', '758123-758200'],
]);

/** [label, sample, the value inside it] triples that must be caught. */
export const VALUE_SCAN_POSITIVES: ReadonlyArray<readonly [string, string, string]> = Object.freeze([
  ['an E.164 phone number', 'Reached them at +15555550123 today.', '+15555550123'],
  ['a phone number in parentheses', 'Call (555) 555-0142 after noon.', '(555) 555-0142'],
  ['a dashed phone number', 'Number: 555-555-0143.', '555-555-0143'],
  ['a dotted phone number', 'Number: 555.555.0144', '555.555.0144'],
  ['a spaced phone number', 'Number 555 555 0145 please', '555 555 0145'],
  ['an email address', 'Wrote to someone@example.com about it.', 'someone@example.com'],
  ['an https link', 'See https://example.com/case/1 for details.', 'https://example.com/case/1'],
  ['an http link', 'Old link http://example.org', 'http://example.org'],
]);
