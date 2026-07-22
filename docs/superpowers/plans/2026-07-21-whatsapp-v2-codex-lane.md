# WhatsApp V2 — Codex Integration Lane Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Date:** 2026-07-21
**Lane:** `feat/wa-v2-integration` in `.worktrees/wa-v2-integration` (Codex merge captain)
**Canonical sources:** `docs/superpowers/specs/2026-07-21-whatsapp-onboarding-gate-design.md` and `docs/superpowers/plans/2026-07-21-whatsapp-onboarding-gate.md`

**Goal:** Deliver every Codex-owned half of the WhatsApp v2 onboarding gate — shared contracts, migration `042`, repository primitives, runtime controls, the delivery policy/gateway, SM/MM validation, FIFO inbound infrastructure, producer deferral and grouped release, exact-target reset, PostgreSQL security/concurrency gates, rollout tooling, and final integration — so that the workflow lane can land on a stable, already-verified substrate.

**Architecture:** Add additive v2 records beside the legacy WhatsApp tables. Every worker-directed business message becomes a typed durable intent evaluated by a pure policy and persisted by one gateway; only gateway-authorized rows may reach Twilio. Inbound v2 events serialize through an SQS FIFO queue keyed by a one-way phone hash with `MessageSid` deduplication. Readiness publishes transactional-outbox events that a leased, bounded consumer turns into one ordered per-worker release sequence.

**Tech Stack:** TypeScript 5.9, Node.js Lambda, Jest 30, PostgreSQL 16, AWS CDK/SQS FIFO, Twilio WhatsApp/SMS, `pg` 8.

---

## Global Constraints

These are binding on every task agent in this lane.

- Read `docs/superpowers/specs/2026-07-21-whatsapp-onboarding-gate-design.md` and `docs/superpowers/plans/2026-07-21-whatsapp-onboarding-gate.md` in full before editing anything.
- The additive migration is `042_whatsapp_onboarding_gate.sql`. Do not edit migrations `001` through `041`. Superseding a `040` function via `CREATE OR REPLACE` inside `042` is additive and allowed; editing `040` itself is not.
- Do not drop or rename legacy WhatsApp tables or columns. Legacy flow must keep working for non-allowlisted workers.
- Only the delivery gateway may create sendable worker-directed WhatsApp outbox rows. **(Contract-repair note, 2026-07-22 — Design A):** this governs *user-bound* (`source_type = 'worker_intent'`) rows via `enqueueWorkerMessage`. Pre-auth prompts (pre-OTP, no `user_id`) are a distinct, already-sanctioned origin class: the phone/`inbound_message_sid` reply row (`inbound_message_sid IS NOT NULL AND source_type IS NULL`), written by the existing legacy inbound-reply writers. Pre-auth delivery must never use the `worker_intent` origin and never mints a *new* sendable-outbox writer.
- Successful OTP verification is the only identity-binding operation. Nothing in this lane may bind `user_id` from a phone lookup.
- Never target RDS from a local test. The database gate uses disposable PostgreSQL 16 through `JALE_TEST_DATABASE_URL`.
- Do not add LocalStack, a cloud sandbox, a trade-change UI, or an admin dashboard.
- Keep existing untracked `demo-ready-windows/` and `reports/` untouched.
- Do not push, deploy, run RDS migrations, or reset any production worker. Every task stops at a local commit.
- Task agents work in disposable worktrees branched from this lane's persistent branch. They never edit `.worktrees/wa-v2-claude`.

## Binding Cross-Lane Resolutions

These resolutions were produced by the independent Claude/Codex plan comparison and supersede any conflicting task prose below.

1. **Pre-OTP persistence:** no `worker_workflow_runs` row exists before verified OTP because `user_id` remains required. Migration `042` extends `worker_identity_challenges` with `provider_challenge_id`, `preferred_language`, `current_step_key` restricted to `start.choose_language | identity.verify_otp`, and `context`; `expires_at` is nullable until a provider challenge is issued. Start cooldown history, language choice, resend state, candidate lookup, and OTP attempts live there. A phone lookup may populate `candidate_user_id` but never `verified_user_id`, `whatsapp_conversations.user_id`, lifecycle, or a workflow run.
2. **Verified binding boundary:** C4 provides exact phone-hash pre-auth repository operations plus `bindVerifiedIdentityAndStartWorkflow(...)`. Only that function, called after the identity adapter returns `verified`, marks the challenge verified, binds the conversation, creates `worker_onboarding_state`, creates the one active user-bound run at `legal.review`, and appends the OTP-success transition in the caller's existing transaction.
3. **Workflow persistence contract:** C4 also provides `advanceWorkflow(...)` with an `expectedLockVersion` guard and context patch, in addition to `loadWorkerGate`, `appendTransition`, and `completeOnboarding`. Claude uses these functions rather than lane-local SQL for new v2 tables.
4. **Atomic final answer:** Claude persists trust answer three with its profile/trust adapter and then calls `completeOnboarding` on the same `PoolClient` and inside the same existing processor transaction. `completeOnboarding` owns lifecycle/run/transition/domain-event changes; it does not own the legacy trust-answer table. A rollback reverses all five effects.
5. **One ready confirmation:** the workflow lane does not enqueue a ready confirmation after answer three. C6's `worker.ready` release group emits the sole onboarding-complete confirmation first.
6. **Renderer contracts:** C2 owns `CategoryRenderer`, `ReleaseRenderRequest`, `ReleaseRenderedMessage`, and `ReleaseRenderer` as shared types. C4's registry consumes the shared `CategoryRenderer`; Claude Task 3 implements and registers onboarding/security renderers matching that exact async `(client, input)` contract. The renderer may make parameterized DB reads for recipient/language, but performs no network call, clock read, enqueue, or send. C6 imports the shared release types and consumes Claude's `createReleaseRenderer()`; it does not redeclare them.
7. **Terminal states:** `declined` and `completed` are workflow-run statuses, never `WorkflowStepKey` values. Migration `042` adds a check constraint limiting active `current_step_key` values to the canonical ten keys.
8. **Processor gate:** the workflow processor test includes a FIFO-shaped SQS record. Once DB controls select v2, dependency/router failure rolls back and retries; it never falls through to legacy.
9. **Observability ownership:** C7 installs drain metrics on the drain log group and `WhatsAppOtpLock` on the processor log group. Generator fallback remains a structured diagnostic event but does not gain a new alarm unless the canonical alarm set is separately amended.
10. **Bootstrap and task mapping:** Codex C2 owns types, runtime controls, policy, and renderer contracts; C3 owns migration `042`; C4 owns repository/gateway primitives. All Claude implementation tasks, including the relay fix, begin only after C2-C4 are reviewed, merged into the workflow branch, and the PostgreSQL `042` gate passes.

---
## Ownership Exclusions (apply to every task)

The workflow lane (`feat/wa-v2-workflow`, Claude Opus) owns these files. **No task in this plan may create or modify them:**

- `infra/lambda/whatsapp/processor.ts`
- `infra/lambda/whatsapp/onboarding-v2.ts` (onboarding step router and command gate)
- `infra/lambda/whatsapp/lib/conversation-router.ts`
- `infra/lambda/whatsapp/lib/profile-flow.ts`
- `infra/lambda/whatsapp/handlers/custom-trust.ts`
- `infra/lambda/whatsapp/lib/templates.ts`
- `infra/lambda/whatsapp/lib/interactive-templates.ts`
- `infra/lambda/ai/trust-scorer.ts`
- `infra/test/unit/lambda/whatsapp/processor.test.ts`
- `infra/test/unit/lambda/whatsapp/lib/conversation-router.test.ts`
- `infra/test/unit/lambda/whatsapp/lib/templates.test.ts`
- `infra/test/unit/lambda/whatsapp/lib/interactive-templates.test.ts`
- `infra/test/unit/lambda/whatsapp/profile-flow.test.ts`
- `infra/test/unit/lambda/whatsapp/custom-trust-handler.test.ts`
- `infra/test/unit/lambda/whatsapp/onboarding-conversation.test.ts`

Consequences that agents must respect rather than work around:

- The pre-OTP employer-relay defect in `conversation-router.ts` is **not** fixed in this lane. Task C1 fixes only the `SM`-only SID defect.
- No task adds new bilingual worker-facing message strings. Where a new worker-facing string is unavoidable (the grouped release), this plan defines an **injected renderer interface** owned by Codex and **implemented** by the workflow lane. See Task C6.
- No task wires v2 behavior selection inside `processor.ts`. Codex exposes `isV2Enabled()` and the v2 queue; the workflow lane consumes them.

## Canonical Commands

Deterministic CDK synth (use verbatim; environment-less `npx cdk synth --quiet` is invalid on this base):

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

Disposable PostgreSQL 16 testbed wrapper (run from the repository root):

```bash
bash /home/hermesgoma/.codex/skills/psql-migration-testbed/scripts/run-psql-migration-testbed.sh --repo .
```

Tasks C3 and C9 provide their exact focused Jest commands when a subset of the PostgreSQL gate is required.

## Dependency Graph and Sequencing

```
C1 (SM/MM TypeScript)      ──────────────┐
C2 (types/controls/policy) ──┬── C4 ──┬── C6 ──┬── C7 ──┐
C3 (migration 042)         ──┘        │        │        ├── C10
                             └── C5 ──────────────┘     │
                             └── C8                     │
                        C3 + C4 + C6 ── C9 ─────────────┘
```

- **Independent starts:** C1, C2, C3 may run concurrently.
- **C4** branches off the post-fix state of C2 **and** C3.
- **C5** branches off the post-fix state of C2.
- **C6** branches off the post-fix state of C4.
- **C7** branches off the post-fix state of C5 **and** C6 (it is the second and last task allowed to edit `infra/lib/stacks/whatsapp-stack.ts`).
- **C8** branches off the post-fix state of C3.
- **C9** branches off the post-fix state of C6 (which transitively includes C3 and C4).
- **C10** branches off the post-fix state of every other task and additionally consumes the frozen workflow lane.

**Single-owner file rules** (a violation is a review-blocking finding):

| File | Sole owner |
| --- | --- |
| `infra/lambda/whatsapp/lib/twilio.ts` | C1 |
| `infra/lambda/whatsapp/status-callback.ts` | C1 |
| `infra/lambda/whatsapp/lib/outbox.ts` | C1 first, then C4 (sequenced; C4 branches after C1 has merged into the lane branch) |
| `infra/db/migrations/042_whatsapp_onboarding_gate.sql` | C3 |
| `infra/test/unit/db/whatsapp-onboarding-042.integration.test.ts` | C3 |
| `infra/test/unit/db/whatsapp-onboarding-concurrency.integration.test.ts` | C9 |
| `infra/lambda/whatsapp/webhook.ts` | C5 |
| `infra/lib/stacks/whatsapp-stack.ts` | C5 first, then C7 (sequenced) |
| `infra/lambda/whatsapp/worker-ready-release.ts` | C6 |
| `infra/lambda/whatsapp/domain-outbox-drain.ts` | C7 |
| `infra/scripts/*.ts` | C8 |
| `docs/runbooks/whatsapp-onboarding-v2-rollout.md` | C10 |

`infra/package.json` is edited by C8 (two script entries) and C10 (one script entry). C10 runs last, so this is sequenced, not concurrent.

## Per-Task Dev-Cycle Review Gate

Every task below ends with the same three-phase gate. The tech lead (orchestrator) performs Review 1 and Review 2 personally; they are never delegated to the implementing agent.

**Review 1 — orchestrator, in the task's worktree**

1. `git diff` against the branch point; read every changed file. Confirm the task's acceptance criteria, that no file from the Ownership Exclusions list changed, and that no file owned by another task changed.
2. Read for correctness: SQL injection, missing `await`, unhandled rejection, transaction boundaries, `ON CONFLICT` targets, unbounded loops, raw phone numbers or OTP values in logs.
3. Run the task's focused command yourself and record the actual output. Also run `cd infra && npm run build`.
4. Write itemized feedback as `file:line — what is wrong — what fixed looks like`. Vague feedback is a gate violation.

**Fix — implementing agent**

Send the itemized feedback with `SendMessage` to the same agent ID (never a fresh dispatch). Ask it to fix, re-run the task's focused command, and report. Skip this phase only when Review 1 produced zero findings.

**Review 2 — orchestrator, final**

1. Re-diff only the changed hunks. For each Review 1 item ask: was the defect fixed, or was the symptom silenced (assertion loosened, `try/catch` swallowing, test skipped, expectation deleted)?
2. Re-run the task's focused command and `npm run build`.
3. Exactly one feedback round. Remaining correctness issues are patched by the orchestrator directly (small) or reported to the user with specifics (large). Style-only nits at Review 2 are non-blocking and are dropped.

---

## File Structure Produced by This Lane

New modules:

