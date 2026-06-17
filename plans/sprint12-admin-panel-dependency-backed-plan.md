# Sprint 12 Admin Panel Dependency-Backed Implementation Plan

> **For implementers:** This plan starts **after** the no-new-dependency admin action/request/audit contract is complete. Use TDD for pure logic and targeted integration tests for each server/data boundary.

**Goal:** Replace the admin panel preview/mock layer with real Cognito sessions, DB-backed reads, and audited bounded admin mutations.

**Architecture:** Keep the admin panel as a separate Next.js app and CDK stack. Use the existing AdminStack-provided Cognito admin pool, VPC/private subnet Lambda placement, DB secret environment variable, and DB-secret grant. Preserve the pure `action-policy`, `action-requests`, and `audit-contract` modules as the central contract; add dependency-backed adapters around them rather than rewriting them.

**Tech Stack:** Next.js 14 App Router, AWS CDK, Cognito admin user pool/groups, RDS Postgres, Secrets Manager, `pg`, AWS SDK Secrets Manager client if no internal reusable helper is available.

---

## Current baseline before this plan

Implemented already:

- `admin/src/lib/action-policy.ts`
  - bounded action catalog
  - readonly/ops/superadmin role gating
  - closed-state disabling
  - PII justification policy
- `admin/src/lib/action-requests.ts`
  - action request parser
  - target/action mismatch detection
  - preview validator returning `403`, `409`, or `501 not_wired`
- `admin/src/lib/audit-contract.ts`
  - audit payload draft builder
- `admin/src/app/actions.ts`
  - server action stub that validates submitted form data and discards the not-wired result
- detail pages wired to forms:
  - `admin/src/app/cases/[id]/page.tsx`
  - `admin/src/app/verifications/[id]/page.tsx`
- dependency-free verification:
  - `npm --prefix admin run test:policy`
  - `npm --prefix admin run typecheck`
  - `npm --prefix admin run build`

Infrastructure baseline already in AdminStack:

- separate admin Cognito user pool
- groups: `admin_readonly`, `admin_ops`, `admin_superadmin`
- MFA required
- admin Next.js app deployed as Docker Lambda
- Lambda placed in VPC/private subnets
- Lambda gets `DB_SECRET_ARN`
- Lambda has read grant for DB secret
- CloudFront distribution for `admin.<domain>`

---

## Dependency approval boundary

This plan requires user approval before changing dependencies.

Expected dependency changes in `admin/package.json` / `admin/package-lock.json`:

- Add `pg` for Postgres access.
- Add `@types/pg` as a dev dependency if TypeScript needs it.
- Add `@aws-sdk/client-secrets-manager` unless the repo already has a reusable internal Secrets Manager/DB helper that can be imported without adding an admin dependency.
- Potentially add a lightweight JWT/JWKS verifier only if Cognito session validation cannot be safely handled with existing Next/server APIs and AWS-provided tokens.

Do **not** add broad auth frameworks until the session design is explicitly chosen.

---

## Product/security principles

1. Admin remains separate from worker/employer surfaces.
2. Admin actions remain bounded; no free-form DB editing.
3. Every mutation writes an audit event before/atomically with the mutation.
4. Every PII reveal requires a justification and creates a PII audit event.
5. Admin role is derived server-side from Cognito groups, never from client-submitted form data.
6. Client form data may carry target IDs and action IDs, but the server re-loads target state from DB before allowing the action.
7. Readonly admins can view queues and records but cannot mutate or reveal PII.
8. Live Twilio/WhatsApp operations should route through existing backend queue/outbox patterns, not direct arbitrary sends from the admin UI.

---

## Phase 1 — Dependency and helper setup

### Task 1.1: Add approved runtime dependencies

**Objective:** Add only the minimum packages needed for DB-backed admin reads.

**Files:**

- Modify: `admin/package.json`
- Modify: `admin/package-lock.json`

**Steps:**

1. After approval, run from repo root or admin dir:

   ```bash
   npm --prefix admin install pg @aws-sdk/client-secrets-manager
   npm --prefix admin install -D @types/pg
   ```

2. Verify dependency changes are limited:

   ```bash
   git diff -- admin/package.json admin/package-lock.json
   ```

3. Run:

   ```bash
   npm --prefix admin run typecheck
   npm --prefix admin run build
   ```

**Expected:** typecheck/build pass.

---

### Task 1.2: Create admin DB secret loader

**Objective:** Load and cache the RDS secret exposed by AdminStack as `DB_SECRET_ARN`.

**Files:**

- Create: `admin/src/lib/server/db-secret.ts`
- Test/extend: `admin/scripts/check-action-policy.mjs` or create a new no-network server helper check script.

**Implementation requirements:**

