# Jale CI/CD Pipeline Specification

Status: proposed
Date: 2026-05-21
Owner: Jale operator

## 1. Purpose

This spec defines a secure, scalable GitHub Actions CI/CD pipeline for Jale. The pipeline must validate every code change before deployment, deploy to exactly one AWS environment from the `prod` branch, and avoid the historical failure modes documented in `docs/deployment-ci-cd-runbook.md`.

The current development AWS instance becomes the production instance. There is no separate dev AWS deployment target in this design.

## 2. External Patterns Reviewed

This design follows these current patterns from similar CDK/GitHub Actions deployments:

- GitHub recommends OpenID Connect for AWS so workflows receive temporary credentials instead of long-lived AWS keys. It also requires explicit `id-token: write` permission for OIDC jobs.
  Source: https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws
- GitHub deployment environments provide manual approvals, branch restrictions, environment-scoped secrets, variables, deployment history, and concurrency controls.
  Source: https://docs.github.com/en/actions/tutorials/deploying-with-github-actions
- GitHub reusable workflows do not inherit workflow-level environment variables automatically, and caller permissions can only be downgraded by called workflows. The Jale workflows must pass inputs explicitly and keep permissions least-privilege at the caller job.
  Source: https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations
- AWS Prescriptive Guidance for CDK + GitHub Actions serverless deployments recommends modular stacks, separation of concerns, comprehensive testing, least privilege, monitoring, reusable workflows, and repeatable deployments.
  Source: https://docs.aws.amazon.com/prescriptive-guidance/latest/patterns/optimize-multi-account-serverless-deployments.html
- AWS CI/CD examples for CDK pipelines use build, lint/security/unit checks, deployment, and post-deploy validation as separate gates. Jale adapts that model to GitHub Actions and a single production target.
  Source: https://docs.aws.amazon.com/prescriptive-guidance/latest/patterns/set-up-a-ci-cd-pipeline-by-using-aws-codepipeline-and-aws-cdk.html
- AWS CDK environments must be bootstrapped before deployment; the bootstrap stack owns deployment assets such as S3 buckets, ECR repositories, and IAM roles.
  Source: https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html

Decision: use GitHub Actions directly, not CDK Pipelines or CodePipeline, because the repo is already GitHub-centered and the immediate need is a lightweight pipeline around the existing CDK app. Revisit CDK Pipelines only if Jale later needs multi-account promotion, self-mutating pipeline infrastructure, or many independent deployment stages.

## 3. Deployment Model

Jale has one long-lived deployment target:

| Target | GitHub Environment | AWS account | CDK context | Purpose |
|---|---|---|---|---|
| Production | `production` | Current AWS account, formerly dev | `environment=prod` once production guardrails are ready | The only live Jale instance |

There is no `dev` GitHub Environment and no `deploy-dev.yml`. A `dev` branch may exist for collaboration, but pushes to it run validation only and must not assume AWS deploy credentials.

Production stack names remain the current `Jale*Stack` names to avoid replacing the existing environment. Renaming the GitHub Environment to `production` must not imply CloudFormation stack renames.

## 4. Branch And Trigger Policy

| Event | Workflow | AWS access | Deploys? |
|---|---|---:|---:|
| Pull request to `prod` or `main` | `pr-validate.yml` | No | No |
| Push to `dev`, if the branch exists | `pr-validate.yml` validation mode | No | No |
| Push to `prod` | `deploy-production.yml` | Yes, after approval | Yes |
| Manual dispatch from `prod` | `deploy-production.yml` | Yes, after approval | Yes |
| Scheduled daily validation on `main` | `pr-validate.yml` validation mode | No | No |

Manual production dispatch must reject non-`prod` refs. The pipeline must not support arbitrary SHA or tag deployment until Jale has a formal rollback and release-candidate process.

Branch protection:

- `prod` requires pull requests.
- `prod` requires the full validation workflow to pass.
- `prod` requires at least one review.
- CODEOWNERS review is required for `.github/`, `infra/`, `infra/db/migrations/`, `scripts/run-migrations*`, and production deployment docs.
- Direct pushes to `prod` are disabled except for emergency admins.

