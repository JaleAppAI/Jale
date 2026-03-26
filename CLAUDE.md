# Jale App — Claude Code Context

## What This Is

Jale is a bilingual (EN/ES) job platform connecting blue-collar workers with employers. Workers authenticate via phone/OTP, employers via email/password. Built on AWS with CDK (TypeScript).

**Status:** Sprint 1-2 infrastructure is code-complete but NOT deployed to AWS.

## Project Structure

```
Jale/
├── infra/                        # AWS CDK infrastructure (TypeScript)
│   ├── bin/jale-app.ts           # CDK app entry point — instantiates all stacks
│   ├── lib/stacks/               # 5 CDK stacks (deploy order: Network → Database → Auth → Api → Legal)
│   ├── lib/constructs/           # Reusable L3 constructs (JaleLambdaFunction, CognitoPool)
│   ├── lambda/                   # Lambda handler source code (bundled by esbuild, NOT CDK)
│   │   └── lib/                  # Shared Lambda utilities (db.ts, http.ts)
│   ├── test/                     # CDK assertion tests (jest, 37 tests)
│   ├── cdk.json                  # CDK config + context values
│   └── tsconfig.json             # commonjs module, strict mode
└── docs/                         # Architecture docs and specs (gitignored)
```

## Tech Stack

- **IaC:** AWS CDK v2 (TypeScript, commonjs module)
- **Lambda Runtime:** Node.js 20.x, 256MB, 30s timeout, esbuild bundling
- **Database:** RDS PostgreSQL 16 (db.t4g.micro)
- **Auth:** AWS Cognito (2 pools: Worker phone/OTP, Employer email/password)
- **API:** API Gateway REST, stage `dev`
- **Testing:** jest + ts-jest + aws-cdk-lib/assertions

## Architecture (5 Stacks)

**NetworkStack** — VPC (2 AZs, NO NAT Gateway), private + isolated subnets, Lambda/RDS security groups, 7 VPC endpoints (6 interface: secretsmanager, sns, cognito-idp, sts, logs, sqs + 1 gateway: s3). All Lambda egress goes through VPC endpoints — missing an endpoint = silent timeout.

**DatabaseStack** — RDS PostgreSQL 16 in isolated subnets, credentials in Secrets Manager. Takes `NetworkStack` as a prop (not individual fields).

**AuthStack** — Worker Cognito Pool (phone/OTP, MFA required) + Employer Pool (email/password, MFA optional with TOTP). Shared post-confirmation Lambda syncs users to RDS and assigns Cognito groups (Workers/Employers). KMS-encrypted SQS DLQ with explicit fallback push for failed events. SMS IAM role for Cognito → SNS OTP delivery.

**ApiStack** — REST API with Worker, Employer, and Dual Cognito Authorizers. Routes: GET /health, GET /worker/profile, GET /employer/profile, POST /auth/refresh, POST /auth/logout. Profile Lambdas enforce a legal wall via `checkCompliance` before returning data. Dual authorizer is shared with LegalStack.

**LegalStack** — S3 versioned bucket for ToS/Privacy docs. GET /legal/tos (presigned URLs, public), POST /legal/accept (records consent in DB + audit log, protected by dual Cognito authorizer). Routes added to ApiStack's API Gateway via cross-stack ref.

## Key Patterns

### CDK Imports (commonjs, no .js extensions)
```typescript
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { NetworkStack } from '../lib/stacks/network-stack';  // NO .js
```

### Lambda Handler Code (bundled by esbuild, different from CDK)
```typescript
// Lambda files use standard Node.js imports — esbuild resolves them
import { Pool } from 'pg';
import { getDbPool } from '../lib/db';
import { corsHeaders } from '../lib/http';
```

### DB Access Pattern (all DB Lambdas follow this)
1. Import shared `getDbPool()` from `lambda/lib/db.ts` (pg.Pool with max: 1, TTL-cached secrets)
2. Check out a client from the pool: `const client = await pool.connect()`
3. Set RLS context: `BEGIN` → `SET LOCAL app.current_user_id = $1` → queries → `COMMIT`
4. Release client in `finally` block: `client.release()`

