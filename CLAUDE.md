# Jale App — Claude Code Context

## What This Is

Jale is a bilingual English/Spanish job platform for blue-collar workers and employers. Workers authenticate by phone/OTP and onboard through WhatsApp. Employers authenticate by email/password and post jobs through the web. Infrastructure is AWS CDK v2 in TypeScript, Lambda runtime is Node.js 20.x, the database is RDS PostgreSQL 16, and the frontend is a Next.js 14 app with `next-intl`.

Built subsystems (code-complete, not yet deployed to prod):
- Core auth + legal wall (dual Cognito pools, post-confirmation sync, ToS acceptance)
- WhatsApp onboarding state machine (8 states, OTP via Twilio, profile builder, trust signal collection)
- Job posting + application flow (employer creates jobs, workers apply via WhatsApp or web)
- Document vault (presigned S3 upload, KMS encryption, employer document access scoped to applicants)
- Trust signal layer (3-question per-trade assessment stored in `users.trust_signals JSONB`)

Planned (not yet implemented):
- Job matching engine V2 — see `docs/jobmatch-v2-corrected-plan.md`

Current state: infrastructure and frontend code exist, but treat all AWS deploys as deliberate operator actions. Do not assume a stack is safely deployed just because CDK code is present. Migrations are manual and forward-only.

---

## System Status And Deployment State

| Layer | Status |
|---|---|
| Migrations 001–002 | **Live in dev RDS** — immutable; never edit these files |
| Migrations 003–006 | Written, undeployed, safe to edit in place |
| CDK stacks | Code-complete; none deployed to AWS without explicit operator action |
| Frontend | Next.js 14 app; dev server only |
| Job Matching Engine | **Planned** — authoritative plan: `docs/jobmatch-v2-corrected-plan.md` |

The migration chain is coherent (001–006 consolidated). Matching engine migrations (007+) can be added on top of the current clean baseline.

---

## Repository Map

```text
Jale/
  infra/                         AWS CDK app, Lambda handlers, DB migrations, tests
    bin/jale-app.ts              CDK app entrypoint; wires 8 stacks
    lib/stacks/                  Network, Database, Auth, Api, Legal, WhatsApp, Documents, Bastion
    lib/constructs/              JaleLambdaFunction, CognitoPool
    lambda/                      Lambda handler source bundled by esbuild
      api/                       REST API handlers (profile, jobs, documents, auth)
      auth/                      Token refresh, logout, OTP challenge Lambdas
      whatsapp/                  Webhook, processor, job-alert
        lib/                     flows.ts, templates.ts, twilio.ts, jwt.ts
      legal/                     get-tos.ts, accept-tos.ts, check-compliance.ts
      post-confirmation/         Cognito post-confirmation sync Lambda
      jobs/                      (planned) enrichment-processor, reranker-cron, worker-rerank
      lib/                       db.ts, http.ts, job-enrichment.ts (planned)
    db/migrations/               001 through 006 SQL migrations
    test/unit/                   CDK and Lambda unit tests
      stacks/                    CDK assertion tests per stack
      lambda/                    Lambda handler unit tests
      db/                        (planned) migration apply + scoring tests
    test/integration/            Live AWS integration tests
  frontend/                      Next.js 14 App Router frontend
    src/app/[locale]/            Localized routes
    src/components/              Auth, legal wall, layout, UI primitives
    src/contexts/AuthContext.tsx Cognito token/session state
    src/lib/                     API and Cognito wrappers
    src/messages/                en/es translations
  docs/                          Architecture docs, plans, audits, runbooks
    jobmatch-v2-corrected-plan.md    Authoritative V2 matching engine plan
    jobmatch-implementation-start.md Execution-facing matching PR sequence
    jobmatch-adversarial-fix-log.md  60-item audit trail for V2 decisions
  scripts/                       Migration, WhatsApp, and OTP smoke scripts
  .claude/skills/                Claude-local skills, currently playwright-cli
```

---

## Tech Stack

- Infrastructure: AWS CDK v2, TypeScript, CommonJS, strict mode.
- Compute: Lambda Node.js 20.x through `NodejsFunction` and esbuild.
- Database: RDS PostgreSQL 16, encrypted, isolated subnets, RLS enforced.
- Auth: Cognito worker pool (phone/OTP custom auth) and employer pool (email/password).
- API: API Gateway REST API with Cognito authorizers and Lambda integrations.
- Messaging: Twilio SMS for worker OTP custom auth; Twilio WhatsApp webhook + SQS processor; Twilio Content API for templated WhatsApp messages.
- Storage: S3 versioned bucket for legal docs; S3 KMS-encrypted bucket for worker documents.
- Frontend: Next.js 14, React 18, `next-intl`, Tailwind CSS 4, `amazon-cognito-identity-js`.
- Tests: Jest + ts-jest + CDK assertions; separate integration Jest config.
- Planned (matching): `pg_trgm` extension + normalized `worker_skills` table; Claude Haiku via `@anthropic-ai/sdk` for job feature enrichment.

---

## CDK Architecture

### Current: 8 stacks

```text
NetworkStack
  -> DatabaseStack
  -> AuthStack
  -> ApiStack
  -> LegalStack
  -> WhatsAppStack
  -> DocumentsStack      (added for document vault)
  -> BastionStack        (synthesized; deploy only on demand, destroy after use)
```

### Planned: 9 stacks (matching engine)

```text
NetworkStack
  -> DatabaseStack
  -> AuthStack
  -> MatchingStack       (PLANNED — must come before ApiStack; owns queues + processors)
  -> ApiStack
  -> LegalStack
  -> WhatsAppStack
  -> DocumentsStack
  -> BastionStack
```

**Stack dependency notes:**

