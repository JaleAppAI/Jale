# Sprint 12 Admin Panel Handoff

Branch: `feat/sprint12-admin-panel`

## Current Branch State

This branch contains the Sprint 12 admin panel work moved onto a branch based on `main`, plus the follow-up cleanup and implementation work done after the initial placeholder/scaffold pass.

The current working tree has the admin-panel changes staged. No commit has been created yet in this session.

## What Changed

### Admin App

- Added a standalone Next.js admin app under `admin/`.
- Added admin routes:
  - `/`
  - `/login`
  - `/cases`
  - `/cases/[id]`
  - `/verifications`
  - `/verifications/[id]`
  - `/audit`
  - `/api/session`
- Added admin layout, globals, typed UI models, login flow, and middleware.
- Replaced mock admin data with DB-backed server read models.
- Removed placeholder/scaffold wording and old preview-only action naming.
- Removed the old `admin/src/lib/mock-data.ts` placeholder data module.
- Removed the unrelated placeholder plan file `plans/frontend-cult-ui-cleanup-plan.md`.
- Updated the admin Dockerfile so it no longer requires a placeholder `public` directory.
- Added the RDS CA bundle into `admin/rds-ca-bundle.pem` for admin runtime DB SSL support.

### Admin Auth

- Added Cognito username/password login through `amazon-cognito-identity-js`.
- Added support for TOTP/MFA challenge handling in the login form.
- Added `/api/session` to exchange a Cognito ID token for an httpOnly admin session cookie.
- Added server-side JWT verification through `aws-jwt-verify`.
- Added session helpers:
  - `admin/src/lib/server/session.ts`
  - `admin/src/lib/server/session-claims.ts`
  - `admin/src/lib/session-cookie.ts`
- Added middleware protection for admin routes.
- Local preview role is still allowed only outside production.

### DB Access

- Added DB secret loading through Secrets Manager:
  - `admin/src/lib/server/db-secret.ts`
- Added shared Postgres pool helper:
  - `admin/src/lib/server/db.ts`
- Added dependency support for:
  - `@aws-sdk/client-secrets-manager`
  - `pg`
  - `@types/pg`
- DB helper expects the admin DB secret to resolve to the `jale_admin` role and validates required secret fields.

### DB-Backed Read Models

- Added DB-backed admin case reads:
  - `admin/src/lib/server/admin-cases.ts`
- Added DB-backed admin verification reads:
  - `admin/src/lib/server/admin-verifications.ts`
- Added DB-backed audit reads:
  - `admin/src/lib/server/admin-audit.ts`
- Admin pages now load data from the DB read models instead of mock data.
- PII is masked at the read-model boundary for list/detail display.
- Verification blockers are currently modeled from `admin_cases.case_type = 'verification_blocker'` and metadata in `details`, because the current admin migration does not define a separate verification table.

### Admin Actions

- Added audited action dispatch:
  - `admin/src/lib/server/admin-action-dispatch.ts`
- Renamed the action path from preview-oriented naming to live action naming:
  - `submitAdminPreviewAction` became `submitAdminAction`.
- Action validation now returns an audit event for valid actions instead of the old placeholder `not_wired` contract.
- Implemented DB-backed audited mutations for:
  - Case request more info
  - Case resolve
  - Verification approve
  - Verification reject
  - Verification request more info
  - Verification reset step
- `reveal_pii` is currently audit-only. It records the action but does not yet return raw PII to the UI.
- `reply_whatsapp` and `resend_outbound` still return explicit not-implemented responses until they are wired into the real WhatsApp outbox/retry path.

### Infrastructure

- Added admin CDK stack:
  - `infra/lib/stacks/admin-stack.ts`
- Wired the admin stack into the CDK app:
  - `infra/bin/jale-app.ts`
- Added admin migration:
  - `infra/db/migrations/025_admin_panel.sql`
- Updated migration scripts/tests to include the admin migration.
- Added admin stack unit tests:
  - `infra/test/unit/stacks/admin-stack.test.ts`

### Verification Harnesses

Added admin verification scripts:

- `admin/scripts/check-action-policy.mjs`
- `admin/scripts/check-server-db-helpers.mjs`
- `admin/scripts/check-session-helpers.mjs`
- `admin/scripts/check-read-models.mjs`
- `admin/scripts/check-action-dispatch.mjs`

