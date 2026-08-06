/**
 * Backfill jobs.city / jobs.state_region from jobs.location for existing rows.
 *
 * Only touches jobs where city IS NULL AND location IS NOT NULL (that filter
 * lives in list_jobs_missing_geo() below, migration 061), so it is safe to
 * re-run: a row already backfilled (or one an employer has since edited
 * directly) is never revisited. A location the parser can't confidently
 * handle is left NULL rather than guessed -- see
 * infra/lambda/lib/job-location-parse.ts for exactly what it recognizes.
 *
 * Reads and writes go through two SECURITY DEFINER functions
 * (list_jobs_missing_geo(), set_job_geo()), not raw SELECT/UPDATE on jobs.
 * jobs is ENABLE+FORCE ROW LEVEL SECURITY (migration 003) with owner-keyed
 * policies on app.current_user_id; this script connects as jale_admin with
 * no Cognito sub (there is no request to derive one from), so a raw query
 * here would silently see/affect zero rows under those policies. The two
 * functions carry their own narrow capability-flag policies for exactly this
 * case -- see migration 061's "Geo backfill access" section for the full
 * rationale. set_job_geo() also re-validates city/state_region server-side
 * and raises on a bad state code, so a malformed parse result can never be
 * written even if this script's own validation were bypassed.
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
    const { rows } = await client.query<JobRow>(`SELECT * FROM list_jobs_missing_geo()`);

    console.log(`${dryRun ? '[dry-run] ' : ''}Found ${rows.length} job(s) with city IS NULL and location IS NOT NULL.`);

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
        // set_job_geo() re-validates city/state_region and its own UPDATE is
        // guarded by `AND city IS NULL` (same guard the old raw SQL here
        // used to carry) -- so this is safe even if two runs overlap, or an
        // employer sets city via the Edit modal between this job being
        // listed and this call landing: whichever write reaches the row
        // first wins, and the loser's set_job_geo() call returns false
        // without clobbering it.
        const res = await client.query<{ set_job_geo: boolean }>(
          `SELECT set_job_geo($1, $2, $3)`,
          [job.id, result.city, result.state_region],
        );
        if (res.rows[0]?.set_job_geo) updated += 1;
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