- `infra/lambda/whatsapp/lib/onboarding-types.ts` — shared lifecycle, workflow, intent, decision, and domain-event types.
- `infra/lambda/whatsapp/lib/runtime-controls.ts` — database-backed v2/deferred-delivery controls and the one-way phone hash.
- `infra/lambda/whatsapp/lib/delivery-policy.ts` — pure allow/defer/reject/expire policy.
- `infra/lambda/whatsapp/lib/onboarding-repository.ts` — SQL for workflow runs, transitions, gate loads, and atomic readiness.
- `infra/lambda/whatsapp/lib/worker-delivery-gateway.ts` — typed intent persistence and outbox authorization.
- `infra/lambda/whatsapp/worker-ready-release.ts` — lease, revalidate, group, order, and release deferred intents.
- `infra/lambda/whatsapp/domain-outbox-drain.ts` — bounded scheduled domain-event consumer.
- `infra/scripts/reset-whatsapp-onboarding-v2.ts` — exact-target dry-run/execute reset.
- `infra/scripts/whatsapp-runtime-controls.ts` — read/modify runtime controls.
- `infra/db/migrations/042_whatsapp_onboarding_gate.sql` — the additive v2 data model.
- `docs/runbooks/whatsapp-onboarding-v2-rollout.md` — production rollout runbook.

---

### Task C1: Accept Both `SM` and `MM` Twilio Identifiers in TypeScript

**Depends on:** nothing. May start immediately.

**Files:**
- Modify: `infra/lambda/whatsapp/lib/twilio.ts`
- Modify: `infra/lambda/whatsapp/lib/outbox.ts`
- Modify: `infra/lambda/whatsapp/status-callback.ts`
- Modify: `infra/test/unit/lambda/whatsapp/lib/twilio.test.ts`
- Modify: `infra/test/unit/lambda/whatsapp/lib/outbox.test.ts`
- Modify: `infra/test/unit/lambda/whatsapp/status-callback.test.ts`

**Do not touch:** `conversation-router.ts`, `processor.ts`, or their tests. The pre-OTP relay defect belongs to the workflow lane. `infra/db/migrations/040_whatsapp_delivery_status.sql` is immutable; its `SM`-only SQL guard is fixed by Task C3.

**Interfaces produced:**

```ts
// infra/lambda/whatsapp/lib/twilio.ts
export function isTwilioMessageSid(value: unknown): value is string {
  return typeof value === 'string' && /^(?:SM|MM)[0-9a-fA-F]{32}$/.test(value);
}
```

**Interfaces consumed:** existing `sendTwilioWhatsAppMessage()` in `outbox.ts` and the `status-callback.ts` handler.

**Known `SM`-only literals in the repository** (confirmed by inspection; the whole in-lane set):

| Location | Current | Owner |
| --- | --- | --- |
| `infra/lambda/whatsapp/lib/outbox.ts:10` | `const TWILIO_SID_RE = /^SM[0-9A-Fa-f]{32}$/` | C1 |
| `infra/lambda/whatsapp/status-callback.ts:7` | `const SID_RE = /^SM[0-9A-Fa-f]{32}$/` | C1 |
| `infra/db/migrations/040_whatsapp_delivery_status.sql:313` | `p_twilio_message_sid !~ '^SM[0-9A-Fa-f]{32}$'` | C3 |

- [ ] **Step 1: Write the failing validation tests**

In `twilio.test.ts` add a table-driven suite for `isTwilioMessageSid`: `SM` + 32 hex and `MM` + 32 hex pass; `SM` + 31 hex, `SM` + 33 hex, `XX` + 32 hex, uppercase-only non-hex, `null`, `undefined`, a number, and a string with leading/trailing whitespace all fail.

```ts
it.each([
  `SM${'a'.repeat(32)}`,
  `MM${'0'.repeat(32)}`,
  `MM${'A1b2C3d4'.repeat(4)}`,
])('accepts Twilio messaging SID %s', (sid) => {
  expect(isTwilioMessageSid(sid)).toBe(true);
});

it.each([
  `SM${'a'.repeat(31)}`,
  `SM${'a'.repeat(33)}`,
  `XX${'a'.repeat(32)}`,
  `SM${'g'.repeat(32)}`,
  ` SM${'a'.repeat(32)}`,
  null,
  undefined,
  12345,
])('rejects %p', (value) => {
  expect(isTwilioMessageSid(value)).toBe(false);
});
```

In `outbox.test.ts` add a case where the Twilio `Messages.json` stub returns `{ sid: 'MM' + 32 hex }` and assert `sendTwilioWhatsAppMessage()` resolves with that SID and does **not** throw `AmbiguousTwilioSendError`. Keep an existing-shaped case asserting a malformed SID still throws `AmbiguousTwilioSendError`.

In `status-callback.test.ts` add a signed-callback case whose `MessageSid` is `MM` + 32 hex and assert the handler reaches the database call (the mocked `pool.query` receives that SID) and returns `200`, instead of returning `400 malformed body`.

- [ ] **Step 2: Run the focused tests and confirm failure**

```bash
cd infra
npx jest test/unit/lambda/whatsapp/lib/twilio.test.ts test/unit/lambda/whatsapp/lib/outbox.test.ts test/unit/lambda/whatsapp/status-callback.test.ts --runInBand
```

Expected: FAIL. `twilio.test.ts` fails on `isTwilioMessageSid is not a function`; `outbox.test.ts` fails with `AmbiguousTwilioSendError: Twilio response missing a valid message SID`; `status-callback.test.ts` fails with a `400` where `200` was expected.

- [ ] **Step 3: Centralize the validator and adopt it in all three call sites**

Add the exported `isTwilioMessageSid` shown above to `lib/twilio.ts`. In `outbox.ts` delete the module-level `TWILIO_SID_RE` and replace the check at the response-SID guard with `!isTwilioMessageSid(sid)`, importing from `./twilio`. In `status-callback.ts` delete `SID_RE` and replace `!SID_RE.test(sid)` with `!isTwilioMessageSid(sid)`, importing from `./lib/twilio`. Do not change the ambiguous-send semantics, the status regex, the error-code regex, or the 1000-character error-message bound. Update the `SM...` wording in the `outbox.ts` comment block so it reads `SM.../MM...`.

- [ ] **Step 4: Re-run the focused tests**

```bash
cd infra
npx jest test/unit/lambda/whatsapp/lib/twilio.test.ts test/unit/lambda/whatsapp/lib/outbox.test.ts test/unit/lambda/whatsapp/status-callback.test.ts --runInBand
npm run build
```

Expected: all three suites pass; `tsc` exits 0.

- [ ] **Step 5: Confirm no `SM`-only literal remains in TypeScript**

```bash
cd infra
grep -rn "SM\[0-9A-Fa-f\]\{32\}\|SM\[0-9a-fA-F\]\{32\}" lambda/ | grep -v "SM|MM"
```

Expected: no output.

- [ ] **Step 6: Dev-cycle review gate**

Run Review 1 / Fix / Review 2 exactly as defined in *Per-Task Dev-Cycle Review Gate*. Review 1 must specifically confirm the validator is a single exported function used by all three sites (no re-inlined regex), and that no other behavior in `status-callback.ts` changed.

- [ ] **Step 7: Commit**

```bash
git add infra/lambda/whatsapp/lib/twilio.ts infra/lambda/whatsapp/lib/outbox.ts infra/lambda/whatsapp/status-callback.ts infra/test/unit/lambda/whatsapp
git commit -m "fix: accept MM Twilio messaging identifiers"
```

**Handoff:** `isTwilioMessageSid` is now importable by any lane. The workflow lane must use it rather than writing a new regex. Task C3 completes the SM/MM requirement on the database side.

---

### Task C2: Shared Types, Runtime Controls, and the Pure Delivery Policy

**Depends on:** nothing. May start immediately.

**Files:**
- Create: `infra/lambda/whatsapp/lib/onboarding-types.ts`
- Create: `infra/lambda/whatsapp/lib/runtime-controls.ts`
- Create: `infra/lambda/whatsapp/lib/delivery-policy.ts`
- Create: `infra/test/unit/lambda/whatsapp/lib/runtime-controls.test.ts`
- Create: `infra/test/unit/lambda/whatsapp/lib/delivery-policy.test.ts`

**Do not touch:** any existing file. This task is purely additive. `delivery-policy.ts` performs no I/O — no `pg`, no `fetch`, no AWS SDK import.

**Interfaces produced — implement these exactly:**

```ts
// infra/lambda/whatsapp/lib/onboarding-types.ts
export type WorkerLifecycle = 'onboarding' | 'ready' | 'suspended';

export type WorkflowStepKey =
  | 'start.choose_language'
  | 'identity.verify_otp'
  | 'legal.review'
  | 'profile.name'
  | 'profile.location'
  | 'profile.trade'
  | 'profile.custom_trade'
  | 'trust.question.1'
  | 'trust.question.2'
  | 'trust.question.3';

export type WorkflowRunStatus =
  | 'active' | 'completed' | 'declined' | 'cancelled' | 'failed';

export type MessageCategory =
  | 'onboarding' | 'security' | 'account' | 'job_alert' | 'employer_chat';

export type OwnerService =
  | 'onboarding-v2' | 'identity' | 'job-alert' | 'job-messaging' | 'account';

export type IntentStatus =
  | 'deferred' | 'eligible' | 'leased' | 'released' | 'delivered'
  | 'expired' | 'superseded' | 'rejected' | 'failed';

export type PreferredLanguage = 'en' | 'es';

export const DELIVERY_POLICY_VERSION = 1;

export type DeliveryDecision =
  | { action: 'allow'; reason: 'workflow_message' | 'security_message' | 'worker_ready' }
  | { action: 'defer'; reason: 'worker_onboarding' | 'delivery_disabled' }
  | { action: 'reject'; reason: 'worker_suspended' | 'invalid_owner' }
  | { action: 'expire'; reason: 'intent_expired' };

export interface WorkerMessageIntentInput {
  workerId: string;
  category: MessageCategory;
  ownerService: OwnerService;
  sourceType: string;
  sourceId: string;
  dedupeKey: string;
  priority: number;
  expiresAt: Date | null;
  payload: Record<string, unknown>;
}

export type DomainEventType = 'assessment.requested' | 'worker.ready';

/** Shared renderer contracts consumed by both lanes. */
export type ReleaseRenderRequest =
  | { kind: 'onboarding_complete'; workerId: string; language: PreferredLanguage }
  | { kind: 'account_notice'; workerId: string; language: PreferredLanguage; sourceType: string; sourceId: string }
  | { kind: 'job_alert_digest'; workerId: string; language: PreferredLanguage; jobs: ReadonlyArray<{ jobId: string; title: string; companyName: string; score: number }> }
  | { kind: 'employer_chat_single'; workerId: string; language: PreferredLanguage; conversationId: string; companyName: string; jobTitle: string }
  | { kind: 'employer_chat_summary'; workerId: string; language: PreferredLanguage; conversationCount: number };
export interface ReleaseRenderedMessage { body: string | null; contentTemplate: string | null; contentVariables: Record<string, string> | null; }
export interface ReleaseRenderer { render(request: ReleaseRenderRequest): Promise<ReleaseRenderedMessage>; }
export interface RenderedOutboxMessage { whatsappNumber: string; body: string | null; contentTemplate: string | null; contentVariables: Record<string, string> | null; }
export type CategoryRenderer = (client: PoolClient, input: WorkerMessageIntentInput) => Promise<RenderedOutboxMessage | null>;
```

```ts
// infra/lambda/whatsapp/lib/runtime-controls.ts
import type { PoolClient } from 'pg';

export interface RuntimeControls {
  onboardingV2Enabled: boolean;
  onboardingV2GlobalEnabled: boolean;
  onboardingV2PhoneHashes: ReadonlySet<string>;
  deferredDeliveryEnabled: boolean;
}

/** Lowercase hex SHA-256 of the E.164-normalized phone. Never log the input. */
export function hashNormalizedPhone(phone: string): string;

/** Reads whatsapp_runtime_controls. Missing or malformed rows fail closed to disabled. */
export function loadRuntimeControls(client: PoolClient): Promise<RuntimeControls>;

export function isV2Enabled(controls: RuntimeControls, phoneHash: string): boolean;

export function isDeferredDeliveryEnabled(controls: RuntimeControls): boolean;
```

```ts
// infra/lambda/whatsapp/lib/delivery-policy.ts
import type {
  DeliveryDecision, MessageCategory, OwnerService, WorkerLifecycle,
} from './onboarding-types';
import type { RuntimeControls } from './runtime-controls';

export interface DeliveryEvaluationInput {
  lifecycle: WorkerLifecycle;
  category: MessageCategory;
  ownerService: OwnerService;
  controls: RuntimeControls;
  expiresAt: Date | null;
  /** True when a job conversation is currently focused. Must not change the outcome. */
  hasFocusedConversation?: boolean;
}

export function evaluateDelivery(
  input: DeliveryEvaluationInput,
  now: Date,
): DeliveryDecision;
```

**Required policy semantics** (assert every row):

