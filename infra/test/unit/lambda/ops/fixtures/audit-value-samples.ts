/**
 * The one shared sample table for the value scan.
 *
 * The export job's free-text scanner and every CloudWatch metric-filter pattern
 * on the audit log groups are tested against both lists, so the two can never
 * disagree about what counts as a value.
 *
 * MUST_NOT_HIT holds the shapes the audit stores carry every day: an engine
 * log line in the default prefix (`%t:%r:%u@%d:[%p]:`), canonical JSON rows as
 * the database builds them, a fallback line, UUIDs, request ids, a migration
 * file name, ISO times, clock times, IP addresses, process ids and long
 * sequence numbers. Every value below is synthetic: documentation address
 * ranges, phone numbers from the ranges reserved for fiction (555 numbers
 * and the UK's drama range) and example.com.
 */

export const MUST_NOT_HIT: readonly string[] = [
  // Engine log lines, default RDS prefix.
  '2026-10-04 12:34:56 UTC:10.0.12.34(54321):jale_api@jale:[12345]:LOG:  connection authorized: user=jale_api database=jale application_name=jale-api SSL enabled (protocol=TLSv1.3, cipher=TLS_AES_256_GCM_SHA384, bits=256)',
  '2026-10-04 12:34:57 UTC:10.0.12.34(54321):jale_api@jale:[12345]:LOG:  disconnection: session time: 0:00:01.234 user=jale_api database=jale host=10.0.12.34 port=54321',
  '2026-10-04 12:35:00 UTC:10.0.200.150(40112):jale_admin@jale:[23456]:LOG:  AUDIT: SESSION,1,1,DDL,CREATE TABLE,,,"CREATE TABLE public.example_items (id uuid PRIMARY KEY, created_at timestamptz)",<not logged>',
  '2026-10-04 12:35:01 UTC:10.0.200.150(40112):jale_admin@jale:[23456]:LOG:  AUDIT: SESSION,2,1,ROLE,GRANT,,,GRANT SELECT ON public.example_items TO jale_api,<not logged>',
  // A canonical event row, as json_build_object renders it.
  '{"seq" : 9223372036, "event_id" : "3f1c2b9e-8a4d-4c1e-9b7a-2d5e6f7a8b9c", "xact" : "18446744073709551", "occurred_at" : "2026-10-04T12:34:56.123456Z", "kind" : "read", "outcome" : "allowed", "actor_kind" : "employer", "actor_id" : "0b8f5a7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b", "actor_role" : null, "actor_session" : null, "channel" : "web", "surface" : "employer.job_applicants", "categories" : ["contact_details", "application_answers"], "subject_user_ids" : ["6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d"], "record_type" : "job_application", "record_ids" : ["7b8c9d0e-1f2a-4b3c-9d4e-5f6a7b8c9d0e"], "result_count" : 125, "field_names" : ["phone", "email"], "purpose_kind" : "job", "purpose_id" : "8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f", "reason" : null, "link_expires_at" : "2026-10-04T12:49:56.000000Z", "part" : 1, "parts" : 1, "request_id" : "c6af9ac6-7b61-11e6-9a41-93e8deadbeef", "db_login" : "jale_api", "db_pid" : 12345}',
  // A canonical change row.
  '{"seq" : 4567, "event_id" : "9d0e1f2a-3b4c-4d5e-9f6a-7b8c9d0e1f2a", "xact" : "987654321", "occurred_at" : "2026-10-04T00:00:00.000001Z", "table_name" : "public.worker_profiles", "operation" : "update", "row_count" : 1, "record_ids" : ["0e1f2a3b-4c5d-4e6f-8a7b-8c9d0e1f2a3b"], "subject_user_ids" : ["0e1f2a3b-4c5d-4e6f-8a7b-8c9d0e1f2a3b"], "changed_fields" : ["city", "phone"], "actor_kind" : "worker", "actor_id" : "0e1f2a3b-4c5d-4e6f-8a7b-8c9d0e1f2a3b", "channel" : "whatsapp", "surface" : "worker.profile_update", "request_id" : null, "context_status" : "set", "db_login" : "jale_whatsapp", "db_pid" : 31337}',
  // A fallback line: the record_event payload, the client time and the origin.
  '{"kind":"attempt","outcome":"denied","actor_kind":"employer","actor_id":"1f2a3b4c-5d6e-4f7a-8b9c-0d1e2f3a4b5c","channel":"web","surface":"employer.worker_profile","categories":["profile"],"subject_user_ids":["2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d"],"record_ids":[],"result_count":0,"field_names":[],"request_id":"5f2b8c1e-0d4a-4e6b-9c3f-7a1d2e3f4b5c","occurred_at":"2026-10-04T12:34:56.789Z","origin":"api"}',
  // UUIDs and request ids.
  '123e4567-e89b-12d3-a456-426614174000',
  '00000000-0000-0000-0000-000000000000',
  '12345678-1234-5678-1234-567812345678',
  'Root=1-5759e988-bd862e3fe1be46a994272793;Parent=53995c3f42cd8ad8;Sampled=1',
  // Migration file names and object keys.
  '107_audit_storage.sql',
  'infra/db/migrations/103_worker_referred_jobs.sql',
  'db/events/dt=2026-10-04/00000000000000987654.jsonl.gz',
  // Times.
  '2026-10-04T12:34:56.123Z',
  '2026-10-04 12:34:56+00',
  '23:59:59.999999',
  // Addresses, ports, pids, long numbers.
  '192.168.100.200',
  '10.0.12.34:5432',
  '203.0.113.255',
  '[12345]',
  '9223372036854775807',
  '18446744073709551615',
  'pid 4242 exited with code 1 after 1234 ms',
];

/** Each true-positive shape, alone and inside text or a JSON row. */
export const MUST_HIT: readonly { readonly sample: string; readonly kind: 'phone' | 'email' | 'url' }[] = [
  { sample: '+15550001234', kind: 'phone' },
  { sample: 'call +447700900123 today', kind: 'phone' },
  { sample: '(555) 010-1234', kind: 'phone' },
  { sample: '(555)010-1234', kind: 'phone' },
  { sample: '555-010-1234', kind: 'phone' },
  { sample: '555.010.1234', kind: 'phone' },
  { sample: '555 010 1234', kind: 'phone' },
  // Mixed separators: the export scan holds them wherever a stored rule is narrower.
  { sample: '555 010-1234', kind: 'phone' },
  { sample: 'call back on 555.010 1234 today', kind: 'phone' },
  { sample: 'reach them at 555-010-1234.', kind: 'phone' },
  { sample: '{"reason" : "555-010-1234"}', kind: 'phone' },
  { sample: 'jane.doe@example.com', kind: 'email' },
  { sample: 'write to someone@mail.example.org please', kind: 'email' },
  { sample: '{"reason" : "contact a.b-c@example.co"}', kind: 'email' },
  { sample: 'https://example.com/path', kind: 'url' },
  { sample: 'see http://example.com', kind: 'url' },
];