Added package scripts:

- `npm --prefix admin run test:policy`
- `npm --prefix admin run test:server-db`
- `npm --prefix admin run test:session`
- `npm --prefix admin run test:read-models`
- `npm --prefix admin run test:dispatch`

## Verification Already Run

These checks passed during implementation:

- `npm --prefix admin run test:policy`
- `npm --prefix admin run test:server-db`
- `npm --prefix admin run test:session`
- `npm --prefix admin run test:read-models`
- `npm --prefix admin run test:dispatch`
- `npm --prefix admin run typecheck`
- `npm --prefix admin run build`
- `npm --prefix infra test -- --runInBand infra/test/unit/stacks/admin-stack.test.ts`

After the final Dockerfile/cert cleanup, these checks were rerun and passed:

- `npm --prefix admin run typecheck`
- `npm --prefix admin run test:dispatch`
- Placeholder scan against admin files found no remaining matches for old preview/scaffold/mock markers.

The final `npm --prefix admin run build` rerun after the Dockerfile/cert cleanup was interrupted by the user, so the latest build result after that cleanup is not confirmed.

## Currently In The Branch

Primary staged paths:

- `admin/`
- `infra/db/migrations/025_admin_panel.sql`
- `infra/lib/stacks/admin-stack.ts`
- `infra/bin/jale-app.ts`
- `infra/test/unit/stacks/admin-stack.test.ts`
- migration test updates under `infra/test/unit/db/`
- migration runner updates under `scripts/`
- `plans/sprint12-admin-panel-dependency-backed-plan.md`
- this handoff file

## Completed In The Verify-And-Implement Pass (2026-06-04)