| Condition (evaluated in this order) | Decision |
| --- | --- |
| `expiresAt !== null && expiresAt <= now` | `{ action: 'expire', reason: 'intent_expired' }` |
| `category === 'onboarding' && ownerService !== 'onboarding-v2'` | `{ action: 'reject', reason: 'invalid_owner' }` |
| `category === 'security' && ownerService !== 'identity'` | `{ action: 'reject', reason: 'invalid_owner' }` |
| `category === 'onboarding'` (correct owner) | `{ action: 'allow', reason: 'workflow_message' }` |
| `category === 'security'` (correct owner) | `{ action: 'allow', reason: 'security_message' }` |
| `lifecycle === 'suspended'` | `{ action: 'reject', reason: 'worker_suspended' }` |
| `lifecycle === 'onboarding'` | `{ action: 'defer', reason: 'worker_onboarding' }` |
| `lifecycle === 'ready' && !deferredDeliveryEnabled` | `{ action: 'defer', reason: 'delivery_disabled' }` |
| `lifecycle === 'ready' && deferredDeliveryEnabled` | `{ action: 'allow', reason: 'worker_ready' }` |

Onboarding and security decisions are evaluated before the lifecycle branches so that OTP, legal, and step prompts are never blocked by the deferred-delivery kill switch. `hasFocusedConversation: true` never changes any outcome.

- [ ] **Step 1: Write the failing control and policy tables**

`runtime-controls.test.ts` must cover, with a stubbed `PoolClient` whose `query()` returns fixture rows:
- absent control rows → both controls disabled;
- a non-boolean/`NULL` enabled value → disabled (fail closed);
- `onboarding_v2_enabled` on with an exact allowlist → `isV2Enabled` true only for a hash in the list;
- `onboarding_v2_enabled` on with the global flag → true for any hash;
- `deferred_delivery_enabled` independent of `onboarding_v2_enabled` in both directions;
- `hashNormalizedPhone('+15551234567')` returns 64 lowercase hex characters, is stable across calls, differs for a different number, and never contains the digits of the input;
- the loader issues no query containing a raw phone number.

`delivery-policy.test.ts` must be a table-driven suite covering every row above plus: an expired `job_alert` while `ready` still returns `expire` (expiry precedes lifecycle); `category: 'onboarding'` with `ownerService: 'job-alert'` returns `invalid_owner`; `category: 'employer_chat'` with `hasFocusedConversation: true` while `onboarding` still returns `defer`/`worker_onboarding`.

- [ ] **Step 2: Run and confirm the missing-module failure**

```bash
cd infra
npx jest test/unit/lambda/whatsapp/lib/runtime-controls.test.ts test/unit/lambda/whatsapp/lib/delivery-policy.test.ts --runInBand
```

Expected: FAIL with `Cannot find module './runtime-controls'` and `Cannot find module './delivery-policy'`.

- [ ] **Step 3: Implement the three modules**

`hashNormalizedPhone` uses `node:crypto` `createHash('sha256')` over the trimmed input and returns `digest('hex')`. `loadRuntimeControls` reads `whatsapp_runtime_controls` by `control_key` and treats anything it cannot parse as disabled. `evaluateDelivery` is a pure function with no `Date.now()`, no `new Date()`, and no imports beyond the two type modules.

- [ ] **Step 4: Run tests and build**

```bash
cd infra
npx jest test/unit/lambda/whatsapp/lib/runtime-controls.test.ts test/unit/lambda/whatsapp/lib/delivery-policy.test.ts --runInBand
npm run build
```

Expected: both suites pass; `tsc` exits 0.

- [ ] **Step 5: Dev-cycle review gate**

Run Review 1 / Fix / Review 2. Review 1 must confirm `delivery-policy.ts` imports nothing beyond the two type modules, that no test asserts a decision this plan does not define, and that fail-closed parsing is real (not `?? true`).

- [ ] **Step 6: Commit**

```bash
git add infra/lambda/whatsapp/lib/onboarding-types.ts infra/lambda/whatsapp/lib/runtime-controls.ts infra/lambda/whatsapp/lib/delivery-policy.ts infra/test/unit/lambda/whatsapp/lib
git commit -m "feat: define WhatsApp v2 types, runtime controls, and delivery policy"
```

**Handoff:** `isV2Enabled(controls, hashNormalizedPhone(from))` is the contract the workflow lane calls inside `processor.ts` to select v2. `hashNormalizedPhone` is also the `MessageGroupId` source in Task C5. `WorkflowStepKey` is the shared step vocabulary; the workflow lane must not invent step keys outside this union without a cross-lane change to this file.

---

### Task C3: Migration 042 — Additive V2 Data Model and MM-Capable Delivery Callback

**Depends on:** nothing. May start immediately.

**Files:**
- Create: `infra/db/migrations/042_whatsapp_onboarding_gate.sql`
- Modify: `infra/test/unit/db/migrations/apply-order.test.ts`
- Modify: `infra/test/unit/db/migrations.test.ts`
- Modify: `scripts/run-migrations.sh`
- Create: `infra/test/unit/db/whatsapp-onboarding-042.integration.test.ts`

**Do not touch:** migrations `001`–`041`; `scripts/run-production-upgrade-020b-040.sh` and `infra/test/unit/scripts/run-production-upgrade-020b-040.test.ts` — that script is a **fixed historical upgrade range (020b→040)** for an already-deployed cluster and must not grow a `042` entry. Do not touch `infra/test/unit/db/whatsapp-onboarding-concurrency.integration.test.ts` (Task C9 owns it).

**Three baseline registration sites — all three are required:**

1. `infra/test/unit/db/migrations/apply-order.test.ts` → append `'042_whatsapp_onboarding_gate.sql'` to `expectedBaselineMigrations`.
2. `infra/test/unit/db/migrations.test.ts` → append `'042'` to the contiguous `numbers` array asserted by `use one contiguous lexical sequence (plus the one documented insertion)`. This is a **second, separate array in a different file**; missing it makes the suite fail.
3. `scripts/run-migrations.sh` → append `"042_whatsapp_onboarding_gate.sql"` to the `MIGRATIONS` array.

**Interfaces produced.** Tables (all UUID primary keys defaulting to `gen_random_uuid()`, all timestamps `TIMESTAMPTZ`, all context/payload columns `JSONB NOT NULL DEFAULT '{}'::jsonb`):

| Table | Required columns |
| --- | --- |
| `worker_onboarding_state` | `id`, `user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE`, `lifecycle TEXT NOT NULL DEFAULT 'onboarding'`, `lifecycle_changed_at`, `ready_at`, `created_at`, `updated_at` |
| `worker_workflow_runs` | `id`, `user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE`, `workflow_version INTEGER NOT NULL`, `current_step_key TEXT NOT NULL`, `status TEXT NOT NULL DEFAULT 'active'`, `preferred_language TEXT NOT NULL DEFAULT 'es'`, `lock_version INTEGER NOT NULL DEFAULT 0`, `context JSONB`, `created_at`, `updated_at`, `completed_at` |
| `worker_workflow_transitions` | `id`, `run_id UUID NOT NULL REFERENCES worker_workflow_runs(id) ON DELETE CASCADE`, `from_step_key TEXT`, `to_step_key TEXT NOT NULL`, `inbound_message_sid TEXT`, `reason TEXT NOT NULL`, `metadata JSONB`, `created_at` |
| `worker_identity_challenges` | `id`, `phone_hash TEXT NOT NULL`, `provider_challenge_id TEXT`, `candidate_user_id UUID REFERENCES users(id) ON DELETE SET NULL`, `verified_user_id UUID REFERENCES users(id) ON DELETE SET NULL`, `preferred_language TEXT NOT NULL DEFAULT 'es'`, `current_step_key TEXT NOT NULL DEFAULT 'start.choose_language'`, `context JSONB`, `status TEXT NOT NULL DEFAULT 'pending'`, `attempts INTEGER NOT NULL DEFAULT 0`, `expires_at TIMESTAMPTZ`, `locked_until`, `created_at`, `updated_at` |
| `worker_message_intents` | `id`, `user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE`, `category TEXT NOT NULL`, `owner_service TEXT NOT NULL`, `source_type TEXT NOT NULL`, `source_id UUID NOT NULL`, `dedupe_key TEXT NOT NULL`, `priority INTEGER NOT NULL`, `status TEXT NOT NULL DEFAULT 'deferred'`, `policy_version INTEGER NOT NULL`, `decision_reason TEXT`, `payload JSONB`, `expires_at`, `release_sequence INTEGER`, `leased_until`, `outbox_id UUID REFERENCES whatsapp_outbox(id) ON DELETE SET NULL`, `created_at`, `updated_at` |
| `worker_domain_outbox` | `id`, `event_type TEXT NOT NULL`, `aggregate_id UUID NOT NULL`, `event_key TEXT NOT NULL`, `payload JSONB`, `status TEXT NOT NULL DEFAULT 'pending'`, `attempts INTEGER NOT NULL DEFAULT 0`, `next_attempt_at`, `last_error TEXT`, `created_at`, `updated_at` |
| `whatsapp_runtime_controls` | `control_key TEXT PRIMARY KEY`, `enabled BOOLEAN NOT NULL DEFAULT false`, `phone_hashes TEXT[] NOT NULL DEFAULT '{}'::text[]`, `global_enabled BOOLEAN NOT NULL DEFAULT false`, `updated_by TEXT`, `updated_at` |
| `worker_reset_audit` | `id`, `user_id UUID NOT NULL`, `phone_hash TEXT NOT NULL`, `operator TEXT NOT NULL`, `reason TEXT NOT NULL`, `table_counts JSONB NOT NULL`, `dry_run BOOLEAN NOT NULL`, `created_at` |

Named constraints (exact names — later tasks and tests reference them):

- `worker_workflow_one_active`: partial unique index on `worker_workflow_runs (user_id) WHERE status = 'active'`.
- `worker_message_intent_dedupe`: unique constraint on `worker_message_intents (dedupe_key)`.
- `worker_domain_outbox_event_key`: unique constraint on `worker_domain_outbox (event_key)`.
- `worker_message_intents_release_sequence_unique`: partial unique index on `(user_id, release_sequence) WHERE release_sequence IS NOT NULL`.

Canonical check constraints (copy verbatim):

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
-- worker_message_intents.category
CHECK (category IN ('onboarding', 'security', 'account', 'job_alert', 'employer_chat'))
-- worker_message_intents.owner_service
CHECK (owner_service IN ('onboarding-v2', 'identity', 'job-alert', 'job-messaging', 'account'))
-- worker_domain_outbox.status
CHECK (status IN ('pending', 'processing', 'completed', 'failed'))
-- worker_domain_outbox.event_type
CHECK (event_type IN ('assessment.requested', 'worker.ready'))
-- worker_identity_challenges.current_step_key
CHECK (current_step_key IN ('start.choose_language', 'identity.verify_otp'))
-- worker_workflow_runs.current_step_key
CHECK (current_step_key IN ('start.choose_language', 'identity.verify_otp', 'legal.review', 'profile.name', 'profile.location', 'profile.trade', 'profile.custom_trade', 'trust.question.1', 'trust.question.2', 'trust.question.3'))
-- worker_workflow_runs.preferred_language
CHECK (preferred_language IN ('en', 'es'))
```

Seed exactly two runtime-control rows, both disabled:

```sql
INSERT INTO whatsapp_runtime_controls (control_key, enabled, global_enabled)
VALUES ('onboarding_v2_enabled', false, false),
       ('deferred_delivery_enabled', false, false)