- `NetworkStack` creates the VPC, public/private/isolated subnet tiers, Lambda and RDS security groups, a Cognito SMS role, 1 NAT Gateway, Secrets Manager and CloudWatch Logs interface endpoints, and an S3 gateway endpoint.
- `DatabaseStack` creates PostgreSQL 16 in isolated subnets and a generated `jale_admin` Secrets Manager secret.
- `AuthStack` creates worker and employer Cognito pools, post-confirmation sync Lambda, worker custom-auth challenge Lambdas (define/create/verify), and a post-confirmation DLQ.
- `ApiStack` creates the REST API, access logs, gateway CORS responses, worker/employer/dual authorizers, and all REST routes except `/legal/*`, `/whatsapp/*`, and document vault routes.
- `LegalStack` owns the versioned legal-docs S3 bucket and adds `/legal/tos` + `/legal/accept` to the API from `ApiStack`.
- `WhatsAppStack` owns WhatsApp webhook, SQS queue/DLQ, processor, job-alert Lambda, and adds unauthenticated `POST /whatsapp/webhook`.
- `DocumentsStack` owns the KMS-encrypted worker documents S3 bucket (versioned, 90-day lifecycle to IA, CORS for PUT), and adds document vault routes to the API. Lambdas: `worker-doc-upload-url`, `worker-doc-confirm`, `worker-doc-submit`, `employer-worker-profile`, `employer-worker-docs`, `employer-upload-token`.
- `MatchingStack` (planned) owns `job-enrichment-queue` + DLQ, `worker-rerank-queue` + DLQ, `JobEnrichmentProcessor`, `JobRerankerCron`, `WorkerRerankProcessor`, and matching alarms. It passes queue references as props into `ApiStack` and `WhatsAppStack`. It must **not** add API Gateway routes.
- `BastionStack` is an SSM-only, private EC2 host for migrations and ad-hoc `psql`.

**Cross-stack cycle avoidance:** current patterns deliberately pass the API and dual authorizer into downstream stacks, reconstruct the WhatsApp webhook URL at runtime, and scope some Cognito IAM policies to regional `userpool/*` to avoid Lambda-trigger/user-pool cycles. MatchingStack must not import from ApiStack or WhatsAppStack.

---

## Network And Egress Reality

The app has `natGateways: 1`. Any older docs or comments that say "NO NAT Gateway" are stale — NAT was added when Twilio was integrated.

All `JaleLambdaFunction` Lambdas run in `PRIVATE_WITH_EGRESS` subnets behind the shared NAT Gateway. This enables Twilio and Anthropic calls, but it also means every Lambda attached to the shared `lambdaSg` can reach the public internet because `allowAllOutbound` is currently true. Treat that as a known V1 security risk, not a general permission slip.

Rules:
- For new AWS service calls, check whether an existing endpoint covers it or whether NAT routing is acceptable.
- For new external services (Twilio, Anthropic, etc.), explicitly call out the shared NAT blast radius. Consider a dedicated security group or moving the Lambda outside the VPC if it does not need RDS.
- Do not add interface endpoints casually. Current strategy keeps only high-value/high-frequency endpoints plus S3 gateway; NAT handles the rest.
- Planned: enrichment Lambda (Anthropic calls) should eventually get its own SG with outbound HTTPS; DB-only Lambdas should be constrained.

---

## Database And Migrations

Migrations live in `infra/db/migrations/` and must be applied manually in order:

```text
001_initial_schema.sql          LIVE in dev RDS — immutable
002_rls_policies.sql            LIVE in dev RDS — immutable
003_jobs_and_applications.sql   undeployed — jobs, job_applications, worker_profiles
004_whatsapp.sql                undeployed — jale_whatsapp role, conversations,
                                  processed_messages, outbox, users profile extensions
                                  (consolidated from original 003_whatsapp + 006_reliability)
005_document_vault.sql          undeployed — document_upload_tokens, worker_documents,
                                  jobs.required_docs[]
006_trust_signal_layer.sql      undeployed — users.trust_signals JSONB,
                                  users.trust_signals_completed_at
```

Planned matching migrations (numbered tentatively; add after 006):

```text
007+  metros, metro_cities, geo columns on users/jobs
008+  jobs matching columns (trade, seniority_required, job_features, matching_status)
009+  worker_skills table + pg_trgm extension
010+  job_candidates table + RLS policies
011+  worker_job_impressions + worker_match_log + employer_daily_usage
012+  seniority_rank() + match_score() PL/pgSQL functions
```

### Key Tables

| Table | Purpose |
|---|---|
| `users` | Worker/employer identity; profile fields (city, main_trade, years_experience, etc.); legal acceptance columns; WhatsApp link; `trust_signals JSONB`; `metro_id` (planned) |
| `legal_consent_log` | Immutable consent audit; FK on `user_id` is `ON DELETE RESTRICT` |
| `worker_profiles` | **Canonical matching profile**: `skills TEXT[]`, `availability`, `years_experience`, `location`; WhatsApp onboarding must upsert this, not just `users` |
| `jobs` | Employer postings: title, location, job_type, description, `required_docs TEXT[]`, status, `employer_id`; matching columns added in planned 008+ migration |
| `job_applications` | `UNIQUE(job_id, worker_id)`; uses `worker_id` (never `user_id`) |
| `whatsapp_conversations` | Per-phone state row: `conversation_state`, `state_context JSONB` (stores collected profile fields, cognito_session, field_sids, recent_jobs) |
| `whatsapp_processed_messages` | MessageSid idempotency; atomic claim via `INSERT … ON CONFLICT DO NOTHING`; status lifecycle: `claimed → db_committed → sent / failed` |
| `whatsapp_outbox` | Durable reply queue: written inside DB tx, flushed to Twilio after commit |
| `document_upload_tokens` | One-time S3 presign auth: `token_hash` (not raw token), `expires_at`, `used` flag |
| `worker_documents` | S3 object metadata: `worker_id`, `job_id`, `doc_type`, `s3_key`; `UNIQUE(worker_id, job_id, doc_type)` |
| `metros` / `metro_cities` | (planned) Metro-level geography for matching |
| `job_candidates` | (planned) Materialized per-job ranked workers: `score`, `score_components JSONB`; RLS: employer reads only candidates for own jobs |
| `worker_job_impressions` | (planned) Deduped impression log: `surface` (whatsapp/web/push/direct), `impression_window_key` for dedupe |
| `worker_match_log` | (planned) Impression-linked outcome log: `outcome` (viewed/applied/hired/rejected/ignored); triggers auto-flip on application lifecycle |
| `employer_daily_usage` | (planned) Atomic enrichment quota counter per employer per day |

### DB Role Model

