# WhatsApp V2 — Codex Integration Lane Progress & Handoff

**Date:** 2026-07-22
**Author of this note:** Claude Code (picking up the Codex integration lane after Codex hit its OpenAI weekly usage limit mid-run)
**Lane branch:** `feat/wa-v2-integration` @ `c02cd28` (worktree `.worktrees/wa-v2-integration`, ahead of `origin/main` by 10 commits, 0 behind)
**Master plan:** `docs/superpowers/plans/2026-07-21-whatsapp-v2-codex-lane.md` (tasks C1–C10)
**Companion Claude lane:** `feat/wa-v2-workflow` (worktree `.worktrees/wa-v2-claude`, Sprint18C tmux session)

---

## 1. What this lane is

Dual-orchestrator build of "WhatsApp onboarding v2". Codex runs the **integration lane**
(`feat/wa-v2-integration`) as merge captain and owns the shared primitives (types, migration,
repository/gateway, queue, release, drain, CLIs, DB gate, runbook) as tasks **C1–C10**. A
separate Claude lane (`feat/wa-v2-workflow`) owns the processor / conversation-router /
onboarding-router surface and consumes Codex's primitives. The two lanes never edit each
other's files (see *Ownership Exclusions* in the master plan).

Codex's working model: for each task it creates a disposable worktree branched off the lane
branch, dispatches a task agent to implement it TDD-style, personally runs a three-phase
**Review 1 / Fix / Review 2** dev-cycle gate, then commits/merges into `feat/wa-v2-integration`.

---

## 2. Progress to date

### Done and integrated into `feat/wa-v2-integration`

| Task | Scope | Integration commit(s) | Status |
| --- | --- | --- | --- |
| Docs | Design + plans (onboarding-gate design/plan, worktree contract, dual-orchestrator plans) | `f5a5fc8`, `ee2fa89`, `cabfe3e`, `ac8432a` | ✅ merged |
| **C1** | Accept both `SM` and `MM` Twilio SIDs in TypeScript; single exported `isTwilioMessageSid` used by `outbox.ts` + `status-callback.ts` | `1e22ac6` | ✅ integrated & verified |
| **C2** | Shared types (`onboarding-types.ts`), runtime controls (`runtime-controls.ts`), pure delivery policy (`delivery-policy.ts`), renderer contracts | `4436ca6` | ✅ integrated & verified |
| **C3** | Migration `042_whatsapp_onboarding_gate.sql` — additive v2 data model (8 tables, constraints, RLS + grants, lease fn, MM-capable delivery callback, fail-closed self-audit) + its integration test | `e5b56e0`, `3b0b543`, `418b70d` | ✅ integrated locally |
| C3 follow-up | Widen `whatsapp_outbox_origin_check` to include `'worker_intent'` (cross-lane fix required by C4; see master plan line ~779) + apply-order test assertion | `c02cd28` | ✅ integrated |

**Verification evidence captured before the stop:**
- C3's own PostgreSQL suite reached **9/9 green** during its Review 2.
- A fresh production-shaped PostgreSQL 16 chain applied migrations `001`–`042` cleanly.
- A subsequent whole-chain bootstrap run scored **8/9**; the one failure was a
  disposable-container **password/credential mismatch in the test harness** (second-apply
  connection), **not** a migration or behavioral assertion. This was being fixed when the
  usage limit hit.
- Claude lane's unblocked subset (its Tasks 1–3) is complete, clean, and independently
  verified (build green; 190/190 focused + 519/519 WhatsApp-tree tests; no gated symbol
  leakage). It is correctly **stopped**, waiting for C2–C4 to land before its dependent work.

### Not started

- **C4** — repository primitives + worker-delivery gateway. Worktree `.worktrees/wa-v2-c4`
  (branch `task/wa-v2-c4`) exists and is **clean at `c02cd28`**; no C4 files written yet.
  **This is the next task.**
- **C5–C10** — queue/webhook (C5), producer deferral & grouped release (C6), drain/alarms
  (C7), operator CLIs (C8), PostgreSQL RLS/idempotency/concurrency gate (C9), rollout runbook
  & final integration (C10). All blocked behind C4 (and each other) per the dependency graph.