GitHub Environment protection:

- Environment: `production`
- Required reviewer: Jale operator
- Prevent self-review: enabled if the GitHub plan supports it.
- Deployment branch policy: only protected `prod`.
- Environment secrets are unavailable until approval passes.

## 5. Workflow Files

Create this minimal workflow layout:

```text
.github/
  workflows/
    pr-validate.yml
    deploy-production.yml
    _reusable-validate.yml
    _reusable-deploy.yml
  actions/
    setup-node-cache/
    aws-oidc-login/
  CODEOWNERS
```

Top-level workflows wire triggers and permissions. Reusable workflows contain the logic. Composite actions contain small, stable setup steps.

Important GitHub Actions constraint: jobs that call reusable workflows can only use a limited set of keywords, and environment variables are not automatically propagated. All environment name, region, CDK context, and stack-list values must be passed as explicit `with:` inputs.

## 6. Required Validation Gates

Every pull request and every production deploy must run the same validation suite. Deploy jobs may add AWS-aware preflight and post-deploy checks, but they must not skip validation.

### 6.1 Repository Hygiene

- Checkout with full history only when needed; otherwise shallow checkout is fine.
- Run on Ubuntu GitHub-hosted runners first. Add Windows validation later only if scripts require it.
- Enforce lockfile installs with `npm ci`.
- Do not use path filters to skip validation. A docs-only change can still break deployment docs or workflows.
- Fail if workflow files use unpinned third-party actions after the first hardening pass. Initial implementation may pin trusted official actions by major version; production hardening should pin by commit SHA.

### 6.2 Infra Validation

Working directory: `infra`

Required commands:

```bash
npm ci
npm run build
npm test -- --runInBand
npx cdk synth --all -c skipFrontend=true --output "$RUNNER_TEMP/jale-cdk-synth-backend"
```

Notes:

- `npm run build` is mandatory before synth to avoid stale TypeScript/JavaScript resolution issues.
- Backend synth uses `skipFrontend=true` for fast PR validation.
- Production deploy runs a full synth during the deploy workflow with production context and frontend build arguments.
- The bastion stack may be synthesized, but it must not be included in the production deploy stack list by default.

### 6.3 Frontend Validation

Working directory: `frontend`

Required commands:

```bash
npm ci
npm run build
```

Add `npm run lint` only after confirming the Next.js lint script is stable in CI. Once stable, lint becomes required.

Frontend production build must use the same `NEXT_PUBLIC_*` values that the `FrontendStack` will bake into the Docker image. Deploy workflows must derive these from CloudFormation outputs or GitHub Environment variables, never from a hand-maintained local `.env`.

### 6.4 Migration Validation

Required checks:

- Migration filenames are strictly ordered.
- No applied migration is edited after being marked live.
- New migrations are forward-only.
- Migration tests in `infra/test/unit/db` pass.
- SQL touching RLS, grants, roles, or destructive table changes requires CODEOWNERS review.

Automation boundary:

- CI may parse and test migration files.
- CI must not automatically apply production migrations until a migration ledger exists and the runner can prove which migrations are unapplied.
- Until then, production deploys that include migration changes require an explicit migration plan artifact and operator approval.

### 6.5 Script Validation

Required checks:

```bash
bash -n scripts/*.sh
pwsh -NoProfile -Command "Get-ChildItem scripts -Filter *.ps1 | ForEach-Object { $null = [System.Management.Automation.PSParser]::Tokenize((Get-Content -Raw $_.FullName), [ref]$null) }"
```

The goal is to catch shell syntax and CRLF regressions before deployment.

### 6.6 Security Validation

Required in PR validation:

- Secret scan.
- Dependency audit in `infra` and `frontend`.
- GitHub Actions permission linting.
- CDK synth warnings reviewed as failures for production-bound PRs unless explicitly waived.

Recommended tools:

- `gitleaks` for secret scanning.
- `npm audit --audit-level=high` for both Node projects.
- `actionlint` for workflow syntax and permissions.
- `cdk-nag` later, after an initial suppression baseline is intentionally reviewed.

## 7. Production Deployment Flow

Workflow: `.github/workflows/deploy-production.yml`

Trigger:

- `push` to `prod`
- `workflow_dispatch`, but only when `github.ref == refs/heads/prod`

Job sequence:

1. `validate`
   - Calls `_reusable-validate.yml`.
   - No AWS credentials.
2. `production-plan`
   - Uses OIDC to assume a read-only or low-privilege planning role.
   - Confirms caller identity and region.
   - Checks CloudFormation stack statuses.
   - Checks Lambda account concurrency headroom.
   - Runs full production `cdk synth`.
   - Runs `cdk diff` for the exact production stack list.
   - Uploads synth templates and diff output as artifacts.
3. `production-deploy`
   - References GitHub Environment `production`; this is the approval gate.
   - Waits for required reviewer approval before the job starts.
   - Receives environment secrets only after approval.
   - Assumes production deploy role through OIDC.
   - Deploys the explicit production stack list.
   - Uses `--require-approval never` only because GitHub Environment approval has already occurred.
   - Captures CloudFormation events and CDK output as artifacts.
4. `post-deploy-verify`
   - Regenerates integration-test environment values from CloudFormation outputs.
   - Runs live smoke/integration tests.
   - Fetches Lambda logs for any 5xx failure.
   - Publishes a GitHub step summary with commit SHA, account, region, stacks, artifacts, and smoke result.

Default production deploy stack list:

```text
JaleNetworkStack
JaleDatabaseStack
JaleAuthStack
JaleAiStack
JaleMatchingStack
JaleApiStack
JaleLegalStack
JaleWhatsAppStack
JaleDocumentsStack
JaleFrontendStack
```

Excluded by default:

```text
JaleBastionStack
```

The bastion is deployed only through an explicit operator workflow or manual runbook action.

## 8. AWS Identity And Permission Model

No static AWS access keys are allowed in GitHub secrets.

Use GitHub OIDC with IAM trust conditions bound to:

- Repository owner/name.
- Branch ref `refs/heads/prod` for deploy.
- GitHub Environment `production` for deploy credentials.
- Audience `sts.amazonaws.com`.

Roles:

| Role | Used by | Permission shape |
|---|---|---|
| `JaleGitHubActionsPlanRole` | `production-plan` | Read-only CloudFormation, IAM read, Lambda account settings read, S3/ECR asset read where needed, CDK lookup read |
| `JaleGitHubActionsDeployRole` | `production-deploy` | CDK deploy permissions for the explicit Jale stacks and CDK bootstrap roles |
| `JaleGitHubActionsSmokeRole` | `post-deploy-verify` | CloudFormation output read, CloudWatch logs read, Cognito/API smoke-test permissions only |

If bootstrapped CDK roles require broader CloudFormation/IAM capabilities, start with the standard CDK deploy role and tighten with IAM Access Analyzer after observing real access patterns.

## 9. GitHub Permissions

Default permissions:

```yaml
permissions:
  contents: read
```

Only AWS jobs receive:

```yaml
permissions:
  contents: read
  id-token: write
```

Only PR comment jobs receive:

```yaml
permissions:
  contents: read
  pull-requests: write
```

Do not use `pull_request_target` for code validation.

## 10. Concurrency

Validation concurrency:

```yaml
concurrency:
  group: validate-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
```

Production deployment concurrency:

```yaml
concurrency:
  group: deploy-production
  cancel-in-progress: false
```

Production deploys queue instead of canceling. Canceling mid-deploy risks leaving CloudFormation stacks in transitional states.

## 11. Production Guardrails

Before the current development instance is declared production, the pipeline must enforce these guardrails:

- CDK context uses `environment=prod`.
- RDS deletion protection is enabled, or an explicit operator waiver is documented.
- RDS backup retention and restore procedure are verified.
- Destructive CloudFormation changes are visible in the `cdk diff` artifact before approval.
- `JaleBastionStack` is excluded from default deploys.
- CloudFront/Next.js production build arguments are generated from deployed stack outputs or environment variables.
- Integration tests never rely on stale local `.env.integration`.
- Deployment summary includes exact commit SHA and AWS account ID.

If any guardrail must be temporarily waived to preserve the current development instance unchanged, the waiver must be recorded in the deployment summary and linked to a follow-up issue.

## 12. Database Migration Policy

Jale migrations remain manual and forward-only until a migration ledger is implemented.

Pipeline behavior before ledger:

- Detect migration file changes.
- Run migration unit/apply-order tests.
- Require CODEOWNERS review.
- Generate a migration plan artifact listing changed migration files and required manual steps.
- Block automatic schema application.

Pipeline behavior after ledger:

- Deploy or start the bastion only through an explicit migration job.
- Query ledger.
- Apply only unapplied migrations.
- Sync service-role passwords after successful schema changes.
- Attach SSM stdout/stderr as artifacts.
- Run schema preflight before deploying app code that depends on the new schema.

Never replay the full migration chain against production as a shortcut.

## 13. Observability And Failure Handling

Every production deployment must retain these artifacts:

- Validation logs.
- Backend synth output.
- Full production synth output.
- CDK diff.
- CDK deploy logs.
- CloudFormation event tail.
- Integration environment generated from stack outputs.
- Smoke/integration test report.

On failure:

- If validation fails, no AWS role is assumed.
- If plan/diff fails, no production approval is requested.
- If approval is rejected, no production deploy credentials are issued.
- If deploy fails, capture CloudFormation events and stack status.
- If smoke tests fail, fetch Lambda logs for failing endpoints and mark deployment failed even if CloudFormation succeeded.

## 14. Scalability Rules

The pipeline should remain fast and reliable as the repo grows:

- Keep validation jobs parallel by subsystem: infra, frontend, security, scripts.
- Reuse npm cache keyed by lockfile and working directory.
- Keep deploy serialized by environment.
- Keep stack list explicit to avoid accidental bastion or experimental stack deploys.
- Add matrix validation only when new packages or apps appear.
- Prefer reusable workflows for whole jobs and composite actions for setup steps.
- Keep integration tests small and smoke-oriented in the deploy workflow; deeper end-to-end suites can run nightly.

## 15. Initial Implementation Plan

Phase 1: validation only

- Add `.github/CODEOWNERS`.
- Add `pr-validate.yml`.
- Add `_reusable-validate.yml`.
- Add `setup-node-cache` composite action.
- Add secret scan, dependency audit, script parse checks, infra build/test/synth, and frontend build.

Phase 2: production deployment

- Configure GitHub Environment `production`.
- Add AWS OIDC provider and IAM plan/deploy/smoke roles.
- Add `aws-oidc-login` composite action.
- Add `deploy-production.yml`.
- Add `_reusable-deploy.yml`.
- Use explicit production stack list excluding `JaleBastionStack`.
- Upload synth/diff/deploy artifacts.

Phase 3: production hardening

- Add action pinning policy.
- Add `actionlint`.
- Add CDK context guard tests for production settings.
- Add migration-change detection and migration plan artifact.
- Add post-deploy smoke tests generated from CloudFormation outputs.
- Add CloudWatch log collection on smoke failure.

Phase 4: migration automation, only after ledger

- Add migration ledger.
- Add explicit migration workflow.
- Add schema preflight gates.
- Keep migration workflow separate from normal production deploy approval.

## 16. Open Decisions

1. Whether production uses a separate plan role or lets the deploy role perform `cdk diff` before approval. Recommendation: separate plan role.
2. Whether `dev` branch should exist as a validation-only integration branch. Recommendation: optional, no AWS deploy.
3. Whether to enable `cdk-nag` immediately or after a suppression baseline. Recommendation: add after baseline to avoid noisy first adoption.
4. Whether to enforce RDS production guardrails immediately or preserve current dev settings temporarily with a documented waiver. Recommendation: enforce before public launch.
