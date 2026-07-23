# WhatsApp Onboarding v2 — Production Rollout Runbook

**Status:** ready for operator execution — **execution requires separate, explicit
user authorization.** Nothing in this runbook runs automatically. Every command
below is copy-pastable, but the destructive and outward-facing ones (migration
apply, `cdk deploy`, runtime-control writes, the `--execute` reset) must not be
run without a human operator deliberately choosing to, per the sprint's global
constraints (no push/deploy/RDS-migration/worker-reset without explicit approval).

**Verified integration commit:** `d120cfa` on `feat/wa-v2-integration` (the
code state the full local gate ran green against — see the Handoff section
below; the final integration commit adds only this runbook and the
`test:whatsapp-v2-db` script). Operator-input tokens below — `<uuid>`,
`<operator_e164>`, `<worker2_e164>`, etc. — are parameters the operator fills at
runtime, not unresolved placeholders.

**Every inspection query in this runbook is read-only** (`SELECT` only). They are
safe to run against a target database for verification; they mutate nothing.

---

## 0. Model and safety recap

- v2 is gated behind two independent runtime controls, both seeded **disabled**
  (`onboarding_v2_enabled`, `deferred_delivery_enabled` in
  `whatsapp_runtime_controls`). Legacy onboarding keeps working for every
  non-allowlisted phone until v2 is enabled for it.
- Successful OTP verification is the **only** identity-binding operation. Nothing
  binds `user_id` from a phone lookup.
- Only the delivery gateway creates sendable worker-directed outbox rows.
- Rollout order: enable v2 for the operator's **one** verified phone → verify end
  to end → only then the other two accounts → global → deferred delivery last.

---

## 1. Prerequisites — local gate must be green first

Run the full local gate (build, unit suite, the three PostgreSQL testbed gates,
deterministic synth, reviewed diff) and record the outputs. Expected results are
recorded verbatim in the **Handoff** section at the end of this runbook.

```bash
cd infra
npm run build            # tsc → exit 0
npm test -- --runInBand  # full unit suite → 0 failures
```

The database gates use the **in-repo** testbed
(`infra/db/local/bootstrap-testbed.sh`), which applies the chain as the
non-superuser `jale_admin` owner — the production ownership model. The sprint
plans' single bundled four-suite command cannot pass against any testbed (see
`infra/db/local/README.md`); run the three gates below instead, which cover the
same ground and each get the database they require:

```bash
# Gate 1 — migrated suites (persistent container, chain applied incl. 042):
#          migrations + 042 gate + concurrency gate
cd infra/db/local
./bootstrap-testbed.sh --verify
export JALE_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55442/jale
cd ../.. && npx jest test/unit/db --runInBand \
  --testPathIgnorePatterns 'apply-order|billing-034-upgrade'
#   Expected: 8 passed / 8 total suites, no `CONCERN:` lines.

# Gate 2 — clean apply (virgin cluster WITH jale_admin; apply-order self-applies):
cd infra/db/local
./bootstrap-testbed.sh --ephemeral --empty --repo ../../.. \
  -- bash -lc 'cd infra && npx jest test/unit/db/migrations/apply-order --runInBand'
#   Expected: 25 passed, 1 skipped (the docs/ content check; docs/ is local-only).

# Gate 3 — migration 034 upgrade path (virgin cluster WITHOUT jale_admin):
./bootstrap-testbed.sh --ephemeral --bare --url-var JALE_TEST_UPGRADE_DATABASE_URL --repo ../../.. \
  -- bash -lc 'cd infra && npx jest test/unit/db/migrations/billing-034-upgrade --runInBand'
#   Expected: 14 passed.
```

The v2 database gate (042 + concurrency, the two suites this sprint added) is also
available as one command once the persistent testbed is up and
`JALE_TEST_DATABASE_URL` is exported:

```bash
cd infra && npm run test:whatsapp-v2-db
#   Expected (URL exported): 2 passed suites — migration 042 + onboarding
#     concurrency actually execute (no `CONCERN:`/skip lines).
```

This command is **fail-closed**: it runs through
`scripts/run-whatsapp-v2-db-tests.sh`, which exits non-zero (never printing the
URL) when `JALE_TEST_DATABASE_URL` is unset or empty — because both integration
suites SKIP without a database URL, so a bare `jest` invocation would exit 0
without verifying anything. With the URL unset it prints and exits 1:

