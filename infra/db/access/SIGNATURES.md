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
| `employer_org_usage(p_lock boolean)` | `jale_api` | `jale_cap_org_limits` | `TABLE(organization_id uuid, active_jobs integer, templates integer, active_foremen integer, suspended_foremen integer, pending_invites integer)` |

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
- **employer_org_usage** answers for the caller's company (the caller is
  `app.current_internal_user_id` and must be an active member; `42501`
  otherwise): every member's active jobs, whatever their membership status,
  every member's templates, the active foremen, the billing-suspended foremen
  (`status = 'suspended'` with `billing_suspended_at` set; a suspension for
  any other reason is not counted) and the live pending invites (not
  accepted, revoked or expired). `pending_invites` is the last column, so a
  reader that names its columns is unaffected. With
  `p_lock = true` it first takes the company's `organizations` row
  `FOR NO KEY UPDATE`, held to the end of the caller's transaction: the lock
  the plan-limit gates and the billing enforcer serialise on (migration 128).
  Once the lock is held it checks the caller again, so a member a downgrade
  suspended while they waited is refused (`42501`).
  NO KEY UPDATE conflicts with itself but not with the `FOR KEY SHARE` of a
  foreign-key check, so an insert that names the company never waits for it.

## Team invites (owner `jale_cap_org_team`, migration 133)

| Function | Caller | Returns |
|---|---|---|
| `org_team_invite_create(p_email text, p_contact_name text, p_token_hash bytea, p_seat_limit integer)` | `jale_api` | `TABLE(outcome text, invite_id uuid, email text, contact_name text, created_at timestamp with time zone, expires_at timestamp with time zone, last_sent_at timestamp with time zone, company_name text, cognito_sub text)` |
| `org_team_invite_resend(p_invite_id uuid, p_token_hash bytea, p_seat_limit integer)` | `jale_api` | create's columns + `retry_after_seconds integer` |
| `org_team_invite_revoke(p_invite_id uuid)` | `jale_api` | `TABLE(outcome text, cognito_sub text)` |
| `org_team_invite_queue_email(p_invite_id uuid, p_subject text, p_body_text text, p_body_html text)` | `jale_api` | `uuid` (the outbox id) |
| `org_team_invite_lookup(p_token_hash bytea)` | `jale_api_public` | `TABLE(outcome text, company_name text, email text, contact_name text, existing_account boolean, expires_at timestamp with time zone)` |
| `org_team_invite_accept(p_token_hash bytea)` | `jale_api` | `TABLE(outcome text, organization_id uuid)` |
| `org_team_invite_accept_email()` | `jale_api` | `TABLE(outcome text, organization_id uuid)` |
| `org_team_invite_mail_purge(p_batch integer)` | `jale_billing` | `integer` (rows deleted) |
| `org_team_locked_owner_org()` | none (internal) | `uuid` |