ON CONFLICT (control_key) DO NOTHING;
```

Security requirements, following the established conventions of migrations `040` and `041`:

- `ENABLE` and `FORCE ROW LEVEL SECURITY` on all seven worker-scoped tables (every table above except `whatsapp_runtime_controls`, which is read-only to `jale_whatsapp` and gets `ENABLE`/`FORCE` plus a read-only policy).
- Grant `jale_whatsapp` **column-scoped** privileges only — never bare `GRANT SELECT ON <table>`. Worker-scoped policies compare `user_id::text = current_setting('app.current_internal_user_id', true)`.
- `whatsapp_runtime_controls`: `GRANT SELECT (control_key, enabled, phone_hashes, global_enabled) TO jale_whatsapp` with a `USING (true)` SELECT policy and **no** INSERT/UPDATE/DELETE grant to `jale_whatsapp`.
- Pre-OTP access uses exactly three catalog-path `SECURITY DEFINER` functions: `load_worker_pre_auth(p_phone_hash TEXT)`, `save_worker_pre_auth(p_phone_hash TEXT, p_patch JSONB)`, and `bind_verified_identity_and_start_workflow(...)`. Each validates `p_phone_hash` as 64 lowercase hex, qualifies every relation, exposes only one exact hash, revokes `PUBLIC`, and grants execute only to `jale_whatsapp`. `worker_identity_challenges` receives no policy that exposes all unbound rows and no direct pre-auth write grant. C4's TypeScript functions are thin parameterized wrappers over these SQL functions.
- One narrow `SECURITY DEFINER` lease function, `public.lease_worker_domain_events(p_event_type TEXT, p_limit INTEGER)`, `SET search_path = pg_catalog, pg_temp`, fully-qualified relation names, returning claimed `worker_domain_outbox` rows using `FOR UPDATE SKIP LOCKED` and setting `status = 'processing'`. It exists because the scheduled drain is cross-worker and cannot operate under worker RLS. `REVOKE ALL ... FROM PUBLIC`; `GRANT EXECUTE` to `jale_whatsapp` only. Bound `p_limit` to `1..100` inside the function and raise on anything else.
- Close with a fail-closed self-audit covering RLS, constraints, and all four `SECURITY DEFINER` functions (three pre-auth plus the lease): catalog-only search paths, exact owners/signatures, and no `PUBLIC` execute.

**SM/MM database completion (required — this is the other half of the SM/MM requirement):**

Migration `040` line 313 hard-rejects any non-`SM` SID inside `jale_twilio_callback.record_whatsapp_delivery_status`, which raises `22023` before any row is matched. Widening only the TypeScript guard (Task C1) makes `MM` callbacks reach the database and throw. Migration `042` must therefore re-create that function with the widened regex, using the same mechanism `040` used:

- Re-grant the temporary `SET`-capable membership and `SET LOCAL ROLE jale_twilio_callback` around the re-creation, then reset the role and revoke the temporary `SET` exactly as `040` does at its lines 81–88 and 612–630. The function must remain **owned by** `jale_twilio_callback`, `SECURITY DEFINER`, `SET search_path = pg_catalog, pg_temp`, with fully-qualified `public.` relation names.
- Change **only** the guard, from `p_twilio_message_sid !~ '^SM[0-9A-Fa-f]{32}$'` to `p_twilio_message_sid !~ '^(SM|MM)[0-9A-Fa-f]{32}$'`. Every other behavior is preserved byte-for-byte: the status allow-list, the duplicate same-status refresh returning `(true, false)`, the transition table, the terminal-state guards, the `admin_case_events` insert, and the `admin_cases` details update.
- Do **not** re-create `public.record_whatsapp_delivery_status`, `jale_twilio_callback.record_twilio_delivery_status`, `record_twilio_status`, or `record_admin_whatsapp_delivery`. They call the replaced implementation and inherit the fix.
- Add to `042`'s self-audit: the function still exists in the `jale_twilio_callback` schema, is still owned by `jale_twilio_callback`, is still `prosecdef`, and still has the catalog-only `search_path`.

- [ ] **Step 1: Write the failing structure and integration tests**

Append the migration to all three baseline sites listed above. In `apply-order.test.ts` add one `it` that reads `042_whatsapp_onboarding_gate.sql` and asserts: each of the eight `CREATE TABLE` statements; each of the eleven canonical check constraints verbatim; each of the four named constraints/indexes; `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` for every worker-scoped table; the absence of any bare `GRANT SELECT ON worker_` (column-scoped only); `'^(SM|MM)[0-9A-Fa-f]{32}$'`; and `lease_worker_domain_events`.

Create `infra/test/unit/db/whatsapp-onboarding-042.integration.test.ts` following the guard style of `whatsapp-support-039.integration.test.ts` (skip with a loud `DONE_WITH_CONCERNS` warning when `JALE_TEST_DATABASE_URL` is unset; reuse its `applyLocalRlsRecursionWorkaround` helper for the local testbed). Assert against real PostgreSQL 16:

1. Migrations `001` through `042` apply cleanly in baseline order.
2. Inserting a second `status = 'active'` workflow run for the same user violates `worker_workflow_one_active`.
3. Inserting a second intent with the same `dedupe_key` violates `worker_message_intent_dedupe`.
4. Inserting a second domain event with the same `event_key` violates `worker_domain_outbox_event_key`.
5. With no `app.current_internal_user_id`, `jale_whatsapp` can load/upsert only the exact 64-hex phone hash passed through the pre-auth functions; direct table SELECT/INSERT is denied, a different hash returns no row, and a raw/E.164 value raises.
6. Two concurrent sessions calling `lease_worker_domain_events('worker.ready', 10)` claim disjoint row sets (`FOR UPDATE SKIP LOCKED`).
7. `lease_worker_domain_events('worker.ready', 0)` and `(…, 101)` raise.
8. `SELECT * FROM jale_twilio_callback.record_whatsapp_delivery_status('MM' || repeat('a',32), 'delivered', NULL, NULL)` returns without raising (matching an inserted outbox row and reporting `matched = true`), and the same call with `'XX' || repeat('a',32)` still raises SQLSTATE `22023`.
9. A `SET ROLE jale_whatsapp` session with `app.current_internal_user_id` set to worker A cannot read worker B's `worker_message_intents` row, and cannot `UPDATE whatsapp_runtime_controls`.

- [ ] **Step 2: Run the structure tests and confirm failure**

```bash
cd infra
npx jest test/unit/db/migrations.test.ts test/unit/db/migrations/apply-order.test.ts --runInBand
```

Expected: FAIL because the tests and registrations now require `042_whatsapp_onboarding_gate.sql`, but the migration file does not exist until Step 3. The structural assertions must not be weakened or removed to obtain the expected red state.

- [ ] **Step 3: Write migration 042**

Wrap the whole file in one `BEGIN; ... COMMIT;` with a header comment block matching the house style of `040`/`041` (what, connect-as `jale_admin`, why each privileged step exists). Use `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, and `DROP POLICY IF EXISTS` before each `CREATE POLICY` so the file is safely re-runnable. Add indexes on `worker_message_intents (user_id, status)`, `worker_message_intents (status, expires_at)`, `worker_domain_outbox (status, next_attempt_at)`, and `worker_identity_challenges (phone_hash, status)`.

- [ ] **Step 4: Run the disposable PostgreSQL gate**

```bash
bash /home/hermesgoma/.codex/skills/psql-migration-testbed/scripts/run-psql-migration-testbed.sh \
  --repo . -- \
  bash -lc 'cd infra && JALE_TEST_DATABASE_URL="$JALE_TEST_DATABASE_URL" npx jest test/unit/db/migrations.test.ts test/unit/db/migrations/apply-order.test.ts test/unit/db/whatsapp-onboarding-042.integration.test.ts --runInBand'
```

Expected: migrations `001` through `042` apply on PostgreSQL 16 and all three suites pass, including the `MM` callback case and the cross-worker RLS denial.

- [ ] **Step 5: Verify the three baseline sites and the excluded script**

```bash
cd /home/hermesgoma/Desktop/hermes/Jale/live-debug/Jale/.worktrees/wa-v2-integration
grep -c "042_whatsapp_onboarding_gate.sql" infra/test/unit/db/migrations/apply-order.test.ts scripts/run-migrations.sh
grep -n "'042'" infra/test/unit/db/migrations.test.ts
grep -c "042" scripts/run-production-upgrade-020b-040.sh
```

Expected: `1` for each of the first two files, one match for `'042'`, and `0` for the historical upgrade script.

- [ ] **Step 6: Dev-cycle review gate**

Run Review 1 / Fix / Review 2. Review 1 must specifically read the re-created callback function line by line against `040`'s original and confirm the **only** difference is the SID regex; any other drift is a blocking finding. Review 1 must also confirm no bare table-level grant to `jale_whatsapp` was introduced and that the self-audit actually raises (temporarily break one assertion locally to prove it, then restore).

- [ ] **Step 7: Commit**

```bash
git add infra/db/migrations/042_whatsapp_onboarding_gate.sql infra/test/unit/db scripts/run-migrations.sh
git commit -m "feat: add WhatsApp onboarding v2 data model and MM delivery callbacks"
```

**Handoff:** Tables and the lease function are now available to C4, C6, C7, C8, and C9. The workflow lane reads `worker_workflow_runs`/`worker_workflow_transitions`/`worker_identity_challenges` through Task C4's repository, not with its own SQL.

---

### Task C4: Repository Primitives and the Worker-Delivery Gateway

**Depends on:** C2 and C3, both through Review 2. Branch off the lane branch after both have merged. Also branches after C1 because it edits `outbox.ts`.

**Files:**
- Create: `infra/lambda/whatsapp/lib/onboarding-repository.ts`
- Create: `infra/lambda/whatsapp/lib/worker-delivery-gateway.ts`
- Modify: `infra/lambda/whatsapp/lib/outbox.ts`
- Create: `infra/test/unit/lambda/whatsapp/lib/onboarding-repository.test.ts`
- Create: `infra/test/unit/lambda/whatsapp/lib/worker-delivery-gateway.test.ts`
- Modify: `infra/test/unit/lambda/whatsapp/lib/outbox.test.ts`

**Do not touch:** `delivery-policy.ts` or `runtime-controls.ts` (C2 owns them — consume, do not edit), migration `042` (C3 owns it — if a column is missing, report it as a cross-lane interface change rather than editing the migration), and every file in the Ownership Exclusions list.

**Interfaces produced — implement these exactly:**

```ts
// infra/lambda/whatsapp/lib/onboarding-repository.ts
import type { PoolClient } from 'pg';
import type {
  PreferredLanguage, WorkerLifecycle, WorkflowRunStatus, WorkflowStepKey,
} from './onboarding-types';

export interface WorkerGate {
  userId: string;
  lifecycle: WorkerLifecycle;
  runId: string | null;
  workflowVersion: number | null;
  currentStepKey: WorkflowStepKey | null;
  status: WorkflowRunStatus | null;
  preferredLanguage: PreferredLanguage;
  lockVersion: number | null;
}

/** SELECT ... FOR UPDATE on the state and active run rows. Requires an open transaction. */
export function loadWorkerGate(client: PoolClient, workerId: string): Promise<WorkerGate | null>;

export interface PreAuthState {
  challengeId: string;
  phoneHash: string;
  providerChallengeId: string | null;
  candidateUserId: string | null;
  preferredLanguage: PreferredLanguage;
  currentStepKey: 'start.choose_language' | 'identity.verify_otp';
  context: Record<string, unknown>;
  status: 'pending' | 'expired' | 'locked' | 'superseded';
  attempts: number;
  expiresAt: Date | null;
  lockedUntil: Date | null;
}
export function loadPreAuthStateForUpdate(client: PoolClient, phoneHash: string): Promise<PreAuthState | null>;
export function savePreAuthState(client: PoolClient, phoneHash: string, patch: Partial<PreAuthState>): Promise<PreAuthState>;
export function bindVerifiedIdentityAndStartWorkflow(client: PoolClient, input: { conversationId: string; phoneHash: string; challengeId: string; verifiedWorkerId: string; preferredLanguage: PreferredLanguage; workflowVersion: number; inboundMessageSid: string }): Promise<WorkerGate>;
export function advanceWorkflow(client: PoolClient, input: { runId: string; expectedLockVersion: number; fromStepKey: WorkflowStepKey; toStepKey: WorkflowStepKey; status?: WorkflowRunStatus; contextPatch: Record<string, unknown>; inboundMessageSid: string; reason: string }): Promise<WorkerGate>;

export function appendTransition(
  client: PoolClient,
  input: {
    runId: string;
    fromStepKey: WorkflowStepKey | null;
    toStepKey: WorkflowStepKey;
    inboundMessageSid: string | null;
    reason: string;
    metadata?: Record<string, unknown>;
  },
): Promise<{ transitionId: string }>;

/**
 * One atomic readiness transition. MUST be called inside an already-open
 * transaction and MUST NOT perform any network call.
 */
export function completeOnboarding(
  client: PoolClient,
  input: {
    workerId: string;
    runId: string;
    expectedLockVersion: number;
    assessmentProvenance: Record<string, unknown>;
  },
): Promise<{ assessmentEventId: string; workerReadyEventId: string }>;
```

The workflow lane persists trust answer three immediately before this call on the same client and in the same caller-owned transaction; `expectedLockVersion` comes from the locked `WorkerGate`.

`completeOnboarding` performs, in one statement sequence on the caller's client and with no `BEGIN`/`COMMIT` of its own: update `worker_onboarding_state` to `lifecycle = 'ready'` and set `ready_at`; update `worker_workflow_runs` to `status = 'completed'`, `completed_at = now()`, `lock_version = lock_version + 1`, guarded by `WHERE id = $runId AND lock_version = $expectedLockVersion`; throw `Error('workflow_lock_conflict')` when that update affects zero rows; `appendTransition(...)` with reason `onboarding_complete`; and insert two `worker_domain_outbox` rows with `event_key` values `assessment.requested:<workerId>:<runId>` and `worker.ready:<workerId>:<runId>` using `ON CONFLICT (event_key) DO NOTHING`, returning the existing IDs when the conflict fires.

```ts
// infra/lambda/whatsapp/lib/worker-delivery-gateway.ts
import type { PoolClient } from 'pg';
import type { DeliveryDecision, WorkerMessageIntentInput } from './onboarding-types';

export async function enqueueWorkerMessage(
  client: PoolClient,
  input: WorkerMessageIntentInput,
  now = new Date(),
): Promise<{ intentId: string; decision: DeliveryDecision }>;

/** Rendered content an authorized intent turns into. Registered per category. */
export interface RenderedOutboxMessage {
  whatsappNumber: string;
  body: string | null;
  contentTemplate: string | null;
  contentVariables: Record<string, string> | null;
}

export type CategoryRenderer = (
  client: PoolClient,
  input: WorkerMessageIntentInput,
) => Promise<RenderedOutboxMessage | null>;

export function registerCategoryRenderer(
  category: WorkerMessageIntentInput['category'],
  renderer: CategoryRenderer,
): void;
```