- `jale_admin` — used by most Lambdas (API handlers, auth, document vault); RLS still applies because policies are forced.
- `jale_whatsapp` — used by WhatsApp Lambdas via `jale/whatsapp/db` secret; cross-user SELECT on `users` (workers only, column-scoped); UPDATE on profile + trust_signals + WhatsApp fields. Cross-user SELECT is a V1 trade-off for phone-based lookup during onboarding; compensated by column-level grants and `user_type='worker'` policy filter.
- `jale_matching` — (planned) service role for candidate materialization writes; bypasses worker/employer RLS policies via explicit service policies or `SECURITY DEFINER` functions. Never use employer/worker RLS policies for internal ranking writes.

RLS is central. DB Lambdas must set `app.current_user_id` (Cognito sub) using `setRlsContext()` inside a transaction before user-scoped queries. Do not use raw string-built `SET LOCAL`. For internal service writes that cannot use a Cognito sub, use a dedicated DB role or `SECURITY DEFINER` function rather than broadening user-facing policies.

---

## Lambda Patterns

All new Lambdas should use `JaleLambdaFunction` from `infra/lib/constructs/lambda-function.ts`.

Important defaults:
- Runtime Node.js 20.x
- Memory 256 MB
- Timeout 30 seconds unless overridden
- X-Ray tracing enabled
- CloudWatch log retention 1 month
- VPC placement in private-with-egress subnets
- esbuild bundles local code and excludes `@aws-sdk/*` plus `pg-native`
- `rds-ca-bundle.pem` is copied into every bundle by command hook

### DB-access pattern (Cognito-authenticated)

1. Import `getDbPool()` and `setRlsContext()` from `infra/lambda/lib/db.ts`.
2. `const client = await pool.connect()`.
3. `BEGIN`.
4. `await setRlsContext(client, cognitoSub)` — sets `app.current_user_id` to the Cognito sub.
5. Run queries with parameterized SQL only.
6. `COMMIT`.
7. Roll back on error; always `client.release()` in `finally`.

### Document token auth pattern (unauthenticated upload flow)

When Cognito JWT is unavailable (worker document uploads), use one-time upload tokens:
1. Validate token hash against `document_upload_tokens` (hash match, not used, not expired).
2. Extract `worker_id` (UUID) from the token row.
3. Set `app.current_internal_user_id` (not `app.current_user_id`) for RLS context.
4. Mark token as used atomically.
5. Proceed with document metadata write.

Rationale: token is a single-use credential; hash in DB prevents value exposure even if DB is read.

### Matching write pattern (planned)

Candidate materialization, impression inserts, and match log writes use `jale_matching` DB role or `SECURITY DEFINER` SQL functions. Never expand worker/employer RLS policies to accommodate internal ranking writes. Internal writes that bypass RLS must be scoped to the exact tables they need and audited.

### HTTP/CORS pattern

- Use `corsHeaders()` from `infra/lambda/lib/http.ts`.
- Do not hardcode CORS headers in Lambda handlers.
- API Gateway gateway responses also need CORS when auth/throttle failures happen before Lambda.

### WhatsApp processor pattern

- Public webhook validates Twilio signature and queues the raw form body to SQS.
- SQS batch size is 1.
- Processor claims MessageSid with `INSERT … ON CONFLICT DO NOTHING`.
- State mutations and outbox rows happen inside one DB transaction.
- Twilio sends happen after commit through `sendPendingOutbox()`.
- If Twilio fails after DB commit, retries resume from `db_committed` status — state mutation is never re-executed.

The processor is large (~1700 lines) and should be split before V2 complexity (matching integration) lands.

---

## Feature Architecture

### WhatsApp Onboarding State Machine

The WhatsApp processor (`infra/lambda/whatsapp/processor.ts`) implements an 8-state machine:

```
new → awaiting_otp → awaiting_legal → building_profile → building_trust_signal → idle
                                                                ↓
                                                    legal_declined / otp_timeout
```

**Reliability guarantee (claim-commit-outbox):**
1. Atomic MessageSid claim: `INSERT INTO whatsapp_processed_messages … ON CONFLICT DO NOTHING`
2. All state mutations + outbox reply rows happen inside one DB transaction
3. Twilio sends happen after commit via `sendPendingOutbox()`
4. Twilio failure: row stays `db_committed`; SQS retry flushes outbox without re-executing the state mutation

**Key design decisions annotated inline:**
- **Session persistence**: Cognito OTP session stored in `state_context.cognito_session`; reused on every SQS retry — one Twilio SMS per onboarding attempt regardless of retry count.
- **Sub reconciliation**: after OTP success, IdToken JWT decoded → real UUID. Three cases: (A) promote placeholder (phone-number sub) in place, (B) merge into pre-existing web-created user, (C) use real-sub row directly.
- **Pending-field model**: `state_context.collected[field]` tracks answered questions; prevents re-prompting the same question on SQS retries.
- **Language detection**: "Hola"/"hola" → `es`; "Hello"/"hello" → `en`; default `es`.

**Trust signal collection (`building_trust_signal` state):**
- 3 questions per trade: specialization, seniority, tasks — hardcoded in `infra/lambda/whatsapp/lib/flows.ts`
- Answers stored as **stable taxonomy keys** in `users.trust_signals JSONB` (e.g., `electrician.specialization.residential`, `seniority.can_work_alone`)
- `trust_signals_completed_at` set when all 3 answered
- Backward-compatible: workers who reached `idle` before this feature shipped have NULL trust_signals; `JOBS` command works, trust_alignment scoring component returns 0

**Idle state (`idle`):**
- Keywords `JOBS`/`TRABAJOS`: query matched jobs (planned: matched via scoring; V1: latest active jobs), return numbered list, throttle 3 alerts/worker/24h
- Button callbacks: `accept:job-{id}`, `decline:job-{id}`, `info:job-{id}`
- Recent job IDs stored in `state_context.recent_jobs` for typed-number resolution

---

### Document Vault

**Upload flow (unauthenticated — worker may not have active Cognito session):**
1. Employer (or API) creates an upload token: `POST /employer/upload-tokens`
2. Worker calls `POST /worker/documents/upload-url` with token → presigned S3 PUT URL (short TTL)
3. Worker PUTs file directly to S3 (bypasses Lambda)
4. Worker calls `POST /worker/documents/confirm` with token → Lambda validates hash, inserts `worker_documents` metadata row, marks token used

