# WhatsApp Onboarding Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a locally verified WhatsApp v2 onboarding flow that prevents business messages before readiness and safely releases current deferred work after onboarding.

**Architecture:** Add versioned workflow/lifecycle records beside the legacy conversation state, route all worker delivery through a typed policy gateway, serialize v2 inbound events with SQS FIFO, and publish assessment/release work through transactional outbox rows. Preserve the current employer-chat store and matching logic while changing only when their WhatsApp notifications become eligible.

**Tech Stack:** TypeScript 5.9, Node.js Lambda, Jest 30, PostgreSQL 16, AWS CDK/SQS FIFO, Cognito custom auth, Twilio WhatsApp/SMS, Bedrock trust assessment.

## Global Constraints

- Follow the approved design in `docs/superpowers/specs/2026-07-21-whatsapp-onboarding-gate-design.md`.
- Use additive migration `042`; do not edit migrations `001` through `041`.
- Do not drop or rename legacy WhatsApp columns or switch non-allowlisted workers to v2.
- Successful OTP verification is the only identity-binding operation.
- Only the delivery gateway may create sendable worker WhatsApp outbox rows.
- AI assessment must not block `ready`.
- Use real disposable PostgreSQL 16 for the database gate; never target RDS from local tests.
- Do not add LocalStack, a cloud sandbox, trade-change UI, or an admin dashboard.
- Preserve optional photo/voice enrichment, but do not make it a v2 readiness requirement.
- Keep existing untracked `demo-ready-windows/` and `reports/` untouched.

---

## Canonical Worktree and Ownership Contract

This plan and `docs/superpowers/specs/2026-07-21-whatsapp-onboarding-gate-design.md` must exist byte-for-byte identically in both persistent branches before implementation begins. Every implementation agent reads both files before editing and follows the ownership boundary below. Requirements changes land as reviewed shared commits; agents do not create lane-local variants of either document.

Shared base and reconciliation:

- Refreshed `origin/main` is `6b4dbab` and is the source of truth.
- Upstream already contains migrations `039_whatsapp_support_cases.sql`, `040_whatsapp_delivery_status.sql`, and `041_whatsapp_web_worker_lookup_grant.sql`.
- Preserve upstream command-language, support, delivery-callback, and WhatsApp changes.
- The onboarding migration is `042_whatsapp_onboarding_gate.sql`; all migration baselines and PostgreSQL expectations extend through `042`.
- The confirmed `SM`-only validation defect and pre-OTP employer relay remain in scope even where upstream code overlaps the originally planned files.

Persistent lanes:

- Codex owns `.worktrees/wa-v2-integration` / `feat/wa-v2-integration` as merge captain. Its lane owns the shared bootstrap, migration `042`, delivery gateway and policy, FIFO/DLQ/CDK work, producer deferral and release, reset tooling, PostgreSQL gates, rollout tooling, and final integration.
- Claude Opus owns `.worktrees/wa-v2-claude` / `feat/wa-v2-workflow` as workflow orchestrator. Its lane owns `processor.ts`, OTP-only binding, onboarding router/state handling, legal/profile/trust flow, conversation relay behavior, bilingual templates, and deterministic conversation tests.
- Task agents use disposable worktrees and do not edit either persistent worktree directly. Cross-lane interface changes require review by both orchestrators before dependent commits land.
- Opus freezes the workflow lane before integration. Codex merges it, runs the full build/Jest/PostgreSQL/CDK/security gate, and stops before push, deployment, RDS migrations, or worker reset.

Canonical deterministic synth command:

```bash
cd infra
CDK_DEFAULT_ACCOUNT=111111111111 \
CDK_DEFAULT_REGION=us-east-2 \
npx cdk synth --all \
  -c environment=dev \
  -c skipFrontend=true \
  -c emailFromAddress=ci-synth@jaleapp.ai \
  -c sesVerifiedIdentityArn=arn:aws:ses:us-east-2:111111111111:identity/jaleapp.ai \
  -c whatsappStatusCallbackUrl=https://api.example.invalid/whatsapp/status-callback \
  -c whatsappAlarmTopicArn=arn:aws:sns:us-east-2:111111111111:jale-ci-whatsapp-alarms
```

This mirrors the repository CI contract. Environment-less `npx cdk synth --quiet` is invalid on the refreshed base.

---

## File Structure

New focused modules:

- `infra/lambda/whatsapp/lib/onboarding-types.ts`: shared lifecycle, workflow, identity, intent, and transition types.
- `infra/lambda/whatsapp/lib/runtime-controls.ts`: parse and evaluate v2/deferred runtime controls.
- `infra/lambda/whatsapp/lib/onboarding-repository.ts`: SQL operations for workflow runs, transitions, challenges, and atomic readiness.
- `infra/lambda/whatsapp/lib/delivery-policy.ts`: pure allow/defer/reject/expire policy.
- `infra/lambda/whatsapp/lib/worker-delivery-gateway.ts`: persist typed intents and authorize outbox creation.
- `infra/lambda/whatsapp/onboarding-v2.ts`: step router and command gate using injected identity/provider adapters.
- `infra/lambda/whatsapp/worker-ready-release.ts`: lease, revalidate, group, render, and release deferred intents.
- `infra/scripts/reset-whatsapp-onboarding-v2.ts`: exact-target dry-run/reset command.