- Must throw a clear error if `DB_SECRET_ARN` is missing.
- Must not log secret values.
- Must parse the secret into host/user/password/dbname/port shape.
- Must cache the parsed secret per Lambda runtime.
- Must be isolated under `src/lib/server/` so it is never bundled into client components.

**Verification:**

- Typecheck.
- Add a local pure parser test using a fake secret string.
- Do not call live AWS in local tests.

---

### Task 1.3: Create admin DB pool helper

**Objective:** Provide a server-only Postgres pool configured from the DB secret.

**Files:**

- Create: `admin/src/lib/server/db.ts`

**Implementation requirements:**

- Use `pg.Pool`.
- Reuse one pool per Lambda runtime.
- Set SSL consistently with existing backend DB helpers.
- Use the admin DB role introduced by migration `026_admin_panel.sql`, not an overpowered owner role.
- Do not expose raw query helpers to client components.

**Verification:**

- Typecheck/build.
- If a local DB is available later, add an opt-in smoke check; do not require live DB for normal local tests.

---

## Phase 2 — Real admin session and role derivation

### Task 2.1: Choose and implement session boundary

**Objective:** Replace `ADMIN_PREVIEW_ROLE` with real server-side role derivation.

**Decision needed before coding:**

Choose one:

1. **Next.js-managed Cognito session cookies**
   - Login page exchanges Cognito auth result for secure cookies.
   - Server components/server actions read cookies and validate tokens.
   - Good MVP fit if we want all admin auth logic inside the admin app.

2. **CloudFront/Lambda-edge/auth proxy boundary**
   - Auth enforced before traffic reaches Next.js.
   - More infra-heavy; may be overkill for MVP.

Recommended MVP: **Next.js-managed Cognito session cookies**, because the admin app is already isolated by stack/domain and role checks belong next to server actions.

**Files likely touched:**

- Modify: `admin/src/lib/auth.ts`
- Create: `admin/src/lib/server/session.ts`
- Modify: `admin/src/app/login/page.tsx`
- Possibly create: `admin/src/app/auth/callback/route.ts`
- Possibly create: `admin/src/middleware.ts`

**Requirements:**

- Secure, httpOnly, sameSite cookies.
- No worker/employer Cognito tokens accepted.
- Admin group extracted from Cognito token claims.
- If multiple groups exist, select highest privilege deterministically:
  1. `admin_superadmin`
  2. `admin_ops`
  3. `admin_readonly`
- Unauthenticated requests redirect to `/login`.
- Server actions re-check the session; UI checks are not enough.

---

### Task 2.2: Replace preview role helper

**Objective:** Remove production reliance on `ADMIN_PREVIEW_ROLE`.

**Files:**

- Modify: `admin/src/lib/auth.ts`
- Modify: `admin/src/app/cases/[id]/page.tsx`
- Modify: `admin/src/app/verifications/[id]/page.tsx`
- Modify: `admin/src/app/actions.ts`

**Implementation requirements:**

- Keep `ADMIN_PREVIEW_ROLE` only for local development fallback if `NODE_ENV !== 'production'`.
- In production, missing/invalid session should redirect or return `401`.
- Never trust role from hidden form fields.

---

## Phase 3 — DB-backed read models

### Task 3.1: Add admin case read model

**Objective:** Replace mock case queue data with DB-backed data.

**Files:**

- Create: `admin/src/lib/server/admin-cases.ts`
- Modify: `admin/src/app/page.tsx`
- Modify: `admin/src/app/cases/page.tsx`
- Modify: `admin/src/app/cases/[id]/page.tsx`

**Queries should return:**

- case ID
- type
- status
- priority
- masked user/contact fields only
- conversation ID/reference
- assigned admin
- created/updated timestamps
- last safe message preview
- timeline events from audit/case history tables

**Security:**

- No raw PII unless a PII reveal action is explicitly performed.
- RLS should use the admin DB role and admin-specific policies from migration `026_admin_panel.sql`.

---

### Task 3.2: Add verification read model

**Objective:** Replace mock verification data with DB-backed verification queues.

**Files:**

- Create: `admin/src/lib/server/admin-verifications.ts`
- Modify: `admin/src/app/verifications/page.tsx`
- Modify: `admin/src/app/verifications/[id]/page.tsx`

**Queries should return:**

- verification ID
- subject type
- subject display label
- status
- step
- reason/blocker
- masked phone/email if available
- assigned admin
- updated timestamp

**Security:**

- No raw document URLs or raw PII in the initial list/detail response.
- Document review links, if needed, should be short-lived and separately audited.

---

### Task 3.3: Add audit log read model

**Objective:** Replace mock audit log with DB-backed audit events.

**Files:**

- Create: `admin/src/lib/server/admin-audit.ts`
- Modify: `admin/src/app/audit/page.tsx`

**Requirements:**