**Key design decisions:**
- Token hash in DB (not raw token): single-use credential; hash prevents value exposure even on DB read (ADR-D03)
- `app.current_internal_user_id` for RLS: worker UUID comes from validated token, not Cognito JWT (ADR-D01)
- KMS encryption (not SSE-S3): worker documents contain PII; KMS provides key-level access audit and rotation (ADR-D02)
- Employer document access: scoped via RLS join on `jobs.employer_id` — employers can only view documents for workers who applied to their jobs

---

### Job Matching Engine (Planned — V2)

**Authoritative plan:** `docs/jobmatch-v2-corrected-plan.md`
**Execution entry point:** `docs/jobmatch-implementation-start.md`
**Audit trail:** `docs/jobmatch-adversarial-fix-log.md` (FIX-001–060)
**V2 supersedes:** `docs/jobmatch.txt` and `.claude/plans/i-am-planning-a-serene-allen.md`

**High-level architecture:**

- **Hard filters** (SQL WHERE before scoring): trade match, seniority rank ≥ required, experience years ≥ required, same metro_id, job `status='active'` AND `matching_status='ready'`
- **Soft scorer** (`match_score` PL/pgSQL STABLE function, max 90 pts): `seniority_match` (20), `skill_overlap` via pg_trgm (25), `trust_alignment` via stable taxonomy keys (20), `experience_over` (10), `profile_completeness` (10), `document_readiness` (5)
- **Async enrichment pipeline**: `POST /jobs` → `job-enrichment-queue` (SQS) → `JobEnrichmentProcessor` Lambda → Claude Haiku enrichment of `job_features` → candidate materialization → `matching_status='ready'`
- **Three read surfaces**: `GET /employer/jobs/:id/candidates`, `GET /worker/jobs` (web feed), WhatsApp `JOBS` command (limit 3, 3/worker/24h throttle)
- **Impression + outcome logging**: deduped `worker_job_impressions` + `worker_match_log`; DB triggers auto-flip `outcome` on application lifecycle changes
- **Secret name**: `jale/jobs/anthropic` — readable only by `JobEnrichmentProcessor`

**Critical V2 constraints (from adversarial review):**
- `worker_profiles` is canonical for matching; WhatsApp onboarding must upsert it
- Normalized `worker_skills` table with GIN trigram index (not fuzzy on `TEXT[]`)
- Stable taxonomy keys in both `trust_signals` and `job_features` (not display labels)
- Materialization: `UPSERT` eligible + `DELETE` stale rows in one transaction (no ghost candidates)
- Employer candidates: privacy-safe summaries only — no phone, full legal name, or raw score components before application
- LLM enrichment: employer job text is untrusted input — delimited in prompt, output validated against taxonomy, raw title/description/prompt/response never logged
- MatchingStack must be inserted before ApiStack in CDK dependency order

---

## API Endpoint Inventory

| Method | Path | Auth | Lambda | Stack |
|---|---|---|---|---|
| GET | /health | none | `api/health.ts` | Api |
| GET | /worker/profile | worker | `api/worker-profile.ts` | Api |
| GET | /employer/profile | employer | `api/employer-profile.ts` | Api |
| POST | /employer/jobs | employer | `api/employer-jobs-create.ts` | Api |
| GET | /employer/jobs | employer | `api/employer-jobs-list.ts` | Api |
| PATCH | /employer/jobs/{jobId} | employer | `api/employer-jobs-update.ts` | Api |
| GET | /employer/jobs/{jobId}/applicants | employer | `api/employer-job-applicants.ts` | Api |
| GET | /employer/jobs/{jobId}/candidates | employer | `api/employer-job-candidates.ts` **(planned)** | Api |
| GET | /worker/jobs | worker | `api/worker-jobs.ts` **(planned)** | Api |
| POST | /auth/refresh | none | `auth/token-refresh.ts` | Api |
| POST | /auth/logout | none | `auth/logout.ts` | Api |
| GET | /legal/tos | none (rate-limited) | `legal/get-tos.ts` | Legal |
| POST | /legal/accept | dual | `legal/accept-tos.ts` | Legal |
| POST | /whatsapp/webhook | none | `whatsapp/webhook.ts` | WhatsApp |
| POST | /worker/documents/upload-url | none (token-auth) | `api/worker-doc-upload-url.ts` | Documents |
| POST | /worker/documents/confirm | none (token-auth) | `api/worker-doc-confirm.ts` | Documents |
| POST | /worker/documents/submit | none (token-auth) | `api/worker-doc-submit.ts` | Documents |
| GET | /employer/workers/{workerId}/profile | employer | `api/employer-worker-profile.ts` | Documents |
| GET | /employer/workers/{workerId}/documents | employer | `api/employer-worker-docs.ts` | Documents |
| POST | /employer/upload-tokens | employer | `api/employer-upload-token.ts` | Documents |

All routes include CORS OPTIONS preflight. API Gateway default 4xx/5xx gateway responses include CORS headers.

---

## Architecture Decisions Record

### Group A — Core Infrastructure

**ADR-001: Dual Cognito pools (not single pool)**
Decision: Two separate pools — Worker (phone/OTP custom auth) and Employer (email/password).
Rationale: Workers are mobile-first, blue-collar, authenticate via phone. Employers use email/password from a desktop. Mixing forces compromises on MFA policy, password policy, and sign-in flow.
Trade-off: Frontend must route to the correct pool. Shared endpoints (e.g., `/legal/accept`) require a dual authorizer that accepts JWTs from both pools.

**ADR-002: NAT Gateway (SUPERSEDES original "no NAT" decision)**
Original decision: no NAT Gateway to save $32/mo (Lambdas reached only AWS services via VPC endpoints).
Superseded when: Twilio SMS + WhatsApp integration required public internet egress from VPC Lambdas.
Current state: `natGateways: 1`, `lambdaSg.allowAllOutbound: true`. All VPC Lambdas can reach the public internet — this is a known V1 blast-radius risk. Planned fix: give egress-only Lambdas (enrichment, Twilio) dedicated security groups.

