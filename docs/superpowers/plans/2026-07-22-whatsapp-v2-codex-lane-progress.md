# WhatsApp V2 — Codex Integration Lane Progress & Handoff

**Date:** 2026-07-22 (updated after C7)
**Lane branch:** `feat/wa-v2-integration` @ `3c3f766` (worktree `.worktrees/wa-v2-integration`)
**Master plan:** `docs/superpowers/plans/2026-07-21-whatsapp-v2-codex-lane.md` (tasks C1–C10)
**Companion Claude lane:** `feat/wa-v2-workflow` @ `938538f` (worktree `.worktrees/wa-v2-claude`) — FROZEN, read-only until C10.

---

## 1. What this lane is

Dual-orchestrator build of "WhatsApp onboarding v2". The integration lane
(`feat/wa-v2-integration`) is merge captain and owns the shared primitives (types, migration,
repository/gateway, queue, release, drain, CLIs, DB gate, runbook) as tasks **C1–C10**. The
Claude workflow lane (`feat/wa-v2-workflow`) owns the processor / conversation-router /
onboarding-router surface and consumes these primitives. The two lanes never edit each
other's files (see *Ownership Exclusions* in the master plan).

Execution model: each task is implemented TDD-first by a dispatched Sonnet subagent working
directly in the integration worktree; the orchestrator personally runs the three-phase
**Review 1 / Fix / Review 2** dev-cycle gate (reads every diff, re-runs the focused command
and `npm run build`), then the commit lands on `feat/wa-v2-integration`.

---

## 2. Progress to date

### Done and integrated into `feat/wa-v2-integration`

| Task | Scope | Commit(s) | Status |
| --- | --- | --- | --- |
| **C1** | Accept `SM`+`MM` Twilio SIDs (`isTwilioMessageSid`) in `twilio.ts`/`outbox.ts`/`status-callback.ts` | `1e22ac6` | ✅ |
| **C2** | Shared types, runtime controls, pure delivery policy, renderer contracts | `4436ca6` | ✅ |
| **C3** | Migration `042` — additive v2 data model, RLS + grants, lease fn, MM callback, self-audit | `e5b56e0`,`3b0b543`,`418b70d`,`c02cd28` | ✅ |
| **C4** | Repository primitives + worker-delivery gateway | `d1cb18a` | ✅ |
| **C5** | FIFO inbound queue + DLQ + webhook routing + DLQ alarms | `8ad6f94` | ✅ review clean |
| **C6** | Producer deferral + grouped worker-ready release | `55cef45` (amended from `b308b86`) | ✅ review clean after 1 fix round |
| **C7** | Scheduled domain-event drain, release wiring, operational alarms | `3c3f766` | ✅ review clean |

**Verification captured at each gate:** C5 — 55/55 focused tests, tsc 0, synth emits both legacy
and v2 FIFO queues. C6 — 67/67 focused tests, tsc 0. C7 — 65/65 focused tests, tsc 0, synth
emits v2 queues + drain Lambda/schedule/4 alarms. All diffs stayed within each task's owned
files; no Ownership-Exclusion file was touched; C5's queue defs untouched by C7.

### Remaining

- **C8** — operator CLIs (`reset-whatsapp-onboarding-v2.ts`, `whatsapp-runtime-controls.ts`) + 2
  package.json scripts. Depends on C3 only; independent of C5–C7. **Next task.**
- **C9** — PostgreSQL RLS/idempotency/lease/concurrency gate
  (`whatsapp-onboarding-concurrency.integration.test.ts`). Depends on C6 (transitively C3/C4).
- **C10** — rollout runbook + final integration (merge frozen workflow lane, handoff verification,
  full local gate, differential review). Depends on all + the frozen workflow lane.

---

## 3. BINDING cross-task decisions (locked during C5–C7 reviews — C8/C9/C10 MUST honor)

