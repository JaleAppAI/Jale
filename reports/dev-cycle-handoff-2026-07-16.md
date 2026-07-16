# Jale dev-cycle handoff — 2026-07-16

## Executive status

This work remains intentionally isolated from `SPRINT16`. The three tracks are
now consolidated on local branch `feat/sprint16-dev-cycle-integration`.
Nothing has been merged into the lead branch, pushed, deployed, or applied to a
shared database.

The source worktree commits are:

| Track | Branch | Local commits | State |
|---|---|---|---|
| Frontend | `track-f-frontend` | `6151045` | Accepted, clean |
| Billing | `track-b-billing` | `43aa976`, `5c51c6e` | Accepted, clean |
| WhatsApp W1 | `track-w-whatsapp` | `58bc7e4` | Accepted |
| WhatsApp W2 | `track-w-whatsapp` | `a8cebd3` | WIP checkpoint; Review 1 corrections required |

The managed execution layer stopped Terra's W2 correction round after reporting
the account Codex usage limit. It reported retry availability as **2026-07-22
22:16** and explicitly prohibited workaround attempts. No W2 correction-round
files were changed after that rejection.

W2 is preserved on the integration branch as explicit WIP commit `9e1c316`.
This checkpoint is not accepted or production-ready and still requires the
correction round and Sol Review 2 described below.

## Safety and authorization boundary

- Keep commits confined to the isolated local worktrees.
- Do not commit or merge into `SPRINT16`.
- Do not push, deploy, release, create secrets, or apply migrations to shared,
  staging, or production infrastructure.
- Do not read secret values.
- Do not use test-only RLS bypasses, superuser ownership rewrites, filtered
  migrations, or other harness shortcuts.
- Preserve the lead checkout's existing untracked files:
  `demo-ready-windows/`, `reports/`, and
  `scripts/demo-preflight.ps1`.

## Repository and worktree locations

- Lead checkout:
  `/home/hermesgoma/Desktop/hermes/Jale/live-debug/Jale`
- Frontend worktree:
  `/home/hermesgoma/Desktop/hermes/Jale/live-debug/Jale/.claude/worktrees/track-f`
- Billing worktree:
  `/home/hermesgoma/Desktop/hermes/Jale/live-debug/Jale/.claude/worktrees/track-b`
- WhatsApp worktree:
  `/home/hermesgoma/Desktop/hermes/Jale/live-debug/Jale/.claude/worktrees/track-w`
- Integration worktree:
  `/home/hermesgoma/Desktop/hermes/Jale/live-debug/Jale/.claude/worktrees/feat-sprint16-integration`
- Original approved Claude plan:
  `/home/hermesgoma/.claude/plans/ok-write-the-plan-lovely-yeti.md`
- Live verification report:
  `reports/live-verification-2026-07-15.md`
- PostgreSQL testbed skill:
  `/home/hermesgoma/.codex/skills/psql-migration-testbed/SKILL.md`

All tracks began from `d837a10`; the integration branch remains based on that
commit and retains each track as a separate cherry-picked commit.

## Required workflow

Continue using the replicated `/dev-cycle`:

1. Sol is lead/orchestrator and reviews the actual diff.
2. Terra implements in the isolated worktree.
3. Luna gathers context and audits read-only.
4. Sol runs independent tests; agent-reported results are not sufficient.
5. Each task gets exactly one feedback round to the same implementor.
6. Sol re-diffs the correction round and runs Review 2.
7. Small Review 2 residuals are lead-owned; large residuals are reported rather
   than starting another implementor feedback round.

W2 has already completed Review 1 and already received its one consolidated
feedback round. Resume by implementing that correction round, not by starting a
new W2 design or a second Review 1.

## Track F — accepted

Commit: `6151045 fix(frontend): harden billing retry and clean builds`

Delivered:

- Cognito pools are lazy, so a clean build does not require placeholder env
  variables.
- Billing idempotency uses a canonical request body and structured storage.
- Failure cleanup clears the correct key.
- Font import and nested `js-cookie` dependency issues were cleaned up.
- Minimal Vitest coverage was added.

