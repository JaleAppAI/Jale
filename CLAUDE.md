# Jale App - Claude Code Context

## What This Is

Jale is a bilingual English/Spanish job platform for blue-collar workers and employers. Workers authenticate by phone/OTP and can onboard through WhatsApp. Employers authenticate by email/password. Infrastructure is AWS CDK v2 in TypeScript, Lambda runtime is Node.js 20.x, the database is RDS PostgreSQL 16, and the frontend is a Next.js 14 app with `next-intl`.

Current state: infrastructure and frontend code exist, but treat all AWS deploys as deliberate operator actions. Do not assume a stack is safely deployed just because CDK code is present. Migrations are manual and forward-only.

## Repository Map

```text
Jale/
  infra/                         AWS CDK app, Lambda handlers, DB migrations, tests
    bin/jale-app.ts              CDK app entrypoint; wires 7 stacks
    lib/stacks/                  Network, Database, Auth, Api, Legal, WhatsApp, Bastion
    lib/constructs/              JaleLambdaFunction, CognitoPool
    lambda/                      Lambda handler source bundled by esbuild
    db/migrations/               001 through 006 SQL migrations
    test/unit/                   CDK and Lambda unit tests
    test/integration/            Live AWS integration tests
  frontend/                      Next.js 14 App Router frontend
    src/app/[locale]/            Localized routes
    src/components/              Auth, legal wall, layout, UI primitives
    src/contexts/AuthContext.tsx Cognito token/session state
    src/lib/                     API and Cognito wrappers
    src/messages/                en/es translations
  docs/                          Architecture docs, audits, specs, runbooks
  scripts/                       Migration, WhatsApp, and OTP smoke scripts
  .claude/skills/                Claude-local skills, currently playwright-cli
```

## Tech Stack

- Infrastructure: AWS CDK v2, TypeScript, CommonJS, strict mode.
- Compute: Lambda Node.js 20.x through `NodejsFunction` and esbuild.
- Database: RDS PostgreSQL 16, encrypted, isolated subnets, RLS enforced.
- Auth: Cognito worker pool and employer pool.
- API: API Gateway REST API with Cognito authorizers and Lambda integrations.
- Messaging: Twilio SMS for worker OTP custom auth, Twilio WhatsApp webhook plus SQS processor.
- Frontend: Next.js 14, React 18, `next-intl`, Tailwind CSS 4, `amazon-cognito-identity-js`.
- Tests: Jest + ts-jest + CDK assertions; separate integration Jest config.

## CDK Architecture

There are 7 stacks wired in `infra/bin/jale-app.ts`:

```text
NetworkStack
  -> DatabaseStack
  -> AuthStack
  -> ApiStack
  -> LegalStack
  -> WhatsAppStack
  -> BastionStack (synthesized, deploy only on demand)
```

Important dependency notes:

- `NetworkStack` creates the VPC, public/private/isolated subnet tiers, Lambda and RDS security groups, a Cognito SMS role, 1 NAT Gateway, Secrets Manager and CloudWatch Logs interface endpoints, and an S3 gateway endpoint.
- `DatabaseStack` creates PostgreSQL 16 in isolated subnets and a generated `jale_admin` Secrets Manager secret.
- `AuthStack` creates worker and employer Cognito pools, post-confirmation sync Lambda, worker custom-auth challenge Lambdas, and a post-confirmation DLQ.
- `ApiStack` creates the REST API, access logs, gateway CORS responses, worker/employer/dual authorizers, `/health`, `/worker/profile`, `/employer/profile`, `/auth/refresh`, and `/auth/logout`.
- `LegalStack` owns the versioned legal-docs S3 bucket and adds `/legal/tos` plus `/legal/accept` to the API from `ApiStack`.
- `WhatsAppStack` owns WhatsApp webhook, SQS queue/DLQ, processor, job-alert Lambda, and adds unauthenticated `POST /whatsapp/webhook`.
- `BastionStack` is an SSM-only, private EC2 host for migrations and ad-hoc `psql`. It is synthesized by default but should be deployed by name and destroyed after use.

