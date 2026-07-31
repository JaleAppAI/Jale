/**
 * Operator CLI: export every table in a schema to CSV, bundled into one zip.
 *
 * Read-only. Discovers tables via information_schema (no hardcoded table
 * list to keep in sync), dumps each with `SELECT *`, writes one CSV per
 * table into a temp directory, then zips that directory into a single
 * archive and removes the temp directory.
 *
 * Usage (against a real RDS instance, run this from a machine that can
 * reach the DB host — e.g. via an SSM port-forward session to the bastion,
 * same connectivity requirement as reset-whatsapp-onboarding-v2.ts):
 *
 *   cd infra
 *   DB_HOST=localhost DB_PORT=5434 DB_NAME=jale DB_USER=jale_admin DB_PASSWORD=<pw> DB_SSL=true \
 *   DB_TLS_SERVERNAME=<real-rds-endpoint> \
 *   npx ts-node scripts/export-db-to-csv.ts [--out <path.zip>] [--schema public] [--tables users,jobs]
 *
 * --out      Output zip path. Defaults to db-export-<ISO timestamp>.zip in cwd.
 * --schema   Schema to export. Defaults to "public".
 * --tables   Comma-separated allowlist of table names. Defaults to every
 *            base table in the schema.
 *
 * DB_TLS_SERVERNAME: when connecting through a local SSM tunnel, DB_HOST is
 * "localhost", which does not match the RDS server certificate's hostname.
 * Set this to the real RDS endpoint so certificate hostname verification
 * checks the right name instead of failing on "localhost". Defaults to
 * DB_HOST (correct when connecting directly, e.g. from the bastion itself).
 */

import { Client } from 'pg';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as tls from 'tls';
import { execFileSync } from 'child_process';

interface ExportArgs {
  out: string;
  schema: string;
  tables: string[] | null;
}

function parseArgs(argv: string[]): ExportArgs {
  const known = new Set(['--out', '--schema', '--tables']);
  const collected: Record<string, string> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!known.has(flag)) {
      throw new Error(`Unrecognized argument: ${flag}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for flag: ${flag}`);
    }
    collected[flag] = value;
    i += 1;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  return {
    out: collected['--out'] ?? `db-export-${timestamp}.zip`,
    schema: collected['--schema'] ?? 'public',
    tables: collected['--tables']
      ? collected['--tables'].split(',').map((t) => t.trim()).filter(Boolean)
      : null,
  };
}

function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  let str: string;
  if (value instanceof Date) {
    str = value.toISOString();
  } else if (typeof value === 'object') {
    str = JSON.stringify(value);
  } else {
    str = String(value);
  }
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

async function listTables(
  client: Client,
  schema: string,
): Promise<string[]> {
  const result = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
    [schema],
  );
  return result.rows.map((r) => r.table_name as string);
}

async function exportTable(
  client: Client,
  schema: string,
  table: string,
  destPath: string,
): Promise<number> {
  const result = await client.query(
    `SELECT * FROM "${schema}"."${table}"`,
  );
  const fields = result.fields.map((f) => f.name);
  const lines = [fields.map(csvField).join(',')];
  for (const row of result.rows) {
    lines.push(fields.map((f) => csvField(row[f])).join(','));
  }
  fs.writeFileSync(destPath, lines.join('\n') + '\n', 'utf-8');
  return result.rowCount ?? result.rows.length;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const client = new Client({
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    database: process.env.DB_NAME ?? 'jale',
    user: process.env.DB_USER ?? 'jale_admin',
    password: process.env.DB_PASSWORD,
    ssl:
      process.env.DB_SSL === 'true'
        ? {
            rejectUnauthorized: true,
            ca: fs.readFileSync(
              path.join(__dirname, '../lambda/lib/rds-ca-bundle.pem'),
              'utf-8',
            ),
            checkServerIdentity: (_hostname: string, cert: object) =>
              tls.checkServerIdentity(
                process.env.DB_TLS_SERVERNAME ??
                  process.env.DB_HOST ??
                  'localhost',
                cert as never,
              ),
          }
        : false,
  });

  await client.connect();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jale-db-export-'));

  try {
    const tables = args.tables ?? (await listTables(client, args.schema));
    if (tables.length === 0) {
      console.error(`No base tables found in schema "${args.schema}".`);
      process.exitCode = 1;
      return;
    }

    console.log(`>> Exporting ${tables.length} table(s) from schema "${args.schema}"...`);

    for (const table of tables) {
      const destPath = path.join(tmpDir, `${table}.csv`);
      try {
        const rowCount = await exportTable(client, args.schema, table, destPath);
        console.log(`   ${table}: ${rowCount} row(s)`);
      } catch (err) {
        console.error(
          `   ${table}: FAILED — ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    const outPath = path.resolve(args.out);
    fs.rmSync(outPath, { force: true });
    execFileSync('zip', ['-r', '-q', outPath, '.'], { cwd: tmpDir });

    console.log(`>> Done. Archive written to ${outPath}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await client.end();
  }
}

if (require.main === module) {
  void main();
}
