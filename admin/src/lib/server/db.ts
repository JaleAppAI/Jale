import * as fs from 'node:fs';
import * as path from 'node:path';
import { Pool, type PoolConfig } from 'pg';
import { getAdminDbSecret, type AdminDbSecret } from './db-secret';

type AdminPoolConfig = PoolConfig & {
  ssl: false | {
    rejectUnauthorized: true;
    ca?: string;
  };
};

const EXPECTED_ADMIN_DB_USER = 'jale_admin_console';
let poolPromise: Promise<Pool> | undefined;

function readRdsCaBundle(): string | undefined {
  const candidates = [
    path.join(process.cwd(), 'rds-ca-bundle.pem'),
    path.join(process.cwd(), 'infra', 'lambda', 'lib', 'rds-ca-bundle.pem'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, 'utf-8');
    }
  }

  return undefined;
}

function shouldDisableLocalSsl(): boolean {
  if (process.env.ADMIN_DB_SSL_MODE !== 'disable') {
    return false;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('ADMIN_DB_SSL_MODE=disable is not allowed in production');
  }

  return true;
}

export function buildAdminPoolConfig(secret: AdminDbSecret): AdminPoolConfig {
  if (secret.username !== EXPECTED_ADMIN_DB_USER) {
    throw new Error(`Admin DB secret must use ${EXPECTED_ADMIN_DB_USER}`);
  }

  const ca = readRdsCaBundle();
  const ssl = shouldDisableLocalSsl()
    ? false
    : {
        rejectUnauthorized: true as const,
        ...(ca ? { ca } : {}),
      };

  return {
    host: secret.host,
    port: secret.port,
    database: secret.dbname,
    user: secret.username,
    password: secret.password,
    max: process.env.NODE_ENV === 'production' ? 1 : 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 2000,
    ssl,
  };
}

export function getAdminDbPool(): Promise<Pool> {
  if (poolPromise) {
    return poolPromise;
  }

  poolPromise = (async () => {
    const secret = await getAdminDbSecret();
    const config = buildAdminPoolConfig(secret);
    const newPool = new Pool(config);

    newPool.on('error', (err) => {
      console.error('Unexpected error on idle admin pg client:', err instanceof Error ? err.message : String(err));
      poolPromise = undefined;
      void newPool.end().catch(() => undefined);
    });

    return newPool;
  })();

  return poolPromise;
}