Avoid introducing cross-stack cycles. Current patterns deliberately pass the API and dual authorizer into downstream stacks, reconstruct the WhatsApp webhook URL at runtime, and scope some Cognito IAM policies to regional `userpool/*` to avoid Lambda-trigger/user-pool cycles.

## Network And Egress Reality

The app now has `natGateways: 1`. Older docs or comments that say "NO NAT Gateway" are stale.

All `JaleLambdaFunction` Lambdas run in `PRIVATE_WITH_EGRESS` subnets behind the shared NAT Gateway. This enables Twilio calls, but it also means every Lambda attached to the shared `lambdaSg` can reach the public internet because `allowAllOutbound` is currently true. Treat that as a known V1 security risk, not a general permission slip.

Rules:

- For new AWS service calls, check whether an existing endpoint covers it or whether NAT routing is acceptable.
- For new external services, explicitly call out the shared NAT blast radius and consider a dedicated security group or moving the Lambda outside the VPC if it does not need RDS.
- Do not add interface endpoints casually. Current endpoint strategy keeps only high-value/high-frequency endpoints plus S3 gateway; NAT handles the rest.

## Database And Migrations

Migrations live in `infra/db/migrations/` and must be applied manually in order:

```text
001_initial_schema.sql
002_rls_policies.sql
003_whatsapp.sql
004_jobs.sql
005_job_applications.sql
006_whatsapp_reliability.sql
```

Key tables:

- `users`: worker/employer identity, tenant placeholder, legal acceptance columns, WhatsApp link, and worker profile fields.
- `legal_consent_log`: immutable-ish consent audit log; migration 006 flips its FK to `ON DELETE RESTRICT`.
- `whatsapp_conversations`: per-WhatsApp-number conversation state.
- `whatsapp_processed_messages`: inbound Twilio MessageSid idempotency and status lifecycle.
- `whatsapp_outbox`: durable replies written in the same DB transaction as state changes, then flushed to Twilio after commit.
- `jobs` and `job_applications`: V1 job alert/application model.

RLS is central. DB Lambdas must set `app.current_user_id` using `setRlsContext()` inside a transaction before user-scoped queries. Do not use raw string-built `SET LOCAL`.

DB role model:

- `jale_admin`: used by most Lambdas; RLS still applies because policies are forced.
- `jale_whatsapp`: used by WhatsApp Lambdas through the `jale/whatsapp/db` secret, with narrower grants plus RLS policies for worker rows and WhatsApp state tables.

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

DB-access pattern:

1. Import `getDbPool()` and `setRlsContext()` from `infra/lambda/lib/db.ts`.
2. `const client = await pool.connect()`.
3. `BEGIN`.
4. `await setRlsContext(client, cognitoSub)` for user-scoped operations.
5. Run queries with parameterized SQL only.
6. `COMMIT`.
7. Roll back on error and always `client.release()` in `finally`.

HTTP/CORS pattern:

- Use `corsHeaders()` from `infra/lambda/lib/http.ts`.
- Do not hardcode CORS headers in Lambda handlers.
- API Gateway gateway responses also need CORS when auth/throttle failures happen before Lambda.

WhatsApp processor pattern:

- Public webhook validates Twilio signature and queues the raw form body to SQS.
- SQS batch size is 1.
- Processor claims MessageSid with `INSERT ... ON CONFLICT DO NOTHING`.
- State mutations and outbox rows happen inside one DB transaction.
- Twilio sends happen after commit through `sendPendingOutbox()`.
- If Twilio fails after DB commit, retries resume from `db_committed`.

This is reliable for V1, but the processor is large and should be split before adding much more state-machine behavior.

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

- Refresh tokens are stored in `sessionStorage`. This is accepted V1 scaffolding but not production-grade against XSS. Prefer an HttpOnly-cookie refresh flow before real production traffic.
- `apiFetch()` sends raw JWTs in `Authorization` without a `Bearer` prefix. API Gateway Cognito authorizers tolerate this, but `Bearer <token>` is the conventional target.
- Refresh-and-retry is not wired into API calls yet; expired tokens can fail profile flows.
- Phone input needs E.164 normalization/validation before workers hit Cognito.

