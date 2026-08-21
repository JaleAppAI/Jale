# WhatsApp Application-Fill Flow — Design

**Date:** 2026-08-19
**Author:** Ivan (design brainstormed and six-agent-reviewed with Claude)
**Status:** Draft for review

## 1. Summary

When a worker accepts a job on WhatsApp, the bot collects the job's required
application data in-chat: it walks `jobs.required_fields` asking one question
per key (writing `job_applications.application_answers` incrementally), then
walks `jobs.required_docs` collecting document uploads into `worker_documents`
for that job. Employers request documents implicitly through the per-job
requirements picker (sprint18); requirement additions made after workers have
applied re-trigger collection for the new gaps only (Stage 2).

This is the "future incremental answers-fill flow" that
`infra/lambda/lib/applications.ts` and migration 073 explicitly anticipate.

**Scope split:** this spec yields two implementation plans. **Plan 1 (this
week): the core fill flow** — §4–§9 and §11–§14. **Plan 2 (follow-on):
Stage 2** — §10, including its outbox migration and drain; §10 is
non-normative for Plan 1. Without Stage 2, requirements widened after a
worker completes collection are picked up only when the worker re-accepts
the job (§9).

## 2. What already exists (verified)

- **Apply flow:** `applyWorkerToJob` (`infra/lambda/lib/applications.ts`),
  called from `processor.ts` (`handleJobAction`) on the job-alert button
  payload `accept:job-<uuid>` or typed indexed action ("1 aceptar"). Today it
  bounces with `missing_documents` before any INSERT when required docs are
  absent, and (WhatsApp surface only) skips the answers gate, storing `{}`.
- **Requirements schema:** `jobs.required_fields` (11-key closed CHECK
  allowlist, migration 073) and `jobs.required_docs` (CHECK: resume,
  driver_license, ssn [legacy-only], work_auth_doc, certification_doc).
  Three-state Off/Optional/Required tiers (074). The WhatsApp bot collects
  **required** tiers only; optional tiers stay web-only.
- **Answers validator:** `infra/lambda/lib/application-answers.ts` — the
  single authoritative per-key shape spec. Per-key validators exist for all
  11 keys (`FIELD_VALIDATORS`).
- **Documents:** `worker_documents` (005/007/075). The old
  `(worker_id, job_id, doc_type)` unique constraint was **dropped in 007**;
  partial unique indexes replaced it, and 075 excludes `certification_doc`
  from both (multi-file certs, max 5 per slot via an RLS-scoped trigger).
  Column-arbiter `ON CONFLICT` upserts are impossible for
  `certification_doc` (no unique index covers it), and the pre-075 arbiter
  no longer matches for any type; the web flow uses DELETE-then-INSERT for
  all doc types (`worker-doc-confirm.ts`).
- **Grants already held by `jale_whatsapp`:** SELECT on jobs; SELECT+INSERT
  on job_applications (004); UPDATE (application_answers, updated_at) on
  job_applications (073) with the `jobapp_whatsapp_update` RLS policy (028);
  SELECT+INSERT on worker_documents (021). Worker-scoped RLS policies on
  worker_documents (005/018) key on `app.current_internal_user_id` and are
  not role-scoped — the existing DELETE policy (018) covers our new DELETE
  grant with no policy changes.
- **DB guard:** migration 022 adds a BEFORE INSERT trigger on
  job_applications raising 23514 (`job_applications_required_docs_check`)
  when required docs are missing — independent of the app-level bounce.
- **Media pipeline:** `lib/media.ts` handles photo/voice only; uploads to the
  WhatsApp MEDIA bucket with hardcoded `ServerSideEncryption: 'AES256'`.
  Documents live in `DOCUMENTS_BUCKET` (SSE-KMS, versioned,
  `documents-stack.ts`), key scheme
  `documents/${job_id}/${worker_id}/${doc_type}/${uuid}.${ext}`.