```
run-whatsapp-v2-db-tests: JALE_TEST_DATABASE_URL is not set (or empty).
  Refusing to run: the migration-042 and concurrency suites SKIP without a
  database URL and jest would otherwise exit 0 without verifying anything.
  ...
```

Deterministic CDK synth and diff (use verbatim; an environment-less
`npx cdk synth` is invalid on this base):

```bash
cd infra
CDK_DEFAULT_ACCOUNT=111111111111 CDK_DEFAULT_REGION=us-east-2 \
npx cdk synth --all \
  -c environment=dev -c skipFrontend=true \
  -c emailFromAddress=ci-synth@jaleapp.ai \
  -c sesVerifiedIdentityArn=arn:aws:ses:us-east-2:111111111111:identity/jaleapp.ai \
  -c whatsappStatusCallbackUrl=https://api.example.invalid/whatsapp/status-callback \
  -c whatsappAlarmTopicArn=arn:aws:sns:us-east-2:111111111111:jale-ci-whatsapp-alarms
# then the same context with `npx cdk diff --all --no-change-set` in place of synth.
# (cdk diff compares against the deployed stack; offline, verify additivity by
# inspecting cdk.out/JaleWhatsAppStack.template.json — the legacy
# whatsapp-inbound-queue/-dlq stay unchanged while the v2 whatsapp-inbound-v2.fifo
# pair, DomainOutboxDrain Lambda + rate(1 minute) schedule, and v2 alarms are added.)
```

Expected diff: only reviewed **additive** v2 resources — a new FIFO inbound queue
pair, the domain-outbox drain Lambda + 1-minute schedule, new metric filters and
alarms — and **no** modification or replacement of the legacy inbound queue.
**Do not deploy from the prerequisite step.**

---

## 2. Apply migrations through 042 (RDS) — requires authorization

Migrations are manual, forward-only, applied via the bastion. Inspect the active
`MIGRATIONS` array in `scripts/run-migrations.sh` first (it is operator
scaffolding, not a ledger). Migration `042_whatsapp_onboarding_gate.sql` is
additive: eight new tables, `FORCE ROW LEVEL SECURITY` + column-scoped grants, the
lease function, and a fail-closed self-audit. It never edits `001`–`041`.

```bash
cd infra
npx cdk deploy JaleBastionStack        # if the bastion is not already up
../scripts/run-migrations.sh           # applies the chain through 042; inspect the array first
npx cdk destroy JaleBastionStack       # after use
```

Confirm `042` objects exist (read-only) against the target DB:

```sql
SELECT to_regclass('public.worker_onboarding_state')  IS NOT NULL AS onboarding_state,
       to_regclass('public.worker_workflow_runs')     IS NOT NULL AS runs,
       to_regclass('public.worker_message_intents')   IS NOT NULL AS intents,
       to_regclass('public.worker_domain_outbox')     IS NOT NULL AS domain_outbox,
       to_regclass('public.whatsapp_runtime_controls') IS NOT NULL AS controls,
       to_regclass('public.worker_reset_audit')        IS NOT NULL AS reset_audit;
-- expect all true
```

Deploy the additive code + infrastructure with **both controls disabled**
(default seed). Confirm before enabling anything:

```bash
cd infra && npm run whatsapp:controls -- --show
```

Expected: both `onboarding_v2_enabled` and `deferred_delivery_enabled` rows show
`enabled=false`, `global_enabled=false`, `phoneHashes=[]`. `--show` prints hashes
only — never a raw phone.

---

## 3. Enable v2 for the operator's one verified phone

```bash
cd infra
npm run whatsapp:controls -- --allow-phone "<operator_e164>"
npm run whatsapp:controls -- --show   # confirm exactly one hash in onboarding_v2_enabled.phone_hashes
```

`--allow-phone` stores only the SHA-256 hash. `global_enabled` stays false, so
only this one phone routes to v2; every other phone stays on legacy.

---

## 4. Dry-run, then execute, the clean reset for that one worker

