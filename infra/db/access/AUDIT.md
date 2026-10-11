# Audit storage: functions, codes and settings (`jale_audit`, `jale_ops`)

Migrations 109-112 create append-only audit storage: access, attempt,
session and action events, change records for the sensitive tables, the
export bookkeeping, and the operator read functions. This page is the
interface the application code builds against.

`infra/db/access/manifest.d/audit.json` is the machine-readable form: the
export login, the owners, the tables, functions, sequences and schemas, and
the additions to `admin_users` and `admin_audit_log`. The `audit-*` suites
under `infra/test/unit/db/` prove each signature, owner and grant on a real
database, and check the fragment against the catalog.

## Conventions

- **Owners.** `jale_audit_owner` owns schema `jale_audit`, its tables and its
  functions. `jale_ops_owner` owns schema `jale_ops` and the operator
  functions. Both are NOLOGIN, NOINHERIT and belong to nothing.
- **No table rights.** No role but the owner holds any privilege on a
  `jale_audit` table. Every read and write goes through a `SECURITY DEFINER`
  function with `search_path = pg_catalog, pg_temp`, closed to PUBLIC and
  executable only by the callers listed here. Each caller also holds `USAGE`
  on the schema.
- **No values.** A record holds identifiers, codes, field names, counts and
  times. The only free text is an admin's reason for a contact reveal, at
  most 500 characters.
- **Errors.**
  - `22023` for a malformed argument. The message is
    `<function>: invalid <key>`, `<function>: unknown key`, or
    `<function>: the event must be a JSON object`. It names the key, never
    the value, so an error line can never carry personal data.
  - `42501` for a caller without the right: no `USAGE` on the schema, or no
    `EXECUTE` on the function.
  - `55000` (`object_not_in_prerequisite_state`) when the guard refuses a
    change to an audit record, and when `export_commit` is given a window that
    does not start at the stream's watermark.
- **JSON.** An absent key and a JSON `null` mean the same thing. UUIDs are
  canonical strings (`8-4-4-4-12` hex). Instants are ISO-8601 strings with an
  explicit zone, `Z` or `+hh:mm`, as `Date.prototype.toISOString()` writes
  them. Integers are JSON numbers with no fraction or exponent.

## Code lists

| List | Values |
|---|---|
| `kind` and its `outcome` | `read`: `allowed` · `attempt`: `denied`, `not_found`, `failed` · `session`: `signed_in`, `sign_in_rejected`, `signed_out`, `expired`, `revoked` · `action`: `done` |
| `actor_kind` | `worker`, `employer`, `admin`, `platform`, `token_holder`, `anonymous` |
| `actor_role` (admins only) | `admin_readonly`, `admin_ops`, `admin_superadmin` |
| `channel` | `web`, `whatsapp`, `admin` |
| `categories` | `application_answers`, `contact_details`, `documents`, `trust_assessments`, `conversations`, `profile`, `posts`, `saved_application_details`, `cases`, `verifications`, `analytics`, `billing`, `audit_history`, `problem_reports`, `admin_access` |
| `record_type` | `job_application`, `worker_document`, `worker_post`, `job_conversation`, `admin_case`, `identity_challenge`, `user`, `problem_report`, `admin_user` |
| `purpose_kind` | `job`, `case`, `verification`, `reveal`, `self`, `audit_review` |
| `surface` | `<side>.<thing>[.<verb>]`: matches `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$`, at most 100 characters, e.g. `employer.job_applicants`, `admin.case_detail` |
| field names | match `^[a-z][a-z0-9_]{0,62}$` |
| `request_id` | matches `^[A-Za-z0-9-]{1,64}$` |

Three codes have a narrow use:

- **`admin_access`** is the category for admin session events: sign-in,
  sign-out, expiry, rejection and session revocation.
- **`audit_history`** is only for viewing the access history.
- **`admin_user`** is the record type for an `admin_users.id`, for example
  the admin whose sessions were revoked. `user` always means a `users.id`.

