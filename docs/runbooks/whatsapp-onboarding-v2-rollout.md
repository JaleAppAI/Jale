# WhatsApp Onboarding v2 — Rollout Runbook

> **Header note — read before you add any new file under `docs/`.**
> `docs/` is gitignored (`.gitignore:41`). A plain `git add -A` or `git add .`
> silently drops anything under `docs/` — no error, no warning, it just never
> reaches the index. That is exactly how this document (originally planned
> as deliverable C10) was lost the first time. To commit **any** new or
> changed file under `docs/`, you must force-add it explicitly:
>
> ```bash
> git add -f docs/runbooks/whatsapp-onboarding-v2-rollout.md
> ```
>
> Verify with `git status` (or `git show --stat HEAD`) that the file is
> actually staged/committed before you trust that it landed.

---

## Rollout states & controls

**WhatsApp onboarding v2 is the only onboarding lane. There is no runtime
gate for it anymore.** The `onboarding_v2_enabled` control (migration `042`)
has been retired: the code no longer reads it — `isV2Enabled` and the
`onboardingV2*` fields are gone from `runtime-controls.ts` — and migration
`054` deletes its row from `whatsapp_runtime_controls` outright. If v2 ever
needs to come off, **the only rollback path is redeploying the previous
version of the code.** There is no flag left to flip, no allowlist to empty,
and no "go back to canary" state to fall into — plan any v2 rollback as a
deploy, not a DB write.

The cutover to this state has a fixed order: apply migration `053` (web-worker
bypass function, see the toolbox below) → deploy the hardwired code → apply
migration `054` (drops the `onboarding_v2_enabled` row) → bulk reset (dry-run
first, see `bulk-reset-whatsapp-onboarding-v2.ts` below). Don't reorder this —
applying `054` before the hardwired code deploys would drop the only gate the
old code still reads.

State for the controls that remain lives in `whatsapp_runtime_controls`
(migration `042_whatsapp_onboarding_gate.sql`, joined by
`051_whatsapp_voice_intake_control.sql`), one row per control key, read by
`loadRuntimeControls()` in `infra/lambda/whatsapp/lib/runtime-controls.ts`.
Missing or malformed rows **fail closed to disabled** — that's a deliberate
safety property, not a bug.

Two control keys remain:

| control_key | columns used | default |
|---|---|---|
| `voice_intake_enabled` | `enabled`, `global_enabled`, `phone_hashes` | all false / empty |
| `deferred_delivery_enabled` | `enabled` | false |

`isVoiceIntakeEnabled(controls, phoneHash)` gates voice-note intake (trust-question
voice answers and full profile voice intake) per-worker:
`voice_intake_enabled.enabled && (global_enabled || phone in phone_hashes)`.
Phones are never stored raw — only `hashNormalizedPhone()` (SHA-256 of the
trimmed E.164 string) goes in `phone_hashes`.

All commands below run from `infra/` with DB env vars set:

```bash
cd infra
DB_HOST=<host> DB_PORT=5432 DB_NAME=jale DB_USER=jale_admin DB_PASSWORD=<pw> \
  npx ts-node scripts/whatsapp-runtime-controls.ts <flag> [value]
```

`voice_intake` is now the CLI's **default** phone-scoped control —
`--allow-phone`, `--deny-phone`, and `--go-global` target it with no
`--control` flag needed at all, now that `onboarding_v2` no longer exists as
a target. See the script's own header comment for the authoritative flag
set.

### Per-phone allowlist (canary)

```bash
# Turn voice intake on but keep it OFF for everyone until phones are allowed
npx ts-node scripts/whatsapp-runtime-controls.ts --enable voice_intake

# Allow one phone at a time (hashes, never raw numbers, are persisted/printed)
npx ts-node scripts/whatsapp-runtime-controls.ts --allow-phone +19152272188

# Remove a phone from the allowlist
npx ts-node scripts/whatsapp-runtime-controls.ts --deny-phone +19152272188

# Check current state (prints control_key/enabled/global_enabled/phone_hashes JSON — hashes only)
npx ts-node scripts/whatsapp-runtime-controls.ts --show
```

### Global rollout

```bash
npx ts-node scripts/whatsapp-runtime-controls.ts --go-global
```