`enqueueWorkerMessage` behavior:

1. Insert the logical intent into `worker_message_intents` with `status = 'deferred'`, `policy_version = DELIVERY_POLICY_VERSION`, and `ON CONFLICT ON CONSTRAINT worker_message_intent_dedupe DO UPDATE SET updated_at = now() RETURNING id`, so a repeat call is a no-op that returns the existing intent ID.
2. `loadWorkerGate(client, input.workerId)` and `loadRuntimeControls(client)` — both inside the caller's transaction, both row-locked for the state row.
3. `evaluateDelivery({ lifecycle, category, ownerService, controls, expiresAt: input.expiresAt }, now)`.
4. Persist `status` and `decision_reason` from the decision: `allow → 'eligible'`, `defer → 'deferred'`, `reject → 'rejected'`, `expire → 'expired'`.
5. On `allow` only: call the registered renderer for the category; when it returns `null`, leave the intent `eligible` and record `decision_reason = 'renderer_unavailable'`; otherwise insert one `whatsapp_outbox` row and set `worker_message_intents.outbox_id`.
6. Never call Twilio, `fetch`, or `sendPendingOutbox` from the gateway.

`outbox.ts` change — add and export an authorization guard used by the gateway's insert path:

```ts
export async function insertAuthorizedIntentOutbox(
  client: PoolClient,
  intentId: string,
  message: RenderedOutboxMessage,
): Promise<{ outboxId: string }>;
```

It inserts with `source_type = 'worker_intent'` and `source_id = intentId` and first verifies with a single query that the referenced intent exists and its status is `eligible` or `leased`; otherwise it throws `Error('unauthorized_worker_outbox_row')`. Legacy `queueOutboxText`, `queueJobAlert`, `sendPendingOutbox`, `drainJobAlertOutbox`, and `sendPendingAdminOutbox` keep their current behavior unchanged.

> **Cross-task note for C3's owner:** `whatsapp_outbox_origin_check` (migration `040` line 284) currently permits only `source_type IN ('admin_case', 'job_alert')`. Migration `042` must widen it to `('admin_case', 'job_alert', 'worker_intent')` with the same `DROP CONSTRAINT IF EXISTS` / `ADD CONSTRAINT` shape. If C3 has already merged without it, this is a cross-lane interface change: the orchestrator amends `042` and re-runs C3's Step 4 gate before C4 continues. C4 does not edit the migration itself.

- [ ] **Step 1: Write the failing repository and gateway tests**

Use a fake `PoolClient` that records `{ text, values }` for every `query()` call and returns scripted result sets, in the style of the existing `infra/test/unit/lambda/lib/job-messaging.test.ts`. Assert:

- pre-auth load/save is keyed only by the normalized phone hash and never binds identity; verified binding atomically updates the challenge and conversation then creates lifecycle/run state at `legal.review`;
- `advanceWorkflow` guards `lock_version`, patches context, optionally applies a validated legal terminal status (`declined`, `cancelled`, or `failed`) while retaining a canonical step key, and appends exactly one transition;
- `loadWorkerGate` issues `FOR UPDATE` and returns `null` for an unknown worker.
- `completeOnboarding` issues no `BEGIN` and no `COMMIT`; updates lifecycle, completes the run, appends a transition, and inserts both domain events; throws `workflow_lock_conflict` when the guarded update reports `rowCount === 0`; returns existing event IDs on `ON CONFLICT`.
- `enqueueWorkerMessage` with `lifecycle: 'onboarding'` and `category: 'job_alert'` returns `{ action: 'defer', reason: 'worker_onboarding' }`, writes `status = 'deferred'`, and issues **no** `INSERT INTO whatsapp_outbox`.
- The same call while a conversation is focused still defers.
- `lifecycle: 'ready'` with `deferredDeliveryEnabled: true` returns `allow`, calls the registered renderer once, and inserts exactly one `whatsapp_outbox` row whose `source_id` is the intent ID.
- Calling `enqueueWorkerMessage` twice with the same `dedupeKey` produces one intent row and at most one outbox row.
- `category: 'onboarding'` with `ownerService: 'job-alert'` returns `reject`/`invalid_owner` and inserts no outbox row.
- The gateway never calls `fetch` (assert `global.fetch` mock has zero calls).
- `insertAuthorizedIntentOutbox` throws `unauthorized_worker_outbox_row` when the intent lookup returns `deferred` or no row.

- [ ] **Step 2: Run and confirm failure**

```bash
cd infra
npx jest test/unit/lambda/whatsapp/lib/onboarding-repository.test.ts test/unit/lambda/whatsapp/lib/worker-delivery-gateway.test.ts --runInBand
```

Expected: FAIL with `Cannot find module './onboarding-repository'` and `Cannot find module './worker-delivery-gateway'`.

- [ ] **Step 3: Implement the repository, gateway, and outbox guard**

All SQL is parameterized; no predicate is assembled by string concatenation. No module-level mutable state other than the renderer registry, which must expose a test reset (`_clearCategoryRenderersForTests()`).

- [ ] **Step 4: Run tests and build**

```bash
cd infra
npx jest test/unit/lambda/whatsapp/lib/onboarding-repository.test.ts test/unit/lambda/whatsapp/lib/worker-delivery-gateway.test.ts test/unit/lambda/whatsapp/lib/outbox.test.ts --runInBand
npm run build
```

Expected: all three suites pass; `tsc` exits 0; the pre-existing `outbox.test.ts` cases still pass unchanged.

- [ ] **Step 5: Dev-cycle review gate**

Run Review 1 / Fix / Review 2. Review 1 must confirm `completeOnboarding` contains no `BEGIN`/`COMMIT`/`fetch`/AWS SDK call, that the gateway re-reads policy from locked rows rather than from a caller-supplied lifecycle argument, and that no legacy outbox function's behavior changed.

- [ ] **Step 6: Commit**

```bash
git add infra/lambda/whatsapp/lib infra/test/unit/lambda/whatsapp/lib
git commit -m "feat: add WhatsApp worker delivery gateway and onboarding repository"
```

**Handoff:** `completeOnboarding()` is what the workflow lane calls inside the same transaction that saves trust answer three. `enqueueWorkerMessage()` is the only sanctioned path for worker-directed business messages. **(Contract-repair note, 2026-07-22 — Design A):** the workflow lane uses `enqueueWorkerMessage` for **bound-step** prompts only (`legal.review` onward, `ownerService: 'onboarding-v2'`/`'identity'`), where `user_id` exists. **Pre-auth** prompts (`start.choose_language`, `identity.verify_otp`, and OTP status replies) have no `user_id` — a net-new worker has no `users` row — so they deliver through the phone/`inbound_message_sid`-keyed inbound-reply gateway (`deps.enqueuePreAuthPrompt`/`enqueuePreAuthText`), not `enqueueWorkerMessage`. This does not change `enqueueWorkerMessage`'s own signature or behavior.

---

### Task C5: FIFO Inbound Queue, DLQ, and Webhook Routing

**Depends on:** C2 through Review 2 (for `hashNormalizedPhone`). Independent of C3/C4.

**Files:**
- Modify: `infra/lambda/whatsapp/webhook.ts`
- Modify: `infra/lib/stacks/whatsapp-stack.ts`
- Modify: `infra/test/unit/lambda/whatsapp/webhook.test.ts`
- Modify: `infra/test/unit/stacks/whatsapp-stack.test.ts`

**Do not touch:** `processor.ts` and `processor.test.ts` — the v2/legacy behavior branch inside the processor belongs to the workflow lane. This task only makes the v2 queue exist, deliver to the existing processor Lambda, and carry correct FIFO attributes.

**Interfaces produced:**
- Webhook sends `MessageGroupId = hashNormalizedPhone(normalizedFrom)` and `MessageDeduplicationId = params.MessageSid` to the v2 FIFO queue when `WHATSAPP_INBOUND_V2_QUEUE_URL` is set; otherwise it uses the existing `SQS_QUEUE_URL` standard queue unchanged.
- Stack exports `public readonly inboundV2Queue: sqs.Queue` and `public readonly inboundV2Dlq: sqs.Queue`.

Normalization for the group ID: strip a leading `whatsapp:` prefix, trim, and lowercase before hashing. The raw phone must never appear in a log line, a queue attribute, or a message attribute — only the hash.

**Additive, not replacing:** the legacy `whatsapp-inbound-queue` and `whatsapp-inbound-dlq` remain exactly as they are today, with `maxReceiveCount: 3` and their current visibility timeout. The v2 queue is new.

- [ ] **Step 1: Write the failing webhook and CDK assertions**

In `webhook.test.ts`, with `WHATSAPP_INBOUND_V2_QUEUE_URL` set, assert the `SendMessageCommand` input contains `QueueUrl` equal to the v2 URL, `MessageGroupId` equal to the SHA-256 of the normalized `From`, and `MessageDeduplicationId` equal to the signed `MessageSid`; assert `MessageGroupId` does not contain any digit sequence from the phone; assert that with the env var unset the existing standard-queue behavior and payload are byte-identical to today; assert an invalid signature still returns `403` and enqueues nothing.

In `whatsapp-stack.test.ts` assert via `Template.fromStack`: a queue named `whatsapp-inbound-v2.fifo` with `FifoQueue: true` and `ContentBasedDeduplication: false`; a DLQ named `whatsapp-inbound-v2-dlq.fifo` with `FifoQueue: true` and 14-day `MessageRetentionPeriod`; the v2 queue's `RedrivePolicy` has `maxReceiveCount: 5`; both use `KmsMasterKeyId` (KMS-managed encryption); an `AWS::Lambda::EventSourceMapping` from the v2 queue to the processor function with `BatchSize: 1` and `FunctionResponseTypes: ['ReportBatchItemFailures']`; the webhook Lambda's environment contains `WHATSAPP_INBOUND_V2_QUEUE_URL`; the webhook role can `sqs:SendMessage` to the v2 queue; and the legacy `whatsapp-inbound-queue` still exists with `maxReceiveCount: 3`. Add two alarms and assert them: `WhatsAppInboundV2DlqDepth` on `ApproximateNumberOfMessagesVisible` for the v2 DLQ, and `WhatsAppInboundV2DlqAge` on `ApproximateAgeOfOldestMessage`, both wired to the existing alarm topic action.

- [ ] **Step 2: Run focused suites and confirm failure**

```bash
cd infra
npx jest test/unit/lambda/whatsapp/webhook.test.ts test/unit/stacks/whatsapp-stack.test.ts --runInBand
```

Expected: FAIL — the webhook sends no `MessageGroupId`, and the template contains no `whatsapp-inbound-v2.fifo` resource.

- [ ] **Step 3: Add the additive v2 FIFO queue and webhook routing**

In the stack, create `inboundV2Dlq` (`whatsapp-inbound-v2-dlq.fifo`, `fifo: true`, `contentBasedDeduplication: false`, `encryption: sqs.QueueEncryption.KMS_MANAGED`, `retentionPeriod: cdk.Duration.days(14)`) and `inboundV2Queue` (`whatsapp-inbound-v2.fifo`, `fifo: true`, `contentBasedDeduplication: false`, `encryption: sqs.QueueEncryption.KMS_MANAGED`, `visibilityTimeout: cdk.Duration.seconds(360)`, `deadLetterQueue: { queue: this.inboundV2Dlq, maxReceiveCount: 5 }`). Add `WHATSAPP_INBOUND_V2_QUEUE_URL` to the webhook Lambda environment, grant `sendMessages`, and add a second `SqsEventSource(this.inboundV2Queue, { batchSize: 1, reportBatchItemFailures: true })` to the existing processor Lambda. Add the two DLQ alarms next to the existing alarm block, reusing the local `alarm()` helper's shape and `alarmAction`.

In `webhook.ts`, import `hashNormalizedPhone` from `./lib/runtime-controls`, read `WHATSAPP_INBOUND_V2_QUEUE_URL`, and add the group/dedupe IDs only on the v2 branch. Keep the handler DB-free and Twilio-API-free; keep the empty-TwiML 200 response and the `text/xml` header unchanged.

- [ ] **Step 4: Re-run tests and synthesize**

```bash
cd infra
npx jest test/unit/lambda/whatsapp/webhook.test.ts test/unit/stacks/whatsapp-stack.test.ts --runInBand
npm run build
```

then the canonical deterministic synth command from *Canonical Commands*.

Expected: both suites pass, `tsc` exits 0, and synth succeeds emitting **both** the legacy standard queue and the new `.fifo` pair. A synth that removed or renamed the legacy queue is a blocking failure.

- [ ] **Step 5: Dev-cycle review gate**

Run Review 1 / Fix / Review 2. Review 1 must confirm `processor.ts` is untouched (`git diff --name-only` contains no `processor`), that the legacy queue's properties are byte-identical in the synthesized template, and that no raw phone reaches a log or a queue attribute.

- [ ] **Step 6: Commit**

```bash
git add infra/lambda/whatsapp/webhook.ts infra/lib/stacks/whatsapp-stack.ts infra/test/unit
git commit -m "feat: add WhatsApp v2 FIFO inbound queue and DLQ"
```

