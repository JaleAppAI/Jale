# WhatsApp v2 — Lane C Sprint Completion Plan

**Owner:** Sprint18C (Claude Opus 4.8 orchestrator). **Branch:** `fix/wa-v2-sprint-completion`, base `748cc916`.
**Worktree:** `.worktrees/wa-v2-sprint-completion`. **Execution:** Sonnet subagents, one at a time in this worktree, orchestrator reviews every diff + runs real-PG gates + commits. Order: **O2 → O1 → O3** (eligibility before the sweep that re-drives release; replay is independent, last).

## Hard constraints (all tasks)
- Do **not** edit Lane C2 files: `domain-outbox-drain.ts`, `whatsapp-stack.ts` (or `lib/stacks/whatsapp-stack.ts`), their tests, assessment types.
- No push / deploy / AWS / prod / runtime-control mutation on real infra / worker reset.
- TDD (red→green), real-PostgreSQL integration tests where specified, no raw phones/OTPs/message bodies/DB URLs/secrets in any log or output.
- Additive migration `044_*` only; never edit 001–043. New package scripts only (orchestrator reconciles `package.json` centrally to avoid collisions).

## Architecture decisions (binding)

**D1 — Re-trigger by re-emitting `worker.ready` (O1).** The drain (C2-owned) leases `worker.ready` from `worker_domain_outbox` and calls `releaseWorkerReady`. To re-drive deferred workers when `deferred_delivery` flips on, the sweep **INSERTs fresh `worker.ready` events** (new per-sweep-generation `event_key`, e.g. `worker.ready:sweep:<workerId>:<sweepRunId>`, status `pending`) — never edits the drain. Idempotency is guaranteed by the **release layer**: `releaseWorkerReady` leases intents `WHERE status IN ('deferred','eligible') ... FOR UPDATE SKIP LOCKED`; already-`released` intents are never re-leased, and the `onboarding-complete:<workerId>` dedupe key makes the synthesized confirmation a no-op. So repeated enables / concurrent sweeps cannot duplicate messages or sequences. An optional `WHERE NOT EXISTS (pending/processing worker.ready for that worker)` guard reduces event churn (not a correctness dependency).

**D2 — NO migration is required (CORRECTED).** The original premise was wrong: it was derived from grepping migration 042 alone. Migration **043** already creates `worker_message_intents_definer` (`TO jale_admin ... FOR ALL USING (true)`), and 042 creates `worker_onboarding_state_definer` and `worker_domain_outbox_definer` for `jale_admin`. So the sweep-as-`jale_admin` reads and the event INSERT all succeed on the **001–043** chain — verified empirically against the local testbed with the candidate 044 policy **dropped**, and by the O1 real-PG integration test passing on that baseline. A drafted `044_whatsapp_delivery_retrigger_sweep_read.sql` (a redundant SELECT-only policy layered on the existing FOR ALL policy) was therefore **deleted**: the handoff authorizes 044 only "if database support is required," and an unnecessary migration would cost a real RDS apply at the merge gate for zero functional gain, while leaving two overlapping `jale_admin` policies on one table.

**D3 — Replay target = `worker_domain_outbox` (O3), an explicit interpretation.** "inbound event/message" is read as an internal domain event because it is the **only** DB record retaining original payload + idempotency key (`event_key` UNIQUE) + a status lifecycle (`pending/processing/completed/failed`). `whatsapp_processed_messages` stores no body; SQS DLQ redrive needs AWS (forbidden). Ruled out: no other inbound payload table exists (`billing_webhook_events`/`admin_case_events` are unrelated). **This decision is recorded in the handoff report for the merge-gate review.**

## O2 — Release-time eligibility (Task B, do FIRST)
**Files:** `lambda/whatsapp/worker-ready-release.ts`, `test/unit/lambda/whatsapp/worker-ready-release.test.ts` (+ real-PG coverage if a suitable integration harness exists; otherwise focused unit tests with a fake client). May touch `lib/delivery-policy.ts` **only if required**.

Extend the eligibility reload (currently `worker-ready-release.ts:238-294`). Fail closed on missing source state with a **stable `decision_reason`** (via the existing `discard(..., 'superseded'|'expired'|..., reason)` path). Concrete predicates:

- **job_alert** (currently: job exists + `status='active'`). Add:
  - worker still ready: `gate?.lifecycle === 'ready'` (already loaded) else discard `worker_not_ready`.
  - still matches (mirrors producer `job-alert.ts:101-104`): `NOT EXISTS job_applications(job_id=intent.sourceId, worker_id=workerId)` — if the worker has since applied, discard `worker_already_applied`.
  - keep `job_not_active` for missing/closed job.
- **employer_chat** (currently: conversation exists + `status='open'`). Reload the full chain in the existing join (add columns) and check, in order, with stable reasons:
  - message exists (`jcm.id`) else `message_missing`.
  - job active (`j.status='active'`) else `job_not_active`.
  - employer valid (employer user row for `jc.employer_id` exists; `employer_display_name` non-null) else `employer_missing`.
  - worker ready (`gate.lifecycle='ready'`) else `worker_not_ready`.
  - application exists (`EXISTS job_applications(job_id=jc.job_id, worker_id=workerId)`) else `application_missing`.
  - conversation open (`jc.status='open'`) else `conversation_closed` (existing).