1. **Release transaction/RLS model (design B):** `releaseWorkerReady(client, eventKey, deps)` is
   caller-owned-transaction — it issues **no** BEGIN/COMMIT/ROLLBACK and throws on failure
   (like `completeOnboarding`). The caller MUST, inside its open transaction, call
   `setInternalUserRlsContext(client, workerId)` (workerId = the leased event's `aggregate_id`)
   **before** calling. Forced by migration 042 FORCE RLS: `worker_message_intents_worker` =
   `user_id = current_setting('app.current_internal_user_id',true)`, `worker_domain_outbox_worker`
   = `aggregate_id = …`. As `jale_whatsapp` with no context every worker-scoped read returns 0
   rows (silent no-op). This was a Critical C6 review finding, now fixed.
2. **C7 drain flow (implemented):** per `worker.ready` event — `BEGIN; setInternalUserRlsContext(aggregate_id);
   releaseWorkerReady(client, event_key, deps); UPDATE worker_domain_outbox SET status='completed' …; COMMIT`.
   On throw → ROLLBACK, emit `WhatsAppReleaseFailure`, then a separate tx marks failure (attempts+1,
   `next_attempt_at = now()+least(30s·2^(attempts-1),30min)`, status back to `'pending'` for retry;
   `'failed'`+`WhatsAppDomainEventStuck` at attempts≥5). `lease_worker_domain_events` claims
   `status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=now())`.
3. **Drain renderer seam:** the drain injects a `ReleaseRenderer` via `setDomainOutboxDrainDeps(...)`.
   Its default `unwiredRenderer` THROWS. **C10 must call `setDomainOutboxDrainDeps({ renderer: createReleaseRenderer(), … })`**
   at module load or every `worker.ready` release fails loud.
4. **C9 must run release/RLS scenarios under `SET ROLE jale_whatsapp` with per-worker
   `app.current_internal_user_id`** (not as superuser), or the RLS enforcement ships behind a green gate.
5. **C8 reset ordering:** `releaseWorkerReady` synthesizes the onboarding-complete confirmation
   intent with dedupe key `onboarding-complete:<workerId>` (idempotent across `worker.ready` retries).
   This is only safe across RE-onboards because C8's reset deletes `worker_message_intents` FIRST —
   the master-plan delete order already starts there; keep it.

## 4. Watch items for C9 (real Postgres) / C10

- Column grants for `jale_whatsapp` under context on `jobs` (company/status/title), the
  `job_conversation_messages`/`job_conversations` join, and `users.whatsapp_number` — if missing,
  the release fails under RLS; bounce to the owning task.
- Employer-chat release eligibility currently re-checks only `job_conversations.status='open'`
  (+ existence of job/conversation via join); the plan prose also lists job/employer/worker/
  application — documented narrower scope, no C9 scenario coverage.
- C7 `assessment.requested` handler is ack-only (idempotent `ON CONFLICT DO NOTHING`; no Bedrock).
  The partial-index ON CONFLICT syntax is unexercised against real Postgres; C10 should validate.
  The real scoring/assessment lane wiring is C10's.
- C6 job-alert digest `score` is a hardcoded placeholder (`score:1`; no V1 scoring signal).

## 5. Global constraints (still binding)

Additive `042` only; never edit `001`–`041`. Only the delivery gateway may create sendable
worker-directed outbox rows. Verified OTP is the only identity-binding operation. Never target
RDS from a local test (disposable PostgreSQL 16 via `JALE_TEST_DATABASE_URL`; persistent
container `jale-wa-v2-pg` + volume `jale-wa-v2-pgdata` are the cache). No push, deploy, RDS
migration, worker reset, or production Twilio/Cognito. Task agents never edit `.worktrees/wa-v2-claude`.

## 6. Resume checklist (start C8)

1. `cd .worktrees/wa-v2-integration && git status` → clean at `3c3f766`.
2. Read master plan **Task C8 (lines 1118–1208)** + Global Constraints.
3. Execute C8 TDD (exact-target reset CLI + runtime-controls CLI + 2 package.json scripts); review
   every `DELETE` for a target-ID-bound `WHERE`; `users` and `legal_consent_log` never deleted;
   `worker_message_intents` deleted first; `--show`/reset print hashes only, never raw phones.
4. Then C9 (real-Postgres gate, honor decision #4) and C10 (runbook + final integration, honor
   decisions #3 and #5).

Durable orchestrator ledger with full per-task review evidence:
`/home/hermesgoma/whatsapp-v2-local-records/2026-07-22-whatsapp-v2-integration-C5-C10-ledger.md`.