**ADR-003: RDS PostgreSQL (not Supabase, not Aurora Serverless)**
Decision: CDK-managed RDS PostgreSQL 16, `db.t4g.micro`.
Rationale: Full SQL power, predictable cost (~$15/mo), CDK-managed, pgvector-ready for future ML-assisted matching.
Alternative rejected: Supabase (external CDK dependency), Aurora Serverless v2 (higher minimum cost).

**ADR-004: Monolithic CDK app with separated stacks**
Decision: One CDK app, 8 stacks, cross-stack refs via props.
Rationale: Single `cdk deploy --all`, type-safe references, standard for a small team.
Trade-off: Adding a new stack in the middle of the dependency chain requires careful ordering (see MatchingStack placement before ApiStack).

**ADR-005: Manual migrations via bastion**
Decision: SQL migrations applied manually via EC2 bastion + SSM.
Rationale: Custom Resource Lambdas for migrations are fragile (timeout, rollback complexity). Manual is safer for a small team with infrequent schema changes.

**ADR-006: Legal wall as shared utility (not Lambda Authorizer)**
Decision: `checkCompliance()` imported by Lambda handlers, not a Lambda Authorizer.
Rationale: A Lambda Authorizer replaces the Cognito Authorizer on each route, losing free JWT validation. The shared utility keeps Cognito JWT validation AND adds compliance checking.
Risk: Every protected Lambda must explicitly import and call `checkCompliance()`. A new endpoint that forgets will have no legal wall enforcement.

**ADR-007: Post-confirmation Lambda never throws**
Decision: The post-confirmation Lambda catches all errors and returns successfully. Cognito confirmation always succeeds.
Rationale: A failed DB write should not prevent a user from creating an account. Better to have a ghost account (Cognito-only) than a failed sign-up.
Mitigation: DLQ captures infrastructure failures. Profile endpoints return 404 for ghost accounts.

**ADR-008: `tenant_id` added proactively**
Decision: Nullable `tenant_id UUID` added to `users` now, before Org Management ships.
Rationale: Adding to a populated table later requires a migration + backfill. Free to add now.

**ADR-009: OTP via Twilio SMS (SUPERSEDES original "SNS for OTP" decision)**
Original decision: AWS SNS sandbox for OTP — simpler, no external account, 10 test numbers.
Superseded when: Twilio was added for WhatsApp. Migrating OTP to Twilio unifies messaging on one service, removes the 10-number sandbox limit, and enables production-ready SMS.
Current: Worker custom auth Lambdas (`create-auth-challenge`) call Twilio via `jale/whatsapp/otp-twilio` secret.

**ADR-010: CORS locked to configured origin (not `*`)**
Decision: CORS origin parameterized via `tryGetContext('allowedOrigin')`; default `http://localhost:3000`.
Rationale: `credentials: include` is blocked by browsers when CORS returns `*`. Locking to origin is correct and necessary.
Action needed before prod: update CDK context with actual frontend domain.

---

### Group B — WhatsApp & Messaging

**ADR-W01: SQS batch size 1**
Decision: WhatsApp inbound queue batch size is 1.
Rationale: Prevents phantom parallelism — multiple concurrent Lambda invocations on the same conversation state row. Serialization is enforced by `SELECT … FOR UPDATE` on the conversation row.

**ADR-W02: Outbox pattern for Twilio sends**
Decision: Replies written to `whatsapp_outbox` inside the DB transaction; flushed to Twilio after commit via `sendPendingOutbox()`.
Rationale: Twilio failure must not silently advance the state machine. With the outbox, a Twilio failure after commit leaves the row in `db_committed`; SQS retry resumes from the outbox without re-executing state mutations.

**ADR-W03: Cognito session persistence across retries**
Decision: Cognito challenge session stored in `state_context.cognito_session` after the first `InitiateAuth`; reused in all subsequent `RespondToAuthChallenge` calls within the same onboarding attempt.
Rationale: Each new `InitiateAuth` sends a new Twilio SMS. SQS retries must not trigger additional SMS deliveries. One SMS per onboarding attempt.

**ADR-W04: Real cognito_sub reconciliation (placeholder → real UUID)**
Decision: After OTP success, the IdToken JWT is decoded to extract the real Cognito UUID. The DB row created with `cognito_sub = phone_number` (placeholder) is reconciled to the real sub.
Three cases: (A) promote placeholder in place, (B) merge into a pre-existing web-created user who has a real-sub row, (C) use the real-sub row directly if it already exists.
Rationale: Phone-as-sub placeholders are needed to create the users row before the worker's real Cognito UUID is known; real UUID must be the final key.

**ADR-W05: Cross-user SELECT for `jale_whatsapp` role**
Decision: `jale_whatsapp` can SELECT across all worker rows in `users` (not scoped to a single user).
Rationale: Phone-based user lookup during onboarding requires finding a user by `whatsapp_number`, which is a cross-user query. No user-scoped Cognito sub exists yet at that point in the flow.
Compensating controls: column-level grants (only specific fields), `user_type = 'worker'` policy filter, no write access to employer rows.

**ADR-W06: Trust signal questions hardcoded in `flows.ts`**
Decision: Per-trade question sets and answer options are constants in `infra/lambda/whatsapp/lib/flows.ts`, not a DB-driven table.
Rationale: The taxonomy is small, curated, and changes infrequently. A DB-driven taxonomy adds a table, RLS policies, and a migration for every taxonomy edit — unnecessary overhead at V1.

**ADR-W07: OTP via Twilio SMS (not SNS)**
See ADR-009. Applied specifically to WhatsApp stack context: both OTP SMS and WhatsApp messaging use the same Twilio account and service.

---

### Group C — Document Vault

**ADR-D01: Unauthenticated presigned upload (one-time token flow)**
Decision: Worker document upload does not require a Cognito JWT. Instead, a one-time upload token is generated by an authenticated employer (or API flow) and passed to the worker.
Rationale: Workers may be completing the document upload flow via a link before their next Cognito session. Presigned URL + one-time token provides equivalent security without requiring a re-authentication.

