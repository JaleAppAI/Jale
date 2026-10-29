import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import type { Context, PostConfirmationTriggerEvent } from 'aws-lambda';
import type { PoolClient } from 'pg';
import { auditCallerFor } from '../lib/audit/caller';
import { setAuditContext } from '../lib/audit/context';
import { getDbPool, setRlsContext } from '../lib/db';
import { errorMessage } from '../lib/http';
import { hashInviteToken, isMembershipConflict, isTeamManagementEnabled } from '../lib/org-team';

const VALID_USER_TYPES = ['worker', 'employer'];

// SQLSTATE undefined_function: employer_ensure_organization (migration 118) is not there yet.
const UNDEFINED_FUNCTION = '42883';
// SQLSTATE lock_not_available: the invite's company lock was not free within lock_timeout.
const LOCK_NOT_AVAILABLE = '55P03';

// Cognito allows the trigger 5 s. The DB steps that can wait on a lock share
// what is left of 3.5 s from handler entry; each waits at least 250 ms.
export const SIGN_UP_LOCK_BUDGET_MS = 3500;
export const SIGN_UP_MIN_LOCK_MS = 250;

const ACCEPT_BY_TOKEN_SQL = 'SELECT outcome, organization_id FROM jale_cap.org_team_invite_accept($1)';
const ACCEPT_BY_EMAIL_SQL = 'SELECT outcome, organization_id FROM jale_cap.org_team_invite_accept_email()';

// Module-level clients — reused across warm Lambda invocations
const cognitoClient = new CognitoIdentityProviderClient({});
const sqsClient = new SQSClient({});

