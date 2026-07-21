# WhatsApp V2 Claude Workflow Lane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the WhatsApp v2 conversation workflow — OTP-only identity binding, the
authoritative onboarding command gate, the profile/trade/trust path to readiness, and the
bilingual rendering surface — on top of the merged canonical foundation from the Codex
integration lane.

**Architecture:** `onboarding-v2.ts` is a step router over canonical shared types and functions
imported directly from the integration lane. The lane owns exactly three things the integration
lane does not: the workflow-specific external adapters (identity, location, trust questions), the
deterministic bilingual renderers for every message category and release request kind, and the
step machine itself. All worker-directed sends — onboarding prompts included — flow through
`enqueueWorkerMessage`.

**Tech Stack:** TypeScript 5.9, Node.js Lambda, Jest 30 + ts-jest, `pg` `PoolClient`, PostgreSQL
16, Twilio WhatsApp content templates, Cognito CUSTOM_AUTH, Bedrock (via adapter only).

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-21-whatsapp-onboarding-gate-design.md` and
  `docs/superpowers/plans/2026-07-21-whatsapp-onboarding-gate.md`. Read both before editing.
- Successful OTP verification is the only identity-binding operation.
- Only the delivery gateway may create sendable worker WhatsApp outbox rows. This lane never
  calls `queueOutboxText`, `queueText`, `queueInteractivePrompt`, or inserts `whatsapp_outbox`
  rows directly — including for onboarding and security prompts.
- AI assessment must never block the `ready` lifecycle.
- Do not drop or rename legacy WhatsApp columns; do not switch non-allowlisted workers to v2.
- Never duplicate a canonical shared type or re-declare a canonical function signature. Import it.
- Do not add LocalStack, a cloud sandbox, trade-change UI, or an admin dashboard.
- Preserve optional photo/voice enrichment; never make it a v2 readiness requirement.
- Keep untracked `demo-ready-windows/` and `reports/` untouched.
- Task agents work in disposable worktrees branched from `feat/wa-v2-workflow`. They never edit
  `.worktrees/wa-v2-integration`.
- Stop before push, deployment, RDS migration, or worker reset.

## Binding Cross-Lane Resolutions

These resolutions were produced by the independent Claude/Codex plan comparison and supersede any conflicting task prose below.

1. **Pre-OTP persistence:** no `worker_workflow_runs` row exists before verified OTP because `user_id` remains required. Migration `042` extends `worker_identity_challenges` with `provider_challenge_id`, `preferred_language`, `current_step_key` restricted to `start.choose_language | identity.verify_otp`, and `context`; `expires_at` is nullable until a provider challenge is issued. Start cooldown history, language choice, resend state, candidate lookup, and OTP attempts live there. A phone lookup may populate `candidate_user_id` but never `verified_user_id`, `whatsapp_conversations.user_id`, lifecycle, or a workflow run.
2. **Verified binding boundary:** C4 provides exact phone-hash pre-auth repository operations plus `bindVerifiedIdentityAndStartWorkflow(...)`. Only that function, called after the identity adapter returns `verified`, marks the challenge verified, binds the conversation, creates `worker_onboarding_state`, creates the one active user-bound run at `legal.review`, and appends the OTP-success transition in the caller's existing transaction.
3. **Workflow persistence contract:** C4 also provides `advanceWorkflow(...)` with an `expectedLockVersion` guard, context patch, and transition metadata, in addition to `loadWorkerGate`, `appendTransition`, and `completeOnboarding`. This lane uses those functions rather than lane-local SQL for new v2 tables.
4. **Atomic final answer:** Task 5 persists trust answer three with its profile/trust adapter and then calls `completeOnboarding` on the same `PoolClient` inside the same existing processor transaction. A rollback reverses the answer, lifecycle/run/transition changes, and both domain events.
5. **One ready confirmation:** Task 5 does not enqueue a ready confirmation. Codex C6's `worker.ready` release group emits the sole onboarding-complete confirmation first.
6. **Renderer contracts:** Codex C2 owns `CategoryRenderer`, `ReleaseRenderRequest`, `ReleaseRenderedMessage`, and `ReleaseRenderer` as shared types. Task 3 implements and registers onboarding/security renderers matching the exact async `(client, input)` category contract; parameterized DB reads for recipient/language are allowed, but no network, clock, enqueue, or send. Task 3 also implements `createReleaseRenderer()` from the C2 shared release contract for C6.
7. **Terminal states:** `declined` and `completed` are workflow-run statuses, never step keys. A declined run retains `legal.review`; a completed run retains `trust.question.3` while its status becomes terminal.
8. **Processor gate:** Task 6 includes a FIFO-shaped SQS record. Once DB controls select v2, dependency/router failure rolls back and retries; it never falls through to legacy.
9. **Observability ownership:** Codex C7 installs `WhatsAppOtpLock` on the processor log group. Generator fallback is a sanitized diagnostic event without a new alarm.
10. **Bootstrap and task mapping:** Codex C2 owns types, runtime controls, policy, and renderer contracts; C3 owns migration `042`; C4 owns repository/gateway primitives. Every task in this lane, including Task 1, begins only after C2-C4 are reviewed, merged into this branch, and the PostgreSQL `042` gate passes.

---
## Canonical Values (copy verbatim; never re-derive)

| Constant | Value |
| --- | --- |
| OTP expiry | 5 minutes |
| OTP wrong-attempt lock | 3 attempts → 15-minute lock |
| OTP resend cooldown | 60 seconds |
| OTP sends per phone per hour | 3 |
| Start template cooldown | 1 per normalized phone per 10 minutes |
| Start templates per phone / 24h | 5 |
| Invalid-answer reprompt cooldown | 30 seconds |
| Name length | 2–100 characters |
| Standard trades | `electrician`, `plumber`, `carpenter`, `concrete`, `painting`, `other` |
| Required trust answers | 3 |
| Job-alert intent expiry | 72 hours |
| Employer-chat intent expiry | 7 days |
| Job-alert digest cap | 10 |
| Workflow step keys | `start.choose_language`, `identity.verify_otp`, `legal.review`, `profile.name`, `profile.location`, `profile.trade`, `profile.custom_trade`, `trust.question.1`, `trust.question.2`, `trust.question.3` |

---

## Bootstrap Barrier (blocking, precedes Tasks 2–7)

No workflow implementation begins until every barrier condition below is true. There is no pre-barrier task exception; Task 1 starts only after the shared bootstrap is present and verified.

Barrier conditions:

1. Codex **C2** (canonical `lib/onboarding-types.ts`, `lib/runtime-controls.ts`, `lib/delivery-policy.ts`, and shared renderer contracts), **C3** (`042_whatsapp_onboarding_gate.sql`), and **C4** (`lib/onboarding-repository.ts` and `lib/worker-delivery-gateway.ts`) are reviewed and merged into `feat/wa-v2-workflow`.
2. Migration `042_whatsapp_onboarding_gate.sql` is present on this branch.
3. The PostgreSQL 042 gate is green on this branch:

```bash
bash /home/hermesgoma/.codex/skills/psql-migration-testbed/scripts/run-psql-migration-testbed.sh \
  --repo . -- \
  bash -lc 'cd infra && JALE_TEST_DATABASE_URL="$JALE_TEST_DATABASE_URL" npx jest test/unit/db/migrations.test.ts test/unit/db/migrations/apply-order.test.ts test/unit/db/whatsapp-onboarding-042.integration.test.ts --runInBand'