The reset targets **exactly one** worker (`--user-id` + `--phone` must both be
given once; `--phone` must match the resolved worker's verified phone, or it
aborts before touching anything). It preserves the `users` row, the Cognito
identity, the verified phone, and `legal_consent_log`.

```bash
cd infra
# Dry-run: prints per-table counts, writes nothing, rolls back (no audit row).
npm run reset:whatsapp-v2 -- \
  --user-id <uuid> --phone "<operator_e164>" --reason "v2 rollout: first account" --dry-run
```

Expected dry-run output — a per-table count JSON printed **before** any mutation
(counts reflect current rows; zeros are normal for a fresh worker):

```json
{
  "worker_message_intents": <n>,
  "worker_domain_outbox": <n>,
  "worker_workflow_transitions": <n>,
  "worker_workflow_runs": <n>,
  "worker_identity_challenges": <n>,
  "worker_onboarding_state": <n>,
  "whatsapp_outbox": <n>,
  "whatsapp_processed_messages": <n>,
  "whatsapp_conversations": <n>,
  "job_conversation_messages": <n>,
  "job_message_outbox": <n>,
  "job_conversations": <n>,
  "job_applications": <n>,
  "worker_job_impressions": <n>,
  "worker_match_log": <n>,
  "job_candidates": <n>,
  "worker_trust_assessments": <n>,
  "worker_profile_ai_extractions": <n>,
  "worker_profile_media": <n>,
  "worker_skills": <n>,
  "worker_profiles": 1,
  "users": 1
}
```

Then, **only after reviewing the counts**, execute:

```bash
npm run reset:whatsapp-v2 -- \
  --user-id <uuid> --phone "<operator_e164>" --reason "v2 rollout: first account" --execute
```

`--execute` performs the scoped deletes + column-clears + fresh
`worker_onboarding_state (lifecycle='onboarding')` + one active
`worker_workflow_runs (current_step_key='start.choose_language', workflow_version=1)`,
writes one `worker_reset_audit` row (`dry_run=false`, operator, reason, per-table
counts, phone **hash** only), and commits. Re-running `--execute` is idempotent
(same terminal state, plus a second audit row).

Confirm the audit row (read-only; phone stored as hash, never raw):

```sql
SELECT operator, reason, dry_run, created_at, table_counts
  FROM worker_reset_audit
 WHERE user_id = '<uuid>'
 ORDER BY created_at DESC
 LIMIT 2;
```

---

## 5. Drive one full onboarding and create business traffic mid-flow

Onboard the reset worker end to end over WhatsApp (start → language → OTP → legal
→ name → location → trade → three trust answers). **During** onboarding (before
readiness), create business traffic to prove the gate defers it:

- create a fresh job application for the worker,
- create an employer conversation + at least one employer message to the worker,
- trigger a job alert for the worker.

Per-step inspection (read-only) — watch the workflow advance and intents defer:

```sql
-- Workflow run + current step
SELECT id, current_step_key, status, workflow_version, preferred_language, lock_version
  FROM worker_workflow_runs WHERE user_id = '<uuid>' ORDER BY created_at DESC LIMIT 1;

-- Transition history (append-only)
SELECT from_step_key, to_step_key, reason, created_at
  FROM worker_workflow_transitions
 WHERE run_id = (SELECT id FROM worker_workflow_runs WHERE user_id = '<uuid>'
                 ORDER BY created_at DESC LIMIT 1)
 ORDER BY created_at;

-- Deferred message intents (business traffic must be 'deferred' until ready)
SELECT category, owner_service, source_type, status, priority, dedupe_key, release_sequence
  FROM worker_message_intents WHERE user_id = '<uuid>' ORDER BY created_at;

-- Domain events (assessment.requested + worker.ready appear on completion)
SELECT event_type, event_key, status, attempts, next_attempt_at
  FROM worker_domain_outbox WHERE aggregate_id = '<uuid>' ORDER BY created_at;
```

Expected during onboarding: business intents (`job_alert`, `employer_chat`) are
`status='deferred'`; **zero** rows exist in `whatsapp_outbox` for those intents.
Onboarding never gets interrupted by the deferred business traffic.

---

## 6. Readiness, grouped release, chat selection

