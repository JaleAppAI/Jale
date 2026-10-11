# Capability function signatures (`jale_cap`)

Migration 105 creates these functions. They are the only way a request or job
path reaches the tables its dedicated login holds no rights on. Every function:

- is `SECURITY DEFINER` with `search_path = pg_catalog, pg_temp`, and names every
  object schema-qualified;
- is closed to PUBLIC and executable only by the caller login listed here (the
  caller also holds `USAGE` on `jale_cap`);
- is owned by a NOLOGIN owner role that holds only what its functions need;
- re-checks its own authorisation in SQL and never trusts an identity it can
  derive.

`infra/db/access/manifest.json` is the machine-readable form of this page (key
`functions`). `test/unit/db/least-privilege-cap-functions.integration.test.ts`
proves each signature, owner and grant on a real database.

## Conventions

- **Outcome codes, not exceptions.** Where a call can be refused for a reason
  the endpoint answers with a 4xx today, the function returns an `outcome`
  column whose value is `ok` or the endpoint's existing error code. The
  transaction stays usable.
- **Exceptions** are reserved for programming errors and authorisation
  failures that cannot happen on a correct path: an unset caller context
  (SQLSTATE `42501`), a malformed argument (`22023`), a source that does not
  belong to the caller, or a worker who is not one of the caller's applicants
  (`42501`).
