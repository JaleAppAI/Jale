import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import type { PostConfirmationTriggerEvent } from 'aws-lambda';
import { getDbPool } from '../lib/db';
import { errorMessage } from '../lib/http';

const VALID_USER_TYPES = ['worker', 'employer'];

// Module-level clients — reused across warm Lambda invocations
const cognitoClient = new CognitoIdentityProviderClient({});
const sqsClient = new SQSClient({});

export const handler = async (event: PostConfirmationTriggerEvent): Promise<PostConfirmationTriggerEvent> => {
  // Only act on sign-up confirmation events
  if (event.triggerSource !== 'PostConfirmation_ConfirmSignUp') {
    return event;
  }

  // ── Group assignment (Task 2.1) ──
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

  let client;
  try {
    const pool = await getDbPool();
    client = await pool.connect();

    // RLS requires SET LOCAL before INSERT — see 002_rls_policies.sql
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_user_id = ${client.escapeLiteral(cognitoSub)}`);
    await client.query(
      `INSERT INTO users (cognito_sub, user_type, email, phone, full_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (cognito_sub) DO NOTHING`,
      [cognitoSub, userType, email, phone, fullName],
    );
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