This pass closed the correctness, feature, scalability, and hardening gaps found in
the two-agent verification review. All changes are local-verified (see "Verification
Re-run" below); AWS deploy + migration remain gated operator actions.

### Keystone correctness fix — dedicated `jale_admin_console` DB role

The admin read models JOIN `users` to resolve case-subject identity, but `users` has
`FORCE ROW LEVEL SECURITY` and the admin app connected as the shared `jale_admin`
role with no RLS context — so **every subject name/phone/email returned NULL** and the
panel showed "Unknown subject" / "Masked" for every case. The panel was wired but did
not work.

Fixed by introducing a dedicated least-privilege login role (mirrors ADR-W05 /
`jale_whatsapp`):

- `infra/db/migrations/025_admin_panel.sql`: creates `jale_admin_console`, grants it
  read+insert+update on `admin_cases`, read+insert on `admin_case_events`, append-only
  (read+insert) on `admin_audit_log`, read on `admin_users`, and a **column-scoped**
  `GRANT SELECT (id, full_name, phone, email, user_type, whatsapp_number) ON users`
  with a cross-user `users_admin_console_read` RLS policy. The shared `jale_admin`
  owner role is **not** broadened.
- `infra/lib/stacks/database-stack.ts`: adds CDK-generated `jale/admin-console/db`
  secret (`adminConsoleDbSecret`), mirroring `matchingDbSecret` / `aiDbSecret`.
- `infra/bin/jale-app.ts`: passes `adminDbSecret` to AdminStack; grants the bastion
  read + secret-management on `jale/admin-console/db`.
- `infra/lib/stacks/admin-stack.ts`: prop renamed `dbSecret` → `adminDbSecret`; the
  Lambda's `DB_SECRET_ARN` now points at the console secret.
- `admin/src/lib/server/db.ts`: `EXPECTED_ADMIN_DB_USER = 'jale_admin_console'`
  (rejects the shared role); also drains a broken pool on idle error.
- `scripts/run-migrations.ps1` / `.sh`: set the `jale_admin_console` password from the
  generated secret during migration (mirrors the `jale_matching` step).

### Feature: `reveal_pii` now returns data (audited, role-gated, inline)

- `admin/src/lib/server/admin-cases.ts` + `admin-verifications.ts`: add
  `revealCaseContact` / `revealVerificationContact` raw-contact reads.
- `admin/src/lib/server/admin-action-dispatch.ts`: for `reveal_pii`, writes the
  `pii_reveal=true` audit row first, then reads the raw contact in the **same
  transaction**, returning it in `AdminActionDispatchResult.revealed`.
- `admin/src/app/actions.ts`: adds `submitAdminActionState` (result-returning).
- `admin/src/components/AdminActionsPanel.tsx`: new client panel; reveals contact
  inline for one render (re-masked on refresh). Role gating unchanged
  (`admin_ops` + `admin_superadmin` only, via `action-policy.ts`). Uses a
  `useState` + `onSubmit` RPC call (NOT React 19's `useActionState`, which is absent
  at runtime on React 18.3).

### Scalability

- `listAdminCases` / `listVerificationRecords`: bounded with `LIMIT` (default 200);
  the cases list no longer fetches `admin_case_events` it never rendered.
- Migration 025: partial index `idx_admin_cases_verification_queue` on
  `(status, priority DESC, updated_at DESC) WHERE case_type='verification_blocker'`.

### Security hardening

- Migration 025: `admin_audit_log` is append-only via separate `FOR SELECT` + `FOR
  INSERT` policies (never `FOR ALL`) **and** a SELECT/INSERT-only grant.
- `admin/src/lib/safe-redirect.ts`: `safeNextPath` guard; applied where `?next=` is
  written (middleware) and consumed (login redirect) to block open redirects.
- `admin/src/lib/server/session.ts`: session cookie `sameSite` tightened to `strict`.

### Verification Re-run (all passed, 2026-06-04)

- `npm --prefix admin run test:policy | test:server-db | test:session | test:read-models | test:dispatch`
- `npm --prefix admin run typecheck` and `npm --prefix admin run build`
- `npm --prefix infra run build`
- `npx jest test/unit/stacks/database-stack.test.ts test/unit/stacks/admin-stack.test.ts test/unit/db test/unit/cdk-app.test.ts --runInBand` (6 suites, 44 passed)

Note: a full-app `cdk synth` currently fails on this Windows host with a transient
esbuild `EPERM: rename` while bundling unrelated Lambdas (Documents/AI stacks). CDK
template logic for the changed stacks is validated via the unit tests above instead.

### Live DB verification against real Postgres (2026-06-04)

The keystone fix was proven against a **real Postgres engine** (ephemeral local
PostgreSQL 17 cluster, trust auth, torn down after) — not just templates/types:

- The **full migration chain 001→025 applied cleanly** as `jale_admin`.
- Seeded a worker `users` row + an `admin_cases` row, then `SET ROLE jale_admin_console`
  (non-superuser → `FORCE` RLS applies) and ran the **exact `listAdminCases` JOIN**:
  returned `Carlos Mendoza | +1512... | carlos@example.com` — i.e. the case subject's
  identity now resolves (pre-fix this was NULL). **B1 confirmed working.**
- The reveal query returned the raw contact. **B2 confirmed working.**
- Security boundaries as `jale_admin_console`: audit `INSERT` succeeds; audit `UPDATE`
  and `DELETE` → `permission denied` (append-only, H1); `SELECT cognito_sub FROM users`
  → `permission denied` (column-scoped grant holds); bounded `admin_cases` UPDATE
  succeeds.

This means the only remaining unknown is environment-specific deploy wiring (real RDS
endpoint, secret population, Cognito), not the SQL/RLS/role logic — that is now
empirically verified on the same engine family (PostgreSQL 16/17).

## Security Review (2026-06-04, independent adversarial pass on the final diff)

Verdict: **no critical issues; safe to deploy after the HIGH fix (done).** Confirmed
clean: SQL fully parameterized, reveal_pii role-gated + re-validated server-side +
audit-before-read in one transaction, CSRF (server-action same-origin + sameSite
strict), append-only audit at grant+policy layers, CloudFront-only ingress (IAM OAC +
stripped Authorization), least-privilege column grant (no `cognito_sub`/`trust_signals`),
no secret values logged, migration-runner password step injection-safe.

Fixed in this pass:

- **H1 (was a side effect of the B1 fix): worker legal name rendered unmasked** in the
  case list/detail to all roles with no audit row, under the "masked by default" banner
  (the read gap previously hid it as NULL). Added `maskName` (first name + last initial)
  applied to case subject/employer display names; full name is now reveal-only. Locked
  by a `check-read-models` assertion.
- **M3:** deleted unreachable `revealVerificationContact` (reveal_pii is a case-only
  action) so no gated-but-resurrectable PII path remains.
- **M4:** corrected the `executeMutation` comment — audit + reveal share one
  transaction (no PII without a committed audit row; a reveal failure rolls back both).
- **M1:** documented in `middleware.ts` that it is a UX redirect layer only; the auth
  boundary is `requireAdminSession()` in every page/action.
- **L2:** documented the audit-log trust boundary in migration 025 (append-only binds
  the app role; `jale_admin` owner retains DDL).

Remaining hardening follow-ups (non-blocking, consistent with the existing risk register):

- **M2:** the admin Lambda shares `lambdaSg` (`allowAllOutbound: true`). Give the
  internet-facing admin Lambda a dedicated SG limited to RDS:5432 + HTTPS:443 to shrink
  SSRF blast radius. Tracked alongside the platform-wide NAT/egress risk in CLAUDE.md.
- **L3:** `ADMIN_PREVIEW_ROLE` is gated by `NODE_ENV !== 'production'` (CDK hardcodes
  `production`, so not exploitable in the deployed stack); consider an explicit
  `ENABLE_LOCAL_PREVIEW` flag as belt-and-suspenders for dev images.

Note: the `/security-scan` skill (AgentShield) only audits `.claude/` agent config, not
application code, and currently crashes on a dangling `.claude/skills/agent-browser`
path — so this review was done as an independent code review instead.

## Still Needs To Be Done (gated operator actions)

> **Why this is required:** every check run this pass validates *text and templates*
> (migration SQL strings, CDK secret shape, pure logic). Nothing executed the RLS
> policy, column grants, or the reveal round-trip against a real Postgres — that is
> deploy-gated (no local DB; RDS is in isolated subnets). The keystone B1 fix is
> **designed-correct and locally consistent, not yet live-verified.**

1. Deploy `JaleDatabaseStack` (creates the `jale/admin-console/db` secret).
2. Run migration 025 via the bastion (`scripts/run-migrations.*`) — this creates the
   `jale_admin_console` role and sets its password from the generated secret.
3. **Run migration 025's VERIFICATION block** — this is the literal proof B1 works:
   ```sql
   SET ROLE jale_admin_console;
   SELECT id, full_name FROM users LIMIT 1;   -- must return a row (not 0 rows / not NULL)
   UPDATE admin_audit_log SET action = 'x';   -- must fail (append-only)
   SELECT cognito_sub FROM users LIMIT 1;     -- must fail (column not granted)
   RESET ROLE;
   ```
4. Deploy `JaleAdminStack`.
5. Smoke the UI: open a case detail (subject name/phone show, masked), run a
   `reveal_pii` with justification (raw contact shows inline; audit row has
   `pii_reveal=true`), confirm `admin_readonly` cannot mutate or reveal.
6. Confirm the final production admin domain, allowed origin, callback behavior, env vars.
7. Commit the staged work; decide whether to push for remote review.

### Deferred by decision (still explicit 501)

- `reply_whatsapp` / `resend_outbound`: deliberately kept as explicit 501s this pass.
  Wiring them requires cross-stack integration — the admin app (`jale_admin_console`)
  would write `whatsapp_outbox` (owned by `jale_whatsapp`, flushed by the WhatsApp
  processor Lambda), which needs its own grant + flusher design. Track as a follow-up.

### Known follow-ups (not blocking MVP)

- **Admin audit-log retention/growth**: `LIMIT 200` bounds the *read*, not the table.
  `admin_audit_log` grows unbounded — design a retention/archival strategy before it
  matters operationally.
- **Credential rotation**: the admin pool re-reads the secret only after its 5-min
  cache expires and the pool is rebuilt on connection error; a true rotation strategy
  is still a V1 follow-up (shared with the rest of the platform).

### Security/Operational Follow-Ups

- Review npm audit advisories introduced by the new admin dependencies before production release.
- Confirm the admin DB secret shape and IAM permission boundaries in the deployed stack.
- Confirm CloudWatch alarms/logging expectations for admin actions.
- Decide whether `reveal_pii` needs a separate approval or tighter audit policy before exposing raw values.
