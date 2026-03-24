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

    const result = await client.query(
      'SELECT * FROM users WHERE cognito_sub = $1',
      [cognitoSub],
    );

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

    const user = result.rows[0];
    // Omit sensitive fields
    delete user.password_hash;
    delete user.internal_notes;

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(user),
    };
  } catch (err) {
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