Sets `global_enabled = true` on `voice_intake_enabled` (the default target).
From this point every worker phone gets voice intake regardless of the
allowlist (the allowlist rows are simply no longer consulted —
`isVoiceIntakeEnabled` short-circuits on `global_enabled`). To roll back to
allowlist-only, there's no `--go-global` inverse; disable the control
(`--disable voice_intake`) or edit the row directly if you need "global off,
allowlist still on."

### Turning voice intake off

```bash
npx ts-node scripts/whatsapp-runtime-controls.ts --disable voice_intake
```

`RESET_OPERATOR` (falls back to `$USER`) is recorded as `updated_by` on every
mutation — set it if your shell user isn't a meaningful identity.

---

## ⚠️ The `deferred_delivery_enabled` black hole ⚠️

> **This is the single most dangerous control in this system. Read this
> section before you ever touch `deferred_delivery_enabled` in production.**
>
> Turning `deferred_delivery_enabled` **off** does not pause business
> messages for READY v2 workers — it **silently black-holes them**: job
> alerts, employer chats, and account notices for every READY v2 worker stop
> being delivered, with no error, no alarm, and no visible symptom other than
> "the worker stopped receiving messages." Recovery is **not automatic** when
> you turn it back on unless you use the CLI path described below.

**Why:** `evaluateDelivery()` (`infra/lambda/whatsapp/lib/delivery-policy.ts:51`)
returns `{ action: 'defer', reason: 'delivery_disabled' }` for any business
message (`account` / `job_alert` / `employer_chat`) addressed to a `ready`
lifecycle worker whenever `controls.deferredDeliveryEnabled` is false:

```ts
// delivery-policy.ts:51-53
if (!input.controls.deferredDeliveryEnabled) {
  return { action: 'defer', reason: 'delivery_disabled' };
}
```

The trap: the `worker.ready` domain event that made a worker READY in the
first place gets consumed (marked `completed`) by the scheduled drain the
moment it releases whatever was eligible *at that time*. Once the control
flips back on, **there is no outstanding trigger left** to release the
intents that piled up as `deferred` while it was off — they just sit in
`worker_message_intents` with `status = 'deferred'` forever, because nothing
re-evaluates them without a fresh `worker.ready` event
(`infra/lambda/whatsapp/lib/delivery-retrigger-sweep.ts`, see the "O1" header
comment there for the full idempotency argument).

**The fix is built into the CLI — use it, don't hand-flip the DB row.**
`whatsapp-runtime-controls.ts --enable deferred_delivery` runs the `UPDATE`
and `retriggerDeferredReadyWorkers()` in **one transaction**
(`infra/scripts/whatsapp-runtime-controls.ts:188-214`): if the sweep throws,
the enable rolls back too, so you can never end up with the control "on but
not yet retriggered."

```bash
cd infra
DB_HOST=<host> DB_PORT=5432 DB_NAME=jale DB_USER=jale_admin DB_PASSWORD=<pw> \
  npx ts-node scripts/whatsapp-runtime-controls.ts --enable deferred_delivery
```

This re-emits a fresh `worker.ready` event (event key
`worker.ready:sweep:<workerId>:<sweepRunId>`) for every `ready` worker that
still has a `deferred`, unrendered, business-category intent
(`account` | `job_alert` | `employer_chat` — never `onboarding`/`security`,
which are never subject to this gate). The existing scheduled drain then
leases and releases them exactly as it would a first-time completion. The
sweep is idempotent and safe to re-run (unique `event_key` + `ON CONFLICT DO
NOTHING`, plus `releaseWorkerReady()`'s own `FOR UPDATE SKIP LOCKED` intent
leasing) — running it twice enqueues at worst a harmless extra event that
finds nothing left to release.

**Rules of engagement:**
- `--disable deferred_delivery` never sweeps (there's nothing to release when
  turning it off) — this is intentional, don't add a sweep there.
- Never `UPDATE whatsapp_runtime_controls SET enabled = true WHERE
  control_key = 'deferred_delivery_enabled'` by hand. That flips the switch
  without the sweep and leaves the backlog stranded.