## Recording an event (migration 109)

| Function | Callers | Returns |
|---|---|---|
| `jale_audit.record_event(p_event jsonb)` | `jale_api`, `jale_whatsapp`, `jale_admin_console` | `bigint`, the new row's `seq` |

`p_event` is one JSON object with these keys and no others:

| Key | Type | Rule |
|---|---|---|
| `kind` | string | Required. From the list. |
| `outcome` | string | Required. Must pair with `kind`. |
| `actor_kind` | string | Required. From the list. |
| `actor_id` | UUID | Required for `worker`, `employer` (`users.id`) and `admin` (`admin_users.id`). Absent for every other actor. Comes from the verified sign-in only. |
| `actor_role` | string | Required for `admin`, from the list. Absent otherwise. |
| `actor_session` | UUID | `admin_sessions.id`. Optional for `admin`; absent otherwise. |
| `channel` | string | Required. From the list. |
| `surface` | string | Required. Matches the pattern. |
| `categories` | string[] | Required. 1 to 8 elements, each from the list. |
| `subject_user_ids` | UUID[] | Optional, default empty. At most 500. |
| `record_type` | string | From the list. Required when `record_ids` is not empty. |
| `record_ids` | UUID[] | Optional, default empty. At most 500. |
| `result_count` | integer | Required. 0 or more. |
| `field_names` | string[] | Optional, default empty. At most 100, each matching the pattern. |
| `purpose_kind` | string | Optional. From the list. |
| `purpose_id` | UUID | Required when `purpose_kind` is `job` (the job id) or `case` (the case id). Absent for every other purpose. |
| `reason` | string | 1 to 500 characters. Only when `actor_kind` is `admin` and `purpose_kind` is `reveal`. |
| `link_expires_at` | instant | Optional. When a signed link granted by this read expires. |
| `part`, `parts` | integer | Optional, default 1. `1 <= part <= parts <= 32767`. For an event split at 500 subjects or records. |
| `request_id` | string | Optional. Matches the pattern. |

- `seq`, `event_id`, `xact`, `occurred_at`, `db_login` and `db_pid` are not
  keys. They always come from the column defaults: `db_login` is
  `session_user` (the login, never the function owner), `db_pid` is
  `pg_backend_pid()`, `xact` is `pg_current_xact_id()`, `occurred_at` is
  `clock_timestamp()`. Passing any of them is `unknown key`.
- Every refusal is `22023` with `record_event: invalid <key>`. A refusal
  stores nothing and leaves the caller's transaction aborted, so the request
  fails closed.
- One call inserts one row. Splitting a list over 500 into parts that share a
  `request_id` is the caller's job (`recordAccess`).

## The change-record context (read by migration 111's triggers)

Five settings, set transaction-locally in one statement by
`setAuditContext`. Pass `''` for a value that does not apply.

```sql
SELECT set_config('app.audit_actor_kind', $1, true),
       set_config('app.audit_actor_id',   $2, true),
       set_config('app.audit_channel',    $3, true),
       set_config('app.audit_surface',    $4, true),
       set_config('app.audit_request_id', $5, true);
```

| Setting | Value |
|---|---|
| `app.audit_actor_kind` | an `actor_kind` from the list |
| `app.audit_actor_id` | the actor's UUID, in the canonical `8-4-4-4-12` hex form, when `actor_kind` is `worker`, `employer` or `admin`; `''` otherwise |
| `app.audit_channel` | a `channel` from the list |
| `app.audit_surface` | a `surface` matching the pattern |
| `app.audit_request_id` | a `request_id` matching the pattern, or `''` |

Each change record stores the context with a `context_status`:

- **`unset`:** all five settings are empty or were never set. Background
  jobs and ops scripts set nothing, so they are recorded under their login
  alone.
- **`set`:** every setting follows its rule above. The record carries
  `actor_kind`, `actor_id`, `channel`, `surface` and `request_id`.