Existing files remain responsible for provider transport and legacy behavior. `processor.ts` selects legacy versus v2 and owns the transaction boundary; `job-messaging.ts` remains the employer-chat store; `outbox.ts` remains Twilio transport.

---

### Task 1: Lock the Incident Regressions

**Files:**
- Modify: `infra/lambda/whatsapp/lib/twilio.ts`
- Modify: `infra/lambda/whatsapp/lib/outbox.ts`
- Modify: `infra/lambda/whatsapp/lib/conversation-router.ts`
- Test: `infra/test/unit/lambda/whatsapp/lib/twilio.test.ts`
- Test: `infra/test/unit/lambda/whatsapp/lib/outbox.test.ts`
- Test: `infra/test/unit/lambda/whatsapp/lib/conversation-router.test.ts`
- Test: `infra/test/unit/lambda/whatsapp/processor.test.ts`

**Interfaces:**
- Consumes: current `sendTwilioWhatsAppMessage()` and `tryConversationRelay()`.
- Produces: `isTwilioMessageSid(value: unknown): value is string`; an explicit guarantee that an unbound onboarding session cannot relay business messages.

- [ ] **Step 1: Write failing SID and stale-state tests**

Add table-driven assertions that `SM` and `MM` followed by exactly 32 hexadecimal characters pass, while malformed prefixes/lengths fail. Add Manuel's sequence: existing verified phone, `awaiting_otp`, non-OTP message, legal prompt, Accept; assert no worker binding, legal transition, or employer relay occurs before OTP.

```ts
it.each([
  `SM${'a'.repeat(32)}`,
  `MM${'0'.repeat(32)}`,
])('accepts Twilio messaging SID %s', sid => {
  expect(isTwilioMessageSid(sid)).toBe(true);
});

it('does not relay an existing phone while OTP remains unverified', async () => {
  const result = await tryConversationRelay(client, awaitingOtpUnbound, inbound('Accept'), deps);
  expect(result).toBeNull();
  expect(deps.queueLegalPrompt).not.toHaveBeenCalled();
  expect(sqlCalls()).not.toContainEqual(expect.stringMatching(/job_conversation_messages/i));
});
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run:

```bash
cd infra
npx jest test/unit/lambda/whatsapp/lib/twilio.test.ts test/unit/lambda/whatsapp/lib/outbox.test.ts test/unit/lambda/whatsapp/lib/conversation-router.test.ts test/unit/lambda/whatsapp/processor.test.ts --runInBand
```

Expected: the `MM` case or stale-state regression fails against current behavior.

- [ ] **Step 3: Centralize SID validation and remove pre-OTP relay**

Use this exact validator from both send and callback paths:

```ts
export function isTwilioMessageSid(value: unknown): value is string {
  return typeof value === 'string' && /^(?:SM|MM)[0-9a-fA-F]{32}$/.test(value);
}
```

Change `tryConversationRelay()` so any unbound session returns `null`; v2 policy will expose chats only after lifecycle readiness. Do not bind `user_id` based on phone lookup.

- [ ] **Step 4: Re-run focused tests**

Expected: all focused suites pass.

- [ ] **Step 5: Commit**

```bash
git add infra/lambda/whatsapp/lib/twilio.ts infra/lambda/whatsapp/lib/outbox.ts infra/lambda/whatsapp/lib/conversation-router.ts infra/test/unit/lambda/whatsapp
git commit -m "fix: lock WhatsApp identity and SID regressions"
```

### Task 2: Add the Additive V2 Data Model

**Files:**
- Create: `infra/db/migrations/042_whatsapp_onboarding_gate.sql`
- Modify: `infra/test/unit/db/migrations/apply-order.test.ts`
- Modify: `infra/test/unit/db/migrations.test.ts`
- Create: `infra/test/unit/db/whatsapp-onboarding-042.integration.test.ts`

**Interfaces:**
- Produces tables `worker_onboarding_state`, `worker_workflow_runs`, `worker_workflow_transitions`, `worker_identity_challenges`, `worker_message_intents`, `worker_domain_outbox`, `whatsapp_runtime_controls`, and `worker_reset_audit`.
- Produces constraints `worker_workflow_one_active`, `worker_message_intent_dedupe`, and `worker_domain_outbox_event_key`.

- [ ] **Step 1: Add failing migration-structure tests**

Append `042_whatsapp_onboarding_gate.sql` to `expectedBaselineMigrations` and assert every new table, lifecycle/status check, unique constraint, RLS enablement, and narrow `jale_whatsapp` grant. The integration suite must verify one active workflow per worker, unique event keys, intent deduplication, and concurrent release leasing with `FOR UPDATE SKIP LOCKED`.

- [ ] **Step 2: Run structure tests and confirm failure**

```bash
cd infra
npx jest test/unit/db/migrations.test.ts test/unit/db/migrations/apply-order.test.ts --runInBand
```

Expected: FAIL because migration 042 and its tables do not exist.

- [ ] **Step 3: Add migration 042**

Use UUID primary keys, `TIMESTAMPTZ`, JSONB context/payload, explicit status checks, and these canonical values:

```sql
-- worker_onboarding_state.lifecycle
CHECK (lifecycle IN ('onboarding', 'ready', 'suspended'))
-- worker_workflow_runs.status
CHECK (status IN ('active', 'completed', 'declined', 'cancelled', 'failed'))
-- worker_identity_challenges.status
CHECK (status IN ('pending', 'verified', 'expired', 'locked', 'superseded'))
-- worker_message_intents.status
CHECK (status IN ('deferred', 'eligible', 'leased', 'released', 'delivered',
                  'expired', 'superseded', 'rejected', 'failed'))