- **Turn mechanics:** per-phone FIFO SQS (batchSize 1, visibility 360s,
  60s lambda timeout); one transaction per turn with a `FOR UPDATE` lock on
  the conversation row; idempotency via the `whatsapp_processed_messages`
  claim (rollback releases the claim; commit + redelivery resumes outbox
  only). Ordered multi-reply per inbound SID via outbox `sequence`.
- **State:** `conversation_state` is force-written to `'idle'` on every
  ready-worker turn (`processor.ts` writeback); only `state_context`
  (free-form JSONB) survives. All fill state must live in `state_context`.

## 3. Decision log

| Decision | Choice |
|---|---|
| Scope | Full flow: fields Q&A + doc uploads |
| Trigger | Apply time ("accept"); employer requests = requirements picker; Stage 2 covers post-apply requirement additions |
| Application row | Created upfront at accept, filled incrementally; visible to employer mid-fill (accepted) |
| Sensitive docs | All doc types via WhatsApp except `ssn` (legacy-only, uncollectable → web-handoff message) |
| Complex fields | Free text → Bedrock Haiku extraction → confirmation; per-entry for arrays |
| Voice answers | Out of scope this week (re-ask as text); extraction path is transcript-compatible for later |
| State model | Approach A: progress derived from DB every turn; minimal `state_context` keys; no new ConversationState values |
| Employer re-request | Job-level requirement edits re-trigger fill (Stage 2); no per-applicant request UI |

## 4. Architecture

### 4.1 Module: `infra/lambda/whatsapp/lib/application-fill.ts`

Deps-injected (RouterDeps pattern from `conversation-router.ts`), unit-testable
without processor mocks. Bedrock enters via injected deps (no module-level
mock exists in `processor.test.ts`; tests stub the dep).

- `computeNextStep(client, applicationId)` — diffs
  `jobs.required_fields` (in array order) against `application_answers` keys,
  then `jobs.required_docs` (in array order) against `worker_documents`
  presence for `(worker_id, job_id IS NULL OR job_id = $job)` — the same
  predicate as `missingRequiredDocuments`. Returns
  `{kind:'field',key} | {kind:'doc',docType} |
  {kind:'exit', reason:'job_inactive'|'application_gone'|'application_closed'} |
  {kind:'complete'}`, plus an `uncollectable: docType[]` list on every
  result. Lifecycle exits (§9) surface as `kind:'exit'`. Uncollectable doc
  types (exactly `{ssn}` today; the mechanism exists so future uncollectable
  types slot in) are **excluded from the walk and from the completion gate**
  ("complete" = no missing **collectable** items) — they are never a step
  (which would re-derive forever); instead the web-handoff note is appended
  to the intro message and repeated in the completion message (and Stage 2's
  re-arm prompt), so it is delivered at defined moments, not per turn.
- `handleFillMessage(...)` — the fill-lane dispatcher (§6).
- Prompts live in `infra/lambda/whatsapp/lib/application-fill-prompts.ts`,
  a dedicated bilingual module keyed 1:1 to the validator's field list so a
  missing prompt is a compile error — the onboarding `prompts.ts` precedent,
  not more keys in the already-large `templates.ts`.

### 4.2 State (`state_context` additions)

- `fill_application_id` — the active fill's application id. Single authority
  for which application is being filled. Set at fill entry (clearing
  `pending_picker` and `fill_pending`); switched (with ack) when a new accept
  arrives mid-fill; cleared on completion, CANCELAR, and lifecycle exits.
- `fill_pending: { key, extracted, entries? }` — outstanding
  confirmation/entry-loop state for the current key. **Kept** across
  sanctioned interruptions — escapes, picker resolutions, and the relay
  override — which re-echo the outstanding confirmation afterwards.
  **Scrubbed on exactly:** confirm, discard ("2"/no), anchor switch,
  CANCELAR, completion, lifecycle exit (§9). §6 uses this same list; the two
  must stay identical. It transiently holds extracted PII (§11).