---

## 3. Why work stopped (blockers)

1. **Codex OpenAI weekly usage limit reached** — 0% remaining, resets **11:33 on 28 Jul 2026**.
   The approval/auto-reviewer service began denying commands ("You've hit your usage limit").
2. **Codex sandbox loopback namespace error** — Codex's own sandboxed shell could not open
   loopback sockets. NOTE: this was specific to Codex's sandbox. This host shell CAN run
   `docker` and open TCP loopback normally, so **this does not block a Claude-run continuation.**

### Leftover environment to clean up
- Disposable container **`jale-wa-v2-bootstrap-pg16`** is still running (up ~9h,
  `127.0.0.1:55558->5432/tcp`). Remove it once no longer needed:
  `docker rm -f jale-wa-v2-bootstrap-pg16`.
- Earlier C3 containers (`jale-wa-v2-c3-captain`, `jale-wa-v2-c3-review1`) may also linger —
  check `docker ps -a --format '{{.Names}}' | grep jale-wa-v2`.

**No push, no deploy, no RDS migration, no production reset occurred.** Everything stops at
local commits, per the lane's global constraints.

---

## 4. Next task: C4 (fully unblocked at the code level)

Full spec: master plan **lines 642–833** (`### Task C4`). Summary of what to build in
`.worktrees/wa-v2-c4` (branch `task/wa-v2-c4`):

**Create**
- `infra/lambda/whatsapp/lib/onboarding-repository.ts`
- `infra/lambda/whatsapp/lib/worker-delivery-gateway.ts`
- `infra/test/unit/lambda/whatsapp/lib/onboarding-repository.test.ts`
- `infra/test/unit/lambda/whatsapp/lib/worker-delivery-gateway.test.ts`

**Modify**
- `infra/lambda/whatsapp/lib/outbox.ts` — add/export `insertAuthorizedIntentOutbox(...)`
  (inserts `source_type='worker_intent'`, `source_id=intentId`; verifies intent exists and is
  `eligible`/`leased`, else throws `unauthorized_worker_outbox_row`). Leave every legacy
  outbox function unchanged.
- `infra/test/unit/lambda/whatsapp/lib/outbox.test.ts`

**Key interfaces to implement exactly** (signatures in master plan):
`loadWorkerGate`, `loadPreAuthStateForUpdate`, `savePreAuthState`,
`bindVerifiedIdentityAndStartWorkflow`, `advanceWorkflow` (with `expectedLockVersion` guard),
`appendTransition`, `completeOnboarding` (no `BEGIN`/`COMMIT`/`fetch`; two `worker_domain_outbox`
rows via `ON CONFLICT (event_key) DO NOTHING`; throws `workflow_lock_conflict` on 0 rows);
and gateway `enqueueWorkerMessage`, `registerCategoryRenderer` (+ `_clearCategoryRenderersForTests()`).

**Dependencies — all present and confirmed in the C4 worktree:**
- C2 types: `infra/lambda/whatsapp/lib/onboarding-types.ts` (defines `WorkerLifecycle`,
  `WorkflowStepKey`, `WorkflowRunStatus`, `MessageCategory`, `OwnerService`, `IntentStatus`,
  `PreferredLanguage`, `DELIVERY_POLICY_VERSION`, `DeliveryDecision`, `WorkerMessageIntentInput`,
  `RenderedOutboxMessage`, `CategoryRenderer`, release renderer types).
- C2 policy/controls: `delivery-policy.ts` (`evaluateDelivery`), `runtime-controls.ts`
  (`loadRuntimeControls`, `isV2Enabled`, `isDeferredDeliveryEnabled`, `hashNormalizedPhone`).
- C1 outbox: `outbox.ts` imports `isTwilioMessageSid` from `twilio.ts`.
- C3 migration `042`: target tables `worker_onboarding_state`, `worker_workflow_runs`
  (`lock_version`, partial unique on active run), `worker_workflow_transitions`,
  `worker_identity_challenges`, `worker_message_intents` (dedupe constraint
  `worker_message_intent_dedupe UNIQUE (dedupe_key)`), `worker_domain_outbox`
  (`worker_domain_outbox_event_key UNIQUE (event_key)`), plus the widened
  `whatsapp_outbox_origin_check` allowing `'worker_intent'`.