- **`invalid`:** anything else, such as some settings set and others empty,
  or a value outside its rule. The record stores NULL in all five fields.

A missing or malformed context never fails the write being recorded.

## The change records (migration 111)

Statement-level triggers on every table in
`infra/db/access/audit-change-log.json` call `jale_audit.capture_change()`.
It is a definer owned by `jale_audit_owner`, and no role can execute it
directly. Every statement that changes a covered column leaves one row in
`jale_audit.changes`, written in the same transaction:

| Column | Value |
|---|---|
| `table_name` | `schema.table` |
| `operation` | `insert`, `update`, `delete` or `truncate` |
| `row_count` | the rows whose covered columns changed; 0 for a truncate |
| `changed_fields` | the covered columns that changed, in the file's order |
| `record_ids` | the keys of those rows; `[]` for a table whose rows have no single id; NULL above 100 and for a truncate |
| `subject_user_ids` | the users those rows name, from both versions of an updated row; `[]` for `admin_users`; NULL above 100 and for a truncate |
| `actor_kind`, `actor_id`, `channel`, `surface`, `request_id`, `context_status` | the context above |
| `db_login`, `db_pid`, `xact`, `occurred_at` | the column defaults: `db_login` is the login (`session_user`), never the function owner |

What counts as a change:

- **Insert:** a covered column that holds a value. **Delete:** one that held
  a value. **Update:** one whose text form differs between a row's old and
  new versions. Rows pair on the primary key. A row whose key changed is
  compared with no row, so every covered column it holds a value in counts.
- **No record** when nothing covered changed: an update of other columns, an
  update to the same values, a statement that touched no rows, or an upsert
  that changed nothing.
- **An upsert** leaves a record for what it did to each row: an insert, or an
  update.
- **A truncate** leaves one record naming every covered column, with
  `row_count` 0 and no ids.
- **A move to another user:** where a login may update a row's subject
  column (`admin_cases`, `subscriptions`, `worker_posts` and
  `worker_profile_media`), that column is covered, so a statement that only
  moves a row to another user leaves a record naming both users. Where the
  key is or includes the subject, a key change already counts.
- **A foreign-key cascade** leaves one record for the rows it removed or
  changed in the outer statement, under the same login and context. For
  example, an employer deleting jobs records the removal of their
  applications under the employer.

The covered tables. The file also lists every other column of these tables
with the reason it is left out, and the tables left out entirely:

| Table | Key | Subjects | Covered columns |
|---|---|---|---|
| `public.admin_cases` | `id` | `user_id`, `employer_id` | `case_type`, `status`, `priority`, `user_id`, `conversation_id`, `job_id`, `employer_id`, `assigned_admin_id`, `summary`, `details` |
| `public.admin_users` | `id` | none | `cognito_sub`, `admin_email`, `role`, `active` |
| `public.billing_customers` | `user_id` | `user_id` | `provider`, `provider_customer_id`, `organization_id` |
| `public.document_upload_tokens` | none | `worker_id` | `token_hash`, `job_id`, `used` |
| `public.employer_profiles` | `user_id` | `user_id` | `company_name`, `contact_name`, `phone`, `city`, `service_area`, `hiring_trades`, `typical_job_types`, `company_size`, `company_description` |
| `public.job_applications` | `id` | `worker_id` | `application_answers`, `prompt_answers` |
| `public.subscriptions` | `id` | `user_id` | `user_id`, `provider_subscription_id`, `organization_id` |
| `public.users` | `id` | `id` | `cognito_sub`, `user_type`, `email`, `phone`, `full_name`, `whatsapp_number` |
| `public.worker_application_defaults` | `worker_id` | `worker_id` | `answers` |
| `public.worker_documents` | `id` | `worker_id` | `job_id`, `doc_type`, `s3_key`, `file_name`, `file_size`, `mime_type`, `s3_version_id`, `cert_name` |
| `public.worker_post_media` | `id` | `worker_id` | `post_id`, `s3_key`, `s3_version_id`, `sort_order`, `content_type`, `file_size`, `moderation_status` |
| `public.worker_posts` | `id` | `worker_id` | `worker_id`, `caption`, `source`, `status` |
| `public.worker_preferred_cities` | none | `user_id` | `city_key`, `city`, `state`, `latitude`, `longitude` |
| `public.worker_profile_media` | `id` | `user_id` | `user_id`, `media_type`, `s3_key`, `twilio_media_sid`, `content_type` |
| `public.worker_profiles` | `user_id` | `user_id` | `full_name`, `phone`, `availability`, `years_experience`, `location`, `bio`, `latitude`, `longitude`, `location_source`, `location_confidence`, `experience_months`, `certifications` |
| `public.worker_skills` | none | `worker_id` | `skill` |