- **Caller context.** The employer functions read the caller from
  `app.current_internal_user_id` (the employer's `users.id`), set
  transaction-locally with `setInternalUserRlsContext` in the same transaction.
  An unset or empty value raises `42501`.
- **Token hashes.** The upload functions take `p_token_hash`: the lower-case hex
  SHA-256 of the raw token, exactly as the handlers compute it today. The raw
  token never reaches the database.

## Upload tokens (owner `jale_cap_upload_tokens`)

| Function | Caller | Returns |
|---|---|---|
| `upload_token_issue(p_token_hash text, p_job_id uuid, p_worker_id uuid)` | `jale_api` | `TABLE(outcome text, expires_at timestamptz)` |
| `upload_token_resolve(p_token_hash text, p_doc_type text, p_mime_type text)` | `jale_api_public` | `TABLE(outcome text, s3_key text)` |
| `upload_token_slot(p_token_hash text, p_doc_type text, p_s3_key text, p_mime_type text)` | `jale_api_public` | `TABLE(outcome text, max_file_size integer)` |
| `upload_token_confirm(p_token_hash text, p_doc_type text, p_s3_key text, p_mime_type text, p_file_name text, p_file_size integer, p_s3_version_id text, p_cert_name text)` | `jale_api_public` | `TABLE(outcome text, document_id uuid)` |
| `upload_token_submit(p_token_hash text)` | `jale_api_public` | `TABLE(outcome text)` |

- **issue** replaces the token insert in `employer-upload-token.ts`. It reads
  the caller from `app.current_internal_user_id`, the employer's `users.id`.
  Today that handler sets only `app.current_user_id` (the sub, through
  `setRlsContext`), so it must also resolve the employer's `users.id` and set
  it with `setInternalUserRlsContext` in the same transaction before calling.
  The function re-checks that the caller owns `p_job_id` and that
  `p_worker_id` has an application for it, then stores the hash with a 7-day
  expiry set by the database. Outcomes: `ok`, `forbidden`.
- **resolve** is the database half of upload-url. It validates the token
  (unexpired, not yet submitted, application still present), the document type
  and the MIME type, then issues or re-issues the slot exactly as today (a
  confirmed slot is never re-issued). The object key is built in the database
  from the token's job and worker, the document type, a random UUID and the
  extension mapped from the MIME type, so a caller cannot choose another
  worker's prefix. The handler presigns the returned `s3_key`. Outcomes: `ok`,
  `invalid_token`, `document_already_confirmed`, `invalid_doc_type`,
  `invalid_mime_type`.
- **slot** is confirm's read-only pre-check, run before the object is
  inspected, so the existing status order holds (409 before the object checks).
  It returns the slot's `max_file_size` for the size check. Outcomes: `ok`,
  `invalid_or_confirmed_upload`.
- **confirm** is all of confirm's database work, atomically: it re-validates the
  token, the application and the unconfirmed slot bound to `p_s3_key` and
  `p_mime_type`, checks `p_file_size` against the slot, applies the
  certification caps, marks the slot confirmed with the version id, and
  inserts or replaces the worker's document under the token's worker. Any
  refusal leaves the slot unconfirmed. `p_file_size` and `p_s3_version_id` come
  from the handler's object check. Outcomes: `ok`, `invalid_or_confirmed_upload`,
  `invalid_file_size`, `certification_document_limit`,
  `certification_document_name_limit`, `document_conflict`.
- **submit** marks the token used once at least one slot is confirmed; a repeat
  submit is still `ok`, as today. Outcomes: `ok`, `invalid_token`,
  `confirm_required`.

## Worker lane (owner `jale_cap_worker_lane`)

| Function | Caller | Returns |
|---|---|---|
| `employer_worker_delivery_context(p_worker_id uuid)` | `jale_api` | `TABLE(lifecycle text, workflow_language text, whatsapp_language text)` |
| `employer_stage_recipient(p_application_id uuid)` | `jale_api` | `TABLE(worker_id uuid, language text, has_whatsapp_number boolean)` |
| `employer_claim_worker_intent(p_worker_id uuid, p_kind text, p_source_id uuid, p_payload jsonb, p_message jsonb)` | `jale_api` | `TABLE(intent_id uuid, decision_action text, decision_reason text, outbox_id uuid, outbox_materialized boolean)` |

- **delivery context** replaces the `whatsapp_conversations` join and the gate
  read on the employer messaging paths. It raises `42501` unless the caller has
  an applicant relationship with the worker. It returns one row:
  - `lifecycle`: `onboarding`, `ready` or `suspended`; NULL when the worker has
    no onboarding row yet (treat NULL as onboarding, as today);
  - `workflow_language`: the gate's language (active run first), defaulting to
    `es`;
  - `whatsapp_language`: the WhatsApp conversation's language, NULL when there
    is none.
  It locks the worker's onboarding row for the rest of the transaction, as the
  gate read does today.
- **stage recipient** replaces the recipient read the stage-notification renderer
  does. It raises `42501` unless the application is on one of the caller's
  jobs. `language` is the latest workflow run's language, defaulting to `es`;
  `has_whatsapp_number` is false when the worker has no usable number. That
  case stays non-fatal: render nothing and pass a NULL `p_message` to the claim.
- **claim** is the gateway's intent claim, gate, runtime-control read, delivery
  decision and authorised outbox insert, in one call.
  - `p_kind` is `employer_chat` (`p_source_id` = the employer's
    `job_conversation_messages.id`) or `application_stage` (`p_source_id` =
    `job_applications.id`).
  - The function derives from `p_kind` and the source: category, owner service,
    source type, priority, policy version, expiry (7 days) and the dedupe key.
    For `application_stage` the key carries the application's current status
    and `updated_at`, exactly as the handler builds it today.
  - `p_worker_id` must be one of the caller's applicants, the source must
    belong to the caller, and `p_worker_id` must equal the source's worker;
    otherwise it raises `42501` before it writes anything.
  - `p_payload` is stored on the intent, with its identifying fields (ids,
    kind, status) overwritten from the source.
  - `p_message` is the pre-rendered message, or NULL: `{"body": text}` or
    `{"content_template": text, "content_variables": object}`. It is used only
    when the decision is `allow` and no outbox row exists yet. The recipient
    number is always the worker's own, read in the database.
  - `decision_action`/`decision_reason` keep today's values: `allow/worker_ready`,
    `defer/worker_onboarding`, `defer/delivery_disabled`, `reject/worker_suspended`,
    `expire/intent_expired`, and for an existing terminal intent the same
    mapping the gateway uses (`leased`, `released`, `delivered` give
    `allow/worker_ready`; `expired` gives `expire/intent_expired`; `superseded`,
    `rejected` and `failed` give `reject/invalid_owner`). The decision is made
    on the database clock, with an expiry of `now() + 7 days`.
  - For `application_stage` the application's current status must be
    `details_requested` or `hired` (`22023` otherwise).
  - An `allow` with a NULL `p_message` (no recipient or no renderable copy)
    marks the intent `rejected` with reason `renderer_unavailable` and returns
    `reject/renderer_unavailable`; it never raises for this. Each caller keeps
    today's handling: the stage-notification path records the skip and
    commits, so the rejected intent persists as it does today; the employer
    chat path raises, so its transaction rolls back as it does today.
  - `outbox_materialized` is true only when this call inserted the outbox row.
    A repeat call never inserts a second one.

## Other capabilities

| Function | Caller | Owner | Returns |
|---|---|---|---|
| `resolve_share_link(p_code text)` | `jale_api` | `jale_cap_share_links` | `TABLE(job_id uuid, channel text, referrer_worker_id uuid, referrer_employer_id uuid)` |
| `apply_ses_feedback(p_ses_message_id text)` | `jale_job_ses_feedback` | `jale_cap_ses_feedback` | `TABLE(outcome text, source_type text, changed integer)` |
| `retention_purge(p_batch integer)` | `jale_job_retention` | `jale_cap_retention` | `TABLE(tokens_deleted integer, claims_deleted integer, opens_deleted integer)` |

- **resolve_share_link** returns the one active (unrevoked) link for the code,
  or no row for an unknown, malformed or revoked code. It cannot list links.
  The code must already be normalised (upper-case Crockford, 8 characters,
  the table's own format); the function does not normalise it.
- **apply_ses_feedback** looks up the outbox row by provider message id. Outcomes:
  `unknown_message` (no row), `not_digest` (with its `source_type`), `digest`
  (the digest was disabled for the employer; `changed` is the number of rows
  the disable changed).
- **retention_purge** deletes up to `p_batch` expired rows from each of the three
  referral tables, with today's age rules (apply tokens 7 days past
  `expires_at`; pending claims 30 days past `claimed_at`, or past `expires_at`
  when unclaimed; opens 400 days after `opened_at`), and returns the counts.
  Call it until every count is below `p_batch`. `p_batch` must be between 1 and
  5000 (`22023` otherwise). Its owner's DELETE and SELECT policies carry the
  same ages, so it can never remove a younger row.

## Re-owned definers (no signature change)

| Function | Caller | Owner | Returns |
|---|---|---|---|
| `jale_cap.list_stale_job_outbox_workers(p_min_age interval)` | `jale_whatsapp` | `jale_cap_stale_outbox` | `TABLE(worker_id uuid)` |
| `jale_cap.sync_job_hired_counts()` | trigger only | `jale_cap_hired_counts` | `trigger` |

- `public.list_stale_job_outbox_workers(interval)` keeps its name, signature,
  default (`5 minutes`) and caller (`jale_whatsapp`). It is now an invoker
  wrapper over `jale_cap.list_stale_job_outbox_workers`, whose owner reads only
  sendable outbox rows (`pending` or `failed`, fewer than 5 attempts) and their
  conversations, so discovery works without any caller context. The output is
  bounded: at most 500 workers per call, the oldest stale message first; the
  next sweep picks up the rest. A minimum age under 5 minutes (or NULL) raises
  `22023`.
- `sync_job_hired_counts()` stays the trigger function of
  `job_applications_hired_count_sync` (bound by OID). It moved to `jale_cap`,
  owned by `jale_cap_hired_counts`, which may read `job_applications (job_id,
  status)` and update `jobs (workers_hired, status)` and nothing else. The
  recount is the same for every writer: an employer request, a WhatsApp flow or
  any other login.

## Design notes

- `upload_token_issue` takes the token hash and creates no slots. Slots are
  issued at upload-URL time, and the raw token never leaves the handler.
- `upload_token_slot` lets confirm check its slot before it inspects the
  object, and `upload_token_confirm` checks it again atomically when it
  confirms. That keeps today's status order (409 before the object checks).
- `employer_claim_worker_intent` takes the source id and the pre-rendered
  message and derives everything else, so an intent is always bound to a
  source the caller owns, for one of the caller's applicants.
- A refusal the endpoint answers with a 4xx today comes back as an `outcome`
  code, so the caller's transaction stays usable. An unset caller context, a
  worker or source outside the caller's own (`42501`) and a malformed
  argument (`22023`) raise instead: the employer functions, and the upload
  functions' argument checks, never return an outcome for those.

## Job-messaging triggers (owner `jale_cap_job_messaging`, no caller)

- `jale_cap.job_conversation_application_guard()` (BEFORE INSERT, and UPDATE
  of `job_id`, `employer_id`, `worker_id`, `application_id`, on
  `job_conversations`): the application must be the named worker's
  application to the named job, and the job the named employer's; otherwise
  `23514`. Rows written before it are not re-validated.
- `jale_cap.job_message_outbox_recipient()` (BEFORE INSERT, and UPDATE of
  `conversation_id`, `whatsapp_number`, on `job_message_outbox`): for a row
  the request login writes, `whatsapp_number` becomes the conversation
  worker's number by the employer messaging rule (whatsapp_number, else
  phone, else the profile phone; trimmed, a `whatsapp:` prefix removed),
  whatever the statement supplied; no number raises `23514`. Rows the
  WhatsApp engine or the migration login write are left as written.