**Do NOT touch:** `delivery-policy.ts`, `runtime-controls.ts`, migration `042`, and everything
in the master plan's Ownership Exclusions list (processor.ts, conversation-router.ts,
onboarding-v2.ts, templates, trust-scorer, and their tests — Claude lane).

**Test-first workflow (master plan C4 Steps 1–6):**
1. Write failing repository + gateway tests using a fake `PoolClient` that records
   `{ text, values }` per `query()` and returns scripted results — style ref:
   `infra/test/unit/lambda/lib/job-messaging.test.ts`. Assert the behaviors enumerated in the
   spec (defer-on-onboarding, no outbox insert; ready+deferredDeliveryEnabled → allow + one
   renderer call + one outbox row; dedupe → one intent/one outbox; invalid owner → reject;
   `completeOnboarding` no BEGIN/COMMIT + lock-conflict throw + ON CONFLICT id reuse; gateway
   never calls `fetch`; `insertAuthorizedIntentOutbox` throws on non-eligible intent).
2. Confirm RED: `cd infra && npx jest test/unit/lambda/whatsapp/lib/onboarding-repository.test.ts test/unit/lambda/whatsapp/lib/worker-delivery-gateway.test.ts --runInBand`
   (expect `Cannot find module` errors).
3. Implement repo, gateway, and outbox guard. All SQL parameterized; no string-concatenated
   predicates; no module state except the renderer registry (with test reset).
4. GREEN: `cd infra && npx jest <the three suites> --runInBand && npm run build`.
5. Dev-cycle Review 1 / Fix / Review 2 (orchestrator runs reviews personally — see master plan
   "Per-Task Dev-Cycle Review Gate"). Review 1 must confirm `completeOnboarding` has no
   `BEGIN`/`COMMIT`/`fetch`/AWS SDK call, the gateway re-reads policy from locked rows (not a
   caller-supplied lifecycle), and no legacy outbox behavior changed.
6. Commit: `git commit -m "feat: add WhatsApp worker delivery gateway and onboarding repository"`,
   then merge `task/wa-v2-c4` into `feat/wa-v2-integration`.

**Handoff after C4:** `completeOnboarding()` and `enqueueWorkerMessage()` become the sanctioned
entry points the Claude workflow lane calls; C6 then branches off the post-C4 lane state.

---

## 5. Global constraints (binding on continuation)

- Read `docs/superpowers/specs/2026-07-21-whatsapp-onboarding-gate-design.md` and
  `docs/superpowers/plans/2026-07-21-whatsapp-onboarding-gate.md` before editing.
- Additive migration `042` only; never edit `001`–`041`. `CREATE OR REPLACE` of a `040`
  function inside `042` is allowed; editing `040` is not.
- Only the delivery gateway may create sendable worker-directed outbox rows.
- Successful OTP verification is the only identity-binding operation; never bind `user_id` from
  a phone lookup.
- Never target RDS from a local test; DB gate uses disposable PostgreSQL 16 via
  `JALE_TEST_DATABASE_URL`. Testbed wrapper:
  `bash /home/hermesgoma/.codex/skills/psql-migration-testbed/scripts/run-psql-migration-testbed.sh --repo .`
- Leave untracked `demo-ready-windows/` and `reports/` untouched.
- Do not push, deploy, run RDS migrations, or reset any production worker. Stop at local commits.

---

## 6. Quick resume checklist

1. `cd .worktrees/wa-v2-c4 && git status` → should be clean at `c02cd28`.
2. Confirm the leftover `jale-wa-v2-bootstrap-pg16` container's fate (reuse or `docker rm -f`).
3. Read master plan Task C4 (lines 642–833) + design spec.
4. Execute C4 Steps 1–6 above.
5. Then proceed down the dependency graph: C5/C8 (parallel-eligible), C6 (after C4), C7, C9, C10.
