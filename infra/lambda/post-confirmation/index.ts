import { Client } from 'pg';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';

interface DbSecret {
  host: string;
  port: number;
  dbname: string;
  username: string;
  password: string;
}

// Cache the parsed secret across warm invocations
let cachedSecret: DbSecret | undefined;

const smClient = new SecretsManagerClient({
  region: process.env.DB_REGION,
});

// Module-level client — reused across warm Lambda invocations
const cognitoClient = new CognitoIdentityProviderClient({});

async function getDbSecret(): Promise<DbSecret> {
  if (cachedSecret) {
    return cachedSecret;
  }

  const result = await smClient.send(
    new GetSecretValueCommand({
      SecretId: process.env.DB_SECRET_ARN,
    }),
  );

  cachedSecret = JSON.parse(result.SecretString!) as DbSecret;
  return cachedSecret;
}

export const handler = async (event: any): Promise<any> => {
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
      console.error('[PostConfirm] Group assignment failed (non-fatal):', err);
    }
  } else {
    console.error(`[PostConfirm] Unknown userPoolId: ${event.userPoolId}`);
  }

  let client: Client | undefined;

  try {
    const secret = await getDbSecret();

    client = new Client({
      host: secret.host,
      port: secret.port,
      database: secret.dbname,
      user: secret.username,
      password: secret.password,
      ssl: { rejectUnauthorized: false },
    });

    await client.connect();

    const attrs = event.request.userAttributes;

    // Determine user_type from custom attribute or fall back to inference
    const userType: string | null =
      attrs['custom:user_type'] || null;

    const cognitoSub: string = attrs.sub;
    const email: string | null = attrs.email || null;
    const phone: string | null = attrs.phone_number || null;
    const fullName: string | null = attrs.name || null;

    await client.query(
      `INSERT INTO users (cognito_sub, user_type, email, phone, full_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (cognito_sub) DO NOTHING`,
      [cognitoSub, userType, email, phone, fullName],
    );
  } catch (err) {
    // Log but never throw — do not block Cognito confirmation
    console.error('Post-confirmation handler error:', err);
  } finally {
    if (client) {
      try {
        await client.end();
      } catch (endErr) {
        console.error('Error closing DB connection:', endErr);
      }
    }
  }

  // Cognito requires the event to be returned
  return event;
};