## The access history view (migration 109)

| Function | Callers | Returns |
|---|---|---|
| `jale_audit.history_search(p_actor jsonb, p_filter jsonb, p_limit integer, p_before timestamptz)` | `jale_admin_console` | `TABLE(...)`, the columns below |
| `jale_audit.reveal_count(p_days integer)` | `jale_admin_console` | `bigint` |

**`history_search` arguments:**

- `p_actor`, the signed-in admin from the server-side session:
  `{ actor_id, actor_role, actor_session?, request_id? }`.
  - `actor_id` is the `admin_users.id`, required.
  - `actor_role` is required and must be `admin_superadmin`; any other role
    is refused with `42501`. The page checks the role first and records the
    refusal as an attempt.
  - Any other key is `22023`.
- `p_filter`: `{ subject_user_id?, actor_id?, record_id?, from?, to?, category?, outcome? }`.
  Every key is optional, and any other key is `22023`.
  - `subject_user_id` (UUID): events and change records whose
    `subject_user_ids` contain it. Legacy rows name a target, not a
    subject, so they never match.
  - `actor_id` (UUID): events and change records by that actor, plus legacy
    rows that hold that admin's id, and legacy rows that hold no admin id
    whose `actor_email` is that admin's email (compared case-insensitively).
  - `record_id` (UUID): events and change records whose `record_ids` contain
    it, plus legacy rows whose `target_id` is it.
  - `from` (inclusive) and `to` (exclusive): instants.
  - `category`: from the list. Only events carry categories.
  - `outcome`: any event outcome. Only events carry outcomes.
