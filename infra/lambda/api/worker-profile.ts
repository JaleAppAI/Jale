import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { Client } from 'pg';

interface DbSecret {
  host: string;
  port: number;
  dbname: string;
  username: string;
  password: string;
}

// Cache the parsed secret across warm invocations
let cachedSecret: DbSecret | undefined;

const smClient = new SecretsManagerClient({});

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

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': 'http://localhost:3000',
};

export const handler = async (event: any): Promise<any> => {
  let client: Client | undefined;

  try {
    const cognitoSub: string = event.requestContext.authorizer.claims.sub;

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

    // RLS requires an explicit transaction so SET LOCAL survives until the SELECT
    await client.query('BEGIN');
    await client.query('SET LOCAL app.current_user_id = $1', [cognitoSub]);
    const result = await client.query(
      'SELECT id, user_type, email, phone, full_name, tenant_id, created_at FROM users WHERE cognito_sub = $1',
      [cognitoSub],
    );
    await client.query('COMMIT');

    if (result.rows.length === 0) {
      return {
        statusCode: 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: 'profile_not_found',
          message: 'Please complete profile setup',
        }),
      };
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(result.rows[0]),
    };
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    console.error('Worker profile handler error:', err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'internal_error', message: 'Internal server error' }),
    };
  } finally {
    if (client) {
      try {
        await client.end();
      } catch (endErr) {
        console.error('Error closing DB connection:', endErr);
      }
    }
  }
};