- If you suspect a backlog already happened (control was off for a
  while, you're not sure the CLI was used to re-enable it), just re-run
  `--enable deferred_delivery` — it's safe to run again and will catch
  anything still `deferred`.
- Deferred intents don't page anyone by name — they roll up into
  `WhatsAppDeferredBacklogAge` (see Alarms below). Watch that alarm around
  any `deferred_delivery` toggle.

---

## Operator toolbox

All CLIs live in `infra/scripts/`, are run with `npx ts-node` from `infra/`,
and take the same DB env vars: `DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD
[DB_SSL=true]`. None of them ever print or log a raw phone number — only the
SHA-256 hash. `RESET_OPERATOR` (or `$USER`) is recorded as the acting
operator on every mutation.

### `whatsapp-runtime-controls.ts` — feature flags

Covered above. Reach for it to: canary/allowlist workers into voice intake,
go global, disable voice intake, or flip `deferred_delivery_enabled` (with
its built-in sweep). `--show` is read-only and safe to run any time.

### `reset-whatsapp-onboarding-v2.ts` — full wipe & restart

When: a test/demo worker needs to run onboarding from scratch, or a worker's
state is corrupted beyond a targeted repair. **Destructive** — deletes the
worker's onboarding/profile/trust/job history across ~19 tables (see
`DELETE_STEPS` in the script) and clears profile-answer columns on `users`
and `worker_profiles`. It deliberately seeds NO workflow run: the account is
returned to the pre-auth entry point, so the worker's next message gets the
language choice, then the OTP, and the verified bind creates the run at
`legal.review` exactly like a brand-new worker
(`bind_verified_identity_and_start_workflow`, migration 047). An earlier
version seeded a run at `start.choose_language` — a pre-auth-only key the
bound router cannot handle — and the post-OTP rebind reused it as-is,
softlocking the worker on `unhandled bound step` (2026-07-27 incident). If a
bound run is ever found parked on a pre-auth key again, the router now
self-heals it to `legal.review` and emits the
`OnboardingBoundStepSelfHealed` metric — a nonzero count of that metric
means some tool is still writing pre-auth step keys onto runs.
Requires both `--user-id` and `--phone`, and aborts if the phone doesn't
match that user's verified `whatsapp_number`.

```bash
cd infra
DB_HOST=<host> DB_PORT=5432 DB_NAME=jale DB_USER=jale_admin DB_PASSWORD=<pw> \
  npx ts-node scripts/reset-whatsapp-onboarding-v2.ts \
    --user-id <uuid> --phone <e164> --reason "<why>" --dry-run
# review the printed per-table row-count JSON, then re-run with --execute
```

Always dry-run first — it prints the exact row counts that would be deleted
per table before anything is touched. Every execution is recorded in
`worker_reset_audit` (returns an audit row id on success).

### `bulk-reset-whatsapp-onboarding-v2.ts` — reset ALL workers' onboarding

When: a mass-remediation event — the canonical case is the v2 hardwire
cutover itself — needs every worker's onboarding state returned to scratch
in one pass, instead of running `reset-whatsapp-onboarding-v2.ts` one worker
at a time. Reuses the single-worker tool's semantics exactly: the same
~19-table wipe, the same "no run seeded, next inbound message starts fresh
at the pre-auth entry point" behavior, the same
`bind_verified_identity_and_start_workflow` re-bind path (migration 047) —
but drives it per-worker, each worker resetting inside its **own**
transaction, across the whole worker population.

Flags: `--reason` (required, stamped on every per-worker audit row), exactly
one of `--dry-run` / `--execute`, and an optional `--limit <n>` to cap the
run to the first `n` workers — use it to run a small canary batch before
committing to the full population. Like every other tool here, it never
prints a raw phone number, only the SHA-256 hash.

```bash
cd infra
DB_HOST=<host> DB_PORT=5432 DB_NAME=jale DB_USER=jale_admin DB_PASSWORD=<pw> \
  npx ts-node scripts/bulk-reset-whatsapp-onboarding-v2.ts \
    --reason "v2 hardwire cutover" --dry-run --limit 25
# review the per-worker plan, then re-run with --execute — drop --limit for
# the full population once the canary batch looks right
```

Failure policy: because each worker resets in its own transaction, one
worker's failure never rolls back another worker's progress. If a given
worker's reset throws, the script logs it, **keeps going** to the remaining
workers, and **exits non-zero** at the end with a summary (succeeded /
failed / skipped counts) — a partial run can never masquerade as a clean
success. Every worker that resets successfully still gets its own
`worker_reset_audit` row, exactly like the single-worker tool.

