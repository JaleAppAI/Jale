import {
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';

/**
 * Makes the employer pool's Cognito users match the database's desired
 * access (employer organizations, Phase 3): a removed or billing-suspended
 * member is signed out everywhere and disabled; a member who may sign in
 * again (restored, re-invited) is enabled.
 *
 * Callers run it after COMMIT with what the database decided (a definer's
 * cognito_sub, or jale_cap.org_member_access rows). It is idempotent and
 * never throws: a change it cannot apply is reported in `failed`, and the
 * 15-minute member-access sync repairs it from the database later. That sync
 * also repairs ordering: two requests for one user can commit in one order and
 * reach Cognito in the other, and callers do not re-read.
 *
 * DEADLINE. Pass `deadlineAt` (epoch ms) so a slow Cognito cannot run the
 * Lambda out of time:
 *   - the billing processor and the member-access sync (Task 6):
 *     `Date.now() + context.getRemainingTimeInMillis() - 5000`;
 *   - API handlers: about `Date.now() + 10_000`, well inside their timeout.
 * Once it has passed, the remaining changes fail without a Cognito call
 * (member_access_deadline, logged once); the sync picks them up.
 */
export interface MemberAccessChange {
  cognitoSub: string;
  enabled: boolean;
}

export interface MemberAccessResult {
  converged: number;
  /** The cognito subs whose change was not applied. */
  failed: string[];
}

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 200;

/**
 * Errors about the pool or the caller's credentials, not the user: every
 * other change would fail the same way, so the rest of the batch fails at
 * once (member_access_pool_unavailable, logged once).
 */
const POOL_LEVEL_ERRORS: ReadonlySet<string> = new Set([
  'AccessDeniedException',
  'ResourceNotFoundException',
  'UnrecognizedClientException',
]);

/** Errors a retry cannot fix: the change fails at once and the batch goes on. */
const NON_RETRYABLE_ERRORS: ReadonlySet<string> = new Set([
  'InvalidParameterException',
  'NotAuthorizedException',
]);

let defaultClient: CognitoIdentityProviderClient | undefined;

/**
 * Bounded calls: the SDK's own retries (maxAttempts 3, for throttling and
 * transient faults) inside short connection and request timeouts, so one hung
 * call cannot use up a caller's budget; the loop below adds its own attempts
 * and the deadline.
 */
function memberAccessClient(): CognitoIdentityProviderClient {
  defaultClient ??= new CognitoIdentityProviderClient({
    maxAttempts: 3,
    requestHandler: { connectionTimeout: 1000, requestTimeout: 3000 },
  });
  return defaultClient;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function errorName(err: unknown): string {
  const e = err as { name?: unknown } | null | undefined;
  return typeof e?.name === 'string' && e.name !== '' ? e.name : 'Error';
}

/**
 * One attempt for one user. The employer pool signs in by email alias, so its
 * usernames are the subs. A user Cognito no longer has needs nothing.
 *
 * UserNotFoundException counts as converged because the employer pool has
 * native users only: a missing user cannot sign in. If a federated identity
 * provider were ever added to the employer pool, a federated login could
 * exist under another username, and this would fail OPEN (the member keeps
 * signing in); revisit this before adding one.
 */
async function converge(
  client: CognitoIdentityProviderClient,
  userPoolId: string,
  change: MemberAccessChange,
): Promise<void> {
  const Username = change.cognitoSub;
  try {
    const user = await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username }));
    if (user.Enabled === change.enabled) return;
    if (change.enabled) {
      await client.send(new AdminEnableUserCommand({ UserPoolId: userPoolId, Username }));
    } else {
      // Sign-out first: it revokes the refresh tokens while the user can still
      // be addressed, and a disable that then fails is retried as a whole.
      await client.send(new AdminUserGlobalSignOutCommand({ UserPoolId: userPoolId, Username }));
      await client.send(new AdminDisableUserCommand({ UserPoolId: userPoolId, Username }));
    }
  } catch (err) {
    if (errorName(err) === 'UserNotFoundException') {
      console.warn(JSON.stringify({ event: 'member_access_user_missing', cognitoSub: Username, enabled: change.enabled }));
      return;
    }
    throw err;
  }
}

export async function applyMemberAccess(
  changes: MemberAccessChange[],
  deps: {
    client?: CognitoIdentityProviderClient;
    userPoolId?: string;
    sleep?: (ms: number) => Promise<void>;
    /** Epoch ms after which no further Cognito call is made (see DEADLINE above). */
    deadlineAt?: number;
  } = {},
): Promise<MemberAccessResult> {
  const result: MemberAccessResult = { converged: 0, failed: [] };
  if (changes.length === 0) return result;

  const userPoolId = deps.userPoolId ?? process.env.EMPLOYER_USER_POOL_ID;
  if (!userPoolId) {
    console.error(JSON.stringify({ event: 'member_access_pool_missing', changes: changes.length }));
    result.failed = changes.map((c) => c.cognitoSub);
    return result;
  }

  const sleep = deps.sleep ?? defaultSleep;
  const deadlineAt = deps.deadlineAt;
  const pastDeadline = (): boolean => typeof deadlineAt === 'number' && Date.now() >= deadlineAt;
  let client = deps.client;

  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index];
    let lastError: unknown;
    let done = false;
    if (typeof change.cognitoSub !== 'string' || change.cognitoSub === '' || typeof change.enabled !== 'boolean') {
      lastError = Object.assign(new Error('member_access_change_invalid'), { name: 'InvalidMemberAccessChange' });
    } else {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        if (pastDeadline()) {
          const remaining = changes.slice(index).map((c) => c.cognitoSub);
          console.error(JSON.stringify({ event: 'member_access_deadline', remaining: remaining.length }));
          result.failed.push(...remaining);
          return result;
        }
        try {
          client ??= memberAccessClient();
          await converge(client, userPoolId, change);
          done = true;
          break;
        } catch (err) {
          lastError = err;
          const name = errorName(err);
          if (POOL_LEVEL_ERRORS.has(name)) {
            const remaining = changes.slice(index).map((c) => c.cognitoSub);
            console.error(JSON.stringify({ event: 'member_access_pool_unavailable', error: name, remaining: remaining.length }));
            result.failed.push(...remaining);
            return result;
          }
          if (NON_RETRYABLE_ERRORS.has(name)) break;
          if (attempt < MAX_ATTEMPTS - 1) {
            try {
              await sleep(BASE_DELAY_MS * 2 ** attempt);
            } catch {
              // A failed wait only shortens the backoff.
            }
          }
        }
      }
    }
    if (done) {
      result.converged += 1;
    } else {
      console.error(JSON.stringify({
        event: 'member_access_failed',
        cognitoSub: change.cognitoSub,
        enabled: change.enabled,
        error: errorName(lastError),
      }));
      result.failed.push(change.cognitoSub);
    }
  }
  return result;
}