- `fill_relay_override: true` — one-turn flag set when the worker picks an
  employer chat (CHATS pick or `conversation:focus` button) mid-fill; the
  next free-text inbound relays to the employer, then the flag clears and
  the fill re-prompts.

`conversation_state` stays `'idle'`. All `state_context` writes spread the
existing object (the `updateConversation` JSONB replace requires it).

### 4.3 Writes

- **Answers:** single-key validation
  `validateApplicationAnswers([key], [], {[key]: value})`; store
  `validated.value[key]` (the trimmed rebuilt value, never raw extraction)
  via `UPDATE job_applications SET application_answers =
  application_answers || $1::jsonb, updated_at = now()` under
  `setInternalUserRlsContext(workerId)` inside the turn transaction.
  Last-write-wins vs concurrent web writes of the same key (accepted, tested).
  A per-key size cap is enforced at extraction time, before merge (the
  validator's 16KB cap is per-call; incremental merges could otherwise grow
  the column unboundedly).
- **Documents:** Twilio download (Content-Length precheck, then 10MB cap —
  web-policy parity, not the 16MB transport cap) → magic-byte sniff against
  {pdf, jpeg, png} → put to `DOCUMENTS_BUCKET` via a **document-specific put**
  (never `uploadMediaToS3`, whose AES256 header breaks the KMS bucket) under
  the web key scheme, capturing the response `VersionId` → DELETE-then-INSERT
  `worker_documents` (plain INSERT for `certification_doc`), with
  server-synthesized `file_name`, `file_size`, `mime_type`, `s3_version_id`
  → `copyRequiredDocumentSnapshots`. The per-doc INSERT + snapshot copy run
  inside a **SAVEPOINT**; 23514 is discriminated by
  `err.constraint === 'certification_document_limit'` (the 022 guard shares
  the SQLSTATE) and mapped to the friendly cap message + advance (correct:
  the cap firing means 5 rows already satisfy the requirement — but only
  under a set RLS GUC, which the fill guarantees); 23505 on non-cert doc
  types maps like the web's handler (concurrent-web race,
  **first-write-wins** — the standing row already satisfies the requirement;
  treat as satisfied and advance);
  any other error rolls back to the savepoint and rethrows.
  Invariant: S3 put precedes the DB write; the `worker_documents` row is the
  sole source of truth; orphaned KMS objects from rolled-back turns are
  tolerated (same gap as the web flow; each retry mints a new UUID key).
- **Bedrock:** at most one call per turn, `requestTimeout` 10s,
  `maxAttempts: 1`, so failure always lands in the catch path (an unbounded
  hang would kill the lambda mid-transaction and silently redeliver). The
  call runs inside the turn transaction (precedent: Twilio media downloads);
  the FIFO/visibility math (60s/360s) leaves ample headroom.

## 5. Migration 077 + infra changes

- `GRANT DELETE ON worker_documents TO jale_whatsapp;` (SELECT/INSERT exist
  since 021; the 018 worker-scoped DELETE RLS policy already applies; no
  UPDATE grant — the write pattern is DELETE-then-INSERT).
- Amend the 022 trigger: skip when the session GUC
  `app.allow_incomplete_docs` is set. `applyWorkerToJob` issues the
  `SET LOCAL` immediately before the INSERT when `surface === 'whatsapp'`
  (scoped to the turn transaction); the trigger keeps firing for every other
  writer. If the guard still fires (GUC bug), `applyWorkerToJob` catches
  23514 with `err.constraint === 'job_applications_required_docs_check'` and
  returns an error status; the processor replies with a generic error and
  the turn **commits** — never silent success, never a poison-message
  rollback loop.
- 073-style self-verification DO-blocks for both changes.
- Register in `scripts/run-migrations.sh` + `run-migrations.ps1` manifests
  and the `apply-order.test.ts` baseline (last entry today: 076).