- Audit page is read-only.
- Sort newest first.
- Show PII reveal badge.
- Include actor, action, target, time, summary.
- Do not expose sensitive raw JSON blobs by default.

---

## Phase 4 — Live audited mutations

### Task 4.1: Convert preview server action to real mutation dispatcher

**Objective:** Turn `submitAdminPreviewAction` into a real validated dispatcher.

**Files:**

- Modify: `admin/src/app/actions.ts`
- Create: `admin/src/lib/server/admin-action-dispatch.ts`

**Required server flow:**

1. Load session and role server-side.
2. Parse request with `parseAdminActionRequest`.
3. Load current target from DB by target ID.
4. Re-run `previewAdminAction` / policy validation against live target state.
5. If invalid, return `400`, `403`, or `409`.
6. Open DB transaction.
7. Insert audit event.
8. Execute specific bounded mutation.
9. Commit.
10. Revalidate affected admin routes.

**Never:**

- mutate based only on hidden form fields
- allow arbitrary SQL action names
- reveal PII without justification
- skip audit write

---

### Task 4.2: Implement low-risk mutations first

Recommended order:

1. `request_more_info`
2. `resolve_case`
3. `approve_verification`
4. `reject_verification`
5. `reset_verification_step`
6. `reveal_pii`
7. `reply_whatsapp` / `resend_outbound`

Why this order:

- Start with simple DB state changes.
- Add verification changes after case changes are stable.
- Add PII reveal only after audit path is proven.
- Add Twilio/outbox actions last because they touch operational messaging.

---

### Task 4.3: Wire PII reveal as a short-lived reveal result

**Objective:** Reveal contact data only as a deliberate, audited, time-limited operation.

**Requirements:**

- Require justification length and content server-side.
- Insert audit event with `piiReveal=true` before returning data.
- Return only the requested field(s), not an entire raw user row.
- Prefer not persisting revealed PII in page cache.
- Ensure route is dynamic/no-store for reveal result.

---

### Task 4.4: Wire WhatsApp/outbox actions through existing backend path

**Objective:** Do not send arbitrary WhatsApp messages directly from the admin panel.

**Requirements:**

- `reply_whatsapp` should use bounded templates or constrained text policy.
- `resend_outbound` should queue an outbox retry rather than direct-send if that matches existing backend pattern.
- Every queued action gets an audit event.
- Failures surface as admin-visible status, not silent logs only.

---

## Phase 5 — CDK/deployment verification

### Task 5.1: Synthesize admin stack

Run:

```bash
npm --prefix infra run build
npm --prefix infra run cdk -- synth JaleAdminStack --quiet
```

Expected:

- Synth succeeds.
- Admin Lambda includes VPC/private subnet config.
- `DB_SECRET_ARN` is present.
- Admin Cognito outputs are present.

---

### Task 5.2: Deploy behind explicit approval

Deployment requires explicit approval because it touches live AWS.

Run only after approval:

```bash
npm --prefix infra run cdk -- deploy JaleAdminStack
```

Post-deploy checks:

- `https://admin.<domain>` loads.
- Unauthenticated user redirects to login.
- Admin user must use MFA.
- Admin group controls role.
- `admin_readonly` cannot mutate.
- `admin_ops` can run allowed actions.
- Audit events appear for mutations.
- PII reveal requires justification and logs `piiReveal=true`.

---

## Phase 6 — Tests and acceptance criteria

### Local required checks

Run before handoff:

```bash
npm --prefix admin run test:policy
npm --prefix admin run typecheck
npm --prefix admin run build
npm --prefix infra run build
npm --prefix infra test -- --runInBand
npm --prefix infra run cdk -- synth JaleAdminStack --quiet
```

### Acceptance criteria

- Admin app uses real admin Cognito session in production.
- Admin role is derived from Cognito groups server-side.
- Case/verifications/audit pages read from DB.
- Mock data is not used in production admin pages.
- Mutations are bounded by `action-policy.ts`.
- Every mutation writes audit log.
- Every PII reveal requires justification and writes audit log.
- Readonly role cannot mutate or reveal PII.
- Closed cases/verifications cannot be mutated except by explicitly approved future reopen flow.
- Deployment validation documents what was verified locally vs live AWS.

---

## Open decisions for Goma

1. Session architecture:
   - Recommended: Next.js-managed Cognito session cookies.
   - Alternative: CloudFront/auth-proxy boundary.

2. First live mutation to ship:
   - Recommended: `request_more_info` or `resolve_case` first.

3. PII reveal UX:
   - Should reveal appear inline for one page view, or open a separate short-lived reveal page/modal?

4. WhatsApp admin replies:
   - Should admins use only templates/bounded canned replies for MVP, or constrained free text with logging?

5. Admin user provisioning:
   - Manual Cognito console creation for first admin, or controlled script/CLI flow?