### `bypass_onboarding_for_web_worker()` — web-registered worker bypass (migration 053)

Not a CLI — a `SECURITY DEFINER` Postgres function
(`public.bypass_onboarding_for_web_worker(...)`, migration
`053_whatsapp_web_worker_bypass.sql`) that lets a worker who registered
through the web app, never through WhatsApp, skip WhatsApp onboarding
entirely on their first inbound message.

The discriminator is `users.email IS NOT NULL AND tos_accepted_at IS NOT
NULL`. Web-registered workers always have both set from signup; a
WhatsApp-onboarded worker never gets `email` written to their row at all.
That asymmetry is what makes the bypass safe to leave in place across a
reset: neither `reset-whatsapp-onboarding-v2.ts` nor
`bulk-reset-whatsapp-onboarding-v2.ts` touch `email`/`tos_accepted_at`, so a
freshly-reset WhatsApp worker can never accidentally match the bypass and
skip onboarding they're actually supposed to go through.

### `repair-whatsapp-onboarding-v2.ts` — targeted, non-destructive nudge

When: a worker's run is wedged on one step (e.g. poisoned inbound message,
handler bug) and a full reset is overkill — you just need to move
`current_step_key` so the next inbound message dispatches somewhere healthy.
Nothing is deleted; the move is recorded in `worker_workflow_transitions`.

Inspect (default, read-only, no `--set-step`):

```bash
cd infra
DB_HOST=<host> DB_PORT=5432 DB_NAME=jale DB_USER=jale_admin DB_PASSWORD=<pw> \
  npx ts-node scripts/repair-whatsapp-onboarding-v2.ts --user-id <uuid> --phone <e164>
```

Prints lifecycle, the active/most-recent run, which profile fields are
already filled, pre-auth challenge status, the last 10 transitions, and any
`<sid>#err` rows from `whatsapp_processed_messages` — usually enough to see
*why* the run is stuck without opening CloudWatch.

Repair (requires `--set-step` one of the 17 `WORKFLOW_STEP_KEYS`, `--reason`,
and exactly one of `--dry-run`/`--execute`):

```bash
npx ts-node scripts/repair-whatsapp-onboarding-v2.ts \
  --user-id <uuid> --phone <e164> --set-step profile.location \
  --reason "<why>" --dry-run
```

Refuses to touch a non-`active` run (a completed/declined run isn't "stuck" —
use reset for those) and uses an optimistic `lock_version` check, so a
concurrent transition can't be silently clobbered.

### `replay-whatsapp-inbound.ts` — redrive one DLQ'd inbound WhatsApp message

See the DLQ redrive section below.

### `replay-domain-event.ts` — replay one `worker_domain_outbox` row

When: a single domain event (e.g. a `worker.ready` or `assessment.requested`
event) is stuck `failed` or has an expired lease and needs another attempt,
without fabricating a new event or touching `domain-outbox-drain.ts`.

```bash
cd infra
DB_HOST=<host> DB_PORT=5432 DB_NAME=jale DB_USER=jale_admin DB_PASSWORD=<pw> \
  npx ts-node scripts/replay-domain-event.ts <worker_domain_outbox.id-or-event_key>
# add --execute to actually reset it to 'pending'
```