- App-level: `applyWorkerToJob` skips the `missingRequiredDocuments`
  pre-check for `surface === 'whatsapp'` (mirroring the answers-gate bypass);
  all other surfaces unchanged. The whatsapp accept call stays answer-less.
- CDK: pass the documents bucket + KMS key into `WhatsAppStack`
  (`documentsBucket.grantPut(processor)` adds `kms:GenerateDataKey`), new
  `DOCUMENTS_BUCKET` env on the processor. Watch stack instantiation order
  in `bin/jale-app.ts` (WhatsAppStack currently instantiates before
  DocumentsStack) — reorder or import by ARN; do not create a cycle through
  the shared RestApi.

## 6. Fill-lane dispatch (per turn, when `fill_application_id` is set)

Order inside the fill lane; existing upstream stages (onboarding-v2 handoff,
legal gates, button/list payloads) keep top priority and are unchanged.

1. **Media first** (before any text parsing — captioned photos must not leak
   their caption to the text parser): if the current step is a doc, process
   the first attachment (audio content types still get the existing
   please-type reply); `NumMedia > 1` → take the first, reply "one file at a
   time"; if the current step is a field → "we'll get to documents next".
2. **CANCELAR guard** (before extraction): aborts the fill only — clears
   `fill_application_id` + `fill_pending`, confirms with resume
   instructions: re-accept the job to continue (e.g. "responde '1 aceptar'
   al empleo o toca el boton del empleo para continuar") — after CANCELAR
   the fill is disarmed, so plain messages do not resume it; a *stalled*
   fill (no CANCELAR) stays armed and any inbound re-prompts. **No** website
   promise — no web resume path exists today (§13). Verified >1 edit distance from every
   fuzzy-matched command; a unit test locks this. External checklist:
   confirm Twilio Advanced Opt-Out is off (or that STOP/ALTO never reach the
   webhook — in which case they are platform opt-outs, not fill aborts).
3. **Escape keywords** pass through to their existing handlers, then the
   dispatch tail re-prompts: typed job actions, CHATS/CERRAR, help/support/
   profile commands (sanctioned escapes). The jobs escape uses an
   **exact-match** variant mid-fill (`isJobsKeyword`'s prefix grammar would
   eat answers like "trabajo de pintor 5 años"). Exception: while
   `fill_pending` awaits Sí/No, "1 si"/"2 no"/bare "si"/"no" are consumed as
   confirmation **before** the typed-job-action grammar (which would map
   "1 si" to accepting `recent_jobs[0]`).
4. **Picker precedence:** if an escape re-armed `pending_picker`, the picker
   (always the most recently asked question) wins the next bare digit;
   `fill_pending` is **kept**, and after the picker resolves the fill
   re-echoes the outstanding confirmation (or re-asks the current question).
   At fill entry `pending_picker` is cleared.
5. **Relay override:** if `fill_relay_override` is set, free text relays to
   the focused employer thread, the flag clears, and the fill re-prompts
   (`fill_pending`, if any, is **kept** and re-echoed) — workers can
   interleave chatting with the employer and filling. Without the flag, free
   text while a question is pending feeds the fill; with nothing pending,
   relay behavior is unchanged.
6. **`fill_pending` resolution:** "1"/sí → validate + merge + next prompt;
   "2"/no → discard, re-ask with a format hint. Any other text re-echoes the
   confirmation (defined behavior; never silently re-extracts).
7. **Field step:** deterministic keys parse inline; complex keys extract
   (§7). Parse/extraction failure → re-prompt with per-key hint, nothing
   written. **Doc step, free text:** text that isn't an escape or CANCELAR
   re-sends the document prompt (cooldown-guarded) — text is never
   interpreted at a doc step.
8. **New accept mid-fill** (handled in `handleJobAction`, reachable via
   button and typed paths): switch `fill_application_id`, scrub
   `fill_pending`, ack ("Job B first — we'll come back to Job A"), prompt
   job B's first step. **On `complete`:** send the bilingual completion
   confirmation from the prompts module (including the web-handoff note when
   `uncollectable` is non-empty), clear fill state, then query worker-wide
   for other applications with missing collectable items (most recently
   updated first) and offer at most one:
   "1. Continuar aplicacion de <job>".
9. **Dispatch tail:** if the turn ends with the fill armed and no fill prompt
   queued, queue the re-prompt, guarded by a 30s reprompt cooldown (reuse
   the `REPROMPT_COOLDOWN_MS` constant from `onboarding-language.ts` —
   onboarding-scoped today, so import or lift it). This replaces any "detect
   interleaved messages" state — the rule is simply: always re-derive,
   always re-prompt when silent.

Entry point: `handleJobAction(accept)` result `applied` **or**
`already_applied` with missing collectable items (one extra SELECT computes
the gaps and the intro's counts; grants cover it). The intro replaces (not
duplicates) the current `job_accepted` template for jobs with requirements:
"Para completar tu aplicacion faltan N preguntas y M documentos." Ack text
folds into the next question in a single message wherever possible.

## 7. Field collection

- **Deterministic keys** (no LLM extraction): booleans
  (work_authorization) as numbered options, no confirmation step;
  `desired_pay` via forgiving regex → `{amount, interval}`, no confirmation
  step, echoed normalized in the next prompt;
  dates (`date_of_birth`, `date_available`) prompted with an explicit
  format and **confirmed via the `fill_pending` mechanism, echoed in
  unambiguous long form** ("3 de abril de 1990 — 1. Si 2. No") — dates get
  the cheap confirm because MM/DD vs DD/MM ambiguity is real for US-based
  workers and the validator requires ISO.
- **Extraction keys** (`home_address`, `emergency_contact`,
  `worked_here_before`, `education`, `military_service`, `references`,
  `work_history`): one open question → Haiku extraction with per-field
  confidence scores → if **any required subfield** scores below the
  threshold (the env-overridable `AI_EXTRACTION_CONFIDENCE_THRESHOLD`
  pattern, default 0.75 — voice-onboarding precedent), skip the echo and
  re-ask the whole key with a format hint; otherwise echo a localized
  summary (mirroring `format-application-answers.ts` display shapes) +
  "1. Si / 2. No".
- **Array keys** (`references`, `work_history`; validator caps 3 entries)
  collect **per entry**: "Cuentame de tu trabajo mas reciente" → extract →
  confirm entry → "Tienes otro? 1. Si 2. No" (also bounds each extraction
  blob). Entry prompts note that only company + title are required for
  work_history entries. The deterministic-vs-extraction bucketing above is
  **normative** (all 11 keys, each exactly once); only per-key prompt
  wording is pinned in the implementation plan from
  `application-answers.ts` shapes.
- Unlimited retries; required keys cannot be skipped, but the worker can
  abandon anytime (CANCELAR or silence) and resume by messaging again.

## 8. Document collection

Per-doc prompt names the document and the accepted formats in a full
sentence ("Envia tu licencia de conducir como foto (JPG/PNG) o PDF, maximo
10MB"). The current step defines `doc_type` — no classification. One
accepted file advances non-cert steps; `certification_doc` loops "Tienes
otro certificado? 1. Si 2. No" (bounded by the 5-slot cap, whose overflow
maps to a friendly message + advance). Type/size/sniff failures reply with
full-sentence errors naming problem + formats + next action; the step stays
pending; recovery is the worker resending (a new message SID — redelivery
of a failed turn never re-downloads, per the claim semantics).

## 9. Lifecycle rules (checked by `computeNextStep` every turn)

- Job `active`/`paused` and application `pending`/`contacted`/`talking` →
  continue. (The canonical application enum since migration 023 is
  `pending, contacted, talking, hired, not_interested` —
  `job-fields.ts` `APPLICATION_STATUSES`; `reviewed`/`rejected` survive only
  as legacy API response aliases. `contacted`/`talking` continue because an
  employer actively engaging a worker is exactly when missing items matter.)
- Job `filled`/`closed`, job deleted (application row CASCADE-vanishes while
  `fill_application_id` dangles — detected as "application gone"), or
  application `hired`/`not_interested` → inform the worker appropriately,
  scrub fill state, disarm.
- A `fill_pending` whose key is no longer required (employer edited the
  picker) → discard silently and re-derive.
- Requirements added mid-fill are picked up automatically by the diff.
- Without Stage 2, requirements widened **after** completion are collected
  only when the worker re-accepts the job (`already_applied` entry).

## 10. Stage 2 — employer requests documents after workers applied

*(Non-normative for Plan 1 — this section is its own implementation plan.)*

Employer edits the job's requirements picker (the only request mechanism;
the doc-type allowlist is closed — there is no free-form "send me your X").
When `employer-jobs-update` widens `required_fields`/`required_docs`, it
enqueues a `requirements_changed` event via the domain-outbox pattern
(043-style transport — the employer API role cannot write WhatsApp tables
directly). A WhatsApp drain consumes it: for each applicant of that job with
missing collectable items, re-arm `fill_application_id` on their
conversation; if the worker's 24h session window is open (common — they are
often mid-chat with the employer through the relay), send "Este empleo ahora
pide: … — N preguntas/M documentos" and the first prompt; otherwise arm
silently and the worker's next inbound (e.g. their next chat reply)
triggers it. Previously-complete applicants are only asked for the new gaps
(derive-from-DB). Proactive out-of-window nudges require a Meta-approved
template — follow-up list, same class as the employer-messaging template.
Stage 2 is separable: the core flow ships without it.