**Handoff to the workflow lane:** every signed inbound event now arrives on the FIFO queue, serialized per phone hash and deduplicated by `MessageSid`. `processor.ts` must branch on `isV2Enabled(controls, hashNormalizedPhone(from))` — that edit is the workflow lane's, and Codex verifies it at Task C10.

---

### Task C6: Producer Deferral and Grouped Worker-Ready Release

**Depends on:** C4 through Review 2.

**Files:**
- Modify: `infra/lambda/whatsapp/job-alert.ts`
- Modify: `infra/lambda/lib/job-messaging.ts`
- Modify: `infra/lambda/api/employer-conversations-create.ts`
- Modify: `infra/lambda/api/employer-conversations-send.ts`
- Create: `infra/lambda/whatsapp/worker-ready-release.ts`
- Create: `infra/test/unit/lambda/whatsapp/worker-ready-release.test.ts`
- Modify: `infra/test/unit/lambda/whatsapp/job-alert.test.ts`
- Modify: `infra/test/unit/lambda/lib/job-messaging.test.ts`

**Do not touch:** `templates.ts`, `interactive-templates.ts`, `conversation-router.ts`, `processor.ts`. **No new bilingual worker-facing string may be written in this task.** Rendering is injected — see the renderer contract below. Do not change the `job_conversations` / `job_conversation_messages` write paths: employer messages keep being inserted exactly as they are today; only the moment their WhatsApp notification becomes eligible changes.

**Intent parameters — use these exact values:**

| Producer | category | ownerService | sourceType | sourceId | dedupeKey | priority | expiresAt |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `job-alert.ts` | `job_alert` | `job-alert` | `job` | jobId | `job-alert:<jobId>:<workerId>` | 30 | `now + 72h` |
| `job-messaging.ts` employer send | `employer_chat` | `job-messaging` | `job_conversation_message` | messageId | `employer-chat:<messageId>` | 40 | `now + 7d` |

Release group order (ascending, lower group released first):

| Group | Category | Rule |
| --- | --- | --- |
| 1 | `onboarding` (`onboarding_complete` payload kind) | at most one |
| 2 | `account` | newest intent per `sourceType` wins; older ones become `superseded` |
| 3 | `job_alert` | at most **ten** strongest still-valid matches collapsed into one digest; the rest become `superseded` |
| 4 | `employer_chat` | released last; one unread conversation → single-conversation render; more than one → one summary render |

**Interfaces produced — implement these exactly:**

```ts
// infra/lambda/whatsapp/worker-ready-release.ts
import type { PoolClient } from 'pg';
import type { PreferredLanguage } from './lib/onboarding-types';

export interface ReleaseJobSummary {
  jobId: string;
  title: string;
  companyName: string;
  score: number;
}

export type ReleaseRenderRequest =
  | { kind: 'onboarding_complete'; workerId: string; language: PreferredLanguage }
  | { kind: 'account_notice'; workerId: string; language: PreferredLanguage; sourceType: string; sourceId: string }
  | { kind: 'job_alert_digest'; workerId: string; language: PreferredLanguage; jobs: ReleaseJobSummary[] }
  | { kind: 'employer_chat_single'; workerId: string; language: PreferredLanguage; conversationId: string; companyName: string; jobTitle: string }
  | { kind: 'employer_chat_summary'; workerId: string; language: PreferredLanguage; conversationCount: number };

export interface ReleaseRenderedMessage {
  body: string | null;
  contentTemplate: string | null;
  contentVariables: Record<string, string> | null;
}

/** Implemented by the workflow lane. Codex owns the interface, not the wording. */
export interface ReleaseRenderer {
  render(request: ReleaseRenderRequest): Promise<ReleaseRenderedMessage>;
}

export interface ReleaseDeps {
  renderer: ReleaseRenderer;
  now?: () => Date;
}

export async function releaseWorkerReady(
  client: PoolClient,
  eventKey: string,
  deps: ReleaseDeps,
): Promise<{ released: number; expired: number; superseded: number; failed: number }>;
```

**Renderer ownership decision (binding).** The shared renderer types are owned by C2 in `onboarding-types.ts`. C6 imports them and accepts Claude's required `createReleaseRenderer()` implementation; C6 does not redeclare or default any worker-facing copy. Codex owns grouping, ordering, and sequence allocation, while the workflow lane owns every English/Spanish string.

`releaseWorkerReady` behavior:

1. Require the caller to pass an event already claimed by `lease_worker_domain_events` and verify the exact `eventKey` exists with `event_type = 'worker.ready'` and `status = 'processing'`. The scheduled drain in C7 is the sole event lease owner; this function never calls the generic lease function a second time.
2. `SELECT ... FOR UPDATE SKIP LOCKED` the worker's `deferred`/`eligible` intents, set `status = 'leased'` and `leased_until = now() + interval '5 minutes'`.
3. Reload each intent's **current** source rows (job, employer, application, conversation) — never trust the stored payload for eligibility. Discard as `expired` when `expires_at <= now`, and as `superseded` per the group rules above. A job alert is discarded when its job is closed, paused, or no longer matches; an employer-chat intent is discarded when its job, employer, worker, application, or conversation is no longer eligible. Every disposition writes `decision_reason`.
4. Re-evaluate `evaluateDelivery` for each survivor. A survivor that no longer evaluates to `allow` returns to `deferred` with the new reason.
5. Allocate one contiguous per-worker `release_sequence` block in group order, then within a group by `priority` then `created_at`.
6. Call `deps.renderer.render(...)` per group and insert authorized outbox rows through `insertAuthorizedIntentOutbox`, marking each intent `released`. No Twilio call happens here — transport stays with the existing outbox drains.
7. Return the release counts on success and throw on failure. C7 owns the event's `completed`/retry/terminal-failure transition so event state is updated exactly once.

- [ ] **Step 1: Write the failing defer and release tests**

In `job-alert.test.ts` and `job-messaging.test.ts`, first assert a worker for whom `isV2Enabled(controls, hashNormalizedPhone(phone))` is false follows the existing legacy outbox path byte-for-byte and creates no `worker_message_intents` row. Then, for an allowlisted v2 worker at each of `start.choose_language`, `identity.verify_otp`, `legal.review`, `profile.name`, and `trust.question.3` with `lifecycle: 'onboarding'`, assert the producer creates exactly one `worker_message_intents` row with the exact dedupe key and expiry above, and issues **no** `INSERT INTO whatsapp_outbox` and no `fetch`. Assert `job_conversation_messages` inserts still happen unchanged, and that a repeated producer call does not create a second intent.

In `worker-ready-release.test.ts`, with a fake client and a recording renderer, assert: a non-processing or wrong-type event key is rejected before intents are touched; a closed job and an expired employer message are discarded with the recorded reasons; twelve valid job alerts produce one `job_alert_digest` request carrying exactly ten jobs and two `superseded` intents; one unread conversation produces `employer_chat_single`; three unread conversations produce exactly one `employer_chat_summary` with `conversationCount: 3` and no `employer_chat_single`; the recorded request order is onboarding-complete → account → job digest → employer chat; the allocated `release_sequence` values are contiguous and strictly increasing; and a renderer that throws rolls back every intent/outbox mutation and propagates the error to the drain.

- [ ] **Step 2: Run and confirm failure**

```bash
cd infra
npx jest test/unit/lambda/whatsapp/worker-ready-release.test.ts test/unit/lambda/whatsapp/job-alert.test.ts test/unit/lambda/lib/job-messaging.test.ts --runInBand
```

Expected: FAIL with `Cannot find module '../../../../lambda/whatsapp/worker-ready-release'`, and the producer suites failing because they still insert outbox rows directly.

- [ ] **Step 3: Redirect the producers and implement the release**

In each producer, load runtime controls and hash the target worker's normalized WhatsApp phone without logging it. When `isV2Enabled(controls, phoneHash)` is false, execute the pre-existing legacy notification path unchanged and create no v2 intent. Only when it is true does `job-alert.ts` replace `queueJobAlert(...)` with `enqueueWorkerMessage(...)` using the table above. In `job-messaging.ts`, keep `queueConversationMessageFromEmployer`'s message insert, conversation timestamp update, and application-status update exactly as they are; for a v2-enabled target replace only the immediate `queueEmployerFreeformMessage` / `queueWorkerInviteTemplate` **outbox creation** with `enqueueWorkerMessage(...)`, while a v2-disabled target continues that legacy send path. The existing template-dedupe guard stays. `employer-conversations-create.ts` and `employer-conversations-send.ts` change only where they trigger a send, delegating to the updated `job-messaging.ts` functions. `queueJobAlert` and the legacy drains stay in `outbox.ts` and are not deleted.

- [ ] **Step 4: Run tests and build**

```bash
cd infra
npx jest test/unit/lambda/whatsapp/worker-ready-release.test.ts test/unit/lambda/whatsapp/job-alert.test.ts test/unit/lambda/lib/job-messaging.test.ts test/unit/lambda/whatsapp/lib/outbox.test.ts test/unit/lambda/whatsapp/job-message-outbox-sweeper.test.ts --runInBand
npm run build
```

Expected: all five suites pass; `tsc` exits 0.

- [ ] **Step 5: Dev-cycle review gate**

Run Review 1 / Fix / Review 2. Review 1 must confirm: no bilingual string literal was added anywhere in the diff (`git diff | grep -nE "^\+.*\b(es|en):\s*'"` returns nothing); `job_conversation_messages` write behavior is unchanged; release-time revalidation actually re-queries source rows rather than reading `payload`; and the ten-job cap and last-place employer block are enforced in code, not only in a test.

Review 1 must also prove that a missing, malformed, or disabled onboarding-v2 control selects the legacy producer path and that only an enabled allowlist or global match selects the new intent path.

- [ ] **Step 6: Commit**

```bash
git add infra/lambda/whatsapp/job-alert.ts infra/lambda/lib/job-messaging.ts infra/lambda/api infra/lambda/whatsapp/worker-ready-release.ts infra/test/unit/lambda
git commit -m "feat: defer worker business messages and release them grouped"
```

**Handoff to the workflow lane:** implement `createReleaseRenderer(): ReleaseRenderer` covering all five `ReleaseRenderRequest` kinds in English and Spanish, including the multiple-employer summary with its View Chats action and `CHATS`/`MENSAJES` fallback. Codex verifies its presence at Task C10 and fails the gate if it is missing.

---

### Task C7: Scheduled Domain-Event Drain, Release Wiring, and Operational Alarms

**Depends on:** C5 and C6, both through Review 2. This is the second and last task permitted to edit `infra/lib/stacks/whatsapp-stack.ts`; branch off the lane branch after C5 has merged.

**Files:**
- Create: `infra/lambda/whatsapp/domain-outbox-drain.ts`
- Create: `infra/test/unit/lambda/whatsapp/domain-outbox-drain.test.ts`
- Modify: `infra/lib/stacks/whatsapp-stack.ts`
- Modify: `infra/test/unit/stacks/whatsapp-stack.test.ts`

**Do not touch:** `worker-ready-release.ts` (C6 owns it — import `releaseWorkerReady`, do not edit it), `webhook.ts`, `processor.ts`.

**Interfaces produced:**

```ts
// infra/lambda/whatsapp/domain-outbox-drain.ts
export const handler: () => Promise<{
  claimed: number; completed: number; failed: number;
}>;

export const MAX_DOMAIN_EVENT_ATTEMPTS = 5;
export const DOMAIN_EVENT_BATCH_LIMIT = 25;
```

Behavior: on each EventBridge tick claim at most `DOMAIN_EVENT_BATCH_LIMIT` events through `lease_worker_domain_events`, which already marks them `processing` under `FOR UPDATE SKIP LOCKED`. Dispatch `worker.ready` to `releaseWorkerReady(client, event.event_key, deps)` and `assessment.requested` to an assessment-request insert that performs no Bedrock call. On success mark `completed`; on failure increment `attempts`, store `last_error`, set `next_attempt_at = now() + least(30s * 2^(attempts-1), 30min)`, and mark `failed` once `attempts >= MAX_DOMAIN_EVENT_ATTEMPTS`. Emit structured logs only in the existing `console.log(JSON.stringify({ metric: '...' }))` shape consumed by the stack's `MetricFilter`s, with no OTP value, no raw phone, and no message body.

Metric names to emit and alarm on:

| Metric | Emitted when | Alarm |
| --- | --- | --- |
| `WhatsAppDomainEventStuck` | an event reaches the attempt cap | `WhatsAppDomainEventsStuck` |
| `WhatsAppReleaseFailure` | `releaseWorkerReady` throws | `WhatsAppReleaseFailures` |
| `WhatsAppDeferredBacklogAged` | a claimed intent is older than 24h | `WhatsAppDeferredBacklogAge` |
| `WhatsAppOtpLock` | the workflow lane's identity handler emits the metric when a challenge transitions to `locked`; C7 installs the filter/alarm on the processor log group | `WhatsAppOtpLockRate` |

- [ ] **Step 1: Write the failing drain and stack tests**