**ADR-D02: KMS-encrypted S3 (not SSE-S3)**
Decision: Worker documents S3 bucket uses AWS KMS managed keys, not SSE-S3 server-side encryption.
Rationale: Worker documents contain PII (driver licenses, SSNs, resumes). KMS provides per-key access auditing, fine-grained IAM controls, and rotation capability. SSE-S3 provides encryption at rest but no key-level audit trail.

**ADR-D03: Token hash stored in DB (not raw token)**
Decision: `document_upload_tokens.token_hash` stores the hash of the upload token, not the token itself.
Rationale: The token is a single-use credential. If the `document_upload_tokens` table were ever read by an unauthorized party, raw tokens would be usable. A hash is not.

---

### Group D — Job Matching Engine (Planned V2)

For full rationale on each decision see `docs/jobmatch-adversarial-fix-log.md`.

**ADR-M01: Migration baseline reconciliation before matching**
Decision: The dev migration chain was consolidated into 001–006 before adding matching migrations, eliminating duplicate table definitions and column name inconsistencies.
Rationale: Stacking matching migrations on a broken ordering would make a fresh DB apply fail. Coherent ordering is a prerequisite for any automated migration testing.

**ADR-M02: `worker_profiles` canonical for matching (not `users`)**
Decision: Matching scorer reads from `worker_profiles`, not `users`. WhatsApp onboarding must upsert `worker_profiles` as well as `users` profile fields.
Rationale: `users` mixes identity/auth columns with profile columns. `worker_profiles` is the right relational home for matching-relevant data. Using `LEFT JOIN` as cold-start behavior is deliberate; workers with no `worker_profiles` row get the cold-start floor score.

**ADR-M03: Normalized `worker_skills` table + GIN trigram index**
Decision: Skills stored in a normalized `worker_skills(worker_id, skill)` table with a GIN `gin_trgm_ops` index, not as fuzzy-matched elements of an unnested `TEXT[]`.
Rationale: Fuzzy matching on an unnested array has no index support and misses bilingual aliases ("drywall" / "tablaroca"). A GIN index on a skills table enables sub-millisecond trigram lookups at scale.

**ADR-M04: Stable taxonomy keys (not display labels)**
Decision: Both `users.trust_signals` and `jobs.job_features` store stable keys (e.g., `electrician.specialization.residential`) not display labels (e.g., `"Residential"`).
Rationale: Display labels change with translations and UI copy updates. Matching keys must be stable or every label change silently breaks the trust_alignment scoring component.

**ADR-M05: One-sided materialization (`job_candidates` per job)**
Decision: Employer candidate lists are pre-computed into `job_candidates` per job. Worker job feed is computed on-read.
Rationale: Per-job candidate set is bounded (one row per eligible worker). Per-worker pre-computed recommendation set is unbounded (one row per eligible job × every worker). Pick the bounded side for the materialized table.

**ADR-M06: UPSERT + DELETE stale in one transaction**
Decision: Every candidate materialization run UPSERTs eligible workers AND DELETEs rows for workers who are no longer eligible, in one transaction.
Rationale: Without the DELETE, workers who change trade or metro leave stale `job_candidates` rows visible to employers. The combined UPSERT + DELETE ensures the materialized view is always coherent.

**ADR-M07: Employer candidate privacy (no pre-application PII)**
Decision: Employer candidate response before a worker applies shows only: display_name alias, metro, skills list, `score_band` (strong/good/fair), fit reasons. Phone number and full legal name are never included.
Rationale: Workers have not yet consented to sharing contact info with this specific employer. PII exposure before consent is a privacy violation and a trust risk for the platform.

**ADR-M08: LLM enrichment treats employer text as untrusted input**
Decision: Employer job title and description are delimited as untrusted data in the enrichment prompt. Output is validated strictly against stable taxonomy keys. Raw prompt, title, description, and model response are never logged.
Rationale: Prompt injection in job descriptions could exfiltrate data or manipulate taxonomy outputs. Log redaction is required to prevent PII from job postings entering CloudWatch.

**ADR-M09: MatchingStack inserted before ApiStack in CDK dependency order**
Decision: The new MatchingStack must come before ApiStack in `infra/bin/jale-app.ts`.
Rationale: ApiStack receives the `jobEnrichmentQueue` reference as a prop and needs it at synth time. If MatchingStack comes after ApiStack, ApiStack cannot reference matching queue ARNs without a circular dependency.

---

## Frontend Architecture

The frontend is a localized Next.js App Router app under `frontend/src`.

Routes:
- `/[locale]`: landing/home
- `/[locale]/auth/worker`
- `/[locale]/auth/employer`
- `/[locale]/worker/profile`
- `/[locale]/employer/profile`
- `/[locale]/legal/accept`

Key client modules:
- `AuthContext.tsx`: stores tokens, refreshes sessions, logs out.
- `lib/cognito.ts`: wraps `amazon-cognito-identity-js` for worker and employer flows.
- `lib/api.ts`: fetch wrapper; throws `LegalWallError` when the backend returns `403 legal_required`.
- `useRequireAuth.ts`: page guard and legal-wall routing.
- `LegalWall.tsx`: legal acceptance UI.

Known frontend risks:
- Refresh tokens are stored in `sessionStorage`. Accepted V1 scaffolding; move to HttpOnly-cookie refresh flow before real production traffic.
- `apiFetch()` sends raw JWTs in `Authorization` without a `Bearer` prefix. API Gateway Cognito authorizers tolerate this, but `Bearer <token>` is the conventional target.
- Refresh-and-retry is not wired into API calls; expired tokens can fail profile flows.
- Phone input needs E.164 normalization/validation before workers hit Cognito.

Design expectations:
- Bilingual parity: every visible string needs EN and ES.
- Mobile-first, large touch targets, clear hierarchy, high contrast.
- Workers are skilled professionals; copy should be direct and respectful.
- Preserve the existing bold/professional visual language unless intentionally redesigning.

---

## Commands

Root scripts: none currently.

Infra:

```bash
cd infra
npm run build
npm test
npm run test:integration
npx tsc --noEmit
npx cdk synth
npx cdk diff
npx cdk deploy --all      # NEVER without explicit user approval
npx cdk destroy --all     # NEVER without explicit user approval
```

Frontend:

```bash
cd frontend
npm run dev
npm run build
npm run lint
```

Migration/bastion operations:

```bash
cd infra
npx cdk deploy JaleBastionStack     # only with explicit approval
../scripts/run-migrations.ps1       # Windows path; inspect args first
../scripts/run-migrations.sh        # shell path; inspect args first
npx cdk destroy JaleBastionStack    # destroy after use, with approval
```

---

## Non-Negotiable Rules

- Never run `cdk deploy`, `cdk destroy`, or migration scripts against AWS without explicit user approval.
- Never hardcode AWS account IDs, credentials, API tokens, Twilio secrets, Cognito IDs from a live environment, or DB passwords.
- Never read, print, summarize, screenshot, paste, or copy secret-bearing files such as `.env`, `.env.*`, AWS credential files, private keys, exported shell env dumps, or Secrets Manager payloads. If a task appears to require them, stop and ask for a redacted shape/schema instead.
- Do not overwrite user changes. Check `git status --short` before broad edits.
- Keep CDK code in `infra/lib/stacks/` and constructs in `infra/lib/constructs/`.
- Keep Lambda handler code in `infra/lambda/`; it is bundled code, not CDK synth-time code.
- Keep tests next to the layer they verify: stack tests under `infra/test/unit/stacks`, Lambda tests under `infra/test/unit/lambda`, DB tests under `infra/test/unit/db`, integration tests under `infra/test/integration`.
- Use project constructs and shared utilities before introducing new patterns.
- Any new legal/compliance-gated endpoint must enforce the legal wall server-side, not just in the frontend.
- Matching engine: employer job text is untrusted input. Never log raw prompt, title, description, or model response from LLM enrichment.

---

## AI Secret-Handling Practices

Claude must treat secrets as toxic data. The safest secret is one the agent never sees.

- Do not open `.env`, `.env.local`, `.env.integration`, `.env.whatsapp.*`, `.env.otp.*`, `~/.aws/credentials`, PEM/private-key files, downloaded secret JSON, or shell history files unless the user explicitly requests a targeted operation and provides a redacted path/field list.
- Do not run AWS CLI commands that reveal secret values, including `aws secretsmanager get-secret-value`, `aws ssm get-parameter --with-decryption`, `aws configure list`, broad `aws sts` identity dumps in shared output, or commands that print Lambda environment variables containing sensitive values. Prefer `describe-secret`, `list-secrets`, or CloudFormation/CDK references that show names/ARNs only.
- If an AWS command may return credentials, tokens, phone numbers, email addresses, authorization headers, signed URLs, or full Lambda env vars, use a restrictive `--query` that returns only non-sensitive metadata. When uncertain, do not run it.
- Never paste secrets into prompts for Claude, Codex, browser tools, issue text, commit messages, docs, screenshots, test fixtures, logs, or comments.
- When debugging configuration, verify presence and shape, not value. Examples: "secret exists", "JSON contains required keys", "env var is set", "ARN format is valid". Do not display the actual value.
- When writing tests, use fake placeholders with impossible values such as `test-token`, `AC00000000000000000000000000000000`, or `<redacted>`. Never copy real IDs from local env files.
- If a secret is accidentally displayed or committed, stop normal work, tell the user exactly which file/command exposed it without repeating the value, and recommend rotation/removal from git history as appropriate.
- Redact defensively in all user-facing summaries: show only names of secret resources and the minimum safe suffix/prefix if needed for disambiguation.

---

## Production-Ready Coding Practices For This Repo

- Start from the threat model: worker PII, phone numbers, legal consent, DB credentials, refresh tokens, and employer job text (untrusted LLM input) are sensitive.
- Prefer least privilege at the IAM, security group, DB grant, and RLS-policy layers.
- Make every external side effect idempotent. SQS, Twilio webhooks, API retries, and Lambda timeouts all produce duplicates.
- Keep transaction boundaries explicit. Avoid nested `BEGIN` inside helpers called from an outer transaction.
- Parameterize SQL. Never concatenate user-controlled values into SQL identifiers or predicates.
- Fail loudly on missing required env vars at module load or first use with clear error messages.
- Keep AWS SDK clients and DB pools at module scope for warm reuse, but account for stale secrets/rotated credentials.
- Add tests for bug shape, not just happy paths. Include retries, duplicate messages, missing env vars, malformed JWT/body, legal-wall failures, RLS-denied rows, and Twilio/Cognito failure modes.
- For CDK changes, assert generated CloudFormation behavior in unit tests, not just TypeScript compilation.
- For frontend changes, test both `en` and `es`, mobile widths, expired sessions, legal-required redirects, loading, empty, and error states.
- Update docs when architecture changes. `CLAUDE.md`, `docs/Audit.md`, migration comments, and smoke checklists should not contradict code.
- Keep source comments current. Move historical fix-plan archaeology to docs/ADRs when it starts obscuring the current logic.

---

## AWS Best Practices And Official Documentation

When changing AWS architecture, first check the current official AWS docs. Prefer the service guide and AWS Well-Architected Framework over blog posts, memory, or generated advice. If guidance and existing code conflict, call out the tradeoff and update the doc or code deliberately.

Primary AWS references:

- [AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html): start here for architecture decisions.
- [AWS CDK best practices](https://docs.aws.amazon.com/cdk/v2/guide/best-practices.html): keep apps deterministic, unit-test synthesized templates, model reusable logic as constructs.
- [IAM security best practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html): use federation and temporary credentials, MFA, least privilege.
- [AWS Secrets Manager best practices](https://docs.aws.amazon.com/secretsmanager/latest/userguide/best-practices.html): store sensitive values in Secrets Manager, cache reads, rotate secrets.
- [Lambda best practices](https://docs.aws.amazon.com/lambda/latest/dg/best-practices.html): initialize SDK clients and DB pools outside handlers, avoid cross-invocation user data leaks.
- [Lambda environment variable security](https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html): environment variables are for operational parameters; use Secrets Manager for credentials and tokens.
- [API Gateway security best practices](https://docs.aws.amazon.com/apigateway/latest/developerguide/security-best-practices.html): use least privilege, access logging, throttling.
- [Amazon Cognito user pool security best practices](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-security-best-practices.html): protect public auth flows, guard against SMS abuse.
- [Amazon RDS security best practices](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_BestPractices.Security.html): Secrets Manager rotation, encryption, monitoring.
- [Amazon S3 security best practices](https://docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html): Block Public Access, versioning, encryption, least privilege.
- [S3 Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html): use for legal/audit data where accidental deletion must be prevented.
- [VPC security best practices](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-security-best-practices.html): multiple AZs, security groups, intentional egress design.
- [SQS partial batch response best practices](https://docs.aws.amazon.com/prescriptive-guidance/latest/lambda-event-filtering-partial-batch-responses-for-sqs/best-practices-partial-batch-responses.html): DLQs, partial batch responses, idempotency.
- [Lambda CloudWatch metrics](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-metrics.html): create dashboards and alarms.
- [CloudWatch alarm recommendations](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Best-Practice-Alarms.html): codify baseline alarms in IaC.
- [CloudTrail security best practices](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/best-practices-security.html): multi-Region trails, log file validation.
- [AWS Config conformance packs](https://docs.aws.amazon.com/config/latest/developerguide/conformance-packs.html): governance and drift detection.
- [AWS Security Hub CSPM](https://docs.aws.amazon.com/securityhub/latest/userguide/securityhub-get-started.html): AWS Foundational Security Best Practices standards.

Apply these to Jale:
- For every CDK change, run or update unit assertions and check whether the stack remains deterministic.
- For every IAM policy, ask "what exact actions, resources, and conditions does this Lambda need?"
- For every Lambda that touches RDS, preserve module-scope pool reuse, explicit transaction boundaries, RLS context, and parameterized SQL.
- For every new secret, store only the ARN/name in env vars and grant access only to the Lambda that needs it.
- For every public entry point (`/whatsapp/webhook`, `/legal/tos`, auth flows), verify throttling, abuse prevention, and cost-failure behavior.
- For every SQS workflow, design for duplicate delivery, poison messages, DLQ recovery, idempotency, and downstream throttling.
- For every LLM enrichment call, treat employer text as untrusted, validate output, and redact sensitive data from logs.

---

## Current Architecture Review — Open Risks

### High Priority

- **Shared NAT + `lambdaSg.allowAllOutbound: true`** gives all VPC Lambdas internet egress. Split security groups or move non-DB/non-Twilio functions out of the VPC before production hardening.
- **Frontend refresh tokens in `sessionStorage`** are XSS-sensitive. Move refresh to an HttpOnly-cookie backend flow before real production traffic.
- **RDS production guardrails**: deletion protection defaults, logs exports, Performance Insights, alarms, backups, and restore drill all need review before prod.
- **WhatsApp processor is ~1700 lines**. Must be split into router + state modules before matching engine V2 integration adds JOBS feed logic.
- **Add CloudWatch metrics/alarms/runbooks** for DLQs, `db_committed` stuck messages, Twilio send failures, SQS age, Lambda errors, RDS connections, API throttles.
- **Document vault: no immutable employer document access log**. Audit trail is only `worker_documents` metadata; no access log for who viewed which document and when.

### Medium Priority

- **Cognito IAM scoped to regional `userpool/*`** is a known circular-dependency compromise. Consider tags or custom import strategy later.
- **`whatsapp_processed_messages` and `whatsapp_outbox`** need retention/archival strategy.
- **API Gateway global throttling** is shared with unauthenticated webhook traffic.
- **`worker-profile.ts` and `employer-profile.ts`** duplicate most logic.
- **Legal accept audit should prefer `X-Forwarded-For`** first hop for IP capture.
- **Job matching (planned)**: `job_candidates` grows unbounded without periodic cleanup on closed jobs; add a retention/cleanup job before or shortly after launch.
- **Job matching (planned)**: Haiku enrichment failure leaves `jobs.matching_status='failed'` with no candidates visible to employer; DLQ + retry-cron recovers but adds latency.
- **Job matching (planned)**: `worker_match_log` grows unbounded without archival strategy; design retention before matching launch.

---

## Claude Skills And How To Use Them

Available local Claude skill:
- `playwright-cli`: browser automation, UI smoke testing, snapshots, screenshots, console/network inspection. Use after frontend changes, auth flow UI changes, layout changes, and legal-wall changes.

Allowed Codex companion workflows in `.claude/settings.local.json`:
- `codex:rescue`: use when the repo is stuck, tests/build are broken, a refactor got tangled, a CDK dependency cycle appears, a migration is risky, or a second engineer opinion is needed.

Use Codex rescue like this:

```text
Invoke skill codex:rescue with:
- repo root
- exact command that fails
- failing output
- files recently changed
- intended behavior
- constraints such as no deploy/destroy, no secrets, preserve user changes
```

Best practice for asking Codex for help:
- Give it the plan/spec path and the exact files or subsystem to inspect.
- Ask it to be adversarial when you want bugs, not encouragement.
- Ask it to preserve the working tree and avoid deploy/destroy.
- After Codex responds, verify its claims locally. Treat it as a sharp reviewer, not an authority.

---

## Documentation Sources Worth Checking

- `docs/Audit.md`: latest broad codebase audit and open risk tracker.
- `docs/SYSTEM_OVERVIEW.md` and `docs/ARCHITECTURE.md`: broader product/system context; may lag code.
- `docs/DESIGN_DOCUMENT.md`: detailed system design; may lag code.
- `docs/JaleWhatsappFeaturePlan.md`: WhatsApp V1 feature plan (may lag current processor implementation).
- `docs/jobmatch-v2-corrected-plan.md`: **authoritative** V2 job matching engine plan.
- `docs/jobmatch-implementation-start.md`: execution-facing entry point for matching PRs (PR sequence, open decisions).
- `docs/jobmatch-adversarial-fix-log.md`: audit trail for all V2 architectural decisions (FIX-001–060).
- `docs/whatsapp-v1-smoke-checklist.md`: manual WhatsApp smoke checklist.
- `docs/whatsapp-templates-twilio-checklist.md`: Twilio template setup checklist.
- `.claude/plans/`: Claude session plan files; the V1 matching engine plan here is superseded by the V2 docs above.

When docs and code disagree, trust code first, then update the doc that drifted.