Independent Sol gates:

- `npm run test`: 14/14 passed.
- `npm run lint`: passed with only pre-existing React hook warnings.
- `npm ci --dry-run --ignore-scripts`: passed.
- Clean build with all Cognito variables unset: passed.
- Placeholder-variable build: passed.
- `git diff --check`: passed.

The lockfile change was audited and limited to the Vitest/Vite dependency
closure plus the nested `js-cookie` override.

## Track B — accepted

### B1/B2

Commit: `43aa976 fix(billing): classify configuration failures`

Delivered:

- Typed `StripeConfigError` taxonomy for terminal configuration failures.
- Checkout and portal return honest terminal configuration errors.
- Secrets Manager throttling, 5xx, and transport failures remain retryable.
- Explicit Secrets Manager 4xx failures are terminal.
- Exact request-hash matching prevents stale cross-key checkout replay.
- Billing configuration/provider observability was added.

Independent Sol gates:

- TypeScript build: passed.
- Focused Lambda suites: 47 passed.
- BillingStack suite: 28 passed.
- `git diff --check`: passed.

### B3 and cross-cutting RLS repair

Commit: `5c51c6e feat(billing): enforce lapsed plan limits`

Delivered:

- Migration 037 pauses newest active jobs while retaining the oldest allowed
  jobs after an entitlement reduction.
- A locked NOLOGIN enforcer role crosses FORCE RLS through a narrow
  SECURITY DEFINER surface.
- Migration 038 provides a reusable email outbox.
- SES delivery uses a two-phase, duplicate-safe claim, bounded retry/backoff,
  `send_unknown` handling, alarms, and required sender configuration.
- Subscription processing queues bilingual employer notification atomically
  with the job changes.
- Migration 039 repairs the recursive employer/applicant RLS policies with a
  locked relationship-reader role.
- The previous test-only RLS workaround was removed.

Important PostgreSQL 16 invariant:

- A plain CREATEROLE migration owner that creates a role retains one automatic
  creator membership row.
- The reviewed migrations fail closed on exactly the unavoidable
  `ADMIN=true`, `SET=false`, `INHERIT=false` row with a trusted superuser
  grantor.
- Any other membership or capability is rejected.

Independent Sol gates after Review 2:

- TypeScript build: passed.
- Billing production-critical suites: 55/55 passed.
- Adjacent ApiStack fixture: 39/39 passed.
- Earlier focused gate: 100 passed, 2 documented skips.
- BillingStack: 32/32 passed.
- Native PG16 billing/relationship suites: 7/7 passed.
- Migration 037 applied and reapplied under a plain
  NOSUPER/NOBYPASS/CREATEROLE owner.
- `git diff --check`: passed.

## Track W1 — accepted

Commit: `58bc7e4 feat(whatsapp): create support cases from chat`

Delivered:

- Migration 035 adds `create_admin_support_case`.
- Exact `support`/`soporte` command routing occurs after help and before
  relay.
- Worker identity falls back to the verified phone relationship.
- Duplicate open cases return the existing case.
- Admin acknowledgement covers new, existing, and pre-OTP cases.
- Case/event payloads match the admin read model.

Independent gates before the RLS repair:

- TypeScript build: passed.
- Focused WhatsApp/migration suites: 17 suites, 384 passed, 2 skipped.
- Terra's broader gate: 18 suites, 385 passed.
- `git diff --check`: passed.

W1 originally exposed migration 020's real `42P17` recursion. Migration 039 in
Track B repairs that production defect and its native tests prove related versus
unrelated employer visibility across users, profiles, and skills. A final
combined migration-chain run is still required in the integration worktree.

## Track W2 — WIP checkpoint and not accepted

The Track W2 implementation is preserved as source checkpoint `a8cebd3` and
integration checkpoint `9e1c316`. Both commits remain WIP until the required
correction round and Review 2 pass.

Current W2 files include:

- New `infra/db/migrations/036_whatsapp_delivery_status.sql`
- New `infra/lambda/whatsapp/status-callback.ts`
- New `infra/lambda/whatsapp/lib/twilio-secret.ts`
- New callback, secret, and native migration tests
- Changes to job-alert durability, shared outbox sending, ApiStack,
  WhatsAppStack, app entry, migration runners, and stack/WhatsApp tests