- `p_limit`: 1 to 200 rows; anything else is `22023`.
- `p_before`: NULL for the first page. For the next page, pass the last
  row's `occurred_at` with its microseconds (for example, select
  `to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
  next to the row; a JavaScript `Date` keeps milliseconds only); only rows
  strictly older are returned.
- **Ties.** A full page also carries every further row whose `occurred_at`
  equals its last row's, so it can hold more than `p_limit` rows, but only by
  such ties. Paging with `p_before` therefore never skips or repeats a row.

**`history_search` rows**, newest first: `occurred_at DESC`, then `source`,
then `seq DESC`, then `entry_id`.

| Column | `event` rows | `change` rows | `legacy` rows |
|---|---|---|---|
| `source` | `event` | `change` | `legacy` (the dashboard's frozen `admin_audit_log`) |
| `seq` | `events.seq` | `changes.seq` | `admin_audit_log.seq` (110) |
| `entry_id` | `event_id` | `event_id` | `admin_audit_log.id` |
| `occurred_at` | yes | yes | `created_at` |
| `kind`, `outcome` | yes | NULL | NULL |
| `actor_kind`, `actor_id` | yes | from the context, or NULL | `admin` (`platform` for a `system` row), `actor_admin_id` |
| `actor_role` | yes | NULL | `actor_role` |
| `actor_session` | yes | NULL | NULL |
| `actor_email` | the admin's email, for admin actors | the admin's email, for admin actors | `actor_email` |
| `channel`, `surface`, `request_id` | yes | from the context, or NULL | NULL |
| `categories`, `subject_user_ids`, `record_type`, `record_ids`, `result_count`, `field_names`, `purpose_kind`, `purpose_id`, `link_expires_at`, `part`, `parts` | yes | `subject_user_ids` and `record_ids` only | NULL |
| `reason` | the reveal reason | NULL | the justification, with value-shaped spans removed |
| `table_name`, `operation`, `row_count`, `changed_fields`, `context_status` | NULL | yes | NULL |
| `action`, `target_type`, `target_id`, `summary`, `pii_reveal` | NULL | NULL | yes; `summary` is the neutral summary |
| `db_login`, `db_pid` | yes | yes | NULL |

**Its own read event.** After it has computed the page, and before it
returns any row, `history_search` records one event in the caller's
transaction:

- `kind = read`, `outcome = allowed`;
- the actor from `p_actor`, with `channel = admin` and
  `surface = admin.access_history`;
- `categories = [audit_history]`, `purpose_kind = audit_review`;
- `subject_user_ids` is `[subject_user_id]` when that filter is set, and
  empty otherwise;
- `result_count` is the number of rows returned.

A call therefore never returns its own event; the next matching call does.
The page commits before it renders (`withAdminReadTransaction`), so the
event and the read commit together.

**`reveal_count(p_days)`** counts the contact reveals of the last `p_days`
days, where `p_days` is between 1 and 400 (`22023` otherwise). A reveal is a
`read` event with `purpose_kind = reveal`, or a legacy row with
`pii_reveal = true`. It returns the count only.

## The guard (migrations 109 and 110)

`jale_audit.reject_change()` is bound to every `jale_audit` table and to
`public.admin_audit_log`: `BEFORE UPDATE OR DELETE` for each row, and
`BEFORE TRUNCATE`. It refuses every change with `55000`, except three narrow
paths, each opened by a transaction-local flag that one owner-run function
sets around its own statement:

| Flag | Function | What it allows |
|---|---|---|
| `jale_audit.purge` | `purge_expired` | Delete an `events`, `changes` or `admin_audit_log` row that is older than 13 months, below its stream's watermark, and either never held or already exported after its release. |
| `jale_audit.redact` | `redact_and_release` | Set an event's `reason` to `[redacted]`, with every other column unchanged. |
| `jale_audit.export` | `export_commit` | Move a stream's watermark forward in `export_state`. |

`TRUNCATE` is always refused. The runtime logins hold no `UPDATE` or
`DELETE` right on any audit table, so a flag they set opens nothing.

## The dashboard's action records (migration 110)

`public.admin_audit_log` is frozen: the new code writes `jale_audit.events`
only, and the previous dashboard keeps working on it.

- Owner `jale_audit_owner`. The admin console keeps `SELECT` and `INSERT`.
- Every record, old and new, carries the output of one transform,
  `jale_audit.scrub_legacy_metadata`:
  - `note` is removed;
  - `summary` is `<role> requested <action> for <target type>.`, built from
    those columns only;
  - in `justification`, phone numbers, email addresses and links become
    `[removed]`;
  - counts and flags are kept (for example `revokedCount`); any other text,
    list or object is dropped;
  - metadata that is not a JSON object, or is NULL, becomes the summary
    alone.
- An insert trigger applies the transform and stamps `xact`; it never makes
  an insert fail.
- `xact` and `seq` make the records the export stream `admin_actions_legacy`.

## Export (migration 109; the export job's login `jale_job_audit_export` only)

Three streams: `events`, `changes` and `admin_actions_legacy`. A stream's
watermark is an `xid8`: every row whose `xact` is below it is in a committed
window.

| Function | Returns | What it does |
|---|---|---|
| `export_window(p_stream text)` | `TABLE(from_xact xid8, to_xact xid8, prev_digest bytea)` | `from_xact` is the watermark; `to_xact` is `pg_snapshot_xmin(pg_current_snapshot())`, so every transaction below it has finished and a late commit lands in a later window, never in none. `prev_digest` is the stream's last digest, NULL before its first object. |
| `export_rows(p_stream text, p_from xid8, p_to xid8, p_after_seq bigint, p_limit integer)` | `TABLE(seq bigint, line text)` | One page of the window's rows with `xact` in `[p_from, p_to)` and `seq > p_after_seq`, in `seq` order. `p_limit` 1 to 10000. `p_to` may not pass the current snapshot's xmin. |
| `export_commit(p_stream text, p_from xid8, p_to xid8, p_row_count integer, p_seq_min bigint, p_seq_max bigint, p_digest bytea, p_object_key text, p_held_seqs bigint[])` | `bigint`, the batch | Recomputes the window without the held rows and records it only when the count, the seq range and the digest match; records the holds; moves the watermark to `p_to`. `55000` when `p_from` is not the watermark (a replay, or a second run). For a window with no row left, pass `p_row_count = 0`, NULL seqs, NULL digest and NULL key. When `p_from = p_to` it commits nothing and returns NULL. |
| `export_released(p_stream text, p_limit integer)` | `TABLE(seq bigint, line text)` | Released rows not yet exported, in `seq` order, for a release batch. |
| `export_commit_release(p_stream text, p_seqs bigint[], p_digest bytea, p_object_key text)` | `bigint`, the batch | Records a release batch: every seq must be released and not yet exported, and the digest must chain after the stream's last batch. |
| `compare_window(p_stream text, p_from xid8, p_to xid8, p_held_seqs bigint[] DEFAULT NULL)` | `TABLE(row_count integer, lines_sha256 bytea)` | Recomputes a window from the current rows, leaving out the rows held at that window's commit and any `p_held_seqs` (for a window written but not committed, on the retry path). |
| `purge_expired(p_batch integer)` | `TABLE(stream text, deleted integer)` | Deletes up to `p_batch` (1 to 10000) rows per stream that are past 13 months, below the watermark, and never held or already exported. |
| `export_backlog(p_stream text)` | `TABLE(pending_rows bigint, oldest_pending_at timestamptz)` | The rows at or above the stream's watermark that the caller's snapshot sees, and the oldest one's time (`occurred_at`, or `created_at` for `admin_actions_legacy`): rows committed behind an older open transaction count, since no window can reach them until it ends. `0` and NULL for an idle stream; `55000` when the stream has no export state; `22023` for an unknown stream. |

- **Lines.** Each line is one JSON object with a fixed key order (the
  table's columns, in order; `admin_actions_legacy` lines carry the table's
  columns except `actor_email`; `actor_admin_id` is the stored id, so a
  legacy line holds no email address and never changes once written. A
  record stored without an id gets it from `legacy_admin_id`: the one admin
  account whose email matches its stored email case-insensitively, else
  NULL; migration 110 fills the existing records that way once, and the
  insert trigger fills each new one), times as UTC `YYYY-MM-DDTHH24:MI:SS.US` followed by `Z`, and
  `xact` as a string. The output does not depend on the session's time zone
  or date style.
- **Objects and digests.** An object's bytes are its lines in `seq` order,
  each in UTF-8 and followed by `\n`. `digest = sha256(prev_digest ||
  sha256(object bytes))`, where `prev_digest` is empty for a stream's first
  object. `lines_sha256` from `compare_window` is `sha256(object bytes)`.
- **Object keys** match `db/<stream>/.../<name>.jsonl.gz` (letters, digits,
  `=`, `_`, `-` and `.` in each part).
- Every refusal other than the watermark is `22023`, naming the argument.

## Holds and redaction (migrations 109 and 112; `jale_admin` only, a supervised operation)

| Function | Returns | What it does |
|---|---|---|
| `list_holds()` (112) | `TABLE(stream text, seq bigint, occurred_at timestamptz, surface text, held_at timestamptz, pattern_kind text)` | Every held row nobody has released, by stream and seq: the row's time and surface (NULL for a dashboard record, and for a change record written without a context), when it was held, and the kind of value its free text holds. A held row that no longer exists is listed with a NULL time and kind `none`. `pattern_kind`: `url`, `email`, `phone`, `several` (more than one kind) or `none`. An event's `reason` and a dashboard record's metadata are read for the kind and never returned; a change record has no free text (`none`). No subject is returned. |
| `release_hold(p_stream text, p_seq bigint)` | `bigint` | Releases a held row as it is; the next release batch exports it. |
| `redact_and_release(p_stream text, p_seq bigint)` | `bigint` | `events` only: sets the held event's `reason` to `[redacted]`, then releases it. |

`release_hold` and `redact_and_release` refuse a row that is not held, or
already released, with `22023`. The kind comes from
`jale_audit.value_span_kind(text)`, the audit owner's own helper, which
applies the value-span patterns of `redact_value_spans` (migration 110) in
the same order, so it names exactly what that redaction removes.

## Posture checks (`infra/db/access/posture-audit.ts`)

The daily posture run includes four audit checks. Each one reads system
catalogs only:

- `audit_guard_trigger`: every `jale_audit` table, and
  `public.admin_audit_log`, carries its guard triggers (and the dashboard
  records their scrub trigger), enabled (`tgenabled = 'O'`).
- `audit_change_trigger`: every covered table carries its four change-record
  triggers, enabled, with the file's arguments. No other table carries one.
- `audit_table_grants`: no role but the owner holds a privilege on a
  `jale_audit` relation or column.
- `person_login_privileges`: no personal operator login holds a table,
  column or sequence privilege.

## Operator functions (migration 112; `jale_ops`)

Each is a definer owned by `jale_ops_owner` with `search_path = pg_catalog,
pg_temp`, closed to PUBLIC, executable by the operator group
`jale_ops_readonly`. The two audit count functions are also executable by
`jale_admin`, for the release checks that run before any personal login
exists. They return identifiers, codes, times and counts only: never a name,
a contact value, message text, an answer, a score or error text. A function
given a user nobody holds returns no rows.

| Function | Returns | What it does |
|---|---|---|
| `find_user(p_kind text, p_value text)` | `uuid` | The `users.id` for one lookup value, or NULL when none matches. `p_kind`: `email` (case does not matter), `phone` or `whatsapp` (only the digits count, 7 to 15 of them), `cognito_sub`. Pass the value as a bound parameter. `22023` for an unknown kind or a value that is NULL, blank or over 320 characters; `21000` when more than one user matches (the message gives the count). No message echoes the kind or the value. |
| `user_status(p_user_id uuid)` | `TABLE(user_id uuid, user_type text, tenant_id uuid, has_email boolean, has_phone boolean, has_whatsapp boolean, whatsapp_linked_at timestamptz, tos_version text, tos_accepted_at timestamptz, privacy_version text, privacy_accepted_at timestamptz, created_at timestamptz, updated_at timestamptz)` | One user's account codes and times; contact values only as presence flags. |
| `onboarding_status(p_user_id uuid)` | `TABLE(source text, record_id uuid, run_id uuid, status text, step_key text, to_step_key text, attempts integer, created_at timestamptz, changed_at timestamptz, completed_at timestamptz, expires_at timestamptz, locked_until timestamptz)` | One worker's onboarding, a row per record, in this order: `onboarding_state` (status = lifecycle, `changed_at` = its last change, `completed_at` = ready), `workflow_run` (status, current step), `workflow_transition` (the newest 100; `run_id`, from and to steps), `identity_challenge` (challenges naming the user as candidate or verified: status, step, attempts, expiry, lock). A column a source does not have is NULL. |
| `trust_assessment_status(p_user_id uuid)` | `TABLE(assessment_id uuid, profession_key text, status text, rubric_version text, scoring_model_id text, created_at timestamptz, scored_at timestamptz)` | One worker's assessments, newest first. No score, component, rationale or answer. |
| `outbox_status(p_user_id uuid)` | `TABLE(source text, record_id uuid, kind text, service text, status text, attempts integer, priority integer, outbox_id uuid, created_at timestamptz, updated_at timestamptz, next_attempt_at timestamptz, expires_at timestamptz)` | One worker's domain events (`domain_event`: kind = event type) and message intents (`message_intent`: kind = category, service = owner service, the outbox row it became), newest 200. No payload, key or error text. |
| `delivery_status(p_user_id uuid)` | `TABLE(channel text, record_id uuid, kind text, status text, provider_status text, provider_error_code text, attempts integer, created_at timestamptz, sent_at timestamptz, status_updated_at timestamptz, next_attempt_at timestamptz)` | One user's deliveries, newest 200: `whatsapp` (messages to the user's WhatsApp number; kind = source type, `reply` for a reply to an inbound message; the provider's delivery status and numeric error code), `job_message` (kind = send kind), `email` (to the user's address, any case; kind = source type). No body, template, provider message id or error text. |
| `migration_ledger()` | `TABLE(filename text, applied_at timestamptz, checksum text, applied_by text)` | The migration ledger in file order; no rows where the ledger does not exist. |
| `audit_export_status()` | `TABLE(stream text, watermark xid8, watermark_at timestamptz, unexported_rows bigint, batches bigint, last_batch_at timestamptz, last_batch_rows integer, held_rows bigint, released_pending bigint)` | Per stream: the watermark and when it moved, the rows at or above it, the batches and the newest one, the held rows not yet exported, and how many of those are released and waiting for a release batch. `jale_admin` may run it. |
| `audit_event_counts(p_since timestamptz)` | `TABLE(kind text, outcome text, surface text, events bigint)` | Access events since `p_since`, counted per kind, outcome and surface. `22023` when `p_since` is NULL. `jale_admin` may run it. |

The owner reads exactly the columns these functions use, through one
`SELECT` policy of its own per table with row security. The migration ledger
is granted only where it exists. The two audit functions call
`jale_audit.export_status()` and `jale_audit.event_counts(timestamptz)`,
count-only definers owned by `jale_audit_owner` and executable by
`jale_ops_owner` alone, so no role but the audit owner reads an audit table.

## Personal operator logins (migration 112; a separable unit)

Invoker procedures in `jale_ops`, owned by `jale_ops_owner`, closed to
PUBLIC, executable by `jale_admin` only. They run with the master's own
rights. Nothing else in migration 112 depends on them.

| Procedure | What it does |
|---|---|
| `provision_person(p_handle text, p_verifier text, p_valid_days integer)` | Creates `jale_person_<p_handle>`: `LOGIN`, `CONNECTION LIMIT 2`, `VALID UNTIL` now plus `p_valid_days`, the verifier as its password, `GRANT jale_ops_readonly ... WITH INHERIT TRUE, SET FALSE`, `default_transaction_read_only = on`, `statement_timeout = '30s'`, and `pgaudit.log = 'all'` when the pgaudit extension is installed. It belongs to nothing else, owns nothing and holds no table, column or sequence privilege. `42710` when the login exists. |
| `renew_person(p_handle text, p_verifier text, p_valid_days integer)` | Sets a new verifier and expiry, and sets the limit and settings again. `42704` when the login does not exist; `22023` when it no longer has the operator shape (an elevated attribute, or a membership other than the operator group) — remove it instead. |
| `remove_person(p_handle text)` | Drops the login with its membership and settings. A session still open loses the operator group at once; the notice gives the number of such sessions. `42704` when the login does not exist. |

- `p_handle`: `^[a-z][a-z0-9]{1,15}$`.
- `p_verifier`: a SCRAM-SHA-256 verifier the person computed from their own
  password, `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`,
  with at least 4096 iterations, a base64 salt and two 32-byte base64 keys.
  PostgreSQL stores it as given; the password never reaches the database.
- `p_valid_days`: 1 to 90.
- A malformed argument is `22023`. No message or notice names the verifier
  or any rejected input; the notice names the login and its expiry (UTC).