## 11. PII, logging, extraction safety

- Logging is metadata-only: answer **key names**, validation outcomes,
  reason codes, char counts. Never message bodies, Bedrock prompts/responses,
  or extracted values. Sentinel PII guard test (2e1c05b pattern,
  `onboarding-v2-voice.test.ts` precedent).
- `validateApplicationAnswers` is the **only** gate between Bedrock output
  and the DB (key allowlist, proto-key rejection, bounded strings, fresh
  object rebuild). Echo-back confirmation is UX, not a control.
- Raw message text is never persisted. Extracted values persist only in
  `fill_pending` until confirm or lane exit (scrub inventory in §4.2/§9);
  precedent exists (`ProfileStateContext.collected`), but the scrub is
  mandatory. No reuse of `worker_profile_ai_extractions`; no new audit
  table — the validated answer is the record.
- Bedrock model-invocation logging must remain off (or scrubbed) for this
  model — the prompts contain PII.
- Follow-up (not this week): tighten the `surface === 'whatsapp'`
  unvalidated-answers bypass in `applyWorkerToJob` once this flow is the
  only WhatsApp answers writer (the code comment already demands it).

## 12. Error handling summary

| Failure | Behavior |
|---|---|
| Bedrock timeout/error | Caught (bounded client); "no te entendi" re-prompt; nothing written |
| Extraction fails validator / low confidence | Re-prompt with per-key hint; never stored |
| Media type/size/sniff failure | Full-sentence localized error; step pending; worker resends |
| Twilio download failure | Caught → commit + error reply; recovery = resend (claim semantics make redelivery outbox-only) |
| Cert cap (23514 + `certification_document_limit`) | SAVEPOINT rollback, friendly cap message, advance |
| 022 guard 23514 (GUC bug) | Caught in `applyWorkerToJob` (constraint-name match) → error status → generic error reply; turn commits |
| Non-cert 23505 (web race) | Map like web handler; first-write-wins — treat requirement as satisfied, advance |
| Other SQLSTATE | Rethrow → turn rollback → claim released |
| Merged-answers oversize | Prevented by per-key extraction caps; backstop pre-UPDATE check logs the key and asks for a shorter answer — step stays pending |
| Outbox send failure | Existing retry/delivery-status machinery, unchanged |