Accepts exactly one id (uuid or `event_key`) — no wildcards, ranges, or bulk
flags. Prints pre-mutation state (event type, status, attempts, a
key-names/types-only payload summary — never raw payload values — plus the
worker's lifecycle and deferred/released intent counts) before touching
anything. A `completed` event is a safe no-op; an unexpired `processing`
lease is refused as `event_in_flight`. Resets only `status`, `leased_until`,
`lease_token`, `next_attempt_at` — `event_key` and `payload` are always
reused as-is so the drain reprocesses the exact original event.

### `inspect-trust-score.ps1` — read-only trust/AI-scorer inspector (root `scripts/`)

When: you need to see what the trust signal / AI trust scorer flow recorded
for a phone number, without local psql or DB credentials. Runs SQL against
`JaleBastionStack` via SSM using the `JaleDatabaseStack` admin secret.

```powershell
cd infra
npx cdk deploy JaleBastionStack
cd ..
.\scripts\inspect-trust-score.ps1 -Phone 19152272188
.\scripts\inspect-trust-score.ps1 -Phone 19152272188 -LogPath .\tmp\trust-score.log
```

Phone may be `19152272188`, `+19152272188`, or `whatsapp:+19152272188`.

### `run-migrations.sh` — apply DB migrations (root `scripts/`)

See "Deploys that include migrations" below. Also see the `running-jale-migrations` skill for the operational walkthrough — this runbook only points at the script's own `--help`/header.

---

## Alarms

All alarms below publish through `Jale/WhatsApp` metric filters unless noted,
route to the SNS topic configured via `whatsappAlarmTopicArn`/
`whatsappAlarmEmail` context, and are defined in
`infra/lib/stacks/whatsapp-stack.ts` (`infra/lib/stacks/ai-stack.ts` for the
two AI-namespace alarms at the bottom).

| Alarm name | Meaning | First-response action |
|---|---|---|
| `WhatsAppWorkerIntentSendUnknown` | Worker intent outbox tried to send but the send outcome was unknown | Check the intent's row in `worker_message_intents`; look for a Twilio-side ambiguity before assuming failure |
| `WhatsAppWorkerIntentFailures` | Worker intent outbox send failures | Check recent `worker_message_intents` failures for a common `last_error`; may indicate a Twilio outage or bad template |
| `WhatsAppWorkerIntentLeaseLost` | A leased intent's lease expired before completion (drain died mid-processing or ran long) | Check drain Lambda logs/timeouts around the alarm window |
| `WhatsAppWorkerIntentBacklogAged` | Intents have been sitting unprocessed too long | Check drain Lambda health/concurrency; may need a manual `replay-domain-event.ts` nudge |
| `WhatsAppDeliveryFailures` | Twilio-reported terminal delivery failures (failed/undelivered) | Check Twilio console for the affected SIDs; likely a bad number or template issue, not a Jale bug |
| `WhatsAppStatusCallbackErrors` | Status-callback pipeline errors (signature validation, DB/config failures) — the *pipeline* is broken, not a delivery outcome | Check status-callback Lambda logs immediately; this can mask real delivery failures while broken |
| `WhatsAppStatusCallbackUnknownSids` | Callback for a Twilio SID with no matching outbox/job-message row | Could be a correlation bug or an outbox-write/callback race; investigate if sustained |
| `WhatsAppInboundV2DlqDepth` | Messages stuck in the v2 inbound DLQ after exhausting `maxReceiveCount` | Use `replay-whatsapp-inbound.ts` per message after fixing the root cause (see DLQ Redrive) |
| `WhatsAppInboundV2DlqAge` | Oldest stuck message in the v2 inbound DLQ | Same as above — treat depth and age together |
| `WhatsAppWorkerIntentWakeDlqDepth` | Worker-intent wake queue DLQ has messages | Check the wake Lambda for repeated failures; redrive after fixing |
| `WhatsAppDomainOutboxWakeDlqDepth` | Domain-outbox wake queue DLQ has messages | Same pattern as above, domain-outbox side |
| `WhatsAppWorkerIntentWakeAge` | Oldest message age on the worker-intent wake queue exceeds threshold (15 min) | Check wake Lambda invocation health |
| `WhatsAppDomainOutboxWakeAge` | Oldest message age on the domain-outbox wake queue exceeds threshold (15 min) | Check wake Lambda invocation health |
| `WhatsAppOutboxWakeFailures` | Outbox wake invocation failed (processor or domain-outbox drain side) | Check the relevant Lambda's error logs immediately — wake failures mean the drain isn't being nudged |
| `WhatsAppDomainEventsStuck` | A domain event exceeded its retry cap without completing | Inspect via `replay-domain-event.ts <id>` (dry run first) to see state and payload summary |
| `WhatsAppReleaseFailures` | `releaseWorkerReady()` failed during the drain's release step | Check domain-outbox-drain Lambda logs; may need a `replay-domain-event.ts` retry once fixed |
| `WhatsAppAssessmentDispatchFailures` | Dispatch of `assessment.requested` to the TrustScorer SQS queue failed | Check drain logs and TrustScorer SQS queue health |
| `WhatsAppDeferredBacklogAge` | Deferred business intents are aging — the exact signal to watch around any `deferred_delivery_enabled` toggle | If recently toggled, confirm the retrigger sweep ran (see black-hole section); otherwise inspect stuck workers |
| `WhatsAppOtpLockRate` | OTP challenge transitioned to `locked` (identity handler, emitted on the processor log group) | Check for a brute-force pattern or a legitimate user needing manual unlock |
| `WhatsAppTrustQuestionGenerationFailed` | Custom-trade worker's trust question generation failed, leaving them stuck waiting | Check the AI question-generation path/Bedrock health; may need a `repair-whatsapp-onboarding-v2.ts` nudge once fixed |
| `WhatsAppProfileVoicePipelineFailed` | Profile voice Step Function execution failed | Check Step Functions console for the execution; voice is not yet wired into v2 dispatch (see Known Limitations) — this is prerequisite telemetry |
| `WhatsAppProfileVoicePipelineTimedOut` | Profile voice pipeline exceeded its timeout (e.g. stuck Transcribe job) | Same as above |
| `WhatsAppTrustVoicePipelineFailed` | Trust-question voice Step Function execution failed | Same pattern, trust-question voice path |
| `WhatsAppTrustVoicePipelineTimedOut` | Trust-question voice pipeline timed out | Same pattern |
| `TrustAssessmentDlqDepth` (Jale/Ai namespace) | Messages stuck in the trust-assessment DLQ | Check TrustScorer Lambda logs for the root cause before redriving |
| `TrustScorerThrottles` (Jale/Ai namespace) | TrustScorer Lambda throttled more than 5 times in 5 minutes | Check concurrent invocation limits / Bedrock throttling upstream |
| `TrustScorerFailures` (Jale/Ai namespace) | Bedrock parse/validation failures in the trust scorer | Check TrustScorer Lambda logs for the specific parse/validation error |

Note: `OnboardingStepAdvanced` / `OnboardingCompleted` (below) deliberately
have **no alarm** — drop-off is a product signal to graph, not a page.

---

## Dashboards / funnel

The v2 onboarding funnel is driven by two `Jale/WhatsApp` metric filters on
the processor Lambda's log group (`infra/lib/stacks/whatsapp-stack.ts:818-831`),
fed by `console.log` lines in `infra/lambda/whatsapp/lib/onboarding-repository.ts`:

- `OnboardingStepAdvanced` — emitted on every successful step transition, with
  `fromStepKey` / `toStepKey` / `runId` in the log line (line ~314). Graph as
  a CloudWatch metric math / Logs Insights query grouped by `toStepKey` to see
  where workers are in the funnel and where they drop off between steps.
- `OnboardingCompleted` — emitted once per completed onboarding run (line
  ~517), with `runId`.

To build the funnel in CloudWatch: create a dashboard widget per
`WorkflowStepKey` (see the 17 keys in `infra/lambda/whatsapp/lib/onboarding-types.ts`
and `infra/scripts/repair-whatsapp-onboarding-v2.ts`'s `WORKFLOW_STEP_KEYS`),
querying the `Jale/WhatsApp` namespace filtered to `OnboardingStepAdvanced`
and faceted by `toStepKey` via Logs Insights (the metric filter itself only
counts total advances; per-step breakdown requires a Logs Insights query
against the processor log group rather than the plain CloudWatch metric).
Compare `OnboardingCompleted` count against `OnboardingStepAdvanced` count for
`toStepKey = start.choose_language` (or total v2-enabled workers) for an
overall completion rate.

---

## DLQ redrive

Queue: `WhatsAppInboundV2Dlq` (`infra/lib/stacks/whatsapp-stack.ts:128`),
FIFO, fed by `WhatsAppInboundV2Queue`'s redrive policy. Watched by
`WhatsAppInboundV2DlqDepth` / `WhatsAppInboundV2DlqAge` (see Alarms).

Procedure, using `infra/scripts/replay-whatsapp-inbound.ts`:

```bash
cd infra
DB_HOST=<host> DB_PORT=5432 DB_NAME=jale DB_USER=jale_admin DB_PASSWORD=<pw> \
  npx ts-node scripts/replay-whatsapp-inbound.ts \
    --message-sid SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
    --dlq-url <WhatsAppInboundV2Dlq URL> \
    --queue-url <WhatsAppInboundV2Queue URL>
```

(or `--sqs-message-id <id>` instead of `--message-sid` if you only have the
raw SQS MessageId.) This is a **dry run by default** — it prints the target's
receive count, timestamps, a hashed MessageGroupId, and the current DB state
(`whatsapp_processed_messages` status, conversation state, workflow status/
step) without sending or deleting anything. Add `--execute` to actually
redrive.

Safety properties worth knowing before you run it:
- Validates the destination queue's redrive policy actually points back at
  the supplied DLQ, and both queues are FIFO, before touching anything.
- Only replays a message that is the **visible FIFO group head** — if the
  target is stuck behind another group message, it tells you to replay that
  one first, rather than reordering the group.
- On any failure partway through, it restores visibility on every message it
  peeked at (best-effort) so nothing is left invisible/stuck due to the tool
  itself.
- Fix the root cause first (bad payload, downstream bug, etc.) — redriving a
  message that will just fail the same way again only refills the DLQ.

---

## Deploys that include migrations

`deploy-production`'s `detect-changes` job (`.github/workflows/deploy-production.yml:122-125`)
fails the push-triggered deploy if `infra/db/migrations/` appears in the
diff:

```
::error::Production deploy includes migration changes. Apply migrations through the manual migration runbook until a ledger exists.
```

Procedure:

1. Apply the migration **first**, out of band, with
   `scripts/run-migrations.sh` against the bastion (see the script's own
   header for the full `--dry-run` / `--baseline-through` / `--rotate-secrets`
   / `--force-replay` / `--yes` flag set, and the `running-jale-migrations`
   skill for the walkthrough):
   ```bash
   bash scripts/deploy-bastion.sh
   bash scripts/run-migrations.sh --dry-run   # review the plan
   bash scripts/run-migrations.sh             # apply
   cd infra && npx cdk destroy JaleBastionStack
   ```
2. Push to `prod` as normal. Because the migration file(s) are now already
   in a prior commit's diff (or if they still show up in this push's diff),
   the guard may still fire.
3. If the guard fires anyway, use `workflow_dispatch` instead of the push
   trigger with `deploy_scope: all`
   (`.github/workflows/deploy-production.yml:6-18`) — `workflow_dispatch`
   runs take the `deploy_scope` branch of `detect-changes` and never run the
   `infra/db/migrations/` diff check at all (that check only runs on the
   `push` path, lines 115-125).

Never let the CI push deploy apply migrations itself — there is no migration
ledger integration in the workflow; migrations are always applied manually
first via `run-migrations.sh`.

---

## Known limitations

- **Voice onboarding is wired into dispatch.** Both the trust-question voice
  path and full profile voice intake (`profile.voice_choice` /
  `profile.voice_processing`) are implemented and dispatch to real handlers —
  `profile.voice_choice`/`profile.voice_processing` are deliberately absent
  from `infra/lambda/whatsapp/onboarding/gate.ts`'s `UNIMPLEMENTED_STEPS` set
  for exactly this reason. The `voice_intake_enabled` runtime control
  (migration `051_whatsapp_voice_intake_control.sql`) gates it and is
  globally enabled — see "Rollout states & controls" above. The two voice
  Step Functions (`WhatsAppProfileVoicePipelineFailed`/`TimedOut`,
  `WhatsAppTrustVoicePipelineFailed`/`TimedOut` alarms) provide
  failure/timeout telemetry for the pipelines this dispatch invokes.
- **Photo steps are not implemented.** `profile.photo` and
  `profile.photo_type` are also in `UNIMPLEMENTED_STEPS`
  (`infra/lambda/whatsapp/onboarding/gate.ts`) despite being valid
  `WorkflowStepKey` values (migration 050's step-key CHECK already allows
  them) and despite media/template plumbing existing elsewhere
  (`infra/lambda/whatsapp/lib/media.ts`, `interactive-templates.ts`,
  `templates.ts`) for photo classification — none of it is currently
  reachable from the onboarding step gate.
- **Profile-edit (post-onboarding profile changes over WhatsApp) is
  deferred.** Not found implemented or referenced anywhere in the current
  codebase — treat this as a stated future-scope item, not something to go
  looking for a partial implementation of.
