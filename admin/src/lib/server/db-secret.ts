import * as fs from 'node:fs';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

export type AdminDbSecret = {
  host: string;
  port: number;
  dbname: string;
  username: string;
  password: string;
};

const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedSecret: AdminDbSecret | undefined;
let cachedAt = 0;
const secretsManager = new SecretsManagerClient({});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requiredString(source: Record<string, unknown>, key: keyof AdminDbSecret): string {
  const value = source[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`DB secret is missing required field: ${key}`);
  }

  return value.trim();
}

function requiredPort(source: Record<string, unknown>): number {
  const value = source.port;
  const port = typeof value === 'number' ? value : Number(value);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('DB secret is missing required field: port');
  }

  return port;
}

export function parseDbSecret(secretString: string): AdminDbSecret {
  let parsed: unknown;

  try {
    parsed = JSON.parse(secretString);
  } catch {
    throw new Error('DB secret must be valid JSON');
  }

  if (!isRecord(parsed)) {
    throw new Error('DB secret must be a JSON object');
  }

  return {
    host: requiredString(parsed, 'host'),
    port: requiredPort(parsed),
    dbname: requiredString(parsed, 'dbname'),
    username: requiredString(parsed, 'username'),
    password: requiredString(parsed, 'password'),
  };
}

export function requireDbSecretArn(secretArnValue: string | undefined): string {
  const secretArn = secretArnValue?.trim();

  if (!secretArn) {
    throw new Error('DB_SECRET_ARN is required for admin DB access');
  }

  return secretArn;
}

export function clearAdminDbSecretCache(): void {
  cachedSecret = undefined;
  cachedAt = 0;
}

function readLocalSecretFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

export function getLocalDbSecretOverride(nodeEnv = process.env.NODE_ENV): AdminDbSecret | undefined {
  const inlineSecret = process.env.ADMIN_LOCAL_DB_SECRET_JSON?.trim();
  const filePath = process.env.ADMIN_LOCAL_DB_SECRET_FILE?.trim();

  if ((inlineSecret || filePath) && nodeEnv === 'production') {
    throw new Error('Local admin DB secret override is not allowed in production');
  }

  if (inlineSecret) {
    return parseDbSecret(inlineSecret);
  }

  if (filePath) {
    return parseDbSecret(readLocalSecretFile(filePath));
  }

  return undefined;
}

export async function getAdminDbSecret(): Promise<AdminDbSecret> {
  if (cachedSecret && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedSecret;
  }

  const localOverride = getLocalDbSecretOverride();
  if (localOverride) {
    cachedSecret = localOverride;
    cachedAt = Date.now();
    return cachedSecret;
  }

  const result = await secretsManager.send(new GetSecretValueCommand({
    SecretId: requireDbSecretArn(process.env.DB_SECRET_ARN),
  }));

  if (!result.SecretString) {
    throw new Error('DB secret response did not include SecretString');
  }

  cachedSecret = parseDbSecret(result.SecretString);
  cachedAt = Date.now();
  return cachedSecret;
}