### Reusable Constructs
- **JaleLambdaFunction** (`lib/constructs/lambda-function.ts`) — wraps NodejsFunction with VPC placement, logging, X-Ray, esbuild. Supports `deadLetterQueue`, `retryAttempts`, `maxEventAge`. Excludes `@aws-sdk/*` from bundles (runtime-provided).
- **CognitoPool** (`lib/constructs/cognito-pool.ts`) — wraps UserPool + UserPoolClient + Domain. `generateSecret: false` always. Supports `mfaSecondFactor` passthrough.

### Shared Lambda Utilities
- **`lambda/lib/db.ts`** — `getDbPool()` (pg.Pool with max:1, 5-min secret TTL), `getDbSecret()`, `DbSecret` interface
- **`lambda/lib/http.ts`** — `corsHeaders()` reads `ALLOWED_ORIGIN` env var

## Important Context

### Legal Wall Enforcement
Profile endpoints (`/worker/profile`, `/employer/profile`) call `checkCompliance()` inside the RLS transaction before returning data. Users who haven't accepted the current ToS version receive a `403 legal_required` response. The `POST /legal/accept` endpoint validates the submitted `tosVersion` matches `REQUIRED_TOS_VERSION` server-side — clients cannot self-issue compliance.

### VPC Endpoint Constraint
There is NO NAT Gateway. Lambdas can ONLY reach AWS services that have VPC endpoints (secretsmanager, sns, cognito-idp, sts, logs, sqs, s3). Adding a call to Twilio, Stripe, or any external API requires adding `natGateways: 1` to NetworkStack first.

### Database
- Schema must be migrated manually after first deploy: `001_initial_schema.sql` → `002_rls_policies.sql`
- Tables: `users` (with `tenant_id` for future Org Management, legal columns for ToS tracking), `legal_consent_log`
- RLS enforced on both `users` and `legal_consent_log` via `app.current_user_id` session variable
- All Lambdas use the same `jale_admin` credential (no role separation yet)

### Cross-Stack Dependencies
```
NetworkStack → DatabaseStack(network) → AuthStack(vpc, subnets, sg, dbSecret) → ApiStack(pools, vpc, sg, dbSecret) → LegalStack(api, dualAuthorizer, vpc, sg, dbSecret)
```
Stack props are passed in `bin/jale-app.ts`. CDK auto-infers deploy order from these references. The dual Cognito authorizer is created in ApiStack and passed to LegalStack to avoid cross-stack dependency cycles.

## Commands

```bash
cd infra
npm run build          # TypeScript compile
npm test               # 37 CDK assertion tests
npx tsc --noEmit       # Type-check without emitting
npx cdk synth          # Synthesize CloudFormation (5 stacks)
npx cdk diff           # Show changes vs deployed
npx cdk deploy --all   # Deploy all stacks (DO NOT run without user approval)
npx cdk destroy --all  # Tear down (DO NOT run without user approval)
```

## Rules

- NEVER run `cdk deploy` or `cdk destroy` without explicit user approval
- NEVER hardcode AWS account IDs, secrets, or credentials in source files
- When adding a new Lambda that calls an external service (non-AWS), check if NAT Gateway is needed
- When adding a new Lambda that calls an AWS service, check if a VPC endpoint exists for it
- All new Lambdas should use the `JaleLambdaFunction` construct for consistency
- All new Cognito pools should use the `CognitoPool` construct
- Keep Lambda handlers in `infra/lambda/` — they are bundled by esbuild, not executed as CDK
- CDK stack code goes in `infra/lib/stacks/` — this IS CDK, runs at synth time
- Test files go in `infra/test/` — one test file per stack
- All DB-accessing Lambdas must use `lambda/lib/db.ts` shared module — no copy-pasting DB boilerplate
- All Lambda CORS headers must use `lambda/lib/http.ts` — no hardcoded origins