On the third trust answer the workflow completes atomically: lifecycle → `ready`,
one `assessment.requested` and one `worker.ready` domain event inserted in the
same transaction. The scheduled domain-outbox drain (every minute) leases
`worker.ready` and calls the grouped release.

```sql
-- Lifecycle should be 'ready'
SELECT lifecycle, ready_at FROM worker_onboarding_state WHERE user_id = '<uuid>';

-- Grouped release: contiguous per-worker release_sequence from 1, ordered
-- onboarding → account → job digest → employer chat
SELECT category, source_type, status, release_sequence, outbox_id
  FROM worker_message_intents
 WHERE user_id = '<uuid>' AND release_sequence IS NOT NULL
 ORDER BY release_sequence;

-- Authorized outbox rows now exist (created only by the delivery gateway)
SELECT id, status, source_type, created_at
  FROM whatsapp_outbox
 WHERE id IN (SELECT outbox_id FROM worker_message_intents
              WHERE user_id = '<uuid>' AND outbox_id IS NOT NULL)
 ORDER BY created_at;
```

Confirm the worker receives, in order: the onboarding-complete confirmation, any
account notice, the job-alert digest (≤10 jobs), then the employer chat block. If
the worker has multiple open employer conversations, they receive **one** Chats
summary; selecting a chat and replying targets the correct conversation.

### Log, outbox, callback, and DLQ checks (read-only)

```sql
-- Deferred/leased/released/failed intent status distribution
SELECT status, count(*) FROM worker_message_intents WHERE user_id = '<uuid>' GROUP BY status;

-- Domain events fully drained (no stuck 'pending'/'failed')
SELECT event_type, status, attempts, last_error IS NOT NULL AS has_error
  FROM worker_domain_outbox WHERE aggregate_id = '<uuid>';

-- Outbox delivery status
SELECT status, count(*) FROM whatsapp_outbox
 WHERE id IN (SELECT outbox_id FROM worker_message_intents WHERE user_id = '<uuid>' AND outbox_id IS NOT NULL)
 GROUP BY status;
```

- CloudWatch: confirm no `WhatsAppReleaseFailure`, `WhatsAppDomainEventStuck`, or
  DLQ-depth alarms fired; confirm the inbound-v2 FIFO DLQ is empty.
- Confirm delivery-status callbacks recorded (`MM`/`SM` SIDs both accepted).

---

## 7. Production Go/No-Go conditions (verbatim from the design document)

Production rollout proceeds only when:

- Every onboarding step completes in order.
- OTP is the only identity-binding action.
- Commands and business delivery cannot escape the onboarding gate.
- Test employer and job intents remain deferred until ready.
- Final trust answer creates readiness, assessment, and release events atomically.
- AI processing does not block worker access.
- Grouped notifications release in the approved order.
- Multiple employer conversations produce one Chats summary.
- Chat selection and reply target the correct conversation.
- Retries do not duplicate transitions or outbound messages.

---

## 8. Expand rollout — only after all go/no-go conditions pass

```bash
cd infra
# Reset + enable the other two approved workers, one at a time (repeat §3–§6 each):
npm run whatsapp:controls -- --allow-phone "<worker2_e164>"
npm run reset:whatsapp-v2 -- --user-id <uuid2> --phone "<worker2_e164>" --reason "v2 rollout: account 2" --dry-run
npm run reset:whatsapp-v2 -- --user-id <uuid2> --phone "<worker2_e164>" --reason "v2 rollout: account 2" --execute
# ...verify... then worker 3 the same way.

# Then enable globally:
npm run whatsapp:controls -- --go-global

# Enable deferred delivery LAST, only after queue inspection:
npm run whatsapp:controls -- --enable deferred_delivery
npm run whatsapp:controls -- --show   # confirm final control state
```

---

## 9. Failure procedure

If verification fails at any point:

1. **Do not** run `--go-global`; **do not** enable `deferred_delivery`.
2. Leave v2 **allowlisted only** for the phones already added (do not broaden).
3. `deferred_delivery` stays **disabled**.
4. The other two accounts stay **untouched** (do not reset them).
5. Fix the defect, redeploy additively, and clean-reset the first worker again
   (`--dry-run` then `--execute`) before re-verifying.