`domain-outbox-drain.test.ts` (fake pool/client): claims at most 25 events per invocation; a thrown dispatch marks the event failed with `attempts + 1`, a `next_attempt_at`, and emits `WhatsAppReleaseFailure`; the fifth failure emits `WhatsAppDomainEventStuck`; a successful `worker.ready` calls `releaseWorkerReady` exactly once with the event key; the drain never calls `fetch`; no emitted log line contains a phone-shaped digit run or the substring `otp`.

`whatsapp-stack.test.ts`: a `DomainOutboxDrainLambda` exists with an `AWS::Events::Rule` at `rate(1 minute)`; the drain function's role can read only the WhatsApp DB secret (assert the exact `Resource` list, and assert that it cannot read the Twilio secret or any additional `secretsmanager:GetSecretValue` resource); four `AWS::CloudWatch::Alarm` resources with the names in the table above, each with an `AlarmActions` entry pointing at the alarm topic; and the C5 v2 queue/DLQ resources still present and unchanged.

- [ ] **Step 2: Run and confirm failure**

```bash
cd infra
npx jest test/unit/lambda/whatsapp/domain-outbox-drain.test.ts test/unit/stacks/whatsapp-stack.test.ts --runInBand
```

Expected: FAIL with `Cannot find module '../../../../lambda/whatsapp/domain-outbox-drain'` and missing `DomainOutboxDrainLambda`/alarm resources.

- [ ] **Step 3: Implement the drain and wire the stack**

Follow the existing `JobAlertOutboxDrainLambda` construct shape in `whatsapp-stack.ts` for VPC, security group, and environment, but grant only the WhatsApp DB secret: this drain never sends through Twilio and must not receive the Twilio secret or any Twilio-related IAM permission. Add `MetricFilter`s on the drain Lambda's log group using the same `filterPattern: logs.FilterPattern.stringValue('$.metric', '=', ...)` convention and the `Jale/WhatsApp` namespace, then the four alarms via the local `alarm()` helper and `alarmAction`.

- [ ] **Step 4: Run tests, build, and synthesize**

```bash
cd infra
npm run build
npx jest test/unit/lambda/whatsapp/domain-outbox-drain.test.ts test/unit/stacks/whatsapp-stack.test.ts --runInBand
```

then the canonical deterministic synth command from *Canonical Commands*.

Expected: both suites pass, `tsc` exits 0, synth succeeds, and the template contains the v2 queues from C5 plus the new drain Lambda, schedule, metric filters, and four alarms.

- [ ] **Step 5: Dev-cycle review gate**

Run Review 1 / Fix / Review 2. Review 1 must confirm the batch bound is enforced in code (not just asserted), that `next_attempt_at` backoff is capped, that no log line can carry an OTP or raw phone, and that C5's queue definitions are untouched in the diff.

- [ ] **Step 6: Commit**

```bash
git add infra/lambda/whatsapp/domain-outbox-drain.ts infra/lib/stacks/whatsapp-stack.ts infra/test/unit
git commit -m "feat: operate WhatsApp v2 release and domain-event workers"
```

**Handoff:** readiness now flows end to end without any manual step: workflow lane calls `completeOnboarding()` → domain events → scheduled drain → `releaseWorkerReady()` → authorized outbox rows → existing Twilio drains.

---

### Task C8: Operator CLIs — Exact-Target Reset and Runtime Controls

**Depends on:** C3 through Review 2.

**Files:**
- Create: `infra/scripts/reset-whatsapp-onboarding-v2.ts`
- Create: `infra/scripts/whatsapp-runtime-controls.ts`
- Create: `infra/test/unit/scripts/reset-whatsapp-onboarding-v2.test.ts`
- Create: `infra/test/unit/scripts/whatsapp-runtime-controls.test.ts`
- Modify: `infra/package.json`

**Do not touch:** any `lambda/` file, migration `042`, `scripts/*.ps1`, `scripts/run-migrations.sh`.

**Interfaces produced:**

```
reset-whatsapp-onboarding-v2
  --user-id <uuid>        required, repeatable, must be a syntactic UUID
  --phone <e164>          required, must match the resolved user's verified phone
  --reason <text>         required, non-empty
  --dry-run | --execute   exactly one is required
```

No list mode, no wildcard, no phone-only mode, no all-users mode, no `--user-id=*`. A missing, empty, or unrecognized flag exits non-zero **before** opening a database connection.

```
whatsapp-runtime-controls
  --show
  --enable <onboarding_v2|deferred_delivery>
  --disable <onboarding_v2|deferred_delivery>
  --allow-phone <e164>     adds only the SHA-256 hash to onboarding_v2_enabled.phone_hashes
  --deny-phone <e164>      removes that hash
  --go-global              sets onboarding_v2_enabled.global_enabled = true
```

`--show` prints hashes only, never raw phones, and prints no other table.

Reset execution order inside one transaction (matches the FK order proven by `scripts/cleanup-whatsapp-rds-user.ps1`, scoped to the exact user IDs and **without** deleting the `users` row):

`worker_message_intents` → `worker_domain_outbox` → `worker_workflow_transitions` → `worker_workflow_runs` → `worker_identity_challenges` → `worker_onboarding_state` → `whatsapp_outbox` → `whatsapp_processed_messages` → `whatsapp_conversations` → `job_conversation_messages` → `job_message_outbox` → `job_conversations` → `job_applications` → `worker_job_impressions` → `worker_match_log` → `job_candidates` → `worker_trust_assessments` → `worker_profile_ai_extractions` → `worker_profile_media` → `worker_skills` → targeted column clears on `worker_profiles` and `users`.

Preserved and never touched: the `users` row itself, its Cognito identity and verified phone, and `legal_consent_log`.

After clearing, insert one `worker_onboarding_state` row at `lifecycle = 'onboarding'` and one `worker_workflow_runs` row with `status = 'active'`, `current_step_key = 'start.choose_language'`, and the current workflow version.

- [ ] **Step 1: Write the failing parser and SQL-boundary tests**

With a fake client recording every `{ text, values }`: each missing required flag exits non-zero and opens no connection; `--dry-run` issues only scoped `SELECT count(*)` statements, prints the summary, performs no insert/update/delete, and then `ROLLBACK`; a `--phone` that does not match the resolved user's verified phone aborts before any `DELETE`; `--execute` issues the deletes in exactly the order above, each with a `WHERE` clause bound to the target user IDs, and never issues `DELETE FROM users` or `DELETE FROM legal_consent_log`; no statement contains a bare `DELETE FROM <table>` without a `WHERE`; running `--execute` twice yields the same terminal state, one active `start.choose_language` run, and a second committed audit row; each execute audit row records operator, timestamp, reason, `dry_run = false`, and per-table counts.

For the controls CLI: `--show` output contains no raw phone; `--allow-phone` writes only the SHA-256 hash, using `hashNormalizedPhone`; `--enable deferred_delivery` touches only that row; an unknown control name exits non-zero.

- [ ] **Step 2: Run and confirm failure**

```bash
cd infra
npx jest test/unit/scripts/reset-whatsapp-onboarding-v2.test.ts test/unit/scripts/whatsapp-runtime-controls.test.ts --runInBand
```

Expected: FAIL with `Cannot find module '../../../scripts/reset-whatsapp-onboarding-v2'` and `.../whatsapp-runtime-controls`.

- [ ] **Step 3: Implement both commands**

Export the argument parser and the reset routine as named functions so the suite can drive them without spawning a process; guard the CLI entry point with `if (require.main === module)`. Resolve the worker by UUID **and** normalized verified phone in one query. Print the per-table count JSON before any mutation. `--dry-run` must issue only the scoped count queries and roll back without writing an audit row. Require the literal `--execute` before any mutation; the execute transaction performs the scoped reset and commits its `worker_reset_audit` row atomically with `dry_run = false`. Add to `infra/package.json`:

```json
"reset:whatsapp-v2": "ts-node scripts/reset-whatsapp-onboarding-v2.ts",
"whatsapp:controls": "ts-node scripts/whatsapp-runtime-controls.ts"
```

- [ ] **Step 4: Run tests and build**

```bash
cd infra
npx jest test/unit/scripts/reset-whatsapp-onboarding-v2.test.ts test/unit/scripts/whatsapp-runtime-controls.test.ts --runInBand
npm run build
```

Expected: both suites pass; `tsc` exits 0.

- [ ] **Step 5: Dev-cycle review gate**

Run Review 1 / Fix / Review 2. Review 1 must specifically re-read every `DELETE` for a `WHERE` clause bound to the exact target IDs, confirm no code path can widen the target set, confirm `--execute` cannot be inferred from any other flag, and confirm no raw phone is printed or logged.

- [ ] **Step 6: Commit**

```bash
git add infra/scripts infra/test/unit/scripts infra/package.json
git commit -m "feat: add exact-target WhatsApp reset and runtime-control CLIs"
```

**Handoff:** Task C10's runbook cites these two commands verbatim. Neither is executed against RDS in this plan.

---

### Task C9: PostgreSQL RLS, Idempotency, Lease, and Concurrency Gate

**Depends on:** C6 through Review 2 (transitively C3 and C4).

**Files:**
- Create: `infra/test/unit/db/whatsapp-onboarding-concurrency.integration.test.ts`

**Do not touch:** `infra/test/unit/db/whatsapp-onboarding-042.integration.test.ts` (C3 owns it), any `lambda/` file, migration `042`. If this task finds a defect, it reports it; the owning task fixes it in a follow-up round decided by the orchestrator. **Do not loosen an assertion to make the suite pass.**

**Interfaces consumed:** `enqueueWorkerMessage`, `completeOnboarding`, `loadWorkerGate` (C4), `releaseWorkerReady` (C6), `lease_worker_domain_events` (C3).

This suite runs the **real** modules against real PostgreSQL — no `pg` mock — using two independent clients to create genuine concurrency. Follow the guard and RLS-workaround style of `whatsapp-support-039.integration.test.ts`.

Required scenarios:

0. **Pre-auth RLS boundary.** With no user context, exact-hash pre-auth load/save/bind functions work for their one validated hash while direct table access and cross-hash access fail.
1. **Cross-worker RLS.** As `jale_whatsapp` with `app.current_internal_user_id` set to worker A: reading worker B's `worker_message_intents`, `worker_workflow_runs`, `worker_identity_challenges`, and `worker_onboarding_state` returns zero rows; an attempted `UPDATE` of worker B's rows affects zero rows; `UPDATE whatsapp_runtime_controls` is denied.
2. **Inbound idempotency.** Two inserts of the same inbound `MessageSid` violate the unique constraint, and the second `enqueueWorkerMessage` with the same `dedupeKey` yields exactly one intent row.
3. **One active workflow.** Two concurrent transactions each inserting an `active` run for the same worker: exactly one commits; the other fails on `worker_workflow_one_active`.
4. **Release lease.** Two concurrent clients call `lease_worker_domain_events('worker.ready', 1)` behind an explicit barrier; exactly one receives the event and invokes `releaseWorkerReady` with that already-claimed key, while the other receives no event and performs no release. Total authorized outbox rows equal the single-run count.
5. **Outbound sequence.** After a concurrent release the worker's `release_sequence` values are unique, contiguous from 1, and ordered onboarding → account → job digest → employer chat.
6. **Atomic readiness.** `completeOnboarding` inside a transaction that is then rolled back leaves lifecycle `onboarding` and inserts no domain event; committed, it produces exactly one row per `event_key` even when called twice.
7. **Gate under contention.** With `lifecycle = 'onboarding'`, ten concurrent `enqueueWorkerMessage` calls across both business categories create zero rows in `whatsapp_outbox`.
8. **Unauthorized outbox.** A direct insert into `whatsapp_outbox` with `source_type = 'worker_intent'` referencing a `deferred` intent is rejected by `insertAuthorizedIntentOutbox`.

- [ ] **Step 1: Write the suite with all nine scenarios failing or erroring first**

Write every scenario before any investigation. Scenario 4 and 5 must use two real connections with an explicit barrier, not `Promise.all` over one client.

- [ ] **Step 2: Run the gate and record the failures**

```bash
bash /home/hermesgoma/.codex/skills/psql-migration-testbed/scripts/run-psql-migration-testbed.sh \
  --repo . -- \
  bash -lc 'cd infra && JALE_TEST_DATABASE_URL="$JALE_TEST_DATABASE_URL" npx jest test/unit/db/whatsapp-onboarding-concurrency.integration.test.ts --runInBand'
```

Expected on the first run: fixture and wiring failures only. Any scenario that fails on a **behavioral** assertion is a real defect in C3/C4/C6 — record it verbatim and escalate to the orchestrator rather than adjusting the assertion.

- [ ] **Step 3: Complete fixtures and re-run to green**

Build fixtures with a superuser connection and exercise behavior after `SET ROLE jale_whatsapp`, mirroring the `039` suite. Mutate only the disposable database.

- [ ] **Step 4: Run the combined database gate**