What the current W2 checkpoint already does:

- Adds an API Gateway sibling route at
  `POST /whatsapp/status-callback`.
- Uses an exact operator-configured HTTPS callback URL for both outbound Twilio
  requests and signature validation, avoiding a CDK dependency cycle.
- Validates Twilio HMAC signatures and bounded form fields.
- Adds callback columns and a monotonic state machine.
- Correlates both `whatsapp_outbox` and existing employer job-message sends.
- Converts job alerts toward durable `whatsapp_outbox` rows.
- Wires callback configuration to all discovered outbound senders.
- Adds structured delivery logs, metrics, and an alarm.

Terra's pre-review gates:

- TypeScript build: passed.
- Full WhatsApp/stack/migration gate: 20 suites, 428 passed, 2 expected skips.
- Native migration 036 integration: 3/3 passed.
- Full app CDK synth with explicit callback URL: passed.
- `git diff --check`: passed.

Sol's independent Review 1 gates:

- TypeScript build: passed.
- Focused callback/secret/outbox/job-alert/migration suites:
  77 passed, 2 expected skips.
- WhatsAppStack suite: 29/29 passed.

Passing tests do not make this checkpoint acceptable. Sol found the following
production blockers and sent them as the one allowed W2 feedback round.

### W2 correction round — required

1. **Production role creation**

   Migration 036 must not unconditionally run privileged `ALTER ROLE`
   statements. Create the helper with safe flags only when absent, validate an
   existing role, completely remove the temporary self-grant, and assert the
   exact single PG16 creator membership row and grantor.

2. **Locked helper implementation**

   Move privileged WhatsApp and job-message recorder implementations into the
   helper-owned locked schema with fully qualified relations and a catalog-only
   search path. Preserve any required public compatibility through narrow
   wrappers. Assert exact column grants, RLS policy roles/commands/expressions,
   function metadata, schema ACLs, and PUBLIC denial.

3. **Native gate integrity**

   Remove the integration test's
   `ALTER TABLE whatsapp_outbox OWNER TO jale_admin`. Apply exact migrations as
   the plain NOSUPER/NOBYPASS/CREATEROLE database/table owner, reapply 036, and
   execute the unified callback as `SET LOCAL ROLE jale_whatsapp`. Prove direct
   table and admin-event writes remain denied.

4. **Crash-safe job-alert draining**

   The current producer inserts a pending row and then sends directly. A crash,
   timeout, or missing Twilio SID can strand a row or create a duplicate. Add a
   scheduled five-minute drain with a short `SKIP LOCKED` claim committed to
   `send_unknown` before the network call, send outside the transaction,
   bounded retries/backoff only for definite non-acceptance, terminal ambiguity,
   attempt caps, and success only with a valid `SM...` SID.

   The producer should queue idempotently. Add crash-order, concurrency,
   ambiguity, backoff/cap, scheduled recovery, and job+worker idempotency tests.

5. **Delivery-state fidelity**

   Duplicate same-status callbacks must refresh callback timestamp and error
   details while returning `changed=false` and creating no duplicate admin
   event. Add DB bounds for errors. Guard missing admin cases. Native tests must
   cover delivered→read, duplicate metadata refresh, terminal failures,
   failure-after-delivery rejection, non-admin rows, unknown SIDs, and both
   durable stores.

6. **Complete observability**

   Alarm on callback processing/config/database failures and unknown SIDs, not
   only Twilio `failed`/`undelivered`. Alarm actions must target a required
   monitored topic or configured subscription; an empty SNS topic is not an
   actionable alarm. Use WhatsApp/shared configuration naming rather than
   `billingAlarmTopicArn`.

7. **Fail-closed sender configuration**

   ApiStack must require and normalize the callback URL rather than
   conditionally omitting it. `sendTwilioWhatsAppMessage` must treat a missing,
   malformed, or non-`SM` Twilio response SID as ambiguous, never as success.

