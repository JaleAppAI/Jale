# Integration Test Failures — Fix Design

**Date:** 2026-03-30
**Status:** Approved
**Author:** Claude Code (brainstorming session)

---

## Summary

Integration tests (`npm run test:integration`) produce 13 failures across 3 suites after infrastructure deployment. Two distinct root causes account for all failures. This document captures the diagnosis and approved fix design.

| Suite | Failures | Root Cause |
|-------|----------|------------|
| `profile.integration.ts` | 3 × 500 | SSL cert not trusted |
| `legal.integration.ts` | 7 × 500 | SSL cert not trusted |
| `auth.integration.ts` | 2 × 401, 1 × 500 | PrivateLink blocked + missing auth flow |

---

## Root Cause 1 — SSL: `self-signed certificate in certificate chain`

### Symptom

Every Lambda that calls `getDbPool()` logs:

```
Worker profile handler error: self-signed certificate in certificate chain
```

### Cause

`lambda/lib/db.ts` creates a `pg.Pool` with `ssl: { rejectUnauthorized: true }`. Node.js 20.x on Lambda does not include the AWS RDS CA in its default trust store, so TLS verification fails for every connection.

A silent consequence: the post-confirmation Lambda also uses `getDbPool()`, but its `catch` block swallows DB errors (by design — to avoid blocking Cognito sign-up). This means `global-setup` reports success even though no test users were written to the database.

### Affected Lambdas

All Lambdas that import `lambda/lib/db.ts`:
- `lambda/api/worker-profile.ts`
- `lambda/api/employer-profile.ts`
- `lambda/legal/accept-tos.ts`
- `lambda/post-confirmation/index.ts`

### Fix — Bundle RDS CA certificate (A1)

1. **Download** the regional RDS CA bundle and commit it as `infra/lambda/lib/rds-ca-bundle.pem`.
   - Source: `https://truststore.pki.rds.amazonaws.com/us-east-2/us-east-2-bundle.pem`
   - This is a public, non-secret file — safe to commit to git.

2. **Update `db.ts`** to pass the CA bundle to the pool:
   ```typescript
   import * as fs from 'fs';
   import * as path from 'path';

   ssl: {
     rejectUnauthorized: true,
     ca: fs.readFileSync(path.join(__dirname, 'rds-ca-bundle.pem'), 'utf-8'),
   }
   ```

3. **Update `JaleLambdaFunction` construct** to copy the cert into every Lambda bundle via `bundling.commandHooks.afterBundling`. Because all DB Lambdas use the same construct, this single change propagates everywhere without touching each stack.

   ```typescript
   commandHooks: {
     afterBundling: (inputDir: string, outputDir: string) => [
       `cp ${inputDir}/lambda/lib/rds-ca-bundle.pem ${outputDir}/rds-ca-bundle.pem`,
     ],
     beforeBundling: () => [],
     beforeInstall: () => [],
   }
   ```

   At runtime, `__dirname` in the bundled Lambda resolves to `/var/task`, so `path.join(__dirname, 'rds-ca-bundle.pem')` finds the cert at `/var/task/rds-ca-bundle.pem`.

---

## Root Cause 2 — PrivateLink blocked by ManagedLogin

### Symptom

The logout Lambda logs:

```
GlobalSignOut failed: PrivateLink access is disabled for the user pool that has ManagedLogin configured.
RevokeToken failed: PrivateLink access is disabled for the user pool that has ManagedLogin configured.
```

Token refresh returns 401 (caught error from `InitiateAuth` through PrivateLink).

### Cause

`lib/constructs/cognito-pool.ts` calls `this.userPool.addDomain()`, which creates a Cognito-managed hosted domain and enables ManagedLogin. AWS enforces a restriction: when ManagedLogin is enabled, the `cognito-idp` VPC PrivateLink endpoint blocks API calls to that user pool. Since all Lambdas are in the VPC and route Cognito traffic through PrivateLink, every Cognito API call fails.

Affected operations:
- `GlobalSignOut` → logout 500
- `RevokeToken` → logout 500
- `InitiateAuth` (REFRESH_TOKEN_AUTH) → refresh 401

### Fix — Remove `addDomain()` from `CognitoPool` (B1)

The Cognito hosted domain exists only to support the hosted UI (OAuth flows, ManagedLogin pages). Jale uses its own mobile/web auth UI — phone/OTP for workers, email/password for employers — so the hosted domain provides no value.

Remove the `addDomain()` call and the associated `domain` variable from `lib/constructs/cognito-pool.ts`. CDK will delete the domains from both user pools on next deploy.

---

## Root Cause 3 — Missing `ALLOW_REFRESH_TOKEN_AUTH` in auth flows

### Symptom

Would manifest as a distinct error after Root Cause 2 is fixed. `InitiateAuth` with `REFRESH_TOKEN_AUTH` returns `NotAuthorizedException: Refresh tokens are not supported`.

### Cause

`CognitoPool` sets auth flows without `userRefreshToken: true`:

```typescript
const authFlows: cognito.AuthFlow = {
  userSrp: true,
  custom: props.signInAliases.phone ? true : false,
  adminUserPassword: true,
  // userRefreshToken missing → ALLOW_REFRESH_TOKEN_AUTH not added to ExplicitAuthFlows
};
```

When CDK generates `ExplicitAuthFlows`, `ALLOW_REFRESH_TOKEN_AUTH` is absent, so Cognito rejects refresh token exchanges.

### Fix

Add `userRefreshToken: true` to the `authFlows` object in `CognitoPool`:

```typescript
const authFlows: cognito.AuthFlow = {
  userSrp: true,
  custom: props.signInAliases.phone ? true : false,
  adminUserPassword: true,
  userRefreshToken: true,
};
```

---

## Files Changed

```
infra/
├── lambda/lib/
│   ├── rds-ca-bundle.pem           NEW — RDS CA trust bundle (public cert, committed)
│   └── db.ts                       MODIFIED — add `ca` to ssl config
├── lib/constructs/
│   ├── lambda-function.ts          MODIFIED — add commandHooks to copy cert into bundle
│   └── cognito-pool.ts             MODIFIED — remove addDomain(), add userRefreshToken: true
```

---

## Deployment Steps (after code changes)

1. `npm run build` — verify TypeScript compiles cleanly
2. `npm test` — verify CDK unit tests still pass
3. `npx cdk deploy JaleAuthStack` — applies Cognito pool changes (removes domains, adds refresh auth flow)
4. `npx cdk deploy JaleApiStack JaleLegalStack` — redeploys Lambda functions with the bundled CA cert
5. `npm run test:integration` — verify all 13 failures are resolved

> **Note:** Step 3 will delete the Cognito hosted domains. This is safe — the hosted UI is not used by the application.

---

## Testing

- All 13 previously-failing integration tests should pass after deployment
- 1 passing suite (`health.integration.ts`) and 16 passing tests should remain green
- `npm test` (CDK unit tests) count should not change