```bash
bash /home/hermesgoma/.codex/skills/psql-migration-testbed/scripts/run-psql-migration-testbed.sh \
  --repo . -- \
  bash -lc 'cd infra && JALE_TEST_DATABASE_URL="$JALE_TEST_DATABASE_URL" npx jest test/unit/db/migrations.test.ts test/unit/db/migrations/apply-order.test.ts test/unit/db/whatsapp-onboarding-042.integration.test.ts test/unit/db/whatsapp-onboarding-concurrency.integration.test.ts --runInBand'
```

Expected: all four suites pass against PostgreSQL 16 with migrations `001`–`042` applied.

- [ ] **Step 5: Dev-cycle review gate**

Run Review 1 / Fix / Review 2. Review 1 must confirm the suite imports the real modules (no `jest.mock` of `pg`), that scenarios 4 and 5 use two connections, and that nothing was skipped with `it.skip` or weakened to `expect(...).toBeDefined()`.

- [ ] **Step 6: Commit**

```bash
git add infra/test/unit/db/whatsapp-onboarding-concurrency.integration.test.ts
git commit -m "test: gate WhatsApp v2 RLS, idempotency, lease, and concurrency"
```

**Handoff:** this suite is a required step of the Task C10 gate and of any future change to the gateway or release path.

---

### Task C10: Rollout Runbook and Final Integration

**Depends on:** every other task through Review 2, plus the frozen workflow lane. Performed by the orchestrator, not delegated.

**Files:**
- Create: `docs/runbooks/whatsapp-onboarding-v2-rollout.md`
- Modify: `infra/package.json` (one script entry: `"test:whatsapp-v2-db"`)

**Do not touch:** any implementation file. Defects found here are fixed by the owning task's agent through its single feedback round, or patched by the orchestrator when small.

- [ ] **Step 1: Verify the workflow-lane integration handoffs before merging**

Merge `feat/wa-v2-workflow` into this lane, then confirm each contract exists and fail the gate if any is missing:

| Handoff | Owner | Verification |
| --- | --- | --- |
| `createReleaseRenderer(): ReleaseRenderer` covering all five request kinds | workflow lane | `grep -rn "createReleaseRenderer" infra/lambda` and a passing render test per kind |
| `processor.ts` selects v2 via `isV2Enabled(controls, hashNormalizedPhone(from))` | workflow lane | `grep -n "isV2Enabled" infra/lambda/whatsapp/processor.ts` |
| Onboarding/security intents use `ownerService: 'onboarding-v2'` / `'identity'` | workflow lane | `grep -rn "ownerService" infra/lambda/whatsapp/onboarding-v2.ts` |
| Workflow lane calls `completeOnboarding()` in the trust-answer-three transaction | workflow lane | `grep -rn "completeOnboarding" infra/lambda/whatsapp` |
| No new SID regex was introduced | both lanes | `grep -rn "SM\[0-9" infra/lambda` returns nothing |
| `processor.ts` consumes the v2 FIFO queue records | workflow lane | processor suite passes with a FIFO-shaped record |

- [ ] **Step 2: Write the rollout runbook**

`docs/runbooks/whatsapp-onboarding-v2-rollout.md` must contain, as copy-pastable commands with expected output: prerequisite test outputs and the verified commit SHA; migration application through `042` via `scripts/run-migrations.sh`; the CDK diff review command; confirmation that both runtime controls are disabled (`npm run whatsapp:controls -- --show`); enabling v2 for one exact phone (`--allow-phone`); the dry-run reset (`npm run reset:whatsapp-v2 -- --user-id <uuid> --phone <e164> --reason "<text>" --dry-run`) and its expected per-table count JSON; the execute reset; creation of a test application, employer conversation/message, and job alert during onboarding; read-only per-step inspection queries for `worker_workflow_runs`, `worker_workflow_transitions`, `worker_message_intents`, and `worker_domain_outbox`; readiness and grouped-release inspection; log, outbox, callback, and DLQ checks; the go/no-go list from the design document verbatim; enabling the other two workers only after all conditions pass; `--go-global`; enabling deferred delivery last; and the failure procedure that leaves v2 allowlisted, deferred delivery off, and the other two accounts untouched.

Every inspection query in the runbook is read-only. The runbook states explicitly that executing it requires separate user authorization.

- [ ] **Step 3: Run the complete local gate from a clean disposable database**

```bash
cd infra
npm run build
npm test -- --runInBand
cd ..
bash /home/hermesgoma/.codex/skills/psql-migration-testbed/scripts/run-psql-migration-testbed.sh --repo .
```

then the canonical deterministic synth command, then the same command with `npx cdk diff --all --no-change-set` in place of `npx cdk synth --all`.

Expected: build passes; the full Jest suite passes; PostgreSQL migrations apply through `042`; synth succeeds; the diff contains only reviewed additive v2 resources and permissions — a new FIFO queue pair, a drain Lambda and schedule, new metric filters and alarms, and no modification or replacement of the legacy queue. Do not deploy from this step.

- [ ] **Step 4: Security-focused differential review**

Run the `differential-review` skill against the complete branch. Resolve any finding that permits pre-OTP binding, gate bypass, cross-worker data access, a broadened reset target, raw-phone leakage, or duplicate delivery. Add the `"test:whatsapp-v2-db"` package script that runs the four-suite database gate from Task C9 Step 4.

- [ ] **Step 5: Re-run the complete gate after review fixes and record the results**

Repeat Step 3 and record each command's outcome plus the commit SHA in the runbook's handoff section.

- [ ] **Step 6: Dev-cycle review gate**

Run Review 1 / Fix / Review 2 on the runbook itself: every command copy-pastable, no unresolved placeholder tokens, every destructive command preceded by its dry-run, and the failure procedure present.

- [ ] **Step 7: Commit**

```bash
git add -f docs/runbooks/whatsapp-onboarding-v2-rollout.md
git add infra/package.json
git commit -m "docs: add WhatsApp v2 rollout runbook"
```

**Stop here.** Do not push, deploy, migrate RDS, or reset any worker without separate user authorization.

---

## Self-Review: Lane Requirement Coverage

Every requirement named in this lane's charter, mapped to the task that owns it and the evidence that proves it.

| # | Lane requirement | Task(s) | Acceptance evidence |
| --- | --- | --- | --- |
| 1 | Shared lifecycle/workflow types | C2 | `onboarding-types.ts` defines `WorkerLifecycle`, `WorkflowStepKey`, `WorkflowRunStatus`, `MessageCategory`, `OwnerService`, `IntentStatus`, `DeliveryDecision`, `WorkerMessageIntentInput`, `DomainEventType`; consumed by C4, C6, C7 without redefinition |
| 2 | Migration 042 | C3 | `042_whatsapp_onboarding_gate.sql` creates eight tables, four named constraints, eleven check constraints, RLS + column-scoped grants, the lease function, and a fail-closed self-audit; registered in all three baseline sites; PostgreSQL gate green |
| 3 | Repository primitives | C4 | `loadWorkerGate`, `appendTransition`, `completeOnboarding` with lock-version guard, no `BEGIN`/`COMMIT`, no network call; verified by unit tests and C9 scenario 6 |
| 4 | Runtime controls | C2 (readers), C3 (table + seed), C8 (operator CLI) | `loadRuntimeControls`/`isV2Enabled`/`isDeferredDeliveryEnabled` fail closed; both controls seeded disabled; `whatsapp:controls` toggles them independently; C9 scenario 1 proves `jale_whatsapp` cannot write them |
| 5 | Delivery policy | C2 | `evaluateDelivery` is pure and table-tested across all nine rows, including expiry precedence, owner validation, kill switch, and focused-conversation irrelevance |
| 6 | Delivery gateway | C4 | `enqueueWorkerMessage` dedupes, re-evaluates from locked rows, creates an outbox row only on `allow`, and never calls Twilio; `insertAuthorizedIntentOutbox` rejects unauthorized rows; C9 scenarios 7 and 8 |
| 7 | SM/MM validation | **C1 and C3** | C1: `isTwilioMessageSid` adopted by `twilio.ts`, `outbox.ts:10`, and `status-callback.ts:7`, with a grep proving no `SM`-only TypeScript literal remains. C3: migration `042` re-creates `jale_twilio_callback.record_whatsapp_delivery_status` with `'^(SM|MM)[0-9A-Fa-f]{32}$'` (the `040:313` guard), verified by an `MM` callback accepted and an `XX` callback still raising `22023` |
| 8 | FIFO webhook / DLQ / CDK / alarms | C5 (queues, webhook, DLQ alarms), C7 (drain, schedule, operational alarms) | `whatsapp-inbound-v2.fifo` + `.fifo` DLQ, `maxReceiveCount: 5`, `ContentBasedDeduplication: false`, `MessageGroupId` = phone hash, `MessageDeduplicationId` = `MessageSid`, batch size 1 with `ReportBatchItemFailures`, legacy queue unchanged; six alarms total; canonical deterministic synth green in both tasks |
| 9 | Job-alert deferral | C6 | `job-alert.ts` submits `job_alert` intents with `job-alert:<jobId>:<workerId>` and 72-hour expiry; no outbox row at any onboarding step |
| 10 | Employer-message deferral | C6 | `job-messaging.ts` submits `employer_chat` intents with `employer-chat:<messageId>` and 7-day expiry; `job_conversation_messages` remains the source of truth and its writes are unchanged |
| 11 | Release and grouping | C6 (logic), C7 (execution) | Four ordered groups, ≤10-job digest with the rest superseded, employer block last, contiguous per-worker sequence, release-time revalidation from live source rows, lease-protected single release; C9 scenarios 4 and 5 |
| 12 | Exact-target reset | C8 | Required `--user-id`/`--phone`/`--reason` plus exactly one of `--dry-run`/`--execute`; no wildcard or list mode; dry-run counts then rollback; phone mismatch aborts; ordered scoped deletes preserving the `users` row, Cognito identity, and `legal_consent_log`; idempotent re-reset to `start.choose_language`; audit row with operator, timestamp, reason, and counts |
| 13 | PostgreSQL RLS gate | C3 (structure), C9 (enforcement) | RLS enabled and forced on all seven worker tables with column-scoped grants and a self-audit; C9 scenario 1 proves cross-worker denial under `SET ROLE jale_whatsapp` |
| 14 | Idempotency gate | C9 | Scenario 2: duplicate inbound SID rejected, duplicate `dedupeKey` yields one intent; scenario 6: `ON CONFLICT (event_key)` yields one domain event per key |
| 15 | Lease gate | C3 (function), C7 (sole lease owner), C9 (behavior) | `lease_worker_domain_events` is `SECURITY DEFINER` with a catalog-only `search_path`, bounded limit, `FOR UPDATE SKIP LOCKED`, `PUBLIC` execute revoked; C7 never double-claims an event; C9 scenario 4 proves exactly one release under concurrency |
| 16 | Concurrency gate | C9 | Scenario 3 (one active workflow), 4 (single release), 5 (unique contiguous sequence), 7 (gate holds under ten concurrent enqueues) |
| 17 | Rollout tooling | C8 (controls CLI), C10 (runbook) | `whatsapp:controls` with `--show`/`--enable`/`--disable`/`--allow-phone`/`--deny-phone`/`--go-global`, hashes only; runbook covers inspection, dry run, reset, go/no-go, disable, and failure procedure |
| 18 | Final integration | C10 | Workflow-lane handoff verification table, full local gate (build, full Jest, PostgreSQL testbed, deterministic synth, reviewed diff), differential review, recorded commit SHA, hard stop before push/deploy/RDS/reset |

**Ownership exclusions honored.** No task creates or modifies `processor.ts`, `onboarding-v2.ts`, `conversation-router.ts`, `profile-flow.ts`, `handlers/custom-trust.ts`, `templates.ts`, `interactive-templates.ts`, `ai/trust-scorer.ts`, or their suites. The one place this lane would otherwise need worker-facing bilingual text — the grouped release, including the multiple-employer summary — is resolved by the `ReleaseRenderer` interface: Codex owns the contract and the ordering, the workflow lane owns every string, and C10 fails the gate if `createReleaseRenderer()` is absent.

**Single-owner check.** `outbox.ts` (C1 → C4) and `whatsapp-stack.ts` (C5 → C7) are the only shared files, and both are explicitly sequenced with the later task branching off the earlier task's post-fix state. `infra/package.json` is edited by C8 and then C10, which runs last. The two `*.integration.test.ts` files have distinct owners: structure and grants in C3, enforcement and concurrency in C9. No two concurrent tasks share a file.

**Placeholder scan.** Every interface is given as a complete signature, every constraint value and dedupe key is literal, every command is copy-pastable with a stated expected failure or pass, and every task carries a dev-cycle Review 1 / Fix / Review 2 gate. No step defers a decision to implementation time. Work that the design document places after the deadline — new Profile buttons, trade-change UI, an admin dashboard, LocalStack, a cloud sandbox, legacy cleanup — is excluded in Global Constraints rather than stubbed.

**Type consistency.** C2 defines `WorkerMessageIntentInput`, `DeliveryDecision`, `RuntimeControls`, shared category/release renderer contracts, `hashNormalizedPhone()`, `isV2Enabled()`, and `isTwilioMessageSid()` once. C4 defines the pre-auth and repository operations once. C6 and the workflow lane consume those exact names without re-declaration.
