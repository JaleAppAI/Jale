# Jale App 2.0 — Architecture Documentation

> **Last updated:** 2026-05-04 | **Sprint coverage:** Sprint 1-2 + Job Matching readiness prerequisites | **Status:** Infrastructure code complete, Frontend integrated, matching prereqs in progress

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture Decisions Record](#2-architecture-decisions-record)
3. [Current Architecture (Sprint 1-2)](#3-current-architecture-sprint-1-2)
4. [Stack-by-Stack Breakdown](#4-stack-by-stack-breakdown)
5. [Data Flow & User Journeys](#5-data-flow--user-journeys)
6. [Security Model](#6-security-model)
7. [Database Schema](#7-database-schema)
8. [Lambda Function Inventory](#8-lambda-function-inventory)
9. [Known Gaps & Incomplete Items](#9-known-gaps--incomplete-items)
10. [Future Sprint Architecture Impact](#10-future-sprint-architecture-impact)
11. [Cost Model](#11-cost-model)
12. [Deployment Guide](#12-deployment-guide)
13. [CloudFormation Resource Summary](#13-cloudformation-resource-summary)
14. [Appendix: File Manifest](#14-appendix-file-manifest)

---

## 1. Project Overview

**Jale** is a bilingual (EN/ES) job platform connecting blue-collar workers with employers. Workers authenticate via phone/OTP, employers via email/password. The platform is built on AWS using CDK (TypeScript).

**Current state:** Sprint 1-2 infrastructure is code-complete (compiles, tests pass, CDK synth succeeds) but **not deployed** to AWS.

**Tech stack:**
- **Frontend:** Next.js 14+ (React 18), Tailwind CSS v4, shadcn UI, next-intl
- **Infrastructure as Code:** AWS CDK v2 (TypeScript)
- **Runtime:** Node.js 20.x (Lambda)
- **Database:** PostgreSQL 16 (RDS)
- **Auth:** AWS Cognito (dual pools) with `amazon-cognito-identity-js` on client
- **API:** API Gateway (REST)
- **Bundling:** esbuild

---

## 2. Architecture Decisions Record

Every major architectural decision made during planning, with rationale and alternatives considered.

### ADR-001: Dual Cognito Pools (not single pool)

| | |
|---|---|
| **Decision** | Two separate Cognito User Pools — Worker (phone/OTP) and Employer (email/password) |
| **Rationale** | Workers authenticate via phone/OTP (blue-collar, mobile-first). Employers use email/password (office workers). Mixing these in one pool forces compromises on MFA policy, password policy, and sign-in flows. |
| **Alternative rejected** | Single pool with conditional logic. Would create UX complexity and prevent per-pool MFA enforcement. |
| **Consequence** | Frontend must route to the correct pool. API endpoints that serve both user types (e.g., `/legal/accept`) cannot use a single Cognito Authorizer — requires either two routes or manual JWT validation. |

### ADR-002: VPC Endpoints instead of NAT Gateway

| | |
|---|---|
| **Decision** | Use VPC Interface Endpoints for AWS service access. No NAT Gateway. |
| **Rationale** | Saves ~$32/month. Sprint 1-2 Lambdas only call AWS services (Secrets Manager, SNS, Cognito, S3, CloudWatch) — all reachable via VPC endpoints. |
| **Alternative rejected** | NAT Gateway ($32/mo always-on). Not needed until Twilio/Stripe integration arrives. |
| **Upgrade path** | One-line change: `natGateways: 1` in `network-stack.ts`. No other code changes required. |
| **Risk** | Any Lambda call to an AWS service WITHOUT a VPC endpoint will **silently timeout** (up to 30 seconds). Developers must add the endpoint first. |

### ADR-003: RDS PostgreSQL (not Supabase, not Aurora Serverless)

| | |
|---|---|
| **Decision** | CDK-managed RDS PostgreSQL 16 on `db.t4g.micro` |
| **Rationale** | Full SQL power for complex job matching queries. Predictable cost (~$15/mo). Direct CDK management. Easy to add pgvector later for AI-powered matching. |
| **Alternatives rejected** | **Supabase:** external dependency outside CDK. **Aurora Serverless v2:** higher minimum cost, more CDK complexity. |
| **Consequence** | ~$15/mo always-on cost even in dev. Can be manually stopped to pause billing (auto-restarts after 7 days). |

### ADR-004: Monolithic CDK App with 5 Separated Stacks

| | |
|---|---|
| **Decision** | One CDK app (`infra/`), 5 stacks with cross-stack references via props |
| **Rationale** | Simple. Single `cdk deploy --all`. Type-safe cross-stack refs. Standard pattern for 2-person team. |
| **Alternatives rejected** | **CDK Pipelines:** overkill for Sprint 1, adds ~4 hrs setup. **Separate CDK apps:** complex SSM-based cross-references, no compile-time validation. |
| **Upgrade path** | Wrap existing stacks in a `Stage` class and add a `Pipeline` when multi-environment promotion is needed. No restructuring required. |

### ADR-005: Manual Schema Migration (not Custom Resource)

| | |
|---|---|
| **Decision** | Run initial SQL migration manually via bastion/Query Editor, not a CDK Custom Resource Lambda |
| **Rationale** | Custom Resource Lambdas for DB migration add fragility (timeout, error handling, rollback). For a small team doing infrequent schema changes, manual is simpler. |
| **Access methods** | (1) EC2 bastion with SSM Session Manager, (2) One-time migration Lambda, (3) AWS Console Query Editor |

### ADR-006: Legal Wall as Shared Utility (not Lambda Authorizer)

| | |
|---|---|
| **Decision** | `checkCompliance()` is a TypeScript function imported by Lambda handlers, NOT a Lambda Authorizer |
| **Rationale** | A Lambda Authorizer would replace the free Cognito Authorizer on each route, losing built-in JWT validation. The shared utility keeps Cognito Authorizer AND adds compliance checking in application code. |
| **Trade-off** | Every protected Lambda must explicitly import and call `checkCompliance()`. Forgetting to add it to a new endpoint means no legal wall enforcement. |

### ADR-007: Post-Confirmation Lambda Does Not Block Cognito

| | |
|---|---|
| **Decision** | The post-confirmation Lambda catches all errors and NEVER throws. Cognito confirmation always succeeds. |
| **Rationale** | A failed DB write should not prevent a user from creating their account. Better to have a "ghost account" (Cognito-only) than a failed sign-up. |
| **Mitigation** | DLQ captures infrastructure failures. Profile endpoints return 404 with setup prompt for ghost accounts. |
| **Risk** | DLQ now captures both infrastructure failures (timeout/OOM) AND application errors (the Lambda explicitly pushes to SQS in its catch block). No DLQ consumer/alerting is configured yet. |

### ADR-008: `tenant_id` Added Proactively

| | |
|---|---|
| **Decision** | Added nullable `tenant_id UUID` to the `users` table now, before Org Management ships |
| **Rationale** | Adding a column to a populated table later requires a migration + backfill. Free to add now, costly later. |
| **Usage** | NULL until Org Management sprint. Will be populated when employers create organizations. |

### ADR-009: AWS SNS for OTP (not Twilio)

| | |
|---|---|
| **Decision** | Use AWS SNS sandbox for worker OTP delivery |
| **Rationale** | Simpler for Sprint 1. No external account needed. 10 test phone numbers sufficient for dev. |
| **Limitation** | Sandbox mode: max 10 verified numbers, $1/mo cap. Must upgrade to production access before launch. |
| **Future** | Twilio will be added for WhatsApp (5+ features use it). OTP could migrate to Twilio for unified messaging. |

### ADR-010: CORS Locked to localhost

| | |
|---|---|
| **Decision** | CORS origin set to `http://localhost:3000` (not `*`) |
| **Rationale** | Even in dev, `*` with credentialed requests is a security concern. Browsers block `credentials: include` with `*` anyway. |
| **Action needed** | Parameterize via CDK context for staging/production. |

---

## 3. Current Architecture (Sprint 1-2)

### High-Level Diagram

```
                         ┌─────────────────────────────────────────────────────┐
                         │               AWS Account / Region                  │
                         │                                                     │
                         │  ┌──────────────────────────────────────────────┐   │
                         │  │  VPC (2 AZs, no NAT)                         │   │
                         │  │                                              │   │
                         │  │  ┌───────────────────────────────────────┐   │   │
                         │  │  │ Private Subnets (Lambda)              │   │   │
                         │  │  │                                       │   │   │
                         │  │  │  ┌───────────────────┐                │   │   │
                         │  │  │  │  Lambda Functions │──┐             │   │   │
                         │  │  │  │  (8 handlers)     │  │             │   │   │
                         │  │  │  └───────────────────┘  │             │   │   │
                         │  │  │         │               │             │   │   │
                         │  │  │   VPC Endpoints         │ port        │   │   │
                         │  │  │   ┌──────────┐          │ 5432        │   │   │
                         │  │  │   │SM│SNS│CIP│          │             │   │   │
                         │  │  │   │STS│CWL│S3│          │             │   │   │
                         │  │  │   └──────────┘          │             │   │   │
                         │  │  └─────────────────────────┼─────────────┘   │   │
                         │  │                            │                 │   │
                         │  │  ┌─────────────────────────▼─────────────┐   │   │
                         │  │  │ Isolated Subnets (DB)                 │   │   │
                         │  │  │  ┌──────────────────┐                 │   │   │
                         │  │  │  │ RDS PostgreSQL 16│                 │   │   │
                         │  │  │  │ db.t4g.micro     │                 │   │   │
                         │  │  │  └──────────────────┘                 │   │   │
                         │  │  └───────────────────────────────────────┘   │   │
                         │  └──────────────────────────────────────────────┘   │
                         │                                                     │
  ┌────────┐    HTTPS    │  ┌──────────────────┐   JWT    ┌──────────────┐     │
  │Frontend├────────────►│  │  API Gateway     │◄────────►│ Cognito x2   │     │
  │Next.js │             │  │  REST /dev       │          │ Worker Pool  │     │
  └────────┘             │  │  6 routes        │          │ Employer Pool│     │
                         │  └──────────────────┘          └──────────────┘     │
                         │                                       │             │
                         │                         ┌─────────────┘             │
                         │                         │ OTP via SNS               │
                         │                         ▼                           │
                         │                  ┌──────────────┐                   │
                         │                  │ SNS Sandbox  │                   │
                         │                  │ (10 numbers) │                   │
                         │                  └──────────────┘                   │
                         │                                                     │
                         │  ┌──────────────┐  ┌──────────────────────┐         │
                         │  │ S3 (Legal)   │  │ Secrets Manager      │         │
                         │  │ Versioned    │  │ (DB credentials)     │         │
                         │  └──────────────┘  └──────────────────────┘         │
                         └─────────────────────────────────────────────────────┘
```

### Stack Dependency Chain

```
NetworkStack ─► DatabaseStack ─► AuthStack ─► ApiStack ─► LegalStack
```

Each stack passes references as constructor props, creating implicit CDK dependencies. `cdk deploy --all` deploys in this order automatically.

### API Routes

| Method | Path | Auth | Lambda | Sprint |
|--------|------|------|--------|--------|
| GET | /health | None | health | 1 |
| GET | /worker/profile | Worker Cognito Authorizer | worker-profile | 1 |
| GET | /employer/profile | Employer Cognito Authorizer | employer-profile | 1 |
| POST | /auth/refresh | None (refresh token is the credential) | token-refresh | 1 |
| POST | /auth/logout | None (user may have expired access token) | logout | 1 |
| GET | /legal/tos | None (public, rate-limited 10 rps / 20 burst) | get-tos | 2 |
| POST | /legal/accept | Dual Cognito Authorizer (Worker + Employer) | accept-tos | 2 |

All 7 routes include CORS OPTIONS preflight handlers. API Gateway default 4xx/5xx responses include CORS headers.

---

## 4. Stack-by-Stack Breakdown

### NetworkStack (`lib/stacks/network-stack.ts`)

**Purpose:** Shared VPC and network infrastructure for all other stacks.

**27 CloudFormation resources** (from `cdk diff`):

| Resource | Type | CFN Logical ID | Details |
|----------|------|----------------|---------|
| VPC | `ec2.Vpc` | `Vpc8378EB38` | 10.0.0.0/16, 2 AZs, 0 NAT Gateways |
| Private Subnets (x2) | `ec2.Subnet` | `VpcPrivateSubnet1Subnet536B997A`, `VpcPrivateSubnet2Subnet3788AAA1` | /24 CIDR, PRIVATE_WITH_EGRESS (but no egress route without NAT) |
| Isolated Subnets (x2) | `ec2.Subnet` | `VpcIsolatedSubnet1SubnetE48C5737`, `VpcIsolatedSubnet2Subnet16364B91` | /24 CIDR, PRIVATE_ISOLATED |
| Route Tables (x4) | `ec2.RouteTable` | Per-subnet route tables | One per subnet, with subnet associations |
| Internet Gateway | `ec2.InternetGateway` | `VpcIGWD7BA715C` | Attached to VPC (required by CDK, unused without NAT) |
| Lambda SG | `ec2.SecurityGroup` | `LambdaSg30A6108C` | Inbound: TCP 443 from VPC CIDR. Outbound: all traffic |
| RDS SG | `ec2.SecurityGroup` | `RdsSg7F9F43B6` | Inbound: TCP 5432 from Lambda SG only. Outbound: ICMP only (default deny) |
| Secrets Manager Endpoint | `InterfaceVpcEndpoint` | `VpcSecretsManagerEndpoint93E49F69` | Lambda fetches DB credentials |
| SNS Endpoint | `InterfaceVpcEndpoint` | `VpcSnsEndpointF2594FD7` | Cognito sends OTP |
| Cognito IDP Endpoint | `InterfaceVpcEndpoint` | `VpcCognitoIdpEndpointF0FEF4F2` | Token refresh/logout Lambdas call Cognito |
| STS Endpoint | `InterfaceVpcEndpoint` | `VpcStsEndpointF89E8173` | Lambda role assumption |
| CloudWatch Logs Endpoint | `InterfaceVpcEndpoint` | `VpcCloudWatchLogsEndpointA6195533` | Lambda logging |
| SQS Endpoint | `InterfaceVpcEndpoint` | `VpcSqsEndpointF1A4587A` | Post-confirmation DLQ push |
| S3 Gateway Endpoint | `GatewayVpcEndpoint` | `VpcS3Endpoint4A3DE4B5` | Free. Legal Lambdas read ToS from S3 |
| VPC Restrict Default SG | Custom Resource | `VpcRestrictDefaultSecurityGroupCustomResourceC73DA2BE` | CDK auto-restricts the default SG (removes all ingress/egress) |

**Security Group Rules** (from `cdk diff`):

| SG | Direction | Protocol | Peer |
|----|-----------|----------|------|
| LambdaSg | Inbound | TCP 443 | VPC CIDR block |
| LambdaSg | Outbound | All traffic | 0.0.0.0/0 |
| RdsSg | Inbound | TCP 5432 | LambdaSg only |
| RdsSg | Outbound | ICMP 252-86 | 255.255.255.255/32 (effective deny-all) |

> **Side note:** The `PRIVATE_WITH_EGRESS` subnet type label is misleading with `natGateways: 0`. These subnets have no actual egress route and behave identically to isolated subnets from a routing perspective. CDK does not enforce this consistency.

### DatabaseStack (`lib/stacks/database-stack.ts`)

**Purpose:** Stateful database layer, deployed rarely.

**4 CloudFormation resources** (from `cdk diff`):

| Resource | Type | CFN Logical ID | Details |
|----------|------|----------------|---------|
| DB Subnet Group | `rds.SubnetGroup` | `SubnetGroup` | Placed in isolated subnets (2 AZs) |
| DB Secret | `secretsmanager.Secret` | `JaleDatabaseStackDatabaseSecret89088DC3...` | Auto-generated credentials (user: `jale_admin`) |
| Secret Attachment | `secretsmanager.SecretTargetAttachment` | `DatabaseSecretAttachmentE5D1B020` | Binds secret to RDS instance (adds host/port) |
| RDS Instance | `rds.DatabaseInstance` | `DatabaseB269D8BB` | PostgreSQL 16, db.t4g.micro, encrypted storage |

**Configuration:** 7-day backup retention, single-AZ (`multiAz: false`), deletion protection off (`deletionProtection: false` in dev), RemovalPolicy.DESTROY (dev). Database name: `jale`.

**Cross-stack output:** Exports `DatabaseSecretAttachmentE5D1B020` ARN. All downstream stacks import this to grant `secretsmanager:GetSecretValue`.

**Cross-stack input:** Takes entire `NetworkStack` as prop, destructures `vpc`, `isolatedSubnets`, `rdsSg`.

### AuthStack (`lib/stacks/auth-stack.ts`)

**Purpose:** Dual Cognito authentication with database sync.

**18 CloudFormation resources** (from `cdk diff`):

| Resource | Type | CFN Logical ID | Details |
|----------|------|----------------|---------|
| Post-Confirmation DLQ | `sqs.Queue` | `PostConfirmationDlq041C62BA` | `jale-post-confirmation-dlq`, KMS-managed encryption |
| Post-Confirmation Log Group | `logs.LogGroup` | `PostConfirmationLambdaLogGroupEBF6194F` | 1-month retention |
| Post-Confirmation Lambda | `lambda.Function` | `PostConfirmationLambdaFunctionEFA0ABE6` | Syncs Cognito users to RDS, assigns groups |
| Post-Confirmation EventInvokeConfig | `lambda.EventInvokeConfig` | `PostConfirmationLambdaFunctionEventInvokeConfigB6D83F16` | retryAttempts: 0, maxEventAge: 1h, DLQ target |
| SMS IAM Role | `iam.Role` | `WorkerPoolSmsRole5F9140F7` | Trust: `cognito-idp.amazonaws.com` with ExternalId `jale-worker-sms` |
| Worker Pool | `cognito.UserPool` | `WorkerPoolUserPool2D371121` | Phone/OTP sign-in, MFA required |
| Worker Pool Domain | `cognito.UserPoolDomain` | `WorkerPoolUserPoolCognitoDomain4BCC7152` | `jale-worker-pool` prefix |
| Worker Pool Client | `cognito.UserPoolClient` | `WorkerPoolUserPoolClientA51DF4B1` | `generateSecret: false` |
| Employer Pool | `cognito.UserPool` | `EmployerPoolUserPoolD73D395B` | Email/password sign-in, MFA optional |
| Employer Pool Domain | `cognito.UserPoolDomain` | `EmployerPoolUserPoolCognitoDomainF55803F2` | `jale-employer-pool` prefix |
| Employer Pool Client | `cognito.UserPoolClient` | `EmployerPoolUserPoolClient5519D164` | `generateSecret: false` |
| Workers Group | `cognito.CfnUserPoolGroup` | `WorkerGroup` | Precedence 1, assigned by post-confirmation Lambda |
| Employers Group | `cognito.CfnUserPoolGroup` | `EmployerGroup` | Precedence 1, assigned by post-confirmation Lambda |
| Lambda Permissions (x2) | `lambda.Permission` | Per-pool | Allows each Cognito pool to invoke the post-confirmation Lambda |

**Worker Pool config:**
- Sign-in: `phone_number` | MFA: REQUIRED (SMS) | Password: min 12, digits required
- Auth flows: `USER_SRP_AUTH`, `CUSTOM_AUTH` | `generateSecret: false`
- Custom attribute: `custom:user_type` (immutable)
- Self sign-up: enabled | Auto-verify: phone

**Employer Pool config:**
- Sign-in: `email` | MFA: OPTIONAL (TOTP only, no SMS) | Password: 8+ chars, upper + lower + digit + symbol
- Auth flows: `USER_SRP_AUTH` | `generateSecret: false`
- Custom attributes: `custom:user_type` (immutable), `custom:company_name` (mutable)
- Self sign-up: enabled | Auto-verify: email

**IAM Permissions** (from `cdk diff`):

| Principal | Action | Resource |
|-----------|--------|----------|
| Post-Confirmation Lambda | `sqs:SendMessage`, `sqs:GetQueueUrl`, `sqs:GetQueueAttributes` | DLQ ARN |
| Post-Confirmation Lambda | `secretsmanager:GetSecretValue`, `secretsmanager:DescribeSecret` | DB Secret ARN (imported from DatabaseStack) |
| Post-Confirmation Lambda | `cognito-idp:AdminAddUserToGroup` | `arn:aws:cognito-idp:us-east-2:<ACCOUNT>:userpool/*` |
| Post-Confirmation Lambda | `xray:PutTraceSegments`, `xray:PutTelemetryRecords` | `*` (X-Ray standard) |
| SMS Role | `sns:Publish` | `arn:aws:sns:us-east-2:<ACCOUNT>:*` (scoped to region/account) |

### ApiStack (`lib/stacks/api-stack.ts`)

**Purpose:** REST API with dual JWT authorization.

**68 CloudFormation resources** (from `cdk diff`) — the largest stack, includes all API routes and Lambda integrations.

| Resource | Type | CFN Logical ID | Details |
|----------|------|----------------|---------|
| Access Log Group | `logs.LogGroup` | `ApiAccessLogsE9DF007D` | `/aws/apigateway/jale-api`, 30-day retention |
| REST API | `apigateway.RestApi` | `JaleApiD52B6ED0` | `jale-api`, stage `dev`, CORS: localhost:3000 |
| Deployment | `apigateway.Deployment` | `JaleApiDeploymentC8A4CC9B...` | Immutable snapshot of API config |
| Stage (dev) | `apigateway.Stage` | `JaleApiDeploymentStagedev3A47EC3A` | JSON access logging, throttling |
| Gateway Response (4xx) | `apigateway.GatewayResponse` | `JaleApiDefault4xx827E333E` | CORS headers on auth failures |
| Gateway Response (5xx) | `apigateway.GatewayResponse` | `JaleApiDefault5xxCD90DF45` | CORS headers on server errors |
| Worker Authorizer | `apigateway.Authorizer` | `WorkerAuthorizerDA8289AC` | Validates JWTs from Worker pool |
| Employer Authorizer | `apigateway.Authorizer` | `EmployerAuthorizerAAB9B5A6` | Validates JWTs from Employer pool |
| Dual Authorizer | `apigateway.Authorizer` | `DualAuthorizerF4AD9336` | Validates JWTs from both pools (shared with LegalStack) |
| Health Lambda | `lambda.Function` | `HealthLambdaFunction10C74720` | No DB access, no auth |
| Worker Profile Lambda | `lambda.Function` | `WorkerProfileLambdaFunctionF39E40BB` | DB access, Worker auth, legal wall |
| Employer Profile Lambda | `lambda.Function` | `EmployerProfileLambdaFunction70A5A6A6` | DB access, Employer auth, legal wall |
| Token Refresh Lambda | `lambda.Function` | `TokenRefreshLambdaFunction23DED25B` | Cognito InitiateAuth, no auth/DB |
| Logout Lambda | `lambda.Function` | `LogoutLambdaFunctionC30AF661` | Cognito GlobalSignOut + RevokeToken |
| API Resources (x7) | `apigateway.Resource` | Per-path | `/health`, `/worker`, `/worker/profile`, `/employer`, `/employer/profile`, `/auth`, `/auth/refresh`, `/auth/logout`, `/legal`, `/legal/tos`, `/legal/accept` |
| Methods (x7 + OPTIONS) | `apigateway.Method` | Per-route | Each route has a method + OPTIONS preflight |
| Lambda Permissions (x14) | `lambda.Permission` | Per-route | API Gateway invoke permissions (stage + test-invoke) |

**Throttling:** 100 burst / 50 sustained requests/second (stage-level). GET /legal/tos additionally limited to 20 burst / 10 rps (method-level).

**IAM Permissions** (from `cdk diff`):

| Principal | Action | Resource |
|-----------|--------|----------|
| Worker Profile Lambda | `secretsmanager:GetSecretValue`, `secretsmanager:DescribeSecret` | DB Secret ARN |
| Employer Profile Lambda | `secretsmanager:GetSecretValue`, `secretsmanager:DescribeSecret` | DB Secret ARN |
| Token Refresh Lambda | `cognito-idp:InitiateAuth` | Worker Pool ARN, Employer Pool ARN |
| Logout Lambda | `cognito-idp:GlobalSignOut`, `cognito-idp:RevokeToken` | Worker Pool ARN, Employer Pool ARN |
| All 5 Lambdas | `xray:PutTraceSegments`, `xray:PutTelemetryRecords` | `*` (X-Ray standard) |

**Cross-stack outputs:** Exports `JaleApiD52B6ED0` (API ID), `JaleApiDeploymentStagedev3A47EC3A` (stage), `DualAuthorizerF4AD9336` (authorizer). LegalStack imports these to add routes.

> **Side note:** Worker and employer profile Lambdas are near-identical code. They could be a single Lambda with a path parameter.

### LegalStack (`lib/stacks/legal-stack.ts`)

**Purpose:** Legal compliance (ToS/Privacy Policy) with versioned document storage.

**13 CloudFormation resources** (from `cdk diff`):

| Resource | Type | CFN Logical ID | Details |
|----------|------|----------------|---------|
| S3 Bucket | `s3.Bucket` | `LegalDocsBucket2B4D0628` | `jale-legal-docs-<ACCOUNT>`, versioned, SSE-S3, block all public access |
| S3 Bucket Policy | `s3.BucketPolicy` | `LegalDocsBucketPolicyCF910B47` | Enforces SSL transport, allows auto-delete |
| Auto-Delete Custom Resource | Custom Resource | `LegalDocsBucketAutoDeleteObjectsCustomResourceF620BF25` | Empties bucket on `cdk destroy` (dev only) |
| Get-ToS Lambda | `lambda.Function` | `GetTosLambdaFunction8E1E5A12` | Generates presigned URLs (1-hour TTL) |
| Accept-ToS Lambda | `lambda.Function` | `AcceptTosLambdaFunction9B28806C` | Records acceptance in DB + audit log |
| Log Groups (x2) | `logs.LogGroup` | Per-Lambda | 1-month retention |
| IAM Roles (x2) | `iam.Role` | Per-Lambda | VPC execution + basic execution |

**Routes added to ApiStack's API Gateway:**
- `GET /legal/tos` — public, returns presigned URLs for tos.md and privacy-policy.md. Rate-limited to 10 rps / 20 burst.
- `POST /legal/accept` — protected by dual Cognito authorizer (`AuthorizationType.COGNITO`)

**IAM Permissions** (from `cdk diff`):

| Principal | Action | Resource |
|-----------|--------|----------|
| Get-ToS Lambda | `s3:GetObject*`, `s3:GetBucket*`, `s3:List*` | Legal docs bucket ARN |
| Accept-ToS Lambda | `secretsmanager:GetSecretValue`, `secretsmanager:DescribeSecret` | DB Secret ARN |
| Both Lambdas | `xray:PutTraceSegments`, `xray:PutTelemetryRecords` | `*` (X-Ray standard) |

**Cross-stack outputs:** Exports both Lambda ARNs so ApiStack can create invoke permissions for the routes.

### 4.6 Frontend Component Layer (`frontend/`)

**Purpose:** Provides a bilingual interface for Workers and Employers, handling identity directly via Cognito and data fetching via the APIGateway.

**Core Structure:**
- `src/app/[locale]/`: Next.js App Router providing localized routing via `next-intl`
- `src/components/`: UI layer containing `auth`, `legal`, `layout`, and general `ui` (shadcn) components
- `src/contexts/AuthContext.tsx`: Client-side identity management React Context
- `src/lib/cognito.ts` and `src/lib/api.ts`: API and Authentication abstractions

**Auth Strategy:** The frontend utilizes `amazon-cognito-identity-js` directly to manage SRP/Custom Auth flows. User tokens are securely managed in memory and locally for session continuity, skipping Next.js server-side auth (like next-auth) to ensure the App acts as a true REST client relative to the backend.

---

## 5. Data Flow & User Journeys

### Worker Sign-Up (Phone/OTP)

```
1. Client → Cognito (Worker Pool): SignUp(phone, password, custom:user_type="worker")
2. Cognito → SNS (via VPC Endpoint) → Phone: OTP SMS
3. Client → Cognito: ConfirmSignUp(phone, OTP code)
4. Cognito triggers → Post-Confirmation Lambda
5. Lambda → Secrets Manager (via VPC Endpoint): GetSecretValue (cached across warm starts)
6. Lambda → RDS (port 5432 via VPC): INSERT INTO users ... ON CONFLICT DO NOTHING
7. Lambda returns event to Cognito (confirmation succeeds regardless of DB outcome)
8. Client receives JWT tokens (access, id, refresh)
```

**Failure mode:** If step 6 fails, user exists in Cognito but not in the database ("ghost account"). DLQ captures the event for replay. Profile endpoints return 404.

### Employer Sign-Up (Email/Password)

```
1. Client → Cognito (Employer Pool): SignUp(email, password, custom:user_type="employer")
2. Cognito → SES/built-in: Verification email with code
3. Client → Cognito: ConfirmSignUp(email, verification code)
4-8. Same as worker flow (shared post-confirmation Lambda)
```

### Profile Fetch

```
1. Client (Next.js AuthContext) attaches token → API Gateway: GET /worker/profile, Authorization: Bearer <accessToken>
2. API Gateway → Worker Cognito Authorizer: Validate JWT signature against JWKS
3. If valid → invoke Worker Profile Lambda
4. Lambda extracts cognito_sub from event.requestContext.authorizer.claims.sub
5. Lambda → Secrets Manager (cached) → RDS: SELECT * FROM users WHERE cognito_sub = $1
6. If found → 200 { id, user_type, email, phone, full_name, ... }
7. If not found → 404 { error: "profile_not_found", message: "Please complete profile setup" }
```

### ToS Acceptance

```
1. Client → API Gateway: POST /legal/accept, Authorization: Bearer <token>, Body: { tosVersion }
2. API Gateway → Dual Cognito Authorizer: Validates JWT against both Worker + Employer pools
3. Lambda extracts cognitoSub from event.requestContext.authorizer.claims.sub
4. Lambda validates tosVersion matches REQUIRED_TOS_VERSION server-side
5. Lambda → Secrets Manager → RDS (transaction with RLS):
   BEGIN
     setRlsContext(client, cognitoSub)
     UPDATE users SET tos_version, tos_accepted_at, privacy_version, privacy_accepted_at
     INSERT INTO legal_consent_log (tos entry with IP + user_agent)
     INSERT INTO legal_consent_log (privacy_policy entry with IP + user_agent)
   COMMIT
6. Returns 200 { accepted: true, version: "1.0" }
```

### Token Refresh

```
1. Client → API Gateway: POST /auth/refresh, Body: { refreshToken, userType }
2. Lambda selects CLIENT_ID based on userType (WORKER_CLIENT_ID or EMPLOYER_CLIENT_ID)
3. Lambda → Cognito (via VPC Endpoint): InitiateAuth(REFRESH_TOKEN_AUTH)
4. Returns 200 { accessToken, idToken, expiresIn }
```

### Logout

```
1. Client → API Gateway: POST /auth/logout, Body: { accessToken, refreshToken, userType }
2. Lambda validates userType ∈ ['worker', 'employer'] — returns 400 if invalid
3. Lambda → Cognito: GlobalSignOut(accessToken) — invalidates ALL sessions
4. Lambda → Cognito: RevokeToken(refreshToken, clientId) — revokes specific refresh token
5. If at least one succeeds → 200 { loggedOut: true }
6. If BOTH fail → 500 { error: "logout_failed" } (user is NOT logged out)
```

---

## 6. Security Model

### Network Security

| Layer | Control | Details |
|-------|---------|---------|
| VPC | No NAT Gateway | Lambdas cannot reach the public internet. All traffic via VPC endpoints. |
| RDS SG | Inbound whitelist | Only accepts connections from Lambda SG on port 5432 |
| Lambda SG | Outbound only | No inbound rules needed (invocation-based) |
| VPC Endpoints | Private DNS | Traffic stays within AWS network, never traverses internet |
| S3 | Block all public access | Documents served via presigned URLs only |

### Authentication & Authorization

| Endpoint | Auth Method | JWT Verification |
|----------|------------|-----------------|
| GET /health | None | N/A |
| GET /worker/profile | Cognito Authorizer (Worker) | Server-side, JWKS signature check by API Gateway |
| GET /employer/profile | Cognito Authorizer (Employer) | Server-side, JWKS signature check by API Gateway |
| POST /auth/refresh | None | Refresh token is the credential (Cognito validates it) |
| POST /auth/logout | None | Access token passed in body (user may have expired JWT) |
| GET /legal/tos | None (public) | N/A — rate-limited to 10 rps / 20 burst |
| POST /legal/accept | Dual Cognito Authorizer | Server-side, JWKS check against both Worker + Employer pools |

### IAM Grants (Complete, from `cdk diff`)

| Lambda | Permission | Target | Scope |
|--------|-----------|--------|-------|
| post-confirmation | `secretsmanager:GetSecretValue`, `DescribeSecret` | DB secret ARN | Specific ARN |
| post-confirmation | `cognito-idp:AdminAddUserToGroup` | `arn:aws:cognito-idp:<REGION>:<ACCOUNT>:userpool/*` | All pools in account (CDK circular dep workaround) |
| post-confirmation | `sqs:SendMessage`, `GetQueueUrl`, `GetQueueAttributes` | DLQ ARN | Specific ARN |
| worker-profile | `secretsmanager:GetSecretValue`, `DescribeSecret` | DB secret ARN | Specific ARN |
| employer-profile | `secretsmanager:GetSecretValue`, `DescribeSecret` | DB secret ARN | Specific ARN |
| token-refresh | `cognito-idp:InitiateAuth` | Worker Pool ARN, Employer Pool ARN | Specific ARNs |
| logout | `cognito-idp:GlobalSignOut`, `RevokeToken` | Worker Pool ARN, Employer Pool ARN | Specific ARNs |
| accept-tos | `secretsmanager:GetSecretValue`, `DescribeSecret` | DB secret ARN | Specific ARN |
| get-tos | `s3:GetObject*`, `GetBucket*`, `List*` | Legal docs bucket ARN | Specific ARN |
| SMS Role (Cognito) | `sns:Publish` | `arn:aws:sns:<REGION>:<ACCOUNT>:*` | Scoped to region/account |
| All Lambdas (x8) | `xray:PutTraceSegments`, `PutTelemetryRecords` | `*` | X-Ray standard (cannot be scoped) |

> **Side note:** All DB-accessing Lambdas use the same `jale_admin` credential with full privileges. There is no least-privilege separation (e.g., read-only role for profile fetches). This should be addressed before production.

### Known Security Gaps

1. ~~**`POST /legal/accept`** has no server-side JWT verification.~~ **FIXED** — Protected by dual Cognito authorizer.
2. ~~**SSL connection to RDS** uses `rejectUnauthorized: false`.~~ **FIXED** — Changed to `rejectUnauthorized: true` in `db.ts`.
3. ~~**No connection pooling.**~~ **FIXED** — `pg.Pool` with `max: 1` reuses connections per warm container. RDS Proxy recommended for production scaling.
4. **All Lambdas use same DB admin credential** — No least-privilege role separation. Pre-production fix needed.

---

## 7. Database Schema

### Canonical Matching Inputs

The readiness baseline for Job Matching Engine V1 is migrations `001` through `008`. These migrations are the canonical source for table shape until later matching migrations are applied.

| Matching field | Canonical source | Notes |
|---|---|---|
| `skills` | `worker_skills` table | Normalized rows keyed by `(worker_id, skill)` with a trigram GIN index for matching search. |
| `years_experience` | `worker_profiles.years_experience INTEGER` | Matching input. `users.years_experience` remains a display/onboarding enum. |
| `availability` | `worker_profiles.availability` | `worker_profiles.availability is the canonical matching source`; `users.availability is legacy/display data`. |
| `trade` | `users.main_trade` | Populated by WhatsApp onboarding and profile flows. |
| `seniority` | `users.trust_signals JSONB` | Trust-signal taxonomy is stored as JSONB until a later scoring contract hardens it. |
| `document_readiness` | Derived from `worker_documents` | Readiness is computed from uploaded document rows, not stored as a worker profile field. |
| `required_docs` | `jobs.required_docs TEXT[]` | Employer-side document requirements added by migration `005`. |

The intentional type split is:

- `users.years_experience` is a text enum (`0-1`, `2-4`, `5-9`, `10+`) used by onboarding/display.
- `worker_profiles.years_experience INTEGER` is the numeric matching input, normalized by API/WhatsApp writers.

The intentional availability split is:

- `users.availability` is legacy/display data from onboarding.
- `worker_profiles.availability` is the matching source of truth and uses `full_time | part_time | weekends | flexible`.

### Baseline Table Reference

| Table | Canonical columns after migration `007` |
|---|---|
| `users` | `id UUID PK`, `cognito_sub TEXT UNIQUE`, `user_type TEXT`, `email TEXT`, `phone TEXT`, `full_name TEXT`, `tenant_id UUID`, legal acceptance columns, `whatsapp_number VARCHAR(20)`, `whatsapp_linked_at TIMESTAMPTZ`, `city TEXT`, `main_trade TEXT`, `main_trade_other TEXT`, `years_experience TEXT`, `has_transportation BOOLEAN`, `availability TEXT`, `trust_signals JSONB`, `trust_signals_completed_at TIMESTAMPTZ`, timestamps |
| `worker_profiles` | `user_id UUID PK/FK users(id)`, `full_name TEXT`, `phone TEXT`, `availability TEXT`, `years_experience INTEGER`, `location TEXT`, `bio TEXT`, `updated_at TIMESTAMPTZ` |
| `worker_skills` | `worker_id UUID FK users(id)`, `skill TEXT`, `created_at TIMESTAMPTZ`, primary key `(worker_id, skill)`, GIN trigram index on `skill` |
| `jobs` | `id UUID PK`, `employer_id UUID FK users(id)`, `title TEXT`, `company TEXT`, `location TEXT`, `pay TEXT`, `job_type TEXT`, `description TEXT`, `status TEXT`, `required_docs TEXT[]`, timestamps |
| `job_applications` | `id UUID PK`, `job_id UUID FK jobs(id)`, `worker_id UUID FK users(id)`, `status TEXT`, `applied_at TIMESTAMPTZ`, timestamps, unique `(job_id, worker_id)` |
| `worker_documents` | `id UUID PK`, `worker_id UUID FK users(id)`, nullable `job_id UUID FK jobs(id)`, `doc_type TEXT`, `s3_key TEXT`, `file_name TEXT`, `file_size INTEGER`, `mime_type TEXT`, `uploaded_at TIMESTAMPTZ`; unique vault/per-job partial indexes |

### `users` Table (Sprint 1)

```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cognito_sub VARCHAR(255) UNIQUE NOT NULL,
    user_type VARCHAR(20) NOT NULL CHECK (user_type IN ('worker', 'employer')),
    tenant_id UUID,                    -- nullable; for future Org Management
    email VARCHAR(255),
    phone VARCHAR(20),
    full_name VARCHAR(255),
    tos_version VARCHAR(50),           -- Sprint 2: legal compliance
    tos_accepted_at TIMESTAMPTZ,
    privacy_version VARCHAR(50),
    privacy_accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_users_cognito_sub ON users(cognito_sub);
CREATE INDEX idx_users_user_type ON users(user_type);
CREATE INDEX idx_users_tenant ON users(tenant_id) WHERE tenant_id IS NOT NULL;

-- Auto-update trigger
CREATE TRIGGER set_timestamp
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE PROCEDURE trigger_set_timestamp();
```

### `legal_consent_log` Table (Sprint 2)

```sql
CREATE TABLE legal_consent_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    document_type VARCHAR(50) NOT NULL,    -- 'tos' or 'privacy_policy'
    document_version VARCHAR(50) NOT NULL,
    accepted_at TIMESTAMPTZ DEFAULT NOW(),
    ip_address INET,
    user_agent TEXT
);

CREATE INDEX idx_consent_user ON legal_consent_log(user_id);
CREATE INDEX idx_consent_version ON legal_consent_log(document_version, accepted_at);
```

---

## 8. Lambda Function Inventory

### All Lambda Functions (8 handlers)

| Lambda | File | Trigger | VPC | DB | Bundle Size | Key IAM |
|--------|------|---------|-----|----|-------------|---------|
| post-confirmation | `lambda/post-confirmation/index.ts` | Cognito PostConfirmation | Yes | Write | 175.9 KB | Secrets Manager, Cognito, SQS |
| health | `lambda/api/health.ts` | API Gateway GET /health | Yes | No | 1.6 KB | None |
| worker-profile | `lambda/api/worker-profile.ts` | API Gateway GET /worker/profile | Yes | Read | 174.8 KB | Secrets Manager |
| employer-profile | `lambda/api/employer-profile.ts` | API Gateway GET /employer/profile | Yes | Read | 174.8 KB | Secrets Manager |
| token-refresh | `lambda/auth/token-refresh.ts` | API Gateway POST /auth/refresh | Yes | No | 3.3 KB | Cognito (InitiateAuth) |
| logout | `lambda/auth/logout.ts` | API Gateway POST /auth/logout | Yes | No | 3.8 KB | Cognito (GlobalSignOut, RevokeToken) |
| get-tos | `lambda/legal/get-tos.ts` | API Gateway GET /legal/tos | Yes | No | 2.8 KB | S3 Read |
| accept-tos | `lambda/legal/accept-tos.ts` | API Gateway POST /legal/accept | Yes | Write | 175.3 KB | Secrets Manager |

### Shared Utilities (Not Lambda Handlers)

| Module | File | Purpose | Used By |
|--------|------|---------|---------|
| checkCompliance | `lambda/legal/check-compliance.ts` | Verifies ToS acceptance inside RLS transaction | worker-profile, employer-profile |
| getDbPool | `lambda/lib/db.ts` | pg.Pool singleton (max:1), Secrets Manager caching (5m TTL) | All DB-accessing Lambdas |
| corsHeaders | `lambda/lib/http.ts` | Shared CORS headers, `VALID_USER_TYPES`, `errorMessage()` | All API Lambdas |

**All Lambdas:** Node.js 20.x, 256 MB memory, 30s timeout, X-Ray active tracing, esbuild bundling (`@aws-sdk/*` excluded — runtime-provided).

---

## 9. Known Gaps & Incomplete Items

> **Last audit:** 2026-03-26. Items marked !! RESOLVED have been fixed in code. Remaining items are tracked below.

### Resolved (Fixed in Sprint 1-2 Implementation)

| # | Original Gap | Resolution |
|---|-------------|------------|
| 1 | `POST /legal/accept` has no auth | !! Protected by dual Cognito authorizer in `legal-stack.ts` |
| 2 | Token refresh & logout not wired | !! Both wired as POST /auth/refresh and POST /auth/logout in `api-stack.ts` |
| 3 | `checkCompliance` is dead code | !! Imported and called by both profile handlers inside RLS transactions |
| 4 | DLQ is partially inert | !! Post-confirmation Lambda explicitly pushes failed events to SQS DLQ |
| 5 | No DB connection pooling | !! `pg.Pool` with `max: 1` reuses connections per warm container |
| 8 | Employer MFA is OFF | !! Set to `cognito.Mfa.OPTIONAL` (employers can opt into TOTP) |
| 9 | Employer `custom:user_type` is mutable | !! Set to `mutable: false` in `auth-stack.ts` |
| 10 | CORS hardcoded to localhost | !! Parameterized via `tryGetContext('allowedOrigin')` in all stacks |

### Remaining — Critical (Must Fix Before Production)

| # | Gap | Impact | Fix |
|---|-----|--------|-----|
| 6 | **All Lambdas use admin DB credential** | No least-privilege separation | Create read-only and write roles in PostgreSQL, separate Secrets Manager entries |
| — | **No RDS Proxy** | db.t4g.micro supports ~85 connections; burst traffic can exhaust limit | Add RDS Proxy in DatabaseStack |

### Recently Fixed (Sprint 1-2 Security Audit)

| Gap | Resolution |
|-----|------------|
| `ssl: { rejectUnauthorized: false }` | !! Changed to `rejectUnauthorized: true` in `db.ts` |
| Token refresh & logout missing IAM permissions | !! Added `addToRolePolicy()` in `api-stack.ts`, scoped to pool ARNs |
| SNS policy `resources: '*'` | !! Scoped to `arn:aws:sns:<REGION>:<ACCOUNT>:*` |
| Cognito `AdminAddUserToGroup` `resources: '*'` | !! Scoped to `arn:aws:cognito-idp:<REGION>:<ACCOUNT>:userpool/*` |
| Logout returns 200 even when both operations fail | !! Now returns 500 when both GlobalSignOut and RevokeToken fail |
| DLQ messages contain full user PII | !! `userAttributes` removed from DLQ message bodies |
| `userType` not validated at runtime | !! Enum validation added in token-refresh and logout handlers |
| `event: any` type unsafety | !! All handlers now use `APIGatewayProxyEvent`/`PostConfirmationTriggerEvent` |
| Full error objects logged to CloudWatch | !! Sanitized via shared `errorMessage()` utility |
| CORS headers duplicated in auth handlers | !! Consolidated to shared `corsHeaders()` utility |
| No rate limiting on GET /legal/tos | !! Per-method throttle: 10 rps / 20 burst |

### Remaining — Minor

| # | Gap | Details |
|---|-----|---------|
| 11 | Worker & Employer profile Lambdas are duplicate code | Could be a single handler |
| 12 | No API Gateway request validation | Malformed payloads reach Lambda |
| 14 | `checkCompliance` uses strict string equality for version | No semantic version comparison; minor ToS updates force re-acceptance |

---

## 10. Future Sprint Architecture Impact

### Infrastructure Changes Per Feature

#### Foundational Features (Not Yet Built)

| Feature | New AWS Services | New Stack | DB Changes | Third-Party | Est. Cost |
|---------|-----------------|-----------|------------|-------------|-----------|
| **RBAC** | Cognito Groups, RDS row-level policies | Extend AuthStack | Row-level policies | None | $0 |
| **Org Management** | SES (invites) | Extend AuthStack | `organizations` table, `org_members` join table | None | ~$1/mo |
| **Billing** | EventBridge, SES | BillingStack (new) | `subscriptions` table | **Stripe** | Stripe 2.9% + $0.30/txn |
| **Notifications** | SES, SQS | NotificationStack (new) | `notification_preferences`, `notification_log` | **Twilio WhatsApp** | ~$50-250/mo |
| **Admin Panel** | Amplify, CloudFront, Cognito (admin pool) | AdminStack (new) | `admin_audit_log` | None | ~$60-80/mo |

#### Core MVP Features

| Feature | New AWS Services | New Stack | DB Changes | Third-Party | Est. Cost |
|---------|-----------------|-----------|------------|-------------|-----------|
| **Conversational Onboarding** | Lex v2, ElastiCache Redis, DynamoDB | LexStack (new) | DynamoDB `onboarding_sessions` | Twilio WhatsApp | ~$20/mo (Redis) |
| **AI Voice Resume** | MediaConvert, Transcribe, Bedrock | AIStack (new) | Extended `users` (voice columns) | Twilio Media API | ~$1-5/resume |
| **Resume AI Parsing** | Textract, Bedrock | Extend AIStack | Extended `users` (skills columns) | None | ~$0.02-5/resume |
| **WhatsApp Job Alerts** | EventBridge, SQS | JobsStack (new) | `jobs`, `job_alerts_sent`, `job_responses` | Twilio | Variable |
| **Bilingual UI** | AWS Translate, Amplify | CI/CD only | None | None | ~$1-2/mo |
| **Employer Dashboard** | AppSync (GraphQL), Amplify | DashboardStack (new) | `applicants`, `job_attachments` | None | ~$50-80/mo |
| **TWC Pipeline** | Step Functions, SES | Extend AuthStack | `twc_referrals`, `twc_compliance_log` | TWC API | ~$1/mo |

#### Innovative Features

| Feature | New AWS Services | New Stack | DB Changes | Third-Party | Est. Cost |
|---------|-----------------|-----------|------------|-------------|-----------|
| **Gas Money Calc** | Location Service | Extend JobsStack | Extended `jobs` (commute columns) | Google Maps (fallback) | ~$1/mo |
| **Video Audition** | MediaConvert, Rekognition, CloudFront | Extend AIStack | Extended `users` (video columns) | Twilio Media | ~$0.3/video |
| **Instant-Pay Wallet** | DynamoDB + Streams, Step Functions, CloudTrail | PaymentStack (new) | DynamoDB `wallet_ledger` | **Stripe Connect, Plaid** | Stripe 2% + $0.25/payout |
| **Smart-Standby Dispatch** | Location Service (geofencing), EventBridge | DispatchStack (new) | `emergency_jobs`, `dispatch_logs` | Twilio | ~$30/mo |
| **Neighbor Referrals** | DynamoDB, Step Functions, CloudFront | ReferralStack (new) | DynamoDB `referral_graph` | Stripe Connect | Stripe 2%/payout |

### Key Infrastructure Milestones

1. **Add NAT Gateway** — Required when ANY feature needs Twilio, Stripe, or external APIs. One-line change: `natGateways: 1`. Adds ~$32/mo.
2. **Add ElastiCache Redis** — Required by Conversational Onboarding, Job Alerts, Smart-Standby. New stack with security group. Adds ~$20/mo.
3. **Add DynamoDB** — Required by Wallet, Referrals, Onboarding. No VPC dependency (easy addition).
4. **Add EventBridge** — Shared event bus for Billing, Notifications, Job Alerts. 5-line CDK addition.
5. **Add Bedrock/AI VPC endpoints** — Required for AI features. Or rely on NAT Gateway.

### Projected Stack Growth

```
Current (5 stacks):
  NetworkStack → DatabaseStack → AuthStack → ApiStack → LegalStack

Full build-out (14+ stacks):
  NetworkStack → DatabaseStack → AuthStack → ApiStack → LegalStack
                                    ↓
                              BillingStack
                              NotificationStack
                              AdminStack
                              LexStack
                              AIStack
                              JobsStack
                              DashboardStack
                              PaymentStack
                              DispatchStack
                              ReferralStack
```

---

## 11. Cost Model

### Current (Sprint 1-2, Dev)

| Resource | Monthly Cost | Always-on? |
|----------|-------------|------------|
| RDS t4g.micro | ~$15 | Yes (can stop manually, auto-restarts in 7d) |
| VPC Endpoints (6x Interface @ ~$7 each + 1 Gateway free) | ~$42 | Yes |
| Secrets Manager (1 secret) | ~$1 | Yes |
| SQS (DLQ) | ~$0 | Pay per message |
| Lambda (8 functions), API Gateway, Cognito, S3, KMS | Free tier | Pay per use |
| **Total** | **~$58-65/mo** | |

> **Note:** VPC Interface Endpoints are the largest cost driver. Each endpoint costs ~$7/mo (2 AZs × $0.01/hr × 730 hrs). The 6 interface endpoints (Secrets Manager, SNS, Cognito IDP, STS, CloudWatch Logs, SQS) account for ~$42/mo. The S3 Gateway Endpoint is free.

### Projected (All Features, Production)

| Category | Monthly Cost |
|----------|-------------|
| AWS Base Infrastructure | $300-500 |
| Transaction Fees (Stripe, Twilio, Bedrock) | $250-1000+ |
| Third-Party Services | $150-500+ |
| **Total** | **$700-2000+/mo** |

### Cost Trajectory by Phase

| Phase | Sprint | Features Added | Monthly Cost |
|-------|--------|---------------|-------------|
| 1 (Current) | 1-2 | Auth + Legal | ~$58-65 |
| 2 | 3-4 | Worker onboarding, AI resume, job alerts | ~$75-125 |
| 3 | 5-6 | Billing, notifications, employer dashboard | ~$175-275 |
| 4 | 7-8 | Admin, gas money, wallet MVP | ~$255-395 |
| 5 | 9+ | Video, dispatch, referrals, TWC | ~$355-595 + txn fees |

---

## 12. Deployment Guide

### Prerequisites (One-Time)

```bash
# 1. Configure AWS CLI
aws configure
# Set: AWS Access Key ID, Secret Key, Default Region, Output Format

# 2. Bootstrap CDK (one-time per account/region)
cd infra
npx cdk bootstrap aws://<ACCOUNT_ID>/<REGION>

# 3. Verify SNS sandbox (for OTP testing)
# AWS Console → SNS → Text messaging → Add test phone numbers (max 10)
```

### Deploy All Stacks (Sprint 1-2 Combined)

```bash
cd infra
npm run build
npx cdk synth          # Verify all 5 stacks synthesize (8 Lambda bundles)
npm test               # Run 82 assertion tests (16 test suites)
npx cdk diff --all     # Review all resources before creating
npx cdk deploy --all   # Deploys: Network → Database → Auth → Api → Legal
```

CDK will prompt for IAM/security approval on each stack. Expected deploy time: ~10-15 minutes.

**Total resources created:** ~130 CloudFormation resources across 5 stacks.

### Run Schema Migration (Post-Deploy)

Connect to RDS via one of:
- AWS Console → RDS → Query Editor (easiest, requires VPC endpoint for Secrets Manager)
- EC2 bastion with SSM Session Manager
- One-time migration Lambda

Execute migrations in order:
1. `infra/db/migrations/001_initial_schema.sql` — creates `users`, `legal_consent_log` tables, indexes, triggers
2. `infra/db/migrations/002_rls_policies.sql` — enables RLS with `FORCE`, creates SELECT/INSERT/UPDATE policies

### Upload Legal Documents (Post-Deploy)

```bash
# Get bucket name (format: jale-legal-docs-<ACCOUNT_ID>)
aws s3 ls | grep jale-legal-docs

# Upload ToS and privacy policy
aws s3 cp tos.md s3://jale-legal-docs-<ACCOUNT_ID>/tos.md
aws s3 cp privacy-policy.md s3://jale-legal-docs-<ACCOUNT_ID>/privacy-policy.md
```

### Configure SNS Sandbox (Post-Deploy)

Worker OTP requires verified phone numbers in SNS sandbox:
1. AWS Console → SNS → Text messaging (SMS) → Sandbox destination phone numbers
2. Add up to 10 test phone numbers
3. Verify each number by entering the code sent via SMS

### Verify

```bash
# 1. Health check (API URL is in stack output)
curl https://<API_ID>.execute-api.us-east-2.amazonaws.com/dev/health
# Expected: { "status": "healthy", "timestamp": "..." }

# 2. Get legal documents (public endpoint)
curl https://<API_ID>.execute-api.us-east-2.amazonaws.com/dev/legal/tos
# Expected: { "version": "1.0", "tosUrl": "https://...", "privacyUrl": "https://..." }
```

Then test the full flow:
1. Sign up a worker via Cognito (phone/OTP)
2. Check RDS `users` table for synced record
3. Authenticate and call `GET /worker/profile` with JWT — expect 403 (legal wall)
4. Call `POST /legal/accept` with `{ "tosVersion": "1.0" }` — accept ToS
5. Call `GET /worker/profile` again — expect 200 with profile data

---

## 13. CloudFormation Resource Summary

Total resources across all 5 stacks (from `cdk diff --all`):

| Stack | Resources | Key Resource Types |
|-------|-----------|--------------------|
| JaleNetworkStack | 27 | VPC, 4 subnets, 4 route tables, 2 security groups, 7 VPC endpoints, IGW, custom resource |
| JaleDatabaseStack | 4 | RDS instance, subnet group, Secrets Manager secret + attachment |
| JaleAuthStack | 18 | 2 Cognito pools + clients + domains, 2 user pool groups, Lambda + DLQ + event config, SMS IAM role |
| JaleApiStack | 68 | REST API + stage + deployment, 3 authorizers, 5 Lambdas, 7 routes (each with resource + method + OPTIONS + 2 permissions), 2 gateway responses, CloudWatch log group |
| JaleLegalStack | 13 | S3 bucket + policy + auto-delete, 2 Lambdas, IAM roles + policies, log groups |
| **Total** | **~130** | |

### Cross-Stack Exports

| Exporting Stack | Export | Consuming Stack |
|----------------|--------|-----------------|
| NetworkStack | VPC ID, private subnet IDs, isolated subnet IDs, Lambda SG ID, RDS SG ID | DatabaseStack, AuthStack, ApiStack, LegalStack |
| DatabaseStack | DB Secret ARN (`DatabaseSecretAttachmentE5D1B020`) | AuthStack, ApiStack, LegalStack |
| AuthStack | Worker Pool ARN, Employer Pool ARN, Worker Client ID, Employer Client ID | ApiStack |
| ApiStack | API ID, Stage, Dual Authorizer | LegalStack |
| LegalStack | Get-ToS Lambda ARN, Accept-ToS Lambda ARN | ApiStack (for invoke permissions) |

---

## 14. Appendix: File Manifest

```
Jale/
├── docs/
│   ├── specs/
│   │   └── 2026-03-23-cdk-infrastructure-design.md    # Original implementation spec
│   └── ARCHITECTURE.md                                 # This document
├── infra/
│   ├── bin/
│   │   └── jale-app.ts                                # CDK app entry point
│   ├── lib/
│   │   ├── stacks/
│   │   │   ├── network-stack.ts                       # VPC, subnets, SGs, endpoints
│   │   │   ├── database-stack.ts                      # RDS PostgreSQL, Secrets Manager
│   │   │   ├── auth-stack.ts                          # Cognito pools, post-confirmation, DLQ
│   │   │   ├── api-stack.ts                           # API Gateway, authorizers, routes
│   │   │   └── legal-stack.ts                         # S3 legal docs, ToS Lambdas
│   │   └── constructs/
│   │       ├── lambda-function.ts                     # L3 construct: NodejsFunction wrapper
│   │       └── cognito-pool.ts                        # L3 construct: UserPool + Client wrapper
│   ├── lambda/
│   │   ├── post-confirmation/
│   │   │   └── index.ts                               # Cognito → RDS user sync
│   │   ├── api/
│   │   │   ├── health.ts                              # Health check endpoint
│   │   │   ├── worker-profile.ts                      # Worker profile fetch
│   │   │   └── employer-profile.ts                    # Employer profile fetch
│   │   ├── auth/
│   │   │   ├── token-refresh.ts                       # Token refresh (NOT WIRED)
│   │   │   └── logout.ts                              # Logout (NOT WIRED)
│   │   └── legal/
│   │       ├── get-tos.ts                             # ToS presigned URL generator
│   │       ├── accept-tos.ts                          # ToS acceptance recorder
│   │       └── check-compliance.ts                    # Legal wall utility (NOT IMPORTED)
│   ├── test/
│   │   ├── network-stack.test.ts                      # 6 tests
│   │   ├── database-stack.test.ts                     # 5 tests
│   │   ├── auth-stack.test.ts                         # 6 tests
│   │   ├── api-stack.test.ts                          # 5 tests
│   │   └── legal-stack.test.ts                        # 3 tests
│   ├── cdk.json                                       # CDK config + context values
│   ├── tsconfig.json                                  # TypeScript config (commonjs)
│   ├── package.json                                   # Dependencies
│   ├── jest.config.js                                 # Test configuration
│   └── .gitignore
└── README.md
```

**Total:** 23 source files + 5 test files + 4 config files = **32 files**
**Tests:** 25 passing across 5 test suites
**CDK synth:** 5 stacks synthesize successfully