- Verify exact column names against migrations 003 (jobs/job_applications) and 025 (job_conversations/messages) before writing SQL. `jobs.status IN ('active','closed')`, `job_applications` UNIQUE(job_id,worker_id) status in pending/reviewed/hired/rejected, `jobs.employer_id → users`.

**Tests (TDD):** each new discard reason gets a red-first unit test proving the ineligible source row is discarded with that exact reason and never rendered/authorized; plus a still-eligible happy path per category. Preserve all existing worker-ready-release tests green.

## O1 — Deferred re-trigger sweep (Task A, do SECOND)
**Files:** NEW `lambda/whatsapp/lib/delivery-retrigger-sweep.ts` (exported, testable sweep logic), `scripts/whatsapp-runtime-controls.ts` (wire sweep into `--enable deferred_delivery`), NEW `db/migrations/044_*.sql` (D2), NEW focused tests + a real-PG integration test, `package.json` (orchestrator adds any script).

- Sweep fn `retriggerDeferredReadyWorkers(client, { limit, sweepRunId, now })`: SELECT up to `limit` distinct `worker_onboarding_state.lifecycle='ready'` workers having ≥1 `worker_message_intents` row with `status='deferred' AND outbox_id IS NULL AND category = ANY(business categories)`; for each INSERT a `worker.ready` event (fresh `event_key`, D1). Bounded batches; loop chunks until no eligible workers remain (enqueue only — the drain releases in its own 25/min batches). Optional `NOT EXISTS pending/processing worker.ready` guard.
- CLI: after flipping `deferred_delivery_enabled` to enabled (`runControlsAction` enable path), run the sweep in the same connection/transaction so enabling and enqueue commit together. `--disable` must NOT sweep. Preserve all existing CLI invariants (no raw phone, one-flag parse, `--show` hashes-only).
- **Integration test (real PG, required):** disabled → insert deferred business intents + a ready worker + a completed original `worker.ready` → enable (run sweep) → run the real drain/`releaseWorkerReady` → assert exactly one grouped release, correct `release_sequence`, and that a **second** enable/sweep + drain produces **zero** additional released rows/messages (idempotency). Use the committed testbed harness (`bash scripts/run-whatsapp-v2-db-tests.sh` style / `db/local/bootstrap-testbed.sh`), superuser + `SET ROLE`/RLS context as the existing concurrency gate does.

## O3 — Exact-ID replay (Task C, do THIRD)
**Files:** NEW `scripts/replay-domain-event.ts` (thin CLI) + NEW `scripts/lib/replay-domain-event.ts` (or inline exported pure fns) for a testable parser + planner, NEW tests, `package.json` (orchestrator adds `replay:whatsapp-domain-event` script).

- **Parser:** accept exactly one ID — either a `worker_domain_outbox.id` (uuid) or `event_key` (text). Reject: zero IDs, >1 ID, commas/lists, `*`/glob/wildcards, ranges. `--execute` required to mutate; **dry-run is default**. Ambiguous ID (matches both a row `id` and a different row's `event_key`) → reject `ambiguous_id`.
- **State display (before mutation):** print event_type, status, attempts, aggregate_id (uuid — safe), last_error presence (boolean, never the text), created_at, and a **redacted** payload summary (keys/types only, never raw values). Also show the worker's onboarding lifecycle + deferred/released intent counts (reads via the 044 SELECT policy). **Never** print raw phones/OTPs/bodies/DB URLs/secrets.
- **Replay semantics:** reuse the SAME `event_key` (idempotency key) + stored `payload`; on `--execute` reset a `pending`/`failed` (or lease-expired `processing`) event to `status='pending', leased_until=NULL, lease_token=NULL, next_attempt_at=now()`. `completed` → **safe no-op**: report "already successful", exit 0, no mutation (satisfies "reject already-successful unless a safe no-op"). Actively-leased `processing` (unexpired lease) → reject `event_in_flight`.
- **Tests (TDD):** parser (rejects wildcards/lists/bulk/ambiguous, requires one ID + `--execute`), authorization-boundary (runs as `jale_admin` under the `worker_domain_outbox_definer` policy; asserts it touches only `worker_domain_outbox` for mutation and fails closed if the row/role is wrong), idempotency (re-drive reuses event_key; a second replay + drain yields no duplicate release), replay-state (completed = no-op; state shown before mutation; no secret/phone/body in output).

## Final battery (orchestrator, after all three)
tsc build; full unit suite; `npm run test:whatsapp-v2`; the new focused tests; real-PG gates incl. the O1 integration + O3 idempotency against the live testbed; guarded `test:whatsapp-v2-db`; independent Sonnet review of the whole diff (resolve Critical/Important); local commit(s); handoff report under `whatsapp-v2-local-records/` (record the D3 interpretation). Stop before push/AWS/prod. Preserve `jale-wa-v2-pg` + volume.