-- worker_domain_outbox.status
CHECK (status IN ('pending', 'processing', 'completed', 'failed'))
```

`worker_onboarding_state.user_id` is unique. Workflow runs include `workflow_version`, `current_step_key`, `preferred_language`, and `lock_version`. Transitions include from/to step, inbound SID, reason, and metadata. Intents include category, owner service, source type/id, dedupe key, priority, `expires_at`, policy version, payload, and release sequence. Domain outbox events include event type, aggregate ID, event key, payload, attempts, and next-attempt time.

Enable and force RLS. Grant `jale_whatsapp` only required columns and add worker-scoped policies using `app.current_internal_user_id`. Use a narrow SECURITY DEFINER lease function only where a cross-worker scheduled consumer cannot operate through worker RLS.

- [ ] **Step 4: Run the disposable PostgreSQL gate**

```bash
bash /home/hermesgoma/.codex/skills/psql-migration-testbed/scripts/run-psql-migration-testbed.sh \
  --repo . -- \
  bash -lc 'cd infra && JALE_TEST_DATABASE_URL="$JALE_TEST_DATABASE_URL" npx jest test/unit/db/migrations.test.ts test/unit/db/migrations/apply-order.test.ts test/unit/db/whatsapp-onboarding-042.integration.test.ts --runInBand'
```

Expected: migrations `001` through `042` apply on PostgreSQL 16 and all three suites pass.

- [ ] **Step 5: Commit**

```bash
git add infra/db/migrations/042_whatsapp_onboarding_gate.sql infra/test/unit/db
git commit -m "feat: add WhatsApp onboarding v2 data model"
```

### Task 3: Add Domain Types, Runtime Controls, and Pure Delivery Policy

**Files:**
- Create: `infra/lambda/whatsapp/lib/onboarding-types.ts`
- Create: `infra/lambda/whatsapp/lib/runtime-controls.ts`
- Create: `infra/lambda/whatsapp/lib/delivery-policy.ts`
- Create: `infra/test/unit/lambda/whatsapp/lib/runtime-controls.test.ts`
- Create: `infra/test/unit/lambda/whatsapp/lib/delivery-policy.test.ts`

**Interfaces:**
- Produces `WorkerLifecycle`, `WorkflowStepKey`, `MessageCategory`, `WorkerMessageIntentInput`, and `DeliveryDecision`.
- Produces `loadRuntimeControls(client)`, `isV2Enabled(controls, phoneHash)`, and `evaluateDelivery(input, now)`.

- [ ] **Step 1: Write failing policy tables**

Cover onboarding allow/defer behavior, ready allow behavior, suspension rejection, expiration, privileged category ownership, deferred-delivery kill switch, exact allowlist, and non-enumerating phone hashes.

- [ ] **Step 2: Run and confirm missing-module failure**

```bash
cd infra
npx jest test/unit/lambda/whatsapp/lib/runtime-controls.test.ts test/unit/lambda/whatsapp/lib/delivery-policy.test.ts --runInBand
```

- [ ] **Step 3: Implement the pure contract**

```ts
export type WorkerLifecycle = 'onboarding' | 'ready' | 'suspended';
export type MessageCategory =
  | 'onboarding' | 'security' | 'account' | 'job_alert' | 'employer_chat';
export type DeliveryDecision =
  | { action: 'allow'; reason: 'workflow_message' | 'security_message' | 'worker_ready' }
  | { action: 'defer'; reason: 'worker_onboarding' | 'delivery_disabled' }
  | { action: 'reject'; reason: 'worker_suspended' | 'invalid_owner' }
  | { action: 'expire'; reason: 'intent_expired' };