## 13. Explicitly out of scope / follow-ups

- Voice-note answers (pipeline is transcript-compatible; revisit — this
  population is voice-first and work_history typing is the hardest ask).
- Web resume of a WhatsApp-started application (today the web form hides
  once the row exists and re-apply 409s — no copy may promise it).
- Meta-approved re-engagement template for out-of-window nudges.
- Per-applicant document requests from the employer chat UI.
- Optional-tier collection via bot.
- Malware scanning (parity: the web flow has none either; consider
  `Content-Disposition: attachment` on employer PDF downloads).
- Global STOP/opt-out semantics (distinct from CANCELAR).

## 14. Testing

- **Unit — application-fill.ts** (deps-injected): `computeNextStep` matrix
  (order, web-uploaded-doc skip, handoff, complete, lifecycle exits);
  per-key parsers; dispatch precedence (media-first, CANCELAR, "1 si"
  confirmation vs typed action, picker precedence, relay override, exact
  jobs match); anchor switching; scrub-on-exit paths; CANCELAR
  fuzzy-distance lock against `COMMAND_KEYWORDS` (verified: min
  Damerau-Levenshtein distance 5, vs `cerrar`/`saltar`; `support`/`soporte`
  are exact-match only and not fuzzy candidates).
- **Unit — media/doc put:** document category detection, magic-byte sniff,
  10MB, KMS put params, VersionId capture (mocked S3).
