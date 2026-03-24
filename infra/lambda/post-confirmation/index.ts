import { Client } from 'pg';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

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