8. **Stronger route/form tests**

   Prove the exact API resource parent chain makes the callback a sibling of the
   webhook with authorization NONE. Add signed form coverage for percent/plus
   decoding, error bounds, failure metrics, config/secret failures, malformed
   base64/body, and zero DB access before a valid signature. Retain the full-app
   synth cycle gate.

After Terra implements these items, Sol should perform Review 2 by re-diffing
only the correction hunks and rerunning the production-critical gates. Do not
send a second implementor feedback round.

## Current integration branch

The local integration worktree is on `feat/sprint16-dev-cycle-integration` and
contains these cherry-picked commits in order:

1. Frontend `839134a` from `6151045`
2. Billing `7320b0d` from `43aa976`
3. Billing/RLS `f8b9160` from `5c51c6e`
4. WhatsApp W1 `7851b65` from `58bc7e4`
5. WhatsApp W2 WIP `9e1c316` from `a8cebd3`

Do not merge this branch into `SPRINT16` while W2 remains WIP.

Resolve migration runner/order conflicts so the final sequence is:

`034 → 035 → 036 → 037 → 038 → 039`

Required before branch acceptance:

- Full `infra` TypeScript build and Jest suite.
- Full frontend Vitest, lint, and clean environment build.
- Full-app CDK synth with required email, SES identity, WhatsApp callback URL,
  and monitored alarm-topic contexts.
- A brand-new PostgreSQL 16 cluster applying every migration byte-for-byte.
- Production-equivalent plain-role reapply and RLS tests for 035–039.
- `git diff --check` and a secret/stale-contract scan.

The integration branch/worktree must remain local and must not be merged into
`SPRINT16` without a new explicit user instruction.

## Consolidation verification — 2026-07-16

- Frontend clean install, Vitest, lint, and clean-environment production build
  passed. Vitest passed 14/14; lint/build retained the previously documented
  React hook warnings.
- Infra clean install and TypeScript build passed. The full serial Jest run
  passed 111 suites and 1,087 tests; one suite and 61 tests were skipped,
  including the database-backed gates that require a migrated PostgreSQL URL.
- `git diff --check` passed after both conflict resolutions and the handoff
  update.
- The generic disposable testbed, bootstrapped with a superuser `jale_admin`,
  applied migrations 001–036 and then migration 037 correctly rejected the
  superuser-created ACL shape. This harness shape is not production-equivalent.
- A fresh PostgreSQL 16 database owned by a plain `NOSUPERUSER`,
  `NOBYPASSRLS`, `CREATEROLE` `jale_admin` applied migrations 001–022 exactly.
  Migration 023 then aborted with `42P17` (`infinite recursion detected in
  policy for relation "users"`) because migration 020's recursive policy is
  exercised before repair migration 039 can run.

The combined clean-chain and PostgreSQL-backed test gates therefore remain
open. Do not promote or merge this branch until the migration-order recursion
and the W2 Review-1 blockers are corrected and the complete verification
matrix passes.

## Operator prerequisites and external blockers

- Production checkout still lacks the
  `jale/billing/stripe-api` secret in `us-east-2`. Code now reports this
  honestly, but only an authorized operator can create/configure it.
- Billing email delivery requires a verified SES identity and production SES
  access.
- WhatsApp delivery callbacks require the exact public API Gateway callback URL
  and a monitored alarm topic/subscription.
- Twilio templates/SIDs remain operator-managed.
- Any migration application, secret change, push, release, or live-phone test
  requires explicit user approval.

## Quick resume checklist

1. Confirm managed Terra execution capacity is available.
2. Read this handoff and the original Claude plan.
3. Start the recorded W2 correction round from `track-w-whatsapp` at `a8cebd3`.
4. Send the correction to the same Terra implementor; do not start a second
   Review 1 cycle.
5. Run Sol Review 2 and commit the accepted correction on `track-w-whatsapp`.
6. Cherry-pick that correction after `9e1c316` on the integration branch.
7. Run the complete combined verification matrix and update this handoff.
8. Stop before any `SPRINT16` merge, push, deployment, secret operation, or
   shared migration.
