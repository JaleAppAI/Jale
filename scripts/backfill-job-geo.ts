/**
 * Backfill jobs.city / jobs.state_region from jobs.location for existing rows.
 *
 * Only touches jobs where city IS NULL, so it is safe to re-run: a row already
 * backfilled (or one an employer has since edited directly) is never revisited.
 * A location the parser can't confidently handle is left NULL rather than
 * guessed -- see infra/lambda/lib/job-location-parse.ts for exactly what it
 * recognizes.
 *
 * Usage (from the infra/ directory, so `pg`/`ts-node` resolve; or set
 * NODE_PATH=<repo>/infra/node_modules and TS_NODE_PROJECT=<repo>/infra/tsconfig.json
 * to run from elsewhere):
 *   cd infra
 *   DATABASE_URL=postgres://jale_admin:<pw>@<host>:5432/jale \
 *   npx ts-node ../scripts/backfill-job-geo.ts               # dry run (default)
 *
 *   DATABASE_URL=... npx ts-node ../scripts/backfill-job-geo.ts --dry-run   # explicit, same as default
 *   DATABASE_URL=... npx ts-node ../scripts/backfill-job-geo.ts --apply     # writes
 *
 * DATABASE_URL may also carry `?sslmode=require`; TLS is left to the
 * connection string / pg defaults here rather than bundling the RDS CA, since
 * this script is meant to run wherever an operator already has DB access
 * (bastion tunnel, etc.), not exclusively inside the VPC.
 */

import { Client } from 'pg';
import { parseJobLocation } from '../infra/lambda/lib/job-location-parse';

interface JobRow {
  id: string;
  location: string | null;
}

async function main(): Promise<void> {
  // Default is dry-run; --dry-run is accepted explicitly (a no-op, same as the
  // default) so an operator can be unambiguous in a runbook. --apply is the
  // only flag that turns writes on. Any other/unrecognized flag is rejected
  // rather than silently falling back to dry-run, since a typo'd --appyl
  // should never be mistaken for a safe no-op.
  const args = process.argv.slice(2);
  const KNOWN_FLAGS = new Set(['--dry-run', '--apply']);
  const unknown = args.filter((a) => !KNOWN_FLAGS.has(a));
  if (unknown.length > 0) {
    console.error(`Unrecognized argument(s): ${unknown.join(', ')}. Expected --dry-run or --apply.`);
    process.exit(1);
  }
  if (args.includes('--dry-run') && args.includes('--apply')) {
    console.error('Pass either --dry-run or --apply, not both.');
    process.exit(1);
  }
  const dryRun = !args.includes('--apply');

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is required.');
    process.exit(1);
  }

  const client = new Client({ connectionString });
  await client.connect();

  let parsed = 0;
  let unparseable = 0;
  let updated = 0;

  try {
    const { rows } = await client.query<JobRow>(
      `SELECT id, location FROM jobs WHERE city IS NULL ORDER BY created_at`,
    );

    console.log(`${dryRun ? '[dry-run] ' : ''}Found ${rows.length} job(s) with city IS NULL.`);

    for (const job of rows) {
      const result = parseJobLocation(job.location);
      if (!result) {
        unparseable += 1;
        console.log(`SKIP  ${job.id}  location=${JSON.stringify(job.location)} -> unparseable`);
        continue;
      }

      parsed += 1;
      console.log(
        `${dryRun ? 'WOULD SET' : 'SET'}   ${job.id}  location=${JSON.stringify(job.location)} -> city=${result.city}, state_region=${result.state_region}`,
      );

      if (!dryRun) {
        // WHERE city IS NULL again here: idempotent even if two runs overlap,
        // and never clobbers a value an employer or another process already set.
        const res = await client.query(
          `UPDATE jobs SET city = $2, state_region = $3 WHERE id = $1 AND city IS NULL`,
          [job.id, result.city, result.state_region],
        );
        if (res.rowCount === 1) updated += 1;
      }
    }

    console.log('');
    console.log(`${dryRun ? '[dry-run] ' : ''}Summary: ${rows.length} scanned, ${parsed} parsed, ${unparseable} unparseable${dryRun ? '' : `, ${updated} updated`}.`);
    if (dryRun) {
      console.log('Re-run with --apply to write these changes.');
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('backfill-job-geo failed:', err);
  process.exit(1);
});