```

Expected: migrations `001`–`042` apply on PostgreSQL 16 and all three suites pass.

4. `cd infra && npm run build` succeeds on the merged branch.

**Barrier confirmation step (do this once, before Task 2).** The orchestrator records the exact
canonical export names and signatures by reading the merged files — not by guessing:

```bash
cd infra
grep -nE "^export (type|interface|const|function|async function)" \
  lambda/whatsapp/lib/onboarding-types.ts \
  lambda/whatsapp/lib/runtime-controls.ts \
  lambda/whatsapp/lib/delivery-policy.ts \
  lambda/whatsapp/lib/onboarding-repository.ts \
  lambda/whatsapp/lib/worker-delivery-gateway.ts
```

The names this plan relies on are listed in "Canonical Imports" below. If any name or signature
differs from what this plan assumes, that is a cross-lane interface change: stop, propose the
correction against both canonical documents, and get both orchestrators to sign off before Task 2
starts. Do not adapt by re-declaring the type locally.

---

## Canonical Imports (owned by Codex; imported, never redefined)

| Symbol | Source | Used by |
| --- | --- | --- |
| `WorkerLifecycle`, `WorkflowStepKey`, `MessageCategory`, `WorkerMessageIntentInput`, `DeliveryDecision`, workflow run / transition / context types | `lib/onboarding-types.ts` (C2) | Tasks 2–7 |
| `loadRuntimeControls(client)`, `hashNormalizedPhone(phone)`, `isV2Enabled(controls, phoneHash)`, `evaluateDelivery(input, now)` | `lib/runtime-controls.ts` / `lib/delivery-policy.ts` (C2) | Task 6 and gateway |
| C4 `PreAuthState`, `loadPreAuthStateForUpdate`, `savePreAuthState`, `bindVerifiedIdentityAndStartWorkflow`, `loadWorkerGate`, `advanceWorkflow`, `appendTransition`, `completeOnboarding` | `lib/onboarding-repository.ts` (C4) | Tasks 4–7 |
| `enqueueWorkerMessage(client, input, now?) → { intentId, decision }` | `lib/worker-delivery-gateway.ts` (C4) | Tasks 3–7 |
| `CategoryRenderer`, `ReleaseRenderRequest`, `ReleaseRenderedMessage`, `ReleaseRenderer` | `lib/onboarding-types.ts` (C2) | Tasks 3–7 and Codex C6 |

The lane declares **one** local interface, `OnboardingV2Adapters`, holding only workflow adapters with no canonical owner (Task 2). Everything else is imported.
adapters that have no canonical owner (Task 2). Everything else is imported.

---

## Lane Ownership

### Owns (creates / modifies)

- `infra/lambda/whatsapp/lib/conversation-router.ts` — relay gating only
- `infra/lambda/whatsapp/lib/onboarding-adapters.ts` — identity / location / trust-question adapters
- `infra/lambda/whatsapp/lib/onboarding-language.ts` — pure language + cooldown policy
- `infra/lambda/whatsapp/lib/onboarding-renderers.ts` — category renderers + `createReleaseRenderer`
- `infra/lambda/whatsapp/lib/templates.ts`, `lib/interactive-templates.ts` — additive v2 copy
- `infra/lambda/whatsapp/onboarding-v2.ts` — the step router
- `infra/lambda/whatsapp/processor.ts` — v2 branch and relay call sites only
- `infra/test/helpers/whatsapp-v2-harness.ts` and the test files listed per task

### Does not own

| Artifact | Owner | Relationship |
| --- | --- | --- |
| Migration `042` | Codex C3 | Barrier dependency; referenced by table/column name only, never re-declared |
| `lib/onboarding-types.ts` | Codex C2 | Imported |
| `lib/runtime-controls.ts`, `lib/delivery-policy.ts` | Codex C2 | Imported |
| `lib/onboarding-repository.ts`, `lib/worker-delivery-gateway.ts` | Codex C4 | Imported |
| Release handler `worker-ready-release.ts`, its lease / ordering / grouping | Codex C6 | Consumes this lane's `ReleaseRenderer` |
| Log filters, alarms, metric wiring | Codex C7 | Consumes this lane's sanitized metric events |
| `isTwilioMessageSid` (`SM`/`MM`), `lib/twilio.ts`, `lib/outbox.ts`, `status-callback.ts` | Codex | Untouched |
| `webhook.ts`, FIFO/DLQ, `lib/stacks/**` | Codex | Untouched |
| `job-alert.ts`, `lambda/lib/job-messaging.ts`, `lambda/api/employer-conversations-*.ts` | Codex | Untouched |
| Reset tooling, PostgreSQL integration suites, rollout runbook | Codex C10 | Untouched |
| `handleSupportCommand` phone fallback (`processor.ts:975`) | Deliberate no-change | Support cases are not worker-directed business messages; `create_admin_support_case` re-checks the relationship server-side. Out of scope. |

---

## Task Sequencing

```
        ══════ BOOTSTRAP BARRIER ══════

Task 1 (relay/Manuel, independent) ───────────────────────────────────────────────┐
Task 2 (adapters) ─┐                                                            │
                   ├─→ Task 4 → Task 5 → Task 6 → Task 7                         │
Task 3 (renderers)─┘                                                            │
```

Tasks 2 and 3 are independent of each other and may run in parallel worktrees. Task 4 depends on
both. **Task 5 branches off Task 4's post-fix state** — they modify the same file and must not run
concurrently.

Each task ends with one Review 1 → one fix round (`SendMessage` to the same agent) → Review 2.
Review 2 findings are patched by the orchestrator or reported; there is never a second feedback
round.

---

### Task 1: Pre-OTP Relay Prevention and the Manuel Regression

*Runs after the bootstrap barrier. It has no additional canonical dependency.*

**Files:**
- Modify: `lambda/whatsapp/lib/conversation-router.ts` — `tryConversationRelay` (:151),
  `handleEmployerConversationButton` (:232), `handleEmployerConversationTextAction` (:332),
  `handlePickerResponse` (:591)
- Modify: `lambda/whatsapp/processor.ts:1052-1057` — picker pre-check
- Test: `test/unit/lambda/whatsapp/lib/conversation-router.test.ts`,
  `test/unit/lambda/whatsapp/processor.test.ts`

**Interfaces:** consumes existing `ConversationRow` / `IncomingMessage` / `RouterDeps`; produces
the invariant *an unbound session (`conv.user_id === null`) can never relay, focus, pick, or
trigger a legal prompt*.

**Exclusions:** do not touch `lib/twilio.ts`, `lib/outbox.ts`, `status-callback.ts`, the `SM`/`MM`
validator, or `handleSupportCommand`. Keep `resolveWorkerIdForWhatsappNumber` exported — its own
tests at `conversation-router.test.ts:36-62` must stay green; only its use as an identity fallback
in relay paths is removed.

- [ ] **Step 1: Invert the test that encodes the defect.** Replace the `it` block at
  `conversation-router.test.ts:217` (`relays for the 'new' state via phone resolution…`) with one
  asserting: unbound `new` state → `tryConversationRelay` returns `null`,
  `recordWorkerConversationReply` not called, `mockQuery` never called at all (the guard returns
  before the resolver), and no `updateConversation` call carries `user_id` or `conversation_state`.

- [ ] **Step 2: Add the Manuel regression describe block.** Fixture: `awaiting_otp`,
  `user_id: null`, `state_context.cognito_session` set, phone that *would* resolve to a worker.
  Assertions:
  - free text → returns `null`, `recordWorkerConversationReply` not called
  - `CHATS` → returns `null`, `deps.queueLegalPrompt` **not** called
  - no SQL executed matches `/job_conversation_messages/i`
  - no `updateConversation` call carries `user_id` or `conversation_state`
  - `handleEmployerConversationButton` with `{action:'open'}` → `null`, no `updateConversation`
  - `handleEmployerConversationTextAction` with `'open'` → `null`, no `updateConversation`

- [ ] **Step 3: Run red.**
  `cd infra && npx jest test/unit/lambda/whatsapp/lib/conversation-router.test.ts --runInBand`
  Expected **FAIL**, behavioral not missing-module: the unbound-`new` case receives the `WORKER`
  UUID instead of `null` (fallback at `:171-172`); the `CHATS` case fails
  `not.toHaveBeenCalled()` with 1 call (from `:184`); both employer-conversation cases fail
  because `:239` and `:339` phone-resolve.

- [ ] **Step 4: Add the unbound guard.** In `tryConversationRelay`, after the existing
  `if (!msg.body.trim()) return null;`, add `if (!conv.user_id) return null;` with a comment
  citing the design's identity-binding rule and the Manuel incident. Replace the
  `conv.user_id ?? await resolveWorkerIdForWhatsappNumber(...)` expression with `conv.user_id` at
  `:171`, `:239`, `:339`, and in `handlePickerResponse` if present. Delete the now-unreachable
  `ConversationRelayPhoneMatch` log at `:175-177`. In `processor.ts:1052`, guard the picker branch
  on `conv.user_id` and pass it directly instead of re-resolving. A **bound** session in
  `awaiting_otp` still relays — that is re-verification, and the existing test at `:243` must stay
  green.

- [ ] **Step 5: Run green.** Same command as Step 3. Expected **PASS**, whole file.

- [ ] **Step 6: Legacy regression.**
  `cd infra && npx jest test/unit/lambda/whatsapp/processor.test.ts test/unit/lambda/whatsapp/onboarding-conversation.test.ts --runInBand`
  Expected **PASS**. The three processor mock chains referencing the resolver (`:294`, `:1126`,
  `:2841`) all model *no match*, so removing the query only leaves a queued
  `mockResolvedValueOnce` unconsumed. If a chain shifts, fix the **mock chain**, never an
  assertion.

- [ ] **Step 7: Build and commit.** `npm run build`, then commit
  `fix(whatsapp): block relay and legal prompts on unbound sessions`.

- [ ] **Step 8: Review 1 → fix → Review 2.** Orchestrator reads the full diff and personally
  re-runs Steps 5 and 6. Blocking: any surviving resolver fallback in a relay path; a loosened
  test; a touched excluded file. One `SendMessage` fix round, then re-diff the changed hunks and
  re-run both commands.

**Handoff:** none. Merges cleanly ahead of Codex's SID work (disjoint files).

---

### Task 2: Workflow Adapters

**Files:**
- Create: `lambda/whatsapp/lib/onboarding-adapters.ts`
- Test: `test/unit/lambda/whatsapp/lib/onboarding-adapters.test.ts`

**Interfaces:**

Declares the lane's single local interface — workflow-specific external adapters only. No
lifecycle, message-category, delivery, repository, or gateway type appears here; those are
imported from C2/C4 after the barrier.

```ts
export interface OnboardingV2Adapters {
  clock: { now(): Date };
  identity: IdentityAdapter;
  location: LocationResolver;
  trustQuestions: TrustQuestionGenerator;
}
```

Produces the four external adapter surfaces plus their concrete implementations and `createOnboardingV2Adapters()`.
(`createIdentityAdapter`, `createLocationResolver`, `createTrustQuestionGenerator`) and
`createOnboardingV2Adapters()`.

**Behavioral contract:**

- `IdentityAdapter.issueChallenge({ whatsappNumber, lang })` → `sent` with `{ challengeId,
  expiresAt }`, or `throttled` with `retryAfterSeconds`. Wraps the existing Cognito CUSTOM_AUTH
  path already in `processor.ts:1240` (`InitiateAuthCommand`) and the reconciliation helper
  `reconcileWorkerCognitoAccount`. Expiry is 5 minutes, not the legacy 10.
- `IdentityAdapter.verifyChallenge({ challengeId, whatsappNumber, code })` → `verified` with
  `workerId`, `invalid` with `attemptsRemaining`, `expired`, or `locked` with `lockedUntil`.
  Wraps `RespondToAuthChallengeCommand` and the `decodeIdTokenSub` → users-row reconciliation
  already implemented at `processor.ts:1474` (`reconcileUserRow`). Reuse that logic; do not
  reimplement it.
- `LocationResolver.resolve(raw)` → `{ city, state, postalCode, source: 'zip' | 'city_state' }` or
  `null`. A 5-digit body resolves as `zip`; a `City, ST` body resolves as `city_state` with
  `postalCode: null`; anything else is `null`. Built on the existing location vocabulary in
  `lambda/lib/location.ts` (`WorkerLocationSource`, `geocoded_zip`) — map `zip` → `geocoded_zip`
  when persisting so matching signals stay consistent with `lambda/lib/job-matching.ts:212`
  (`zip_exact`).
- `TrustQuestionGenerator.generate(profession)` → three bilingual questions or `null`. Wraps the
  existing generator invocation in `handlers/custom-trust.ts:107` (`loadOrGenerateQuestions`) and
  its `questionGeneratorArn()` Lambda call. Never throws to the caller: on any failure it logs a
  sanitized event and returns `null`.
- `ProfilePersistenceAdapter` wraps the existing profile/trust persistence path without modifying it: `saveName`, `saveLocation`, `saveTrade`, and `saveTrustAnswer`. Each accepts the caller's `PoolClient`; answer three is written immediately before `completeOnboarding` on that same transaction. Location persistence maps `zip` to `geocoded_zip` so matching signals remain intact.
- The concrete trade / custom-trade surface is the existing `flows.ts` vocabulary —
  `TRUST_QUESTIONS`, `SENIORITY_OPTIONS`, `getTrustOptions`, `buildTrustQuestion`,
  `normalizeProfession` — re-exported through this module as `standardTrustQuestions(trade)` and
  `normalizeTrade(raw)`. `flows.ts` itself is not modified.

- [ ] **Step 1: Write the failing adapter tests.** Mock `@aws-sdk/client-cognito-identity-provider`
  and `@aws-sdk/client-lambda` at the module boundary, following the existing pattern at
  `onboarding-conversation.test.ts:32-63`. Assertions:
  - `issueChallenge` returns `sent` with a challenge id and `expiresAt === now + 5 min`
  - a Cognito throttle error surfaces as `throttled`, never a thrown exception
  - `verifyChallenge` returns `verified` with the reconciled worker UUID on a correct code
  - a wrong code returns `invalid` with `attemptsRemaining` counting down 2, 1, 0
  - an expired Cognito session returns `expired`, not `invalid`
  - the third wrong code returns `locked` with `lockedUntil === now + 15 min`
  - `resolve('78701')` → `{ city, state, postalCode: '78701', source: 'zip' }`
  - `resolve('Austin, TX')` → `source: 'city_state'`, `postalCode: null`
  - `resolve('???')` → `null`
  - `generate('welding')` returns three questions each with non-empty, distinct `en` and `es` copy
  - a generator failure returns `null` and logs, and does not throw
  - `standardTrustQuestions('electrician')` returns three questions sourced from `TRUST_QUESTIONS`
  - `normalizeTrade('  WELDING ')` → `'welding'`
  - profile persistence calls update the canonical profile/trade/trust rows through the supplied client, and a forced failure rolls back the workflow advance

- [ ] **Step 2: Run red.**
  `cd infra && npx jest test/unit/lambda/whatsapp/lib/onboarding-adapters.test.ts --runInBand`
  Expected **FAIL**: `Cannot find module '.../lib/onboarding-adapters'`.

- [ ] **Step 3: Implement.** Constants (`OTP_TTL_MS`, `OTP_LOCK_MS`, `OTP_MAX_ATTEMPTS`) come from
  the canonical C2 types module if it exports them; only if it does not, declare them here once
  and record that in the summary for the merge check.

- [ ] **Step 4: Run green.** Same command. Expected **PASS**.

- [ ] **Step 5: Verify no canonical duplication.**
  `cd infra && grep -nE "^export (type|interface) (Worker|Message|Delivery|Workflow)" lambda/whatsapp/lib/onboarding-adapters.ts`
  Expected: **no output**. Any hit means a shared type was re-declared — a blocking defect.

- [ ] **Step 6: Build and commit.** `npm run build`, then
  `feat(whatsapp): add v2 identity, location, and trust-question adapters`.

- [ ] **Step 7: Review 1 → fix → Review 2.** Blocking: any re-declared canonical type; any adapter
  that throws instead of returning a typed failure; reimplementation of `reconcileUserRow` or
  `loadOrGenerateQuestions` rather than reuse; a real AWS client constructed at module load.

**Handoff:** generator fallback emits a sanitized diagnostic event for logs only; it adds no C7 alarm.

---

### Task 3: Bilingual Rendering Surface

**Files:**
- Modify: `lambda/whatsapp/lib/templates.ts` (extend `TemplateKey` at `:12-60` and the record at
  `:62`), `lambda/whatsapp/lib/interactive-templates.ts` (append builders)
- Create: `lambda/whatsapp/lib/onboarding-language.ts`, `lambda/whatsapp/lib/onboarding-renderers.ts`
- Test: `test/unit/lambda/whatsapp/lib/templates.test.ts`,
  `test/unit/lambda/whatsapp/lib/interactive-templates.test.ts`,
  `test/unit/lambda/whatsapp/lib/onboarding-language.test.ts`,
  `test/unit/lambda/whatsapp/lib/onboarding-renderers.test.ts`

**Interfaces:**

- `onboarding-language.ts` (pure; no DB, no I/O, `now` always passed in): `parseLanguageChoice`,
  `detectCommandLang`, `resolveResponseLanguage(preferred, body, isInteractive)`,
  `isLanguageCommand`, `isResendCommand`, `isReviewTermsCommand`, `isOnboardingHelpCommand`,
  `classifyBlockedCommand(body): 'jobs' | 'chats' | 'profile' | null`,
  `evaluateStartCooldown(history, now): { allowed, reason: 'ok'|'cooldown'|'daily_cap' }`,
  `shouldRepeatPrompt(lastIso, now)`, `appendSendTimestamp(history, now)`.
- `onboarding-renderers.ts`: one deterministic renderer per `MessageCategory` (the canonical C2
  union), keyed so the gateway can select by category, plus
  `createReleaseRenderer(): ReleaseRenderer` covering **all five Codex C6 request kinds**:
  1. onboarding-complete confirmation
  2. account / profile notification
  3. grouped job-alert digest (≤10 entries)
  4. single employer-conversation invitation (the existing invite copy)
  5. multi-employer **View Chats** summary — one message stating that multiple employers are
     trying to reach the worker, with a View Chats action and `CHATS`/`MENSAJES` text fallback

Category renderers match C2's exact async `(client, input)` contract, resolve the verified recipient and preferred language through parameterized DB reads, and return the canonical rendered payload; they perform no network call, clock read, enqueue, or send. Task 3 exports `registerOnboardingRenderers()` and Task 6 calls it once during processor dependency construction. Release rendering remains pure over the complete C6 request.

**Exclusions:** additive only. No existing `TemplateKey` or builder is renamed, reworded, or
deleted — the legacy flow and ten existing test files depend on them. `flows.ts` is not modified.
Renderers never enqueue or send; they return renderable payloads for the gateway and the C6
release handler.

- [ ] **Step 1: Write the failing language tests.** Assertions: `START`/`EMPEZAR` and the
  `start:lang:en` / `start:lang:es` payloads map to `en`/`es`; unrelated text → `null`;
  `resolveResponseLanguage('es','HELP',false)` → `'en'` and `('en','AYUDA',false)` → `'es'`;
  interactive taps always return the preferred language; non-command free text returns the
  preferred language; `LANGUAGE`/`IDIOMA`, `RESEND`/`REENVIAR`, `REVIEW TERMS`/`REVISAR TÉRMINOS`,
  `HELP`/`AYUDA` recognized in both languages; `JOBS`/`TRABAJOS`, `CHATS`/`MENSAJES`,
  `PROFILE`/`PERFIL` classify correctly and a step answer returns `null`; the first invitation is
  allowed, a second inside 10 minutes returns `cooldown`, one after 10 minutes is allowed, the
  sixth in 24 hours returns `daily_cap`, and sends older than 24 hours do not count;
  `shouldRepeatPrompt` is true when never repeated, false inside 30 seconds, true after.

- [ ] **Step 2: Write the failing template and renderer tests.** Assertions:
  - every v2 template key returns non-empty `en` and `es` copy, and the two differ
  - `v2_otp_sent` interpolates the 5-minute limit; `v2_otp_invalid` interpolates remaining
    attempts; `v2_otp_locked` interpolates 15; `v2_otp_resend_cooldown` interpolates seconds
  - the start invitation contains both `START` and `EMPEZAR` and never reveals whether an account
    exists (no match for `/existing|already|ya tienes|cuenta existente/i`)
  - the v2 legal prompt carries **both** the Terms and Privacy links in variables and fallback body
  - a renderer exists for every member of the canonical `MessageCategory` union — assert by
    iterating the union's values, so adding a category to C2 fails this test loudly
  - `registerOnboardingRenderers()` registers both privileged categories with the C4 registry and is idempotent under repeated Lambda initialization
  - `createReleaseRenderer()` handles all five request kinds in both languages
  - the job-alert digest renders at most 10 entries and states that `JOBS` shows the full list
  - the single-conversation kind renders the existing invitation copy
  - the multi-employer kind renders exactly one message, mentions multiple employers, offers a
    View Chats action, and includes the `CHATS`/`MENSAJES` fallback
  - no renderer output contains an OTP, a raw phone number, or a raw inbound message body

- [ ] **Step 3: Run red.**
  `cd infra && npx jest test/unit/lambda/whatsapp/lib/onboarding-language.test.ts test/unit/lambda/whatsapp/lib/onboarding-renderers.test.ts test/unit/lambda/whatsapp/lib/templates.test.ts test/unit/lambda/whatsapp/lib/interactive-templates.test.ts --runInBand`
  Expected **FAIL**: the two new suites with `Cannot find module`; `templates.test.ts` with
  `TypeError: Cannot read properties of undefined (reading 'en')` from `t()` at `templates.ts:241`;
  `interactive-templates.test.ts` with `has no exported member`.

- [ ] **Step 4: Implement.** Add the v2 template keys — start invitation and cooldown note; OTP
  sent / invalid / expired / locked / resend-cooldown / send-cap; legal declined; ask-name and
  name-invalid; ask-location and location-invalid; ask-custom-trade and custom-trade-invalid; the
  onboarding-gate blocked notice; language-changed; ready confirmation. Add the v2 prompt builders
  (start invitation with both language buttons, OTP prompt with an `otp:resend` Resend button, v2
  legal prompt with Terms + Privacy links and `legal:accept` / `legal:decline` / `legal:review`
  payloads, and a numbered-option prompt for generated/fallback trust questions). Reuse existing
  profile/trust builders rather than adding parallel ones. Add reviewed bilingual fallback trust
  questions as module constants.

- [ ] **Step 5: Run green.** Same command as Step 3. Expected **PASS**, including all existing
  cases in the modified suites.

- [ ] **Step 6: Build and commit.** `npm run build`, then
  `feat(whatsapp): add bilingual v2 copy, language policy, and renderers`.

- [ ] **Step 7: Review 1 → fix → Review 2.** Blocking: an existing key/builder changed; EN copy in
  the ES slot; a category renderer not matching the shared async contract; missing registration;
  a network/clock/enqueue/send side effect; a release request kind missing or multiply rendered.

**Handoff:** Codex C6 consumes `createReleaseRenderer()` from the C2 shared contract. Codex C10
records the content-template families as a pre-production prerequisite.

---

### Task 4: Router — Entry, OTP, Legal, and the Authoritative Command Gate

**Files:**
- Create: `lambda/whatsapp/onboarding-v2.ts`
- Test: `test/unit/lambda/whatsapp/onboarding-v2.test.ts`

**Interfaces:** `routeOnboardingV2(client, session, msg, deps)` accepts the C4 phone-keyed pre-auth
state before OTP and the canonical user-bound `WorkerGate` after OTP. `deps` combines Task 2's
external adapters with canonical C4 repository/gateway operations and Task 3 renderers; it does
not mirror shared types.

**Sending rule:** every outbound prompt calls `enqueueWorkerMessage` with `ownerService:
'onboarding-v2'` for workflow prompts or `'identity'` for OTP/security prompts. The router never
calls a direct queue/outbox helper. Task 3 renderers are registered once by Task 6.

**Behavioral contract:**

*`start.choose_language`* — load/upsert C4's phone-hash pre-auth state. Rate-limit the invitation;
create no account, lifecycle row, or workflow run. A language choice persists the preference,
issues and persists an identity challenge before enqueuing its security prompt, and moves the
pre-auth `currentStepKey` to `identity.verify_otp`; `workerId` remains null.

*`identity.verify_otp`* — RESEND is valid only here and enforces the cooldown/cap. A replacement
challenge supersedes the old one. Only a `verified` adapter result calls
`bindVerifiedIdentityAndStartWorkflow(...)`; that C4 operation atomically marks the challenge
verified, binds the conversation, creates lifecycle/run state at `legal.review`, and appends the
OTP-success transition. Invalid/expired/locked results leave every identity-binding field null.

*OTP lock logging* — the third failed attempt emits exactly one
`console.warn(JSON.stringify({ metric: 'WhatsAppOtpLock', workflowVersion, stepKey, lockMinutes: 15 }))`.
No OTP, phone, or body is logged; later attempts during the same lock emit nothing. Codex C7 owns
the processor-log filter/alarm.

*`legal.review`* — Accept records immutable versioned consent and advances to `profile.name`.
Decline sets run `status = 'declined'` while retaining `current_step_key = 'legal.review'`; it
never invents a terminal step key. Review Terms stays on the same step. Current consent may
satisfy ordinary runs; reset runs require fresh confirmation without deleting earlier audits.
*Command gate* — runs before step dispatch, so no blocked command can reach a step handler.
`HELP`/`AYUDA` explains and repeats the current step. `LANGUAGE`/`IDIOMA` persists the new
preference. `RESEND` outside the OTP step is refused. `JOBS`/`TRABAJOS`, `CHATS`/`MENSAJES`,
`PROFILE`/`PERFIL`, and unrelated text neither execute nor queue: they emit the gate notice, repeat
the current prompt under the 30-second cooldown, and log
`{ metric: 'OnboardingGateBlocked', command, stepKey }`. A command typed in the non-preferred
language is answered in the command language while subsequent workflow prompts stay in the
preferred language.

- [ ] **Step 1: Write the failing transition-table tests.** One fake-deps factory backed by
  in-memory repository/gateway fakes and a controllable clock. Cover every bullet above, and
  additionally assert: the gate blocks all six blocked-command spellings; the challenge id is
  persisted in the same patch that advances the step; `enqueueWorkerMessage` is called for every
  outbound with the correct `ownerService`; `queueText` / `queueOutboxText` /
  `queueInteractivePrompt` are never called; a phone with an existing worker still ends the OTP
  step unbound when the code is wrong; the `WhatsAppOtpLock` event appears exactly once and
  contains no OTP or phone.

- [ ] **Step 2: Run red.**
  `cd infra && npx jest test/unit/lambda/whatsapp/onboarding-v2.test.ts --runInBand`
  Expected **FAIL**: `Cannot find module '../../../../lambda/whatsapp/onboarding-v2'`.

- [ ] **Step 3: Implement.** Structure: a `sendStepPrompt` helper (single source of truth for
  "what does the current step ask?", routed through `enqueueWorkerMessage`), a
  `repeatCurrentPrompt` wrapper enforcing the 30-second cooldown, an `applyGate` function returning
  a result when it consumed the message or `null` to fall through, then the step dispatch. Add a
  `handleProfileAndTrust` stub that throws `new Error('profile/trust steps land in Task 5')` —
  Task 5 replaces it, and no Task 4 test reaches it because the gate consumes those cases first.

- [ ] **Step 4: Run green.** Same command. Expected **PASS**.

- [ ] **Step 5: Verify the sending rule and canonical usage.**
  ```bash
  cd infra
  grep -n "queueText\|queueOutboxText\|queueInteractivePrompt\|whatsapp_outbox" lambda/whatsapp/onboarding-v2.ts
  grep -n "bindVerifiedIdentityAndStartWorkflow\|enqueueWorkerMessage" lambda/whatsapp/onboarding-v2.ts
  grep -nE "^export (type|interface)" lambda/whatsapp/onboarding-v2.ts
  ```
  `bindVerifiedIdentityAndStartWorkflow` appears exactly once and only on the verified branch; no shared type is exported.
  Expected: direct-send grep has no output; `bindVerifiedIdentityAndStartWorkflow` appears exactly once on the verified branch; no shared type is exported.
- [ ] **Step 6: Build and commit.** `npm run build`, then
  `feat(whatsapp): add v2 identity, legal, and onboarding command gate`.

- [ ] **Step 7: Review 1 → fix → Review 2.** Blocking: any direct outbox write; a bind reachable
  from a non-verified branch; the gate running after dispatch; a timing literal; more than one
  `WhatsAppOtpLock` emission per lock; an OTP or phone in any log; a re-declared canonical type.

**Handoff:** Codex C7 receives the two metric names (`WhatsAppOtpLock`, `OnboardingGateBlocked`)
and their exact field sets.

---

### Task 5: Router — Profile, Location, Trade, Custom Trade, Trust, Atomic Readiness

*Branches off **Task 4's** post-fix state. Same file — never run concurrently with Task 4.*

**Files:**
- Modify: `lambda/whatsapp/onboarding-v2.ts` (replace the `handleProfileAndTrust` stub)
- Test: `test/unit/lambda/whatsapp/onboarding-v2-profile.test.ts`

**Interfaces:** consumes Task 2's adapters (including `profile` persistence), Task 3's renderers, and the canonical
`completeOnboarding(...) → { assessmentEventId, workerReadyEventId }`. Produces `sendTrustPrompt`,
referenced by Task 4's `sendStepPrompt`.

**Exclusions:** do not modify `lib/flows.ts`, `lib/profile-flow.ts`, `handlers/custom-trust.ts`,
or `lambda/ai/trust-scorer.ts` — the legacy flow keeps them, and Task 2 already wraps what this
task needs. Never call Bedrock, Step Functions, or SQS directly.

**Behavioral contract:**

- *`profile.name`* — accept a trimmed name of 2–100 characters with no character-set restriction
  (varied naming conventions are required). Invalid input reprompts under the 30-second cooldown
  and does not persist. Valid input persists and advances to `profile.location`.
- *`profile.location`* — delegate to the Task 2 resolver. A ZIP stores the derived city/state with
  `source: 'zip'`; a `City, ST` body stores `source: 'city_state'` with a null postal code;
  unresolvable input reprompts. Advances to `profile.trade`.
- *`profile.trade`* — the existing WhatsApp list picker. The five standard trades attach the
  standard fixed three-question set (`trustQuestionSource: 'standard'`) and advance straight to
  `trust.question.1`, calling the generator zero times. `other` advances to `profile.custom_trade`.
- *`profile.custom_trade`* — reject an empty profession. Otherwise normalize, then call the
  generator. Three valid generated questions → `source: 'generated'`. `null`, a wrong-length
  result, **or a thrown error** → the reviewed bilingual fallback set with `source: 'fallback'`;
  generation failure never fails the run. Persist trade, question-set version, rubric version, and
  source as assessment provenance.
- *`trust.question.{1,2,3}`* — accept a 1-based option index or `trust:` payload; invalid options
  reprompt. Answers 1 and 2 advance. For answer 3, the caller persists the answer through
  `ProfilePersistenceAdapter.saveTrustAnswer`, then calls `completeOnboarding` exactly once with
  the locked gate's `expectedLockVersion`, using the same client and existing processor transaction.
  It performs no external request or send. C6's release owns the sole ready confirmation.
- *Non-blocking assessment* — v2 has no `processing_ai` step and never awaits an assessment
  result. Readiness is reached with the assessment merely requested. Optional media is never a
  readiness requirement.
- *Idempotency* — an inbound message on an already-completed run returns without calling
  `completeOnboarding` again.

- [ ] **Step 1: Write the failing profile/trust tests.** Cover every bullet above. Explicit cases:
  names `Jo`, `Juan Perez`, `Mary-Anne O'Brien`, `Jose Maria de la Cruz Hernandez` accepted;
  `J`, 101 characters, and whitespace-only rejected; ZIP and `City, State` paths; all five standard
  trades reach `trust.question.1` with `generate` uncalled; `other` → custom trade; generator
  returning `null`, returning a wrong-length array, and **throwing** all land on the fallback set
  with EN ≠ ES copy; answers 1 and 2 do not complete; answer 3 completes exactly once with all
  three answers and the provenance fields; answer-three persistence and `completeOnboarding` share
  one client/transaction; readiness is reached with zero assessment results; no ready confirmation
  is enqueued by the router; a repeated final answer does not complete twice; no `processing_ai` or
  media step ever appears.

- [ ] **Step 2: Run red.**
  `cd infra && npx jest test/unit/lambda/whatsapp/onboarding-v2-profile.test.ts --runInBand`
  Expected **FAIL**: every test throws `profile/trust steps land in Task 5` from the Task 4 stub.

- [ ] **Step 3: Implement**, replacing the stub.

- [ ] **Step 4: Run green (both router suites).**
  `cd infra && npx jest test/unit/lambda/whatsapp/onboarding-v2.test.ts test/unit/lambda/whatsapp/onboarding-v2-profile.test.ts --runInBand`
  Expected **PASS**, both files — Task 4's suite must remain entirely green.

- [ ] **Step 5: Verify no blocking path leaked in.**
  `cd infra && grep -n "processing_ai\|awaiting_media\|BedrockRuntime\|StartExecution\|SendMessageCommand\|queueText\|queueInteractivePrompt" lambda/whatsapp/onboarding-v2.ts`
  Expected: **no output**.

- [ ] **Step 6: Build and commit.** `npm run build`, then
  `feat(whatsapp): complete v2 profile, trade, trust, and readiness`.

- [ ] **Step 7: Review 1 → fix → Review 2.** Blocking: `completeOnboarding` called more than once
  or awaited for external work; a fallback question set that is not reviewed bilingual copy; a
  generator failure that propagates; a direct AWS client; a modified excluded file.

**Handoff:** Codex C4 owns the five atomic operations inside `completeOnboarding`; this lane
asserts that answer three is persisted immediately before it and that both calls share the locked client/transaction. Deliver the question-set version,
fallback version, and rubric version identifiers for assessment provenance.

---

### Task 6: Processor Integration (Fail-Closed)

**Files:**
- Modify: `lambda/whatsapp/processor.ts` — imports, deps construction, one branch in `routeMessage`
- Modify: `test/unit/lambda/whatsapp/processor.test.ts`

**Interfaces:** consumes `loadRuntimeControls`, `hashNormalizedPhone`, `isV2Enabled` (C2), the
canonical repository and gateway (C4), Task 2's adapters, Task 3's renderers, and
`routeOnboardingV2`. All imports are static. There is no dynamic `require`, no module-availability
probe, and no environment-variable allowlist.

**Behavioral contract:**

- The v2 decision is
  `isV2Enabled(await loadRuntimeControls(client), hashNormalizedPhone(conv.whatsapp_number))`.
  The raw phone is never used as a control key and never appears in a control log.
- Deferred delivery is likewise read from the database-backed controls, never from an environment
  variable.
- The branch sits at the top of `routeMessage`, before any legacy handling, and returns without
  falling through.
- **Fail closed.** Once a phone selects v2, any missing dependency or error inside the v2 path
  propagates out of `routeMessage` so the processor's existing transaction rolls back and SQS
  retries. It must never be caught and downgraded to legacy routing. A v2 phone never runs the
  legacy state machine.
- The branch runs inside the existing claim/`db_committed` transaction at `processor.ts:529-655`.
  It opens no `BEGIN`/`COMMIT` of its own and does not alter the outbox-flush or `markCompleted`
  protocol. It returns the bound worker id (or null) into the existing `jobOutboxActorUserId` slot.

**Exclusions:** `webhook.ts`, FIFO configuration, `lib/stacks/**`, the claim protocol, and
`handleSupportCommand` are untouched.

- [ ] **Step 1: Write the failing branch tests.** Reuse this file's existing `makeSqsEvent`,
  `mockQuery`, `FROM`, `PHONE`, and `SID` fixtures. Assertions:
  - controls report the phone hash disabled → `routeOnboardingV2` not called, legacy path runs
  - controls report it enabled → `routeOnboardingV2` called exactly once
  - `registerOnboardingRenderers()` is called before routing and a gateway enqueue resolves both onboarding/security renderers instead of `renderer_unavailable`
  - `hashNormalizedPhone` output is what reaches `isV2Enabled`; the raw phone never does
  - exactly one `BEGIN` and one `COMMIT` per message
  - no legacy state-transition SQL executes for a v2 phone
  - an error thrown from the v2 path propagates out of `handler` and triggers `ROLLBACK` — it does
    **not** fall through to legacy routing (assert the legacy handlers were not invoked)
  - no environment variable gates the decision: with every `WHATSAPP_*` env var unset, an enabled
    control still routes to v2
  - a FIFO-shaped SQS record with `attributes.MessageGroupId` and `messageDeduplicationId` routes
    through the same v2 branch exactly once

- [ ] **Step 2: Run red.**
  `cd infra && npx jest test/unit/lambda/whatsapp/processor.test.ts -t "v2 routing branch" --runInBand`
  Expected **FAIL**: the enabled case receives 0 calls to `routeOnboardingV2` because no branch
  exists.

- [ ] **Step 3: Implement.** Static imports; construct the deps bundle once per invocation from
  Call `registerOnboardingRenderers()` once before the first gateway enqueue; repeated warm-invocation construction is idempotent.
  the canonical repository/gateway/renderers plus `createOnboardingV2Adapters()`. No try/catch
  around the v2 path.

- [ ] **Step 4: Run green.** Same command as Step 2. Expected **PASS**.

- [ ] **Step 5: Full legacy regression.**
  `cd infra && npx jest test/unit/lambda/whatsapp --runInBand`
  Expected **PASS**, every suite — `processor.test.ts` (2893 lines),
  `onboarding-conversation.test.ts`, `job-alert.test.ts`, `webhook.test.ts`,
  `status-callback.test.ts`, `custom-trust-handler.test.ts`, `profile-flow.test.ts`,
  `ai-profile-writer.test.ts`, and all of `lib/`. With controls disabled, legacy behavior is
  bit-identical. A legacy failure is a blocking defect — fix the branch, never the legacy test.

- [ ] **Step 6: Verify no fallback and no env gating.**
  `cd infra && grep -n "require(\|WHATSAPP_V2_ALLOWLIST\|WHATSAPP_DEFERRED_DELIVERY_ENABLED" lambda/whatsapp/processor.ts`
  Expected: **no output**. Then inspect every `catch` block added by this task — there must be
  none in the v2 path.

- [ ] **Step 7: Build and commit.** `npm run build`, then
  `feat(whatsapp): route v2-enabled phones through the workflow router`.

- [ ] **Step 8: Review 1 → fix → Review 2.** Blocking: any dynamic import; any catch that
  downgrades a v2 phone to legacy; an env-var control; a raw phone used as a control key; more
  than one `BEGIN`/`COMMIT`; a modified legacy test assertion.

**Handoff:** Codex C2 confirms the control names read here; Codex C10 records that no new
environment variable is required for the v2 decision.

---

### Task 7: Deterministic Conversation Testbed and Lane Freeze

**Files:**
- Create: `test/helpers/whatsapp-v2-harness.ts`,
  `test/unit/lambda/whatsapp/onboarding-v2-conversation.test.ts`
- Modify: `infra/package.json` (one script)

**Interfaces:** the harness exposes `sendText`, `pressButton`, `advanceTime`,
`injectEmployerMessage`, `injectJobAlert`, `failAdapter`, `driveToStep`, and readers for state,
sent messages, intents, transitions, completions, and legal consents. The clock is injected —
`jest.useFakeTimers` is never used and nothing reads `Date.now()` directly. Cognito, Twilio,
Bedrock, and SQS are faked at their adapter interfaces. Deterministic conversation coverage only;
PostgreSQL concurrency and migration suites belong to Codex.

**Required scenarios:**

- complete Spanish onboarding end to end: entry → language → OTP → legal → name → location →
  trade → three trust answers → ready
- complete English onboarding end to end
- a cross-language command answered in the command language with prompts staying preferred
- `IDIOMA`/`LANGUAGE` persisting a mid-flow preference change
- start cooldown: one invitation per 10 minutes, at most five per 24 hours
- OTP: success, 5-minute expiry, resend invalidating the prior code, 60-second resend cooldown,
  3-per-hour cap, three-strike 15-minute lock and recovery after it
- an existing-phone candidate that cannot bind before OTP
- Manuel's exact sequence: unbound `awaiting_otp` + `Accept` never reaches legal, never records
  consent, and the legal prompt is presented exactly once across the whole conversation
- legal Accept, Decline, and Review Terms
- name validation, ZIP and `City, State` paths, all six trade choices, `other` + custom trade, and
  the AI-question fallback
- **business messages injected at every one of the nine onboarding steps** produce intents whose
  decision is `defer` / `worker_onboarding` and produce zero worker-directed sends
- atomic readiness with zero assessment results, and readiness reached when the question generator
  fails
- duplicate `MessageSid` and double button taps each produce one transition and one consent
- all five release request kinds render through `createReleaseRenderer()`, including the
  multi-employer View Chats summary

- [ ] **Step 1: Write the failing scenario suite** covering every bullet above.

- [ ] **Step 2: Run red.**
  `cd infra && npx jest test/unit/lambda/whatsapp/onboarding-v2-conversation.test.ts --runInBand`
  Expected **FAIL**: `Cannot find module '../../../helpers/whatsapp-v2-harness'`.

- [ ] **Step 3: Implement the harness.** It lives outside `roots: ['<rootDir>/test/unit']` and is
  not a `.test.ts`, so Jest will not collect it while ts-jest still resolves the relative import.
  Repository and gateway are in-memory fakes conforming to the canonical signatures; the identity
  fake generates a deterministic code, supersedes on resend, and enforces expiry/lock/cap; a
  processed-SID set mirrors `whatsapp_processed_messages` for idempotency. When a scenario fails,
  fix `onboarding-v2.ts` — the harness models the design. Loosening an assertion is a task failure.

- [ ] **Step 4: Run green.** Same command as Step 2. Expected **PASS**, every scenario.

- [ ] **Step 5: Add the lane script** `test:whatsapp-v2` running the four v2 suites plus the
  language, renderer, and adapter suites with `--runInBand`.

- [ ] **Step 6: Run the complete lane gate.**
  ```bash
  cd infra
  npm run build
  npm run test:whatsapp-v2
  npx jest test/unit/lambda/whatsapp --runInBand
  ```
  Expected: build clean; v2 script passes; the whole `test/unit/lambda/whatsapp` tree passes,
  legacy suites included. Do **not** run `cdk synth`, `cdk diff`, repo-wide `npm test`, or the
  PostgreSQL testbed — Codex C10 owns the deployment gate after the merge.

- [ ] **Step 7: Commit and freeze.** Commit
  `test(whatsapp): add deterministic v2 conversation testbed`, then stop. No push, no merge, no
  deploy, no migration, no worker reset.

- [ ] **Step 8: Review 1 → fix → Review 2, then the freeze report.** Blocking: a globally mocked
  clock; a real AWS client; deferral coverage missing any of the nine steps; the Manuel scenario
  not asserting a single legal presentation; a release kind untested. The freeze report to Codex
  contains: branch and final commit SHA; the Step 6 commands with output; the canonical symbols
  consumed and where; the `ReleaseRenderer` contract and five kind identifiers; the two metric
  names for C7; the provenance version identifiers for C4; and the Twilio content-template
  families for C10.

---

## Cross-Lane Interface Register

| # | Direction | Contract |
| --- | --- | --- |
| 1 | Codex **C2** → Claude | Canonical lifecycle/workflow/message/delivery types, runtime controls/policy, and shared category/release renderer contracts. Never re-declared here. |
| 2 | Codex **C3** → Claude | Migration `042`, including phone-keyed pre-OTP challenge state and canonical step-key checks. |
| 3 | Codex **C4** → Claude | Phone-keyed pre-auth, verified binding/start, guarded advance, `enqueueWorkerMessage`, and readiness primitives. The caller persists answer three before `completeOnboarding` in the same transaction. |
| 4 | Claude → Codex **C6** | `createReleaseRenderer(): ReleaseRenderer` covering all five request kinds in EN/ES, including the multi-employer View Chats summary (Task 3). |
| 5 | Claude → Codex **C7** | Sanitized `WhatsAppOtpLock` and `OnboardingGateBlocked` events. Generator fallback is diagnostic-only. No OTPs, phones, or raw bodies; C7 owns the canonical filters/alarms. |
| 6 | Claude → Codex **C10** | Freeze report, Twilio content-template families, and confirmation that the v2 decision needs no new environment variable. |

---

## Self-Review

### Requirement → task

| Requirement | Task(s) | Evidence |
| --- | --- | --- |
| `processor.ts` integration | 6 (1 for the picker call site) | Canonical controls, static imports, fail-closed, one `BEGIN`/`COMMIT`, full legacy regression |
| OTP-only identity binding | 4 (2 for the adapter, 7 for E2E) | Bind reachable only from the `verified` branch; grep check; existing-phone scenario stays unbound |
| Pre-OTP relay prevention | 1 | Unbound guard on all four relay entry points; six regression assertions |
| Legal transitions | 4, 7 | Accept / Decline / Review Terms / auto-satisfy / fresh-consent-for-reset; one legal presentation in the Manuel scenario |
| Authoritative onboarding command gate | 4, 7 | Gate precedes dispatch; six blocked spellings; HELP / LANGUAGE / RESEND handled; deferral at all nine steps |
| Manuel regression | 1, 7 | Unit-level in the router; conversation-level end to end |
| Profile / location / trade / custom-trade / trust | 2, 5 | 2–100 names, ZIP + `City, State`, five standard trades + `other`, normalization, generated vs fallback questions |
| Non-blocking AI assessment | 5, 7 | No `processing_ai` (grep check); generator failure → fallback → ready; ready with zero assessment results |
| Bilingual templates / language / cooldowns | 3 | v2 copy with EN ≠ ES; `resolveResponseLanguage`; 10-min / 5-per-day / 30-sec / 60-sec / 3-per-hour as named constants |
| Deterministic conversation tests | 7 | Injected clock, adapter-level fakes, EN + ES end to end, OTP lifecycle, idempotency, all five release kinds |
| Release renderer (all five C6 kinds) | 3 | Per-kind EN/ES assertions incl. the multi-employer View Chats summary |
| Sanitized OTP-lock logging | 4 | Exactly one `WhatsAppOtpLock` per lock, no OTP, no phone |
| Gateway-only sending | 3, 4, 5 | `ownerService` `onboarding-v2` / `identity` on every prompt; grep check forbidding direct outbox writes |
| Bootstrap barrier honored | Barrier section | C2–C4 merged, migration 042 present, PostgreSQL gate green, build clean, canonical names confirmed before Task 2 |

### Ownership review

Owned: relay gating, adapters, language policy, renderers, v2 copy, the router, the processor
branch, the harness. Not owned and not created here: migration `042`; `onboarding-types.ts`;
`runtime-controls.ts` / `delivery-policy.ts`; `onboarding-repository.ts` /
`worker-delivery-gateway.ts`; the release handler; log filters and alarms; the `SM`/`MM` validator
and outbox/Twilio transport; `webhook.ts`, FIFO, and CDK; producers; reset tooling; PostgreSQL
suites; the rollout runbook. `handleSupportCommand` is a documented deliberate no-change. Codex is
not asked to build identity, location, trust-question, or profile-persistence adapters — Task 2 owns all four surfaces.

### Interface review

The lane declares exactly one local interface, `OnboardingV2Adapters`, containing `clock`,
`identity`, `location`, `trustQuestions`, and `profile`. It mirrors no canonical shared type.
The barrier pins the real C2/C4 export names before Task 1. `routeOnboardingV2(client, session,
msg, deps)` accepts C4 `PreAuthState` before binding and `WorkerGate` afterward. `sendStepPrompt`
(Task 4) calls `sendTrustPrompt` (Task 5), the sole intra-module forward reference.


### Sequencing and placeholder review

Seven tasks, dependency-ordered, each with one Review 1 → one fix round → Review 2. Task 5
explicitly branches off **Task 4's** post-fix state. No `TBD`, no "implement later", no "add
appropriate error handling", no "similar to Task N". Every step names exact files, exact commands,
and the exact red or green result including the failing assertion or error text. The one
deliberate temporary is Task 4's `handleProfileAndTrust` stub, which Task 5 Step 3 replaces and
Task 5 Step 2's expected failure message names explicitly.