export interface WorkerMessageIntentInput {
  workerId: string;
  category: MessageCategory;
  ownerService: 'onboarding-v2' | 'identity' | 'job-alert' | 'job-messaging' | 'account';
  sourceType: string;
  sourceId: string;
  dedupeKey: string;
  priority: number;
  expiresAt: Date | null;
  payload: Record<string, unknown>;
}
```

Require owner `onboarding-v2` for onboarding and `identity` for security. A business category is deferred while onboarding even when a chat is focused.

- [ ] **Step 4: Run tests and commit**

```bash
cd infra
npx jest test/unit/lambda/whatsapp/lib/runtime-controls.test.ts test/unit/lambda/whatsapp/lib/delivery-policy.test.ts --runInBand
git add lambda/whatsapp/lib test/unit/lambda/whatsapp/lib
git commit -m "feat: define WhatsApp delivery policy"
```

### Task 4: Implement the Repository and Delivery Gateway

**Files:**
- Create: `infra/lambda/whatsapp/lib/onboarding-repository.ts`
- Create: `infra/lambda/whatsapp/lib/worker-delivery-gateway.ts`
- Modify: `infra/lambda/whatsapp/lib/outbox.ts`
- Create: `infra/test/unit/lambda/whatsapp/lib/onboarding-repository.test.ts`
- Create: `infra/test/unit/lambda/whatsapp/lib/worker-delivery-gateway.test.ts`

**Interfaces:**
- Produces `loadWorkerGate(client, workerId)`, `appendTransition(...)`, `completeOnboarding(...)`, and `enqueueWorkerMessage(client, input)`.
- `completeOnboarding()` returns `{ assessmentEventId, workerReadyEventId }` and requires an existing transaction.

- [ ] **Step 1: Write failing transaction and policy tests**

Assert the gateway stores business intents as deferred during onboarding, creates an authorized outbox row only when allowed, rechecks policy before send, preserves one dedupe row, and never calls Twilio. Assert `completeOnboarding()` updates lifecycle, completes the workflow, appends a transition, and inserts both domain events using one client transaction.

- [ ] **Step 2: Run and confirm failure**

```bash
cd infra
npx jest test/unit/lambda/whatsapp/lib/onboarding-repository.test.ts test/unit/lambda/whatsapp/lib/worker-delivery-gateway.test.ts --runInBand
```

- [ ] **Step 3: Implement exact gateway signature**

```ts
export async function enqueueWorkerMessage(
  client: PoolClient,
  input: WorkerMessageIntentInput,
  now = new Date(),
): Promise<{ intentId: string; decision: DeliveryDecision }>;
```

Insert the logical intent first with `ON CONFLICT` on dedupe key. Evaluate policy from locked lifecycle/runtime rows. For `allow`, render only through category-specific renderers and insert a `whatsapp_outbox` row with the intent ID as source. For `defer`, do not create a sendable outbox row. `outbox.ts` must reject direct business rows that lack an authorized intent source.

- [ ] **Step 4: Run tests and commit**

```bash
cd infra
npx jest test/unit/lambda/whatsapp/lib/onboarding-repository.test.ts test/unit/lambda/whatsapp/lib/worker-delivery-gateway.test.ts test/unit/lambda/whatsapp/lib/outbox.test.ts --runInBand
git add lambda/whatsapp/lib test/unit/lambda/whatsapp/lib
git commit -m "feat: add worker delivery gateway"
```

### Task 5: Add FIFO Inbound Routing and Five-Attempt Isolation

**Files:**
- Modify: `infra/lambda/whatsapp/webhook.ts`
- Modify: `infra/lambda/whatsapp/processor.ts`
- Modify: `infra/lib/stacks/whatsapp-stack.ts`
- Modify: `infra/test/unit/lambda/whatsapp/webhook.test.ts`
- Modify: `infra/test/unit/lambda/whatsapp/processor.test.ts`
- Modify: `infra/test/unit/stacks/whatsapp-stack.test.ts`

**Interfaces:**
- Webhook sends `MessageGroupId = sha256(normalized From)` and `MessageDeduplicationId = MessageSid`.
- Processor selects v2 only through `isV2Enabled()` and retains legacy routing otherwise.

- [ ] **Step 1: Write failing webhook and CDK assertions**

Assert FIFO queue names end in `.fifo`, `fifo: true`, content-based dedupe is false, max receive count is five, group IDs contain no raw phone, and dedup IDs equal the signed `MessageSid`.

- [ ] **Step 2: Run focused suites and confirm failure**

```bash
cd infra
npx jest test/unit/lambda/whatsapp/webhook.test.ts test/unit/stacks/whatsapp-stack.test.ts --runInBand
```

- [ ] **Step 3: Add an additive v2 FIFO queue**

Create `whatsapp-inbound-v2.fifo` and its DLQ rather than replacing the legacy standard queue in place. The webhook chooses the v2 queue for signed inbound events; legacy processing remains available through the runtime branch. Configure `reportBatchItemFailures`, batch size one, five receives, KMS-managed encryption, 14-day DLQ retention, and alarms for DLQ depth/oldest age.

- [ ] **Step 4: Re-run tests and synth**

```bash
cd infra
npx jest test/unit/lambda/whatsapp/webhook.test.ts test/unit/lambda/whatsapp/processor.test.ts test/unit/stacks/whatsapp-stack.test.ts --runInBand
CDK_DEFAULT_ACCOUNT=111111111111 CDK_DEFAULT_REGION=us-east-2 npx cdk synth --all -c environment=dev -c skipFrontend=true -c emailFromAddress=ci-synth@jaleapp.ai -c sesVerifiedIdentityArn=arn:aws:ses:us-east-2:111111111111:identity/jaleapp.ai -c whatsappStatusCallbackUrl=https://api.example.invalid/whatsapp/status-callback -c whatsappAlarmTopicArn=arn:aws:sns:us-east-2:111111111111:jale-ci-whatsapp-alarms
```

Expected: tests pass and synth produces both legacy and v2 queues without replacement of the legacy queue.

- [ ] **Step 5: Commit**

```bash
git add infra/lambda/whatsapp/webhook.ts infra/lambda/whatsapp/processor.ts infra/lib/stacks/whatsapp-stack.ts infra/test/unit
git commit -m "feat: serialize WhatsApp v2 inbound messages"
```

### Task 6: Implement V2 Entry, OTP, Legal, and Command Gating

**Files:**
- Create: `infra/lambda/whatsapp/onboarding-v2.ts`
- Modify: `infra/lambda/whatsapp/processor.ts`
- Modify: `infra/lambda/whatsapp/lib/interactive-templates.ts`
- Modify: `infra/lambda/whatsapp/lib/templates.ts`
- Create: `infra/test/unit/lambda/whatsapp/onboarding-v2.test.ts`
- Modify: `infra/test/unit/lambda/whatsapp/lib/interactive-templates.test.ts`

**Interfaces:**
- Produces `routeOnboardingV2(client, session, message, deps): Promise<RouteResult>`.
- `RouteResult` is `{ handled: true; workerId: string | null; stepKey: string }`.

- [ ] **Step 1: Write failing transition-table tests**

Cover arbitrary first contact, Start buttons/text, English/Spanish preference, cross-language commands, Start cooldowns, existing-phone candidate without binding, OTP success/expiry/resend/lock, legal accept/decline/review, and rejection of `JOBS`, `CHATS`, and `PROFILE` during onboarding.

- [ ] **Step 2: Run and confirm failure**

```bash
cd infra
npx jest test/unit/lambda/whatsapp/onboarding-v2.test.ts test/unit/lambda/whatsapp/lib/interactive-templates.test.ts --runInBand
```

- [ ] **Step 3: Implement step routing with injected adapters**

Inject `Clock`, `IdentityAdapter`, and `WorkflowMessenger`; do not call Cognito/Twilio from pure transition functions. Persist an identity challenge before invoking OTP delivery. Bind `user_id` and advance to `legal.review` only after the adapter returns verified. Reuse the current legal version/template helpers but write v2 transitions.

Use these step keys: `start.choose_language`, `identity.verify_otp`, `legal.review`, `profile.name`, `profile.location`, `profile.trade`, `profile.custom_trade`, `trust.question.1`, `trust.question.2`, and `trust.question.3`.

- [ ] **Step 4: Run tests and commit**

```bash
cd infra
npx jest test/unit/lambda/whatsapp/onboarding-v2.test.ts test/unit/lambda/whatsapp/processor.test.ts test/unit/lambda/whatsapp/lib/interactive-templates.test.ts --runInBand
git add lambda/whatsapp test/unit/lambda/whatsapp
git commit -m "feat: add gated WhatsApp v2 identity flow"
```

### Task 7: Complete Profile, Trust, and Atomic Readiness

**Files:**
- Modify: `infra/lambda/whatsapp/onboarding-v2.ts`
- Modify: `infra/lambda/whatsapp/lib/profile-flow.ts`
- Modify: `infra/lambda/whatsapp/handlers/custom-trust.ts`
- Modify: `infra/lambda/ai/trust-scorer.ts`
- Modify: `infra/test/unit/lambda/whatsapp/onboarding-v2.test.ts`
- Modify: `infra/test/unit/lambda/whatsapp/profile-flow.test.ts`
- Modify: `infra/test/unit/lambda/whatsapp/custom-trust-handler.test.ts`
- Modify: `infra/test/unit/lambda/ai/trust-scorer.test.ts`

**Interfaces:**
- Consumes `completeOnboarding()` from Task 4.
- Produces `assessment.requested` and `worker.ready` domain events without waiting for AI.

- [ ] **Step 1: Write failing full-profile tests**

Cover names 2–100 characters, ZIP-derived location and `City, State` fallback, all six trade choices, three fixed trust questions, Other profession normalization, reviewed bilingual AI fallback questions, and final-answer atomic readiness. Assert optional media is offered only after readiness and cannot block it.

- [ ] **Step 2: Run and confirm failure**

```bash
cd infra
npx jest test/unit/lambda/whatsapp/onboarding-v2.test.ts test/unit/lambda/whatsapp/profile-flow.test.ts test/unit/lambda/whatsapp/custom-trust-handler.test.ts test/unit/lambda/ai/trust-scorer.test.ts --runInBand
```

- [ ] **Step 3: Implement minimal profile/trust transitions**

Reuse current trade picker and trust definitions. Store question-set/rubric/model provenance on the assessment request. Call `completeOnboarding()` in the same transaction that saves trust answer three. Remove any `processing_ai` wait from the v2 readiness path; AI consumers update only assessment state and scores.

- [ ] **Step 4: Run tests and commit**

```bash
cd infra
npx jest test/unit/lambda/whatsapp/onboarding-v2.test.ts test/unit/lambda/whatsapp/profile-flow.test.ts test/unit/lambda/whatsapp/custom-trust-handler.test.ts test/unit/lambda/ai/trust-scorer.test.ts --runInBand
git add lambda/whatsapp lambda/ai test/unit/lambda
git commit -m "feat: complete WhatsApp v2 onboarding"
```

### Task 8: Defer Producers and Release Grouped Work

**Files:**
- Modify: `infra/lambda/whatsapp/job-alert.ts`
- Modify: `infra/lambda/lib/job-messaging.ts`
- Modify: `infra/lambda/api/employer-conversations-create.ts`
- Modify: `infra/lambda/api/employer-conversations-send.ts`
- Create: `infra/lambda/whatsapp/worker-ready-release.ts`
- Create: `infra/test/unit/lambda/whatsapp/worker-ready-release.test.ts`
- Modify: `infra/test/unit/lambda/whatsapp/job-alert.test.ts`
- Modify: `infra/test/unit/lambda/lib/job-messaging.test.ts`

**Interfaces:**
- Job alerts submit category `job_alert`; employer sends submit `employer_chat` while retaining `job_conversation_messages` as source of truth.
- Release handler consumes a `worker.ready` event key and returns `{ released, expired, superseded, failed }` counts.

- [ ] **Step 1: Write failing defer/release tests**

At every onboarding step, create job and employer intents and assert no sendable Twilio row. At readiness, assert invalid/expired sources are discarded; up to ten valid jobs become one digest; one employer conversation gets the existing invite; multiple conversations get one Chats summary; employer notification is last; concurrent releases produce one sequence.

- [ ] **Step 2: Run and confirm failure**

```bash
cd infra
npx jest test/unit/lambda/whatsapp/worker-ready-release.test.ts test/unit/lambda/whatsapp/job-alert.test.ts test/unit/lambda/lib/job-messaging.test.ts --runInBand
```

- [ ] **Step 3: Redirect producers through the gateway**

Keep employer message inserts and conversation creation unchanged, but replace immediate outbox creation with `enqueueWorkerMessage()`. Use `job-alert:<jobId>:<workerId>` and `employer-chat:<messageId>` dedupe keys. Set job expiry to 72 hours and employer expiry to seven days.

The release handler must lock/lease intents, reload source rows, evaluate policy again, allocate one contiguous per-worker sequence, and commit authorized outbox rows before any transport send.

- [ ] **Step 4: Run tests and commit**

```bash
cd infra
npx jest test/unit/lambda/whatsapp/worker-ready-release.test.ts test/unit/lambda/whatsapp/job-alert.test.ts test/unit/lambda/lib/job-messaging.test.ts test/unit/lambda/whatsapp/lib/outbox.test.ts --runInBand
git add lambda/whatsapp lambda/lib lambda/api test/unit/lambda
git commit -m "feat: defer and group worker messages"
```

### Task 9: Add Exact-Target Clean Reset

**Files:**
- Create: `infra/scripts/reset-whatsapp-onboarding-v2.ts`
- Create: `infra/test/unit/scripts/reset-whatsapp-onboarding-v2.test.ts`
- Modify: `infra/package.json`

**Interfaces:**
- CLI requires `--user-id`, `--phone`, `--reason`, and either `--dry-run` or `--execute`.
- No list, wildcard, phone-only, or all-users mode exists.

- [ ] **Step 1: Write failing parser and SQL-boundary tests**

Assert missing flags fail closed, dry-run performs only counts, mismatched phone aborts, execute deletes only target-related onboarding/matching/application/chat rows, immutable legal rows and core user/Cognito values remain, and repeated reset produces the same `awaiting_start` v2 state.

- [ ] **Step 2: Run and confirm failure**

```bash
cd infra
npx jest test/unit/scripts/reset-whatsapp-onboarding-v2.test.ts --runInBand
```

- [ ] **Step 3: Implement the command**

Resolve the worker using both UUID and normalized verified phone inside one transaction. Print table/count JSON before mutation. Require the literal `--execute`; otherwise roll back. Insert `worker_reset_audit`, clear exact dependent rows in foreign-key order, clear target profile/trade/trust fields, and create one active v2 workflow at `start.choose_language`.

Add script:

```json
"reset:whatsapp-v2": "ts-node scripts/reset-whatsapp-onboarding-v2.ts"
```

- [ ] **Step 4: Run tests and commit**

```bash
cd infra
npx jest test/unit/scripts/reset-whatsapp-onboarding-v2.test.ts --runInBand
git add scripts/reset-whatsapp-onboarding-v2.ts test/unit/scripts/reset-whatsapp-onboarding-v2.test.ts package.json
git commit -m "feat: add exact-target WhatsApp reset"
```

### Task 10: Build the Deterministic Local Conversation Testbed

**Files:**
- Create: `infra/test/helpers/whatsapp-v2-harness.ts`
- Create: `infra/test/unit/lambda/whatsapp/onboarding-v2-conversation.test.ts`
- Create: `infra/test/unit/db/whatsapp-onboarding-concurrency.integration.test.ts`
- Modify: `infra/package.json`

**Interfaces:**
- Harness exposes `sendText`, `pressButton`, `advanceTime`, `injectEmployerMessage`, `injectJobAlert`, `failAdapter`, and state/outbox readers.
- Uses real handler functions and deterministic adapters; PostgreSQL concurrency suite uses `JALE_TEST_DATABASE_URL`.

- [ ] **Step 1: Implement the failing end-to-end scenario first**

Write one scenario that starts unverified, chooses Spanish, uses an English command, verifies OTP, accepts legal, completes profile/trust, receives deferred job/chat groups, selects the correct chat, and replies. Inject Manuel's stale-state sequence, duplicate SIDs, double button taps, AI failure, Twilio failure, and a concurrent release.

- [ ] **Step 2: Run and confirm the harness exposes remaining gaps**

```bash
cd infra
npx jest test/unit/lambda/whatsapp/onboarding-v2-conversation.test.ts --runInBand
```

- [ ] **Step 3: Complete deterministic adapters and database concurrency assertions**

Use an injected clock rather than mocking global time. Fake Cognito/Twilio/Bedrock/SQS at their adapter interfaces. Run the concurrency suite against PostgreSQL to prove row locks, unique SIDs, one active workflow, one release lease, and one outbound sequence.

Add script:

```json
"test:whatsapp-v2": "jest test/unit/lambda/whatsapp/onboarding-v2-conversation.test.ts --runInBand"
```

- [ ] **Step 4: Run the complete disposable database gate**

```bash
bash /home/hermesgoma/.codex/skills/psql-migration-testbed/scripts/run-psql-migration-testbed.sh \
  --repo . -- \
  bash -lc 'cd infra && JALE_TEST_DATABASE_URL="$JALE_TEST_DATABASE_URL" npx jest test/unit/db/migrations.test.ts test/unit/db/migrations/apply-order.test.ts test/unit/db/whatsapp-onboarding-042.integration.test.ts test/unit/db/whatsapp-onboarding-concurrency.integration.test.ts test/unit/lambda/whatsapp/onboarding-v2-conversation.test.ts --runInBand'