Design expectations:

- Bilingual parity: every visible string needs EN and ES.
- Mobile-first, large touch targets, clear hierarchy, high contrast.
- Workers are skilled professionals; copy should be direct and respectful.
- Preserve the existing bold/professional visual language unless intentionally redesigning.

## Commands

Root scripts:

```bash
npm run wa:test       # WhatsApp smoke test using root env files
npm run otp:test      # OTP smoke test
npm run otp:quick     # Quick OTP test
```

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

## Non-Negotiable Rules

- Never run `cdk deploy`, `cdk destroy`, or migration scripts against AWS without explicit user approval.
- Never hardcode AWS account IDs, credentials, API tokens, Twilio secrets, Cognito IDs from a live environment, or DB passwords.
- Never read, print, summarize, screenshot, paste, or copy secret-bearing files such as `.env`, `.env.*`, AWS credential files, private keys, exported shell env dumps, or Secrets Manager payloads. If a task appears to require them, stop and ask for a redacted shape/schema instead.
- Do not overwrite user changes. Check `git status --short` before broad edits.
- Keep CDK code in `infra/lib/stacks/` and constructs in `infra/lib/constructs/`.
- Keep Lambda handler code in `infra/lambda/`; it is bundled code, not CDK synth-time code.
- Keep tests next to the layer they verify: stack tests under `infra/test/unit/stacks`, Lambda tests under `infra/test/unit/lambda`, integration tests under `infra/test/integration`.
- Use project constructs and shared utilities before introducing new patterns.
- Any new legal/compliance-gated endpoint must enforce the legal wall server-side, not just in the frontend.

## AI Secret-Handling Practices

Claude must treat secrets as toxic data. The safest secret is one the agent never sees.

- Do not open `.env`, `.env.local`, `.env.integration`, `.env.whatsapp.*`, `.env.otp.*`, `~/.aws/credentials`, PEM/private-key files, downloaded secret JSON, or shell history files unless the user explicitly requests a targeted operation and provides a redacted path/field list.
- Do not run AWS CLI commands that reveal secret values, including `aws secretsmanager get-secret-value`, `aws ssm get-parameter --with-decryption`, `aws configure list`, broad `aws sts` identity dumps in shared output, or commands that print Lambda environment variables containing sensitive values. Prefer `describe-secret`, `list-secrets`, or CloudFormation/CDK references that show names/ARNs only.
- If an AWS command may return credentials, tokens, phone numbers, email addresses, authorization headers, signed URLs, or full Lambda env vars, use a restrictive `--query` that returns only non-sensitive metadata. When uncertain, do not run it.
- Never paste secrets into prompts for Claude, Codex, browser tools, issue text, commit messages, docs, screenshots, test fixtures, logs, or comments.
- Never ask Codex adversarial review or `codex:rescue` to inspect env files or secret values. Provide redacted examples like `{ "accountSid": "AC...", "authToken": "<redacted>" }` and ask it to reason from shape, permissions, and call sites.
- When debugging configuration, verify presence and shape, not value. Examples: "secret exists", "JSON contains required keys", "env var is set", "ARN format is valid". Do not display the actual value.
- When writing tests, use fake placeholders with impossible values such as `test-token`, `AC00000000000000000000000000000000`, or `<redacted>`. Never copy real IDs from local env files.
- If a secret is accidentally displayed or committed, stop normal work, tell the user exactly which file/command exposed it without repeating the value, and recommend rotation/removal from git history as appropriate.
- Redact defensively in all user-facing summaries: show only names of secret resources and the minimum safe suffix/prefix if needed for disambiguation.

## Production-Ready Coding Practices For This Repo

- Start from the threat model: worker PII, phone numbers, legal consent, DB credentials, and refresh tokens are sensitive.
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

## AWS Best Practices And Official Documentation

When changing AWS architecture, first check the current official AWS docs. Prefer the service guide and AWS Well-Architected Framework over blog posts, memory, or generated advice. If guidance and existing code conflict, call out the tradeoff and update the doc or code deliberately.

Primary AWS references:

- [AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html): start here for architecture decisions. Evaluate changes against operational excellence, security, reliability, performance efficiency, cost optimization, and sustainability.
- [AWS CDK best practices](https://docs.aws.amazon.com/cdk/v2/guide/best-practices.html): keep apps deterministic, unit-test synthesized templates, model reusable logic as constructs, deploy with stacks, and pass config through props instead of hidden machine state.
- [IAM security best practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html): use federation and temporary credentials, MFA, least privilege, Access Analyzer, conditions, and regular removal of unused access.
- [AWS Secrets Manager best practices](https://docs.aws.amazon.com/secretsmanager/latest/userguide/best-practices.html): store sensitive values in Secrets Manager, cache secret reads, rotate secrets, limit access, monitor usage, and mitigate CLI exposure risks.
- [Lambda best practices](https://docs.aws.amazon.com/lambda/latest/dg/best-practices.html): initialize SDK clients and DB pools outside handlers, avoid cross-invocation user data leaks, understand downstream throughput limits, use retries/backoff/jitter, configure alarms, and avoid recursive invocation loops.
- [Lambda environment variable security](https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html): environment variables are for operational parameters; use Secrets Manager for DB credentials, API keys, and authorization tokens.
- [API Gateway security best practices](https://docs.aws.amazon.com/apigateway/latest/developerguide/security-best-practices.html): use least privilege, access logging, CloudWatch alarms, CloudTrail, throttling, and avoid logging sensitive request/response bodies.
- [Amazon Cognito user pool security best practices](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-security-best-practices.html): protect public auth flows, guard against SMS abuse, use WAF where appropriate, apply admin least privilege, verify tokens, avoid local token storage, and sanitize attributes.
- [Amazon RDS security best practices](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_BestPractices.Security.html): use IAM least privilege for RDS APIs, security groups, Secrets Manager rotation, encryption, monitoring, and explicit backup/restore posture.
- [Amazon RDS encryption](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Overview.Encryption.html): encrypted RDS instances protect storage, logs, backups, read replicas, and snapshots at rest.
- [Amazon S3 security best practices](https://docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html): use Block Public Access, versioning, encryption, monitoring, least privilege, and consider Object Lock for compliance/audit data.
- [S3 Block Public Access](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html): public access should be blocked at bucket/account/org level unless a public bucket is intentionally designed and reviewed.
- [S3 Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html): use WORM retention or legal holds when accidental or inappropriate deletion must be prevented.
- [VPC security best practices](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-security-best-practices.html): use multiple AZs, security groups, network ACLs where appropriate, and keep subnet/egress design intentional.
- [SQS partial batch response best practices](https://docs.aws.amazon.com/prescriptive-guidance/latest/lambda-event-filtering-partial-batch-responses-for-sqs/best-practices-partial-batch-responses.html): for batch sizes greater than 1, use DLQs, partial batch responses, idempotency, metrics, and avoid snowball retry patterns.
- [Lambda CloudWatch metrics](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-metrics.html): Lambda publishes invocation, performance, concurrency, async, and event source mapping metrics; create dashboards and alarms around them.
- [CloudWatch alarm recommendations](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Best-Practice-Alarms.html): use AWS-recommended alarms as a baseline and codify them in IaC.
- [CloudTrail security best practices](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/best-practices-security.html): create ongoing multi-Region trails, enable log file validation, integrate with CloudWatch Logs, and protect audit logs.
- [AWS Config conformance packs](https://docs.aws.amazon.com/config/latest/developerguide/conformance-packs.html): use managed conformance packs to check governance and drift across accounts/regions.
- [AWS Security Hub CSPM](https://docs.aws.amazon.com/securityhub/latest/userguide/securityhub-get-started.html): use security standards and controls, especially AWS Foundational Security Best Practices, to surface prioritized findings.

Apply these docs to Jale this way:

- For every CDK change, run or update unit assertions and check whether the stack remains deterministic. Avoid synth-time network lookups.
- For every IAM policy, ask "what exact actions, resources, and conditions does this Lambda need?" Avoid `*` unless AWS service limitations require it and document the limitation.
- For every Lambda that touches RDS, preserve module-scope pool reuse, explicit transaction boundaries, RLS context, and parameterized SQL.
- For every new secret, store only the secret ARN/name in env vars and grant read access only to the Lambda that needs it. Never put secret values in CloudFormation, CDK context, Lambda env vars, tests, docs, or logs.
- For every public entry point (`/whatsapp/webhook`, `/legal/tos`, auth flows), verify throttling, abuse prevention, logging redaction, and cost-failure behavior.
- For every SQS workflow, design for duplicate delivery, poison messages, DLQ recovery, idempotency, and downstream throttling.
- For every legal/audit S3 object or consent record, prefer retention over deletion. Review Object Lock or retention policies before production compliance commitments.
- For production readiness, add CloudWatch alarms, CloudTrail, Config/Security Hub posture checks, backup/restore drills, and runbooks before calling the system production-ready.

## Current Architecture Review - Open Risks To Keep In Mind

High priority:

- Shared NAT + `lambdaSg.allowAllOutbound: true` gives all VPC Lambdas internet egress. Split security groups or move non-DB/non-Twilio functions out of the VPC before production hardening.
- Frontend refresh tokens in `sessionStorage` are XSS-sensitive. Move refresh to an HttpOnly-cookie backend flow.
- RDS production guardrails need review: deletion protection defaults, logs exports, Performance Insights, alarms, backups, and restore drill.
- WhatsApp processor is a large state-machine Lambda. Split into router plus state modules before V2 complexity lands.
- Add CloudWatch metrics/alarms/runbooks for DLQs, `db_committed` stuck messages, Twilio send failures, SQS age, Lambda errors, RDS connections, and API throttles.

Medium priority:

- Cognito IAM scoped to regional `userpool/*` is a known circular-dependency compromise. Consider tags or a custom import strategy later.
- `whatsapp_processed_messages` and `whatsapp_outbox` need retention/archival strategy.
- API Gateway global throttling is shared with unauthenticated webhook traffic.
- `worker-profile.ts` and `employer-profile.ts` duplicate most logic.
- Legal accept audit should prefer `X-Forwarded-For` first hop for IP capture.

## Claude Skills And How To Use Them

Available local Claude skill:

- `playwright-cli`: browser automation, UI smoke testing, snapshots, screenshots, console/network inspection. Use after frontend changes, auth flow UI changes, layout changes, and legal-wall changes. Prefer snapshots for interaction targeting; take screenshots when visual regressions matter.

Allowed Codex companion workflows are present in `.claude/settings.local.json`:

- `codex:rescue`: use when the repo is stuck, tests/build are broken, a refactor got tangled, a CDK dependency cycle appears, a migration is risky, or Claude needs a second engineer to propose or apply a repair.
- Codex adversarial review via companion script: use before merging large changes, after implementing a plan, after touching auth/RLS/WhatsApp reliability, or when architecture/security tradeoffs need a hard second pass.

Use Codex adversarial review like this:

```bash
node "C:/Users/luisg/.claude/plugins/cache/openai-codex/codex/1.0.2/scripts/codex-companion.mjs" adversarial-review "Repo root: C:/Users/luisg/OneDrive/Desktop/Jale. Review the working tree against this plan: <paste or point to plan>. Be exhaustive and do not truncate. Prioritize correctness, security, RLS, idempotency, AWS/CDK dependency cycles, missing tests, and production failure modes. Return findings ordered by severity with file paths and concrete fixes."
```

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

## Documentation Sources Worth Checking

- `docs/Audit.md`: latest broad codebase audit and open risk tracker.
- `docs/SYSTEM_OVERVIEW.md` and `docs/ARCHITECTURE.md`: broader product/system context; may lag code.
- `docs/JaleWhatsappFeaturePlan.md`: WhatsApp V1 plan.
- `docs/superpowers/specs/`: historical design specs and Codex-reviewed plans.
- `docs/whatsapp-v1-smoke-checklist.md`: manual WhatsApp smoke checklist.
- `docs/whatsapp-templates-twilio-checklist.md`: Twilio template setup checklist.

When docs and code disagree, trust code first, then update the doc that drifted.