To fully pull v2 back for a phone: `npm run whatsapp:controls -- --deny-phone "<e164>"`
(removes only that hash). Legacy onboarding resumes immediately for that phone.

---

## 10. Pre-enable verifications and known design notes (freeze-report items)

Confirm these before enabling v2 for real traffic (they require the deployed
environment and cannot be verified from the repo alone):

1. **Privacy-doc URL.** The v2 legal prompt uses `https://jale.app/legal/privacy`
   (derived by same-domain convention). Confirm it resolves to a live deployed
   legal page — the frontend also exposes `/privacypolicy` and
   `/legal/privacy/[version]`. Fix the prompt's URL if the deployed path differs.
4. **Cognito username format.** The identity adapter feeds `from`
   (`conv.whatsapp_number`, E.164) as the Cognito `USERNAME` for
   `RespondToAuthChallenge`. Verify this matches the format the live worker pool
   expects (chosen so the router's internal v2-enable hash matches).

Known design notes (awareness only — no action required for rollout):

2. **Mid-flow language override is router-local.** An `IDIOMA`/`LANGUAGE` switch
   applies to subsequent prompts via `state_context`, but the release renderer
   reads `worker_workflow_runs.preferred_language` from the DB — so a
   `worker.ready` confirmation arrives in the originally-bound language until a
   `preferred_language` mutator is added. (C4/C6-era follow-up.)
5. **Cross-message workflow scratch** (generated trust questions, reprompt
   cooldowns, language override) lives in `whatsapp_conversations.state_context`,
   persisted by the processor's v2 branch in the same transaction, because
   `WorkerGate` does not expose `worker_workflow_runs.context`. Sound given the
   C4 contract; documented as a design split.

> **Freeze item 3 (OTP hourly cap) — RESOLVED.** The initial OTP challenge is now
> recorded in the `otpSendHistory` cap alongside resends (`handleStartStep` in
> `lambda/whatsapp/onboarding-v2.ts` appends the initial send timestamp in the
> same `savePreAuthState` patch that advances to `identity.verify_otp`). The
> effective ceiling is the design's **maximum three total sends per phone per
> hour** (1 initial + 2 resends); the third resend is refused with
> `v2_otp_send_cap`. All lockout, resend-cooldown, transaction, and
> no-pre-OTP-binding invariants are unchanged. Covered by
> `onboarding-v2-conversation.test.ts` → "caps OTP sends at 3 total per hour — the
> initial challenge counts."

## Handoff — recorded gate results

Recorded from the Task C10 green gate (2026-07-23):

| Gate | Command | Result |
| --- | --- | --- |
| Build | `npm run build` | tsc exit 0 (clean) |
| Unit suite | `npm test -- --runInBand` | 1603 passed, 0 failed (130/131 suites; DB-integration suites skip without `JALE_TEST_DATABASE_URL`) |
| DB Gate 1 (migrated: migrations + 042 + concurrency + others) | `bootstrap-testbed.sh --verify` + `jest test/unit/db …` | 14/14 verify probes PASS; 10 suites / 99 passed, **0 CONCERN** |
| DB Gate 2 (clean apply) | `bootstrap-testbed.sh --ephemeral --empty … apply-order` | 26 passed, 1 skipped (docs/ check) |
| DB Gate 3 (034 upgrade) | `bootstrap-testbed.sh --ephemeral --bare … billing-034-upgrade` | 14 passed |
| v2 DB gate | `npm run test:whatsapp-v2-db` (under Gate-1 testbed URL) | 2 suites / 26 passed |
| Synth | canonical `cdk synth --all` | exit 0; **additive** — v2 FIFO pair `whatsapp-inbound-v2.fifo`/`-dlq.fifo` + `DomainOutboxDrain` Lambda + `rate(1 minute)` schedule + v2 alarms added; legacy `whatsapp-inbound-queue`/`-dlq` unchanged (verified in `cdk.out/JaleWhatsAppStack.template.json`) |
| Diff | canonical `cdk diff` | Deployed-stack comparison requires prod access (out of scope); additivity verified offline via the synthesized template above |
| Differential review | `differential-review` skill (six named risks) | **0 Critical / 0 Important**; all six risks CONFIRMED CLOSED. 1 Minor reliability follow-up (stuck `processing` domain events on drain crash — a stale-`processing` recovery sweep is recommended before high-scale traffic) + two pre-existing (`ac8432a`) raw-phone log lines in `processor.ts` — neither introduced by this feature |

**Verified commit SHA (code):** `d120cfa` (the state the full gate ran against —
merge `d052423` + drain-renderer wiring `d120cfa`). The final C10 integration
commit adds only this runbook and the `test:whatsapp-v2-db` package script (no
code change; the script was validated green above).

### Final two-fixes battery (2026-07-23)

Re-run after the two user-decided fixes (OTP 3-total-sends/hour enforcement +
fail-closed `test:whatsapp-v2-db` URL guard), base `c8dba0b`:

| Gate | Command | Result |
| --- | --- | --- |
| Build | `npm run build` | tsc exit 0 (clean) |
| Unit suite | `npx jest --runInBand` | **1607 passed**, 0 failed (131 suites + 1 skipped; +4 from the new guard test vs. the 1603 baseline; DB-integration suites skip without a URL) |
| v2 lambda suite | `npm run test:whatsapp-v2` | 7 suites / **251 passed** |
| DB Gate 1 (migrated) | `bootstrap-testbed.sh --verify` (run FIRST) + `jest test/unit/db …` | **14/14** verify probes PASS; 10 suites / 99 passed, **0 CONCERN** |
| DB Gate 2 (clean apply) | `bootstrap-testbed.sh --ephemeral --empty … apply-order` | 26 passed, 1 skipped |
| DB Gate 3 (034 upgrade) | `bootstrap-testbed.sh --ephemeral --bare … billing-034-upgrade` | 14 passed |
| v2 DB gate (guarded) | `npm run test:whatsapp-v2-db` (under Gate-1 testbed URL) | 2 suites / **26 passed, 0 skipped** — migration-042 + concurrency actually executed. Unset/empty URL → **exit 1**, no URL printed. |
| Synth | canonical `cdk synth --all` | exit 0; **additive** — v2 FIFO pair + `DomainOutboxDrain` Lambda + `rate(1 minute)` + v2 alarms; legacy queue unchanged (template inspection) |
| Differential review | inline DEEP + independent Sonnet pass | **0 Critical / 0 Important**; see `2026-07-23-whatsapp-v2-final-two-fixes-differential-review.md` |

> **Gate 1 ordering note:** run `bootstrap-testbed.sh --verify` (the 14 probes)
> **before** the migrated jest suites. The C9 concurrency suite enables
> `deferred_delivery_enabled` in `whatsapp_runtime_controls` without restoring it,
> so a `--verify` run *after* the suites fails the "both runtime controls seeded
> and disabled" probe. The persistent testbed is left with both controls disabled
> after this battery. (Adding an `afterAll` reset to that suite is a tracked
> hygiene follow-up.)

**Verified two-fixes commit SHA:** `8bb9758` — "feat(whatsapp): enforce 3 total
OTP sends/hour and fail-close v2 DB gate" (the code + tests + package script; the
battery above ran against that state). This SHA is recorded here by a small
follow-up docs commit, mirroring how C10 recorded its code SHA separately. Also
logged in the durable ledger `2026-07-22-whatsapp-v2-integration-C5-C10-ledger.md`.

**Known follow-ups (do not block this rollout, but track them):**
1. Add a scheduled stale-`worker_domain_outbox`.`status='processing'` → `pending`
   recovery sweep (mirroring the AI trust-scorer's 15-minute recovery cron), so a
   drain Lambda crash between lease and completion cannot permanently strand a
   `worker.ready` release.
2. Two pre-existing raw-phone log lines in `processor.ts` (`:548` missing-From
   warn, `:1551` legacy `reissueOtp`) predate v2; scrub them in a legacy-cleanup
   pass.
3. The C9 concurrency integration suite
   (`whatsapp-onboarding-concurrency.integration.test.ts`) enables
   `deferred_delivery_enabled` via `enableDeferredDelivery()` and never restores
   it. Add an `afterAll` that resets both runtime controls to disabled so the
   persistent testbed stays clean regardless of gate order.

**Do not push, deploy, migrate RDS, or reset any worker without separate user
authorization.**