export const handler = async (
  event: PostConfirmationTriggerEvent,
  context?: Pick<Context, 'awsRequestId'>,
): Promise<PostConfirmationTriggerEvent> => {
  // Cognito gives this trigger 5 s; the invite steps budget from here.
  const startedAt = Date.now();

  // Only act on sign-up confirmation events
  if (event.triggerSource !== 'PostConfirmation_ConfirmSignUp') {
    return event;
  }

  // ── Group assignment ──
  // Determine the group from custom:user_type attribute in the event.
  // Using the attribute avoids injecting pool ID env vars which would create
  // a CDK circular dependency (Lambda Ref:UserPool ↔ UserPool Ref:Lambda).
  const userTypeAttr = event.request.userAttributes['custom:user_type'];
  const groupName =
    userTypeAttr === 'worker'   ? 'Workers'   :
    userTypeAttr === 'employer' ? 'Employers' : null;

  if (groupName) {
    try {
      await cognitoClient.send(new AdminAddUserToGroupCommand({
        UserPoolId: event.userPoolId,
        Username:   event.userName,
        GroupName:  groupName,
      }));
      console.log(`[PostConfirm] Added ${event.userName} to group ${groupName}`);
    } catch (err) {
      // Log but never rethrow — group assignment failure must not block sign-up
      console.error('[PostConfirm] Group assignment failed (non-fatal):', errorMessage(err));
    }
  } else {
    console.error(`[PostConfirm] Unknown user_type for ${event.userName}: ${userTypeAttr}`);
  }

  const attrs = event.request.userAttributes;
  const userType: string | null = attrs['custom:user_type'] || null;

  // H-3: Validate user_type is in the allowed set before DB insert
  if (!userType || !VALID_USER_TYPES.includes(userType)) {
    console.error(`[PostConfirm] Invalid user_type: ${userType} for ${event.userName} — skipping DB insert`);
    // User exists in Cognito but won't have a DB record. DLQ fallback below
    // will capture this for investigation. Return event so sign-up completes.
    if (process.env.DLQ_URL) {
      try {
        await sqsClient.send(new SendMessageCommand({
          QueueUrl: process.env.DLQ_URL,
          MessageBody: JSON.stringify({
            error: `Invalid user_type: ${userType}`,
            triggerSource: event.triggerSource,
            userPoolId: event.userPoolId,
            userName: event.userName,
            // userAttributes intentionally omitted — contains PII (phone, email)
          }),
        }));
      } catch (sqsErr) {
        console.error('[PostConfirm] CRITICAL: Failed to push to DLQ:', errorMessage(sqsErr));
      }
    }
    return event;
  }

  const cognitoSub: string = attrs.sub;
  const email: string | null = attrs.email || null;
  const phone: string | null = attrs.phone_number || null;
  const fullName: string | null = attrs.name || null;
  const companyName: string | null = attrs['custom:company_name'] || attrs.name || null;

  let client;
  try {
    const pool = await getDbPool();
    client = await pool.connect();

    // RLS requires SET LOCAL before INSERT — see 002_rls_policies.sql
    await client.query('BEGIN');
    await setRlsContext(client, cognitoSub);
    // The person has only just confirmed a sign-up code: an anonymous actor,
    // named by this invocation.
    await setAuditContext(
      client,
      auditCallerFor(context?.awsRequestId ?? '', { kind: 'anonymous' }, 'web'),
      'auth.post_confirmation',
    );
    await client.query(
      `INSERT INTO users (cognito_sub, user_type, email, phone, full_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (cognito_sub) DO NOTHING`,
      [cognitoSub, userType, email, phone, fullName],
    );
    // An employer login always belongs to a company. Same transaction as the
    // users row: both exist or neither does (the DLQ path below covers a
    // failure exactly as before). Idempotent, so a Cognito retry is safe.
    //
    // Deploy order: this code can reach a database where migration 118 is not
    // applied yet. The SAVEPOINT lets that one case (42883 undefined_function)
    // keep the users row; 119's catch-up back-fill creates the company later.
    // Any other error still rolls back the whole transaction. (With team
    // management on, an invite accept's own errors never do: see
    // joinOrStartCompany.)
    if (userType === 'employer') {
      await client.query('SAVEPOINT company_bootstrap');
      // Team management (Phase 3): an invited foreman joins the inviting
      // company instead of getting a company of their own. Flag off: the
      // Phase 2 path below, unchanged.
      if (isTeamManagementEnabled()) {
        await joinOrStartCompany(client, event, cognitoSub, companyName, startedAt);
      } else {
        await ensureCompany(client, event, companyName);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    // ROLLBACK the DB transaction if it was started
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    console.error('Post-confirmation handler error:', errorMessage(err));

    // Push failed event to DLQ for manual investigation/retry.
    // We do NOT re-throw because Cognito would block the user's sign-up.
    if (process.env.DLQ_URL) {
      try {
        await sqsClient.send(new SendMessageCommand({
          QueueUrl: process.env.DLQ_URL,
          MessageBody: JSON.stringify({
            error: errorMessage(err),
            triggerSource: event.triggerSource,
            userPoolId: event.userPoolId,
            userName: event.userName,
            // userAttributes intentionally omitted — contains PII (phone, email)
          }),
        }));
        console.log('[PostConfirm] Failed event pushed to DLQ for retry');
      } catch (sqsErr) {
        console.error('[PostConfirm] CRITICAL: Failed to push to DLQ:', errorMessage(sqsErr));
      }
    }
  } finally {
    if (client) {
      client.release();
    }
  }

  // Cognito requires the event to be returned
  return event;
};

type DbClient = Pick<PoolClient, 'query'>;

/**
 * Inside SAVEPOINT company_bootstrap: the employer's own company. Ends the
 * savepoint either way. A 42883 (migration 118 not applied) keeps the users
 * row; with `deferOnLockTimeout` (team management on, under the sign-up lock
 * budget) a 55P03 does too. Any other error rolls back the whole transaction
 * (the caller's DLQ path).
 */
async function ensureCompany(
  client: DbClient,
  event: PostConfirmationTriggerEvent,
  companyName: string | null,
  options: { deferOnLockTimeout?: boolean; cognitoSub?: string } = {},
): Promise<void> {
  try {
    await client.query('SELECT public.employer_ensure_organization($1) AS org', [companyName]);
    await client.query('RELEASE SAVEPOINT company_bootstrap');
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (options.deferOnLockTimeout && code === LOCK_NOT_AVAILABLE) {
      await client.query('ROLLBACK TO SAVEPOINT company_bootstrap');
      console.warn(JSON.stringify({ event: 'post_confirmation_company_deferred', cognitoSub: options.cognitoSub }));
      return;
    }
    if (code !== UNDEFINED_FUNCTION) throw err;
    await client.query('ROLLBACK TO SAVEPOINT company_bootstrap');
    console.error(
      `[PostConfirm] CRITICAL: employer ${event.userName} has no company yet: `
      + 'public.employer_ensure_organization is missing (migration 118 not applied). '
      + 'The users row is kept; migration 119\'s catch-up back-fill will create the company.',
    );
  }
}

interface AcceptRow { outcome: string; organizationId: string | null }

async function acceptOutcome(client: DbClient, sql: string, params: unknown[]): Promise<AcceptRow> {
  const { rows } = await client.query(sql, params);
  const outcome = rows[0]?.outcome;
  if (typeof outcome !== 'string') throw new Error('invite_accept_no_outcome');
  return { outcome, organizationId: rows[0]?.organization_id ?? null };
}

/** What to log for an accept error: its SQLSTATE or class name, never its message (no token, no email). */
function errorCode(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown; message?: unknown } | null | undefined;
  if (typeof e?.code === 'string' && /^[A-Z0-9]{5}$/.test(e.code)) return e.code;
  if (typeof e?.message === 'string' && /^[a-z_]{1,40}$/.test(e.message)) return e.message;
  if (typeof e?.name === 'string' && /^[A-Za-z]{1,40}$/.test(e.name)) return e.name;
  return 'unknown';
}

/** What is left of the sign-up lock budget, in whole ms (may be negative). */
function budgetLeftMs(startedAt: number): number {
  return Math.floor(SIGN_UP_LOCK_BUDGET_MS - (Date.now() - startedAt));
}

/**
 * Inside SAVEPOINT company_bootstrap, team management on (Open decision 16):
 *   1. With clientMetadata.inviteToken, accept that invite (a malformed token
 *      counts as refused). Accepted: done.
 *   2. Then, or with no token, accept the single live invite to the
 *      confirmed email. Accepted: done.
 *   3. No token and no live invite: the employer's own company, as before,
 *      but only for a self sign-up (custom:company_name set). An invite-mode
 *      sign-up sends no company name: it gets no company of its own.
 *   4. Anything else (a refused token with no email match, two live invites
 *      from different companies, ...) creates no membership: the login
 *      answers no_organization, and the person accepts from the invite link
 *      or starts a company. Logged as post_confirmation_invite_refused; a
 *      Cognito retry (already a member) logs post_confirmation_invite_retry.
 * The accepts run only for a verified email (email_verified = 'true').
 *
 * Time: Cognito gives the trigger 5 s. Each step that can wait on a company
 * lock sets lock_timeout (inside the savepoint) to what is left of 3.5 s from
 * handler entry, at least 250 ms. If the token step leaves less than 250 ms,
 * the email step is skipped and logged as deferred. An error from steps 1-2
 * never fails the sign-up: the savepoint is rolled back and the users row is
 * committed with no membership. 55P03 logs post_confirmation_invite_deferred;
 * a 23505 on the members primary key is already_member.
 *
 * The raw token is never logged, and reaches the database only as its hash.
 */
async function joinOrStartCompany(
  client: DbClient,
  event: PostConfirmationTriggerEvent,
  cognitoSub: string,
  companyName: string | null,
  startedAt: number,
): Promise<void> {
  const attrs = event.request.userAttributes;
  const ownCompany = attrs['custom:company_name'];
  const selfSignUp = typeof ownCompany === 'string' && ownCompany.trim().length > 0;
  const rawToken = event.request.clientMetadata?.inviteToken;
  const hasToken = typeof rawToken === 'string' && rawToken.length > 0;
  let step: 'token' | 'email' = hasToken ? 'token' : 'email';
  let tokenOutcome: string | null = null;
  let emailOutcome: string | null = null;

  const setLockTimeout = async (): Promise<void> => {
    // An integer from budgetLeftMs, never caller input.
    const ms = Math.max(SIGN_UP_MIN_LOCK_MS, budgetLeftMs(startedAt));
    await client.query(`SET LOCAL lock_timeout = '${ms}ms'`);
  };
  const release = async (): Promise<void> => {
    await client.query('RELEASE SAVEPOINT company_bootstrap');
  };
  const accepted = async (via: 'token' | 'email', organizationId: string | null): Promise<void> => {
    await release();
    console.log(JSON.stringify({ event: 'post_confirmation_invite_accepted', via, organizationId, cognitoSub }));
  };
  const startOwnCompany = async (): Promise<void> => {
    if (!selfSignUp) {
      await release();
      console.warn(JSON.stringify({
        event: 'post_confirmation_invite_refused', reason: 'invite_mode_no_invite', tokenOutcome, emailOutcome, cognitoSub,
      }));
      return;
    }
    await setLockTimeout();
    await ensureCompany(client, event, companyName, { deferOnLockTimeout: true, cognitoSub });
  };

  if (attrs.email_verified !== 'true') {
    console.warn(JSON.stringify({ event: 'post_confirmation_invite_skipped', reason: 'email_unverified', hasToken, cognitoSub }));
    if (!hasToken) return await startOwnCompany();
    return await release();
  }

  let outOfBudget = false;
  try {
    if (hasToken) {
      const hash = hashInviteToken(rawToken);
      if (!hash) {
        tokenOutcome = 'malformed';
      } else {
        await setLockTimeout();
        const row = await acceptOutcome(client, ACCEPT_BY_TOKEN_SQL, [hash]);
        tokenOutcome = row.outcome;
        // rejoined cannot happen for a new login; it is a membership all the same.
        if (tokenOutcome === 'accepted' || tokenOutcome === 'rejoined') return await accepted('token', row.organizationId);
      }
      outOfBudget = budgetLeftMs(startedAt) < SIGN_UP_MIN_LOCK_MS;
    }
    if (!outOfBudget) {
      step = 'email';
      await setLockTimeout();
      const row = await acceptOutcome(client, ACCEPT_BY_EMAIL_SQL, []);
      emailOutcome = row.outcome;
      if (emailOutcome === 'accepted') return await accepted('email', row.organizationId);
    }
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT company_bootstrap');
    const code = (err as { code?: unknown } | null)?.code;
    if (isMembershipConflict(err)) {
      // An accept or start-company for this login won the members primary key.
      if (step === 'token') tokenOutcome = 'already_member';
      else emailOutcome = 'already_member';
      console.warn(JSON.stringify({ event: 'post_confirmation_invite_refused', tokenOutcome, emailOutcome, cognitoSub }));
    } else if (code === LOCK_NOT_AVAILABLE) {
      console.warn(JSON.stringify({ event: 'post_confirmation_invite_deferred', step, reason: 'lock_timeout', cognitoSub }));
    } else if (code === UNDEFINED_FUNCTION) {
      // One line with the console call: AuthStack's PostConfirmationInviteFailed
      // filter matches "joined no company" (metric-filter-patterns.test.ts).
      console.error(`[PostConfirm] CRITICAL: employer ${cognitoSub} joined no company: `
        + `jale_cap.org_team_invite_accept${step === 'email' ? '_email' : ''} is missing (migration 133 not applied). `
        + 'The users row is kept; the person can accept from the invite link or start a company.');
    } else {
      console.error(JSON.stringify({ event: 'post_confirmation_invite_failed', step, code: errorCode(err), cognitoSub }));
    }
    return;
  }

  if (outOfBudget) {
    await release();
    console.warn(JSON.stringify({
      event: 'post_confirmation_invite_deferred', step: 'email', reason: 'time_budget', tokenOutcome, cognitoSub,
    }));
    return;
  }

  if (!hasToken && emailOutcome === 'none') return await startOwnCompany();

  await release();
  if (emailOutcome === 'already_member' && (tokenOutcome === null || tokenOutcome === 'used')) {
    // A Cognito retry of this trigger: the first run already gave the login its company.
    console.info(JSON.stringify({ event: 'post_confirmation_invite_retry', tokenOutcome, emailOutcome, cognitoSub }));
    return;
  }
  console.warn(JSON.stringify({ event: 'post_confirmation_invite_refused', tokenOutcome, emailOutcome, cognitoSub }));
}