- **Unit — prompts:** en/es parity keyed to the validator field list
  (templates.test.ts `test.each` precedent).
- **Unit — migrations:** 077 in both runner manifests + apply-order
  baseline; self-verification blocks.
- **DB integration** (register in `infra/scripts/run-whatsapp-v2-db-tests.sh`
  **and** its lock test `run-whatsapp-v2-db-tests.test.ts`; bump the
  runner's schema-header comment): jale_whatsapp DELETE-then-INSERT under
  `setInternalUserRlsContext`; answers merge under the column grant; 022
  GUC bypass on/off; 075 cap interplay (including the RLS-scoped COUNT
  caveat and the snapshot-copy savepoint).
- **Processor-level** (Bedrock stubbed via injected deps): happy path;
  already_applied resume; full interruption matrix (jobs exact-match,
  relay override, new accept, captioned photo, NumMedia>1, voice note,
  CANCELAR, help/profile escapes); lifecycle matrix (job closed/deleted,
  application hired/rejected, de-required key); redelivery idempotency (no
  double merge/doc row); concurrent web upload race.
- **PII sentinel test:** no log call contains message body or extracted
  values.

## 15. Amendments (2026-08-20, post-merge of main's job-flow redesign)

- Migration renumbering: main took 077–079, so this spec's "077" is
  **`080_whatsapp_application_fill.sql`**; the cert-cap error mapping must
  match the `CERTIFICATION_DOCUMENT_LIMIT_CONSTRAINTS` set (078 added a
  second per-cert-name cap), and `worker_documents` writes must account for
  078's `cert_name` column.
- **Defaults seeding (Ivan's decision):** main's 079 created
  `worker_application_defaults` (per-worker saved answers). At fill-arm time
  the bot seeds `application_answers` from the worker's validated defaults
  for the job's relevant keys (never overwriting existing answers; invalid
  defaults are skipped and asked instead), so workers are not re-asked what
  they already saved. A new migration **081** grants `jale_whatsapp` SELECT
  on the table (079's header anticipates it). Write-back of chat-collected
  answers INTO defaults is deferred (follow-up list).

## 16. External checklist (not code)

- Confirm Twilio Advanced Opt-Out setting for the WhatsApp sender
  (does STOP/ALTO reach the webhook?).
- Confirm Bedrock model-invocation logging is off for the extraction model.
- Kick off Meta template approval for the re-engagement nudge (long lead
  time) if Stage 2's proactive path is wanted.