- **Caller context.** create, resend, revoke and queue_email read the caller
  from `app.current_internal_user_id` and act only for the active owner of a
  company, through `org_team_locked_owner_org()`: it takes the company's
  `organizations` row `FOR NO KEY UPDATE` (128's lock, held to the end of the
  caller's transaction) and checks the owner again once it is held. Anyone
  else gets `not_owner` (queue_email raises `42501`). accept and accept_email
  read the caller by `app.current_user_id` (unset raises `42501`). The lookup
  and the purge read no caller.
- **No row locks.** After the company lock the functions read invites and
  memberships with plain reads and update only a row they classified, with a
  row count of 1 (`P0001` otherwise). Every writer of invites and memberships
  holds the company lock.
- **Outcomes.**
  create: `created`, `not_owner`, `invalid_email`, `already_member`,
  `email_in_use`, `invite_pending`, `rate_limited`, `seat_limit_reached`.
  resend: `resent`, `not_owner`, `not_found`, `closed`, `too_soon`,
  `rate_limited`, `email_in_use`, `already_member`, `seat_limit_reached`.
  revoke: `revoked`, `not_owner`, `not_found`, `closed`.
  lookup: `valid`, `not_found`, `expired`, `revoked`, `used`.
  accept: `accepted`, `rejoined`, `not_found`, `expired`, `revoked`, `used`,
  `not_employer`, `email_mismatch`, `already_member`.
  accept_email: `accepted`, `none`, `ambiguous`, `not_employer`,
  `already_member`.
- **Values.** An invite expires 7 days after it is created or re-sent. The
  email is `lower(btrim())`, at most 254 characters, one `@` and a dot after
  it. `contact_name` is trimmed, empty is NULL, at most 120 characters. The
  token hash is the 32-byte SHA-256 of the raw token (`22023` otherwise;
  accept and lookup answer `not_found`). `p_seat_limit` NULL or negative and
  `p_batch` outside 1..1000 raise `22023`.
- **Sends.** Every create and resend writes one `email_outbox` row through
  queue_email (`source_type = 'organization_invite'`, `source_id` the invite,
  idempotency key `org-invite:<id>:<first 8 bytes of the token hash, hex>`),
  which refuses (`42501`) an invite not created or re-sent in the caller's
  transaction. A company may send 20 in any 24 hours, an invite may be
  re-sent 5 times in any 24 hours (`rate_limited`), and not within 60 seconds
  of its last send (`too_soon`, with `retry_after_seconds`).
- **Seats.** Active foremen plus live pending invites (not accepted, revoked
  or expired) hold seats; a billing-suspended foreman holds none. create, and
  resend of an expired invite, give `seat_limit_reached` at the limit. An
  expired pending invite is revoked when a new one is created for its email.
- **Cognito.** `cognito_sub` is set only when a login's sign-in must change:
  create and resend return a removed member of the company invited by email
  (enable); revoke returns that member of the company (disable). No other
  live invite of the company for that email can remain (one pending invite
  per company and email), and another company's invite never re-enables
  the login (create and resend answer it `email_in_use`).
- **accept** re-reads the invite by its token after the lock, so a token a
  resend rotated meanwhile is `not_found`. A closed invite is `used`,
  `revoked` or `expired` before the caller's email is compared.
- **accept and accept_email** answer `already_member` when a concurrent
  accept in another company, or a start-company, for the same login commits
  first (a `23505` on `organization_members_pkey`, caught around the members
  insert); any other unique violation is raised.
- **mail_purge** deletes invite mail a day old that the sender will no
  longer retry (108's terms), oldest first, up to `p_batch`, and returns the
  count.

## Team members (owner `jale_cap_org_team`, migration 134)

| Function | Caller | Returns |
|---|---|---|
| `org_team_remove_member(p_user_id uuid)` | `jale_api` | `TABLE(outcome text, cognito_sub text)` |
| `org_team_members()` | `jale_api` | `TABLE(user_id uuid, email text, display_name text, role text, status text, billing_suspended boolean, joined_at timestamp with time zone, status_changed_at timestamp with time zone, active_jobs integer, open_jobs integer)` |
| `org_team_invites()` | `jale_api` | `TABLE(invite_id uuid, email text, contact_name text, created_at timestamp with time zone, expires_at timestamp with time zone, last_sent_at timestamp with time zone, expired boolean)` |
| `org_team_membership()` | `jale_api` | `TABLE(user_id uuid, organization_id uuid, role text, status text, company_name text, has_live_invite boolean)` |
| `org_member_access(p_organization_id uuid DEFAULT NULL, p_since timestamp with time zone DEFAULT NULL, p_limit integer DEFAULT NULL)` | `jale_billing` | `TABLE(user_id uuid, cognito_sub text, enabled boolean, changed_at timestamp with time zone)` |

- **Caller context.** remove_member, members and invites read the caller
  from `app.current_internal_user_id` and act only for the company's active
  owner. remove_member takes the company lock through 133's
  `org_team_locked_owner_org()` (anyone else gets `not_owner`); members and
  invites only read, without the lock, and raise `42501` (`org_team: the
  caller is not the active owner`) for anyone else. membership reads the
  caller by `app.current_user_id` (unset raises `42501`). member_access reads
  no caller: jale_billing names the company or the time window.
- **No row locks.** remove_member reads the member plainly after the company
  lock and updates only the row it classified, with a row count of 1
  (`P0001` otherwise).
- **remove_member outcomes:** `removed`, `not_owner`, `not_found` (no
  member of the caller's company by that id), `is_owner`, `already_removed`,
  `has_jobs` (any job, whatever its status, still names the member). It moves
  no job: remove-with-reassign moves them first, in the same transaction and
  under the same company lock. `removed` sets `status = 'removed'`, clears
  `billing_suspended_at` and stamps `status_changed_at`, and returns the
  member's `cognito_sub` for the handler to disable.
- **members** lists the company's active and suspended members, the owner
  first, then by `joined_at`. A removed member is never returned (their email
  stays out of the owner's reach; a re-invite shows under invites). `display_name` is the member's own
  trimmed `employer_profiles.contact_name`, else their trimmed
  `users.full_name`, else their email. `billing_suspended` is
  `billing_suspended_at IS NOT NULL`; `active_jobs` counts jobs `active`,
  `open_jobs` jobs `active` or `paused`.
- **invites** lists the company's pending invites (not accepted or revoked),
  expired ones included with `expired = expires_at <= now()`, newest first.
  The token hash is never returned.
- **membership** returns the caller's own membership row in any status (zero
  rows for a login with none, or a non-employer login), with `company_name =
  employer_display_name(<the company's active owner>)` and `has_live_invite`
  (a live invite of that company names the caller's `lower(btrim(email))`).
- **member_access** lists foremen only, never owners. `enabled` is `status =
  'active'`, or `status = 'removed'` with a live invite of the same company
  to the member's `lower(btrim(email))`. `changed_at` is the latest of
  `status_changed_at` and, over that company's invites for the email,
  `created_at`, `last_sent_at`, `revoked_at` and `expires_at` once passed.
  Exactly one key: `p_organization_id` (every foreman of the company,
  `p_limit` NULL) or `p_since` (foremen with `changed_at > p_since`, ordered
  `changed_at DESC, user_id`, with `p_limit` required in 1..1000). Anything
  else raises `22023`. Both forms are ordered the same way. The invites are
  read through `organization_invites_by_org_email (organization_id, email)`,
  which 134 adds.

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
