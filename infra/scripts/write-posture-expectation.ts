/**
 * The posture expectation of the release being deployed, written by the
 * deploy job just before the database posture gate
 * (`.github/workflows/_reusable-deploy.yml`, "Database posture gate"):
 *
 *   cd infra && npx --no-install tsx scripts/write-posture-expectation.ts <file>
 *
 * The file is one JSON object:
 *   - manifest: the merged access manifest (`loadManifest()`);
 *   - change_log: the audit change log (`loadChangeLog()`);
 *   - manifest_sha256 and change_log_sha256: their digests
 *     (`manifestDigest()`, `changeLogDigest()`).
 *
 * The gate (`scripts/db-posture-gate.mjs --phase pre --expected <file>`)
 * sends the manifest and the change log to the posture function, which then
 * checks the database against this release's expectation rather than the one
 * bundled at its own last deploy. The gate accepts the report only when its
 * digests are the ones written here.
 *
 * The loaders and the digests are the library's own, the ones the posture
 * function calls, so the two sides cannot disagree on either. The writer
 * writes the one file it is given and nothing else, and prints only that
 * path. Any failure is one fixed line and exit 1; bad arguments are exit 2.
 */
import * as fs from 'fs';
import { loadManifest, manifestDigest, type AccessManifest } from '../db/access/access-manifest';
import { changeLogDigest, loadChangeLog, type ChangeLog } from '../db/access/posture-audit';

export interface PostureExpectation {
  manifest: AccessManifest;
  change_log: ChangeLog;
  manifest_sha256: string;
  change_log_sha256: string;
}

export const USAGE = 'usage: npx --no-install tsx scripts/write-posture-expectation.ts <output-file>';
export const WRITE_ERROR = '::error::The posture expectation could not be written.';

/** This checkout's merged manifest and change log, with their digests. */
export function buildPostureExpectation(): PostureExpectation {
  const manifest = loadManifest();
  const changeLog = loadChangeLog();
  return {
    manifest,
    change_log: changeLog,
    manifest_sha256: manifestDigest(manifest),
    change_log_sha256: changeLogDigest(changeLog),
  };
}

/** Writes the expectation to `file`, and only there. */
export function writePostureExpectation(file: string): PostureExpectation {
  const expectation = buildPostureExpectation();
  fs.writeFileSync(file, `${JSON.stringify(expectation)}\n`);
  return expectation;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === '') {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
  } else {
    try {
      writePostureExpectation(args[0]);
      process.stdout.write(`wrote ${args[0]}\n`);
    } catch {
      process.stdout.write(`${WRITE_ERROR}\n`);
      process.exitCode = 1;
    }
  }
}