```

- [ ] **Step 5: Commit**

```bash
git add infra/test/helpers infra/test/unit/lambda/whatsapp/onboarding-v2-conversation.test.ts infra/test/unit/db/whatsapp-onboarding-concurrency.integration.test.ts infra/package.json
git commit -m "test: add local WhatsApp v2 conversation gate"
```

### Task 11: Wire Release Consumers, Controls, and Alarms

**Files:**
- Modify: `infra/lib/stacks/whatsapp-stack.ts`
- Modify: `infra/test/unit/stacks/whatsapp-stack.test.ts`
- Modify: `infra/lambda/whatsapp/worker-ready-release.ts`
- Create: `infra/lambda/whatsapp/domain-outbox-drain.ts`
- Create: `infra/test/unit/lambda/whatsapp/domain-outbox-drain.test.ts`

**Interfaces:**
- Scheduled drain claims `assessment.requested` and `worker.ready` events with bounded batches.
- Runtime controls are database-backed and can stop v2 entry and deferred delivery independently without deployment.

- [ ] **Step 1: Write failing stack and drain tests**

Assert a bounded scheduled drain, least-privilege secret access, retry count five, stuck-event alarm, deferred-backlog age alarm, OTP lock-rate alarm, and no direct Twilio permission for the domain-event producer.

- [ ] **Step 2: Run and confirm failure**

```bash
cd infra
npx jest test/unit/lambda/whatsapp/domain-outbox-drain.test.ts test/unit/stacks/whatsapp-stack.test.ts --runInBand
```

- [ ] **Step 3: Add the scheduled consumer and metrics**

Claim events with `FOR UPDATE SKIP LOCKED`, mark processing before dispatch, use stable event keys, cap attempts at five, and store next-attempt times. Emit structured metrics without OTP values or raw message bodies.

- [ ] **Step 4: Run tests, build, and synth**

```bash
cd infra
npm run build
npx jest test/unit/lambda/whatsapp/domain-outbox-drain.test.ts test/unit/stacks/whatsapp-stack.test.ts --runInBand
CDK_DEFAULT_ACCOUNT=111111111111 CDK_DEFAULT_REGION=us-east-2 npx cdk synth --all -c environment=dev -c skipFrontend=true -c emailFromAddress=ci-synth@jaleapp.ai -c sesVerifiedIdentityArn=arn:aws:ses:us-east-2:111111111111:identity/jaleapp.ai -c whatsappStatusCallbackUrl=https://api.example.invalid/whatsapp/status-callback -c whatsappAlarmTopicArn=arn:aws:sns:us-east-2:111111111111:jale-ci-whatsapp-alarms
```

- [ ] **Step 5: Commit**

```bash
git add infra/lib/stacks/whatsapp-stack.ts infra/lambda/whatsapp infra/test/unit
git commit -m "feat: operate WhatsApp v2 release workers"
```

### Task 12: Final Verification and Production Runbook

**Files:**
- Create: `docs/runbooks/whatsapp-onboarding-v2-rollout.md`
- Modify: `docs/superpowers/specs/2026-07-21-whatsapp-onboarding-gate-design.md` only if implementation reveals an approved design correction.

**Interfaces:**
- Runbook contains exact read-only inspection, runtime-control, dry-run reset, execute reset, go/no-go, and disable commands.

- [ ] **Step 1: Write the rollout runbook**

Include: prerequisite test outputs; migration application; CDK diff review; controls initially disabled; exact user ID plus phone dry run; first-user reset; test job/application/employer message creation; per-step database inspection; readiness/release inspection; log/DLQ checks; controls for the other two users; and failure procedure that leaves deferred delivery off.

- [ ] **Step 2: Run all local verification from a clean disposable database**

```bash
cd infra
npm run build
npm test -- --runInBand
cd ..
bash /home/hermesgoma/.codex/skills/psql-migration-testbed/scripts/run-psql-migration-testbed.sh --repo .
cd infra
CDK_DEFAULT_ACCOUNT=111111111111 CDK_DEFAULT_REGION=us-east-2 npx cdk synth --all -c environment=dev -c skipFrontend=true -c emailFromAddress=ci-synth@jaleapp.ai -c sesVerifiedIdentityArn=arn:aws:ses:us-east-2:111111111111:identity/jaleapp.ai -c whatsappStatusCallbackUrl=https://api.example.invalid/whatsapp/status-callback -c whatsappAlarmTopicArn=arn:aws:sns:us-east-2:111111111111:jale-ci-whatsapp-alarms
CDK_DEFAULT_ACCOUNT=111111111111 CDK_DEFAULT_REGION=us-east-2 npx cdk diff --all --no-change-set -c environment=dev -c skipFrontend=true -c emailFromAddress=ci-synth@jaleapp.ai -c sesVerifiedIdentityArn=arn:aws:ses:us-east-2:111111111111:identity/jaleapp.ai -c whatsappStatusCallbackUrl=https://api.example.invalid/whatsapp/status-callback -c whatsappAlarmTopicArn=arn:aws:sns:us-east-2:111111111111:jale-ci-whatsapp-alarms
```

Expected: build and all tests pass; PostgreSQL migrations apply through 042; synth succeeds; diff contains only reviewed additive v2 resources and permissions. Do not deploy from this step.

- [ ] **Step 3: Perform security-focused differential review**

Use the `differential-review` skill against the complete branch. Resolve any finding that permits pre-OTP binding, gate bypass, cross-worker data access, broad reset targets, raw-phone leakage, or duplicate delivery.

- [ ] **Step 4: Re-run the complete gate after review fixes**

Repeat Step 2 and record command output/commit SHA in the runbook handoff section.

- [ ] **Step 5: Commit documentation**

```bash
git add -f docs/runbooks/whatsapp-onboarding-v2-rollout.md docs/superpowers/specs/2026-07-21-whatsapp-onboarding-gate-design.md
git commit -m "docs: add WhatsApp v2 rollout runbook"
```

## Self-Review Results

- Spec coverage: all approved identity, lifecycle, language, OTP, legal, profile/trust, assessment, gating, deferred delivery, employer-chat reuse, FIFO, failure, reset, local-test, rollout, and deadline-scope requirements map to Tasks 1–12.
- Placeholder scan: the plan contains no deferred implementation markers; post-deadline work is explicitly excluded in Global Constraints.
- Type consistency: `WorkerMessageIntentInput`, `DeliveryDecision`, `enqueueWorkerMessage()`, `completeOnboarding()`, `routeOnboardingV2()`, and the domain event names are defined once and consumed by later tasks with matching names.
