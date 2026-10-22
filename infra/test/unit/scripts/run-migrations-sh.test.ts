import { execFileSync, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

const repoRoot = path.join(__dirname, '..', '..', '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'run-migrations.sh');
const migrationsDir = path.join(repoRoot, 'infra', 'db', 'migrations');

function readScript(): string {
  return fs.readFileSync(scriptPath, 'utf8');
}

/**
 * These tests exist because of a specific production incident, not for
 * coverage. The previous revision of this script inlined every migration as
 * base64 into one shell argument. Linux caps a single argv entry at 128 KiB,
 * the corpus was over 400 KiB, so `jq` died with E2BIG, the command
 * substitution collapsed to an empty string, and `aws ssm send-command` was
 * handed an empty command list. SSM ran nothing and exited 0, and the script
 * printed ">> All done." — a fully green run that applied zero migrations.
 *
 * Each test below pins one of the properties that makes that failure
 * impossible to reproduce.
 */
describe('run-migrations.sh', () => {
  it('never passes the SSM payload through argv', () => {
    const script = readScript();

    // The payload must reach the AWS CLI through a file, not an argument.
    expect(script).toContain('--cli-input-json');
    expect(script).toMatch(/--cli-input-json\s+"file:\/\/\$request"/);

    // The old shape — building the parameters inline via command substitution
    // in an argument — is what blew the argv limit. It must not come back.
    expect(script).not.toMatch(/--parameters\s+"commands=\$\(/);
    expect(script).not.toMatch(/--parameters\s+'commands=\$\(/);
  });

  it('refuses to send an empty or command-less payload', () => {
    const script = readScript();

    // Guard the script file itself before building a request.
    expect(script).toMatch(/refusing to send an empty script/);
    // Guard the assembled request.
    expect(script).toMatch(/built an empty SSM request/);
    // Guard that the request actually carries a command, which is the exact
    // state the incident produced.
    expect(script).toContain("jq -e '.Parameters.commands[0] | length > 0'");
    expect(script).toMatch(/carries no command/);
  });

  it('does not treat SSM Success as proof the work happened', () => {
    const script = readScript();

    // A sentinel is printed by the remote script as its final act, and the
    // run fails unless it comes back.
    expect(script).toContain('SENTINEL="__JALE_MIGRATION_RUN_OK__"');
    expect(script).toMatch(/grep -q "\$SENTINEL"/);
    expect(script).toMatch(/never printed the completion sentinel/);
  });

  it('does not mistake SSM output truncation for failure', () => {
    const script = readScript();

    // SSM truncates inline output around 24 KB, which can swallow the
    // sentinel from a run that completed. Absence of the sentinel is only
    // conclusive when the output was not truncated.
    expect(script).toContain("grep -q -- '---Output truncated---'");
    expect(script).toMatch(/falling back to state verification/);
  });

  it('reads command output through the API that does not truncate at 2.5 KB', () => {
    const script = readScript();

    // list-command-invocations truncates its Output field at roughly 2,500
    // characters. That cut a 51-row ledger read off at 28 rows and produced a
    // bogus "migration edited on disk" alarm. get-command-invocation returns
    // up to 24,000 characters.
    expect(script).toContain('aws ssm get-command-invocation');
    expect(script).toContain('--query "StandardOutputContent"');
    expect(script).not.toContain('aws ssm list-command-invocations');
  });

  it('waits for a command on the ops host a bounded time, a little over Run Command\'s default timeouts', () => {
    const script = readScript();
    const poll = Number(script.match(/^SSM_POLL_SECONDS=(\d+)$/m)?.[1]);
    const polls = Number(script.match(/^SSM_MAX_POLLS=(\d+)$/m)?.[1]);
    expect(poll).toBe(5);
    expect(polls).toBe(1500);
    // The defaults: an hour to deliver a command and an hour to run it. The
    // reads have a wait between each two, so the least time the bound takes
    // is one wait fewer than the reads.
    expect((polls - 1) * poll).toBeGreaterThan(2 * 3600);
    expect(poll * polls).toBeLessThanOrEqual(2 * 3600 + 600);
    // The message states the bound as it is kept: a number of reads, and the
    // least time they take.
    expect(script).toContain('did not finish on the ops host after $SSM_MAX_POLLS status reads (at least $(( (SSM_MAX_POLLS - 1) * SSM_POLL_SECONDS / 60 )) minutes)');
    expect(script).not.toContain('did not finish on the ops host within');
    // A failed status read is never taken for a command still running.
    expect(script).not.toContain('|| echo "Pending"');
  });

  it('proves success from database state, not from stdout', () => {
    const script = readScript();

    expect(script).toMatch(/^verify_ledger\(\) \{/m);
    // The verifier re-reads the ledger and compares checksums per file.
    expect(script).toMatch(/SELECT filename, coalesce\(checksum,''\) FROM \$LEDGER_TABLE/);
    expect(script).toMatch(/could not be verified against database state/);
    // And it runs after the batches, on the set that was meant to change.
    expect(script).toMatch(/verify_ledger PENDING/);
  });

  it('keeps a migration ledger so applied migrations are never replayed', () => {
    const script = readScript();

    expect(script).toContain('LEDGER_TABLE="public.schema_migrations"');
    expect(script).toContain('CREATE TABLE IF NOT EXISTS public.schema_migrations');
    expect(script).toMatch(/INSERT INTO \$LEDGER_TABLE \(filename, checksum\)/);
    expect(script).toContain('ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum;');

    // Replaying the whole chain must be an explicit, argued-for choice:
    // migration 042 self-audits its ten-value step-key CHECK and raises once
    // 050 widens it to seventeen.
    expect(script).toContain('--force-replay');
  });

  it('verifies each migration survived the transfer before applying it', () => {
    const script = readScript();

    expect(script).toMatch(/decoded to nothing/);
    expect(script).toMatch(/failed checksum verification after transfer/);
    expect(script).toMatch(/sha256sum \/tmp\/jale-mig\.sql/);
  });

  it('refuses to run a migration that was edited after it was applied', () => {
    const script = readScript();

    expect(script).toMatch(/changed on disk after they were applied/);
    expect(script).toMatch(/an applied migration must never be edited/);
  });

  it('keeps role-password rotation opt-in, separate from applying migrations', () => {
    const script = readScript();

    expect(script).toContain('--rotate-secrets');
    expect(script).toMatch(/ROTATE_SECRETS=false/);

    // Rotation must sit behind the flag, not run unconditionally.
    const rotationIndex = script.indexOf('ALTER ROLE jale_whatsapp WITH PASSWORD');
    const guardIndex = script.indexOf('if $ROTATE_SECRETS; then');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(rotationIndex).toBeGreaterThan(guardIndex);

    // Password material is still scrubbed on the bastion.
    expect(script).toMatch(/unset[^\n]*PGPASSWORD/);
    expect(script).toMatch(/unset[^\n]*WA_PW/);
  });

  it('never prints password material', () => {
    const script = readScript();

    expect(script).not.toMatch(/echo\s+"?\$WA_PW"?/);
    expect(script).not.toMatch(/echo\s+"?\$PGPASSWORD"?/);
    expect(script).not.toMatch(/echo\s+"?\$MATCHING_PW"?/);
    expect(script).not.toMatch(/echo\s+"?\$BILLING_PW"?/);
    expect(script).not.toMatch(/echo\s+"?\$PUBLIC_JOBS_PW"?/);
  });

  it('syncs jale_public_jobs and PROVES the login before reporting success', () => {
    const script = readScript();

    // The sync itself, from the CDK-generated secret.
    expect(script).toContain('ALTER ROLE jale_public_jobs WITH PASSWORD');
    // The self-test: a real login as the role, against the one table it exists
    // for, so vault/database drift dies on the bastion instead of surfacing as
    // a public page that 500s every request.
    expect(script).toContain('-U jale_public_jobs');
    expect(script).toContain('SELECT count(*) FROM jobs WHERE public_listing_enabled');
    expect(script).toContain('jale_public_jobs credential check FAILED');
    // A rotate must never silently skip the sync when the secret is missing.
    expect(script).toContain('refusing to silently skip the jale_public_jobs password sync');
    // The password variable is wiped with the others.
    expect(script).toMatch(/unset PGPASSWORD.*PUBLIC_JOBS_PW/);
    // Fresh-bootstrap warnings name the role so an operator cannot miss it.
    expect(script).toContain('jale_whatsapp, jale_public_jobs.');
  });

  it('fails fast when the manifest and the migrations directory disagree', () => {
    const script = readScript();

    expect(script).toMatch(/manifest lists files absent from/);
    expect(script).toMatch(/missing from the manifest/);
  });

  it('bounds --baseline-through at the named file, and warns that a baseline past the real state skips work', () => {
    const script = readScript();

    expect(script).toContain('--baseline-through');
    // It must name a real manifest entry.
    expect(script).toMatch(/is not in the manifest/);
    // The loop stops at the named file, so migrations after it are still
    // executed rather than recorded.
    expect(script).toMatch(/if \[\[ "\$f" == "\$BASELINE_THROUGH" \]\]; then found=true; break; fi/);
    // Baseline membership decides per file, not globally.
    expect(script).toMatch(/if \[\[ -n "\$\{BASELINE_ONLY\[\$f\]:-\}" \]\]/);
    // Nothing checks the recorded files against the database, so a FILE
    // past the real state records unapplied migrations, which then never
    // run. The help says so, and nothing promises otherwise.
    const help = execFileSync('bash', [scriptPath, '--help'], { encoding: 'utf8' }).replace(/\s*\n#?\s*/g, ' ');
    expect(help).toContain('records the ones in between as applied, and they are never run');
    expect(help).toContain('Verify the database\'s state on its own before choosing FILE.');
    expect(script).not.toMatch(/cannot (silently )?skip real work|never about the future/);
  });

  it('accounts for the APPLY_ONE wrapper bytes, not just the base64 payload, when packing batches', () => {
    const script = readScript();

    // The batch packer must charge the per-file heredoc wrapper — filename
    // and checksum substitutions — on top of the encoded payload, both in
    // the running batch total and in the per-file ceiling check. Otherwise
    // the cap only counts what encode_migration produces, not what SSM
    // actually receives.
    expect(script).toMatch(/APPLY_ONE_FIXED_BYTES=\d+/);
    expect(script).toContain('APPLY_ONE_FILENAME_OCCURRENCES');
    expect(script).toContain('APPLY_ONE_CHECKSUM_OCCURRENCES');
    expect(script).toMatch(
      /fsize=\$\(\(\s*fsize \+ APPLY_ONE_FIXED_BYTES/,
    );
  });

  it('seeds batch_bytes with the preamble cost on every flush, not just the first batch', () => {
    const script = readScript();

    expect(script).toMatch(/PREAMBLE_BYTES=\$\(\s*\{\s*emit_pg_preamble;\s*emit_ledger_ddl;\s*\}\s*\|\s*wc -c\s*\)/);
    expect(script).toContain('batch_bytes=$PREAMBLE_BYTES');

    // Both the initial declaration and the reset inside flush_batch() must
    // use the preamble cost, not a bare 0.
    const occurrences = script.match(/batch_bytes=\$PREAMBLE_BYTES/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });

  it('hard-fails in run_on_bastion when the rendered script exceeds the SSM payload ceiling', () => {
    const script = readScript();

    expect(script).toMatch(/script_bytes=\$\(wc -c < "\$script_file"\)/);
    expect(script).toMatch(/over the \$\{MAX_PAYLOAD_BYTES\}B SSM payload ceiling/);
  });

  it('is strict about truncated output only for the ledger read, not for apply/verify/rotate', () => {
    const script = readScript();

    // The ledger read passes strict_truncation=true and dies rather than
    // proceeding on a partial read.
    expect(script).toMatch(/run_on_bastion "\$WORKDIR\/read-ledger\.sh" "read migration ledger" true/);
    expect(script).toMatch(/cannot plan from partial state/);

    // apply_batch, verify_ledger, and rotate must NOT pass strict=true —
    // truncation there is waived because verify_ledger() re-reads database
    // state afterward.
    expect(script).not.toMatch(/run_on_bastion "\$script" "\$label" true/);
    expect(script).not.toMatch(/run_on_bastion "\$WORKDIR\/verify\.sh" "verify ledger" true/);
    expect(script).not.toMatch(/run_on_bastion "\$WORKDIR\/rotate\.sh" "rotate role secrets" true/);
  });

  it('refuses to report success from a fresh-database bootstrap without provisioning role credentials', () => {
    const script = readScript();

    expect(script).toContain('FRESH_DATABASE=false');
    expect(script).toMatch(/FRESH_DATABASE=true/);
    expect(script).toMatch(/refusing to report success from a fresh-database bootstrap/);

    // Names every role left without a usable password, and says which secret
    // will not exist (by its role: a secret's name is never printed).
    expect(script).toMatch(/jale_matching, jale_admin_console, jale_billing, jale_whatsapp/);
    expect(script).toContain("The WhatsApp login's secret does not exist.");

    // The guard only fires without --rotate-secrets AND without the new
    // --skip-secrets acknowledgment.
    expect(script).toMatch(/\$FRESH_DATABASE && \(\( \$\{n_exec:-0\} > 0 \)\) && ! \$ROTATE_SECRETS && ! \$SKIP_SECRETS/);
  });

  it('adds --skip-secrets as an explicit, documented opt-out of the fresh-bootstrap guard', () => {
    const script = readScript();

    expect(script).toContain('--skip-secrets');
    expect(script).toContain('SKIP_SECRETS=false');
    expect(script).toMatch(/--skip-secrets\)\s*SKIP_SECRETS=true/);
    // Documented in the usage comment block.
    expect(script).toMatch(/#\s+--skip-secrets\s+Acknowledge that a fresh-database bootstrap/);

    // --rotate-secrets remains opt-in on its own; --skip-secrets never
    // implies or triggers rotation.
    expect(script).toContain('ROTATE_SECRETS=false');
  });

  /**
   * F16. A data migration reports what it actually touched with `RAISE
   * NOTICE` ("backfilled N rows"). psql writes notices to STDERR, and
   * `run_on_bastion` only ever prints SSM's `StandardOutputContent` on a
   * successful command -- `StandardErrorContent` is fetched only when the
   * command FAILS. So every row count a migration raised was thrown away on
   * exactly the runs that succeeded, which are the runs an operator needs
   * them on.
   *
   * This test does not pin text: it RENDERS the real APPLY_ONE heredoc with
   * the same shell that renders it in production, then EXECUTES the result
   * against a stub psql that raises a notice, and asserts the notice reaches
   * stdout. The old shape (`"${PG[@]}" -f /tmp/jale-mig.sql` with no
   * redirection) lets that notice escape to the process's own stderr, where
   * SSM would drop it -- so this fails on the pre-fix script.
   */
  it('surfaces a migration\'s RAISE NOTICE output on stdout, where SSM can return it', () => {
    const script = readScript();

    // The per-file apply block, verbatim, INCLUDING its `cat >> ... <<APPLY_ONE`
    // opener and terminator -- rendered by bash itself so no substitution rule
    // has to be re-implemented (and mis-implemented) here.
    const emit = script.match(/(^ *cat >> "\$script" <<APPLY_ONE\n[\s\S]*?^APPLY_ONE$)/m);
    expect(emit).not.toBeNull();

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jale-mig-notice-'));
    try {
      const sql = 'SELECT 1;\n';
      const b64 = zlib.gzipSync(Buffer.from(sql)).toString('base64');
      const sum = crypto.createHash('sha256').update(sql).digest('hex');

      // Stub psql: `-f <file>` is the migration apply and raises a NOTICE on
      // stderr exactly as psql does; everything else (the ledger INSERT) is a
      // silent success.
      const stub = path.join(tmp, 'psql');
      fs.writeFileSync(stub, [
        '#!/bin/bash',
        'for a in "$@"; do',
        '  if [[ "$a" == "-f" ]]; then',
        '    echo "NOTICE:  backfilled 42 rows" >&2',
        '    echo "UPDATE 42"',
        '    exit 0',
        '  fi',
        'done',
        'exit 0',
      ].join('\n') + '\n', { mode: 0o755 });

      const rendered = path.join(tmp, 'rendered.sh');
      const renderer = path.join(tmp, 'render.sh');
      fs.writeFileSync(renderer, [
        '#!/bin/bash',
        'set -euo pipefail',
        `f='095_data_backfill.sql'`,
        `sum='${sum}'`,
        `b64='${b64}'`,
        `LEDGER_TABLE='public.schema_migrations'`,
        `script='${rendered}'`,
        emit![1],
      ].join('\n') + '\n', { mode: 0o755 });
      execFileSync('bash', [renderer], { stdio: 'pipe' });

      // Run the rendered block the way the bastion would: `set -euo pipefail`
      // plus the PG array the preamble defines. STDERR is deliberately NOT
      // merged into stdout here -- that is the whole point: SSM returns
      // StandardOutputContent, so the notice has to already be on stdout.
      const runner = path.join(tmp, 'run.sh');
      fs.writeFileSync(runner, [
        '#!/bin/bash',
        'set -euo pipefail',
        `PG=('${stub}')`,
        `source '${rendered}'`,
      ].join('\n') + '\n', { mode: 0o755 });

      const stdout = execFileSync('bash', [runner], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

      expect(stdout).toContain('-> 095_data_backfill.sql');
      expect(stdout).toContain('NOTICE:  backfilled 42 rows');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync('/tmp/jale-mig.sql', { force: true });
      fs.rmSync('/tmp/jale-mig.err', { force: true });
    }
  });

  /**
   * F16's other half: making notices visible must not cost the failure
   * diagnosis. On a psql failure the captured stderr has to go BACK to
   * stderr, because that is the only stream `run_on_bastion` reads
   * (`StandardErrorContent`) when a command ends Failed.
   */
  it('still reports a failed migration on stderr, where SSM reads it on failure', () => {
    const script = readScript();

    const emit = script.match(/(^ *cat >> "\$script" <<APPLY_ONE\n[\s\S]*?^APPLY_ONE$)/m);
    expect(emit).not.toBeNull();

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jale-mig-fail-'));
    try {
      const sql = 'SELECT 1;\n';
      const b64 = zlib.gzipSync(Buffer.from(sql)).toString('base64');
      const sum = crypto.createHash('sha256').update(sql).digest('hex');

      const stub = path.join(tmp, 'psql');
      fs.writeFileSync(stub, [
        '#!/bin/bash',
        'for a in "$@"; do',
        '  if [[ "$a" == "-f" ]]; then',
        '    echo "ERROR:  relation \\"nope\\" does not exist" >&2',
        '    exit 3',
        '  fi',
        'done',
        'exit 0',
      ].join('\n') + '\n', { mode: 0o755 });

      const rendered = path.join(tmp, 'rendered.sh');
      const renderer = path.join(tmp, 'render.sh');
      fs.writeFileSync(renderer, [
        '#!/bin/bash',
        'set -euo pipefail',
        `f='095_data_backfill.sql'`,
        `sum='${sum}'`,
        `b64='${b64}'`,
        `LEDGER_TABLE='public.schema_migrations'`,
        `script='${rendered}'`,
        emit![1],
      ].join('\n') + '\n', { mode: 0o755 });
      execFileSync('bash', [renderer], { stdio: 'pipe' });

      const runner = path.join(tmp, 'run.sh');
      fs.writeFileSync(runner, [
        '#!/bin/bash',
        'set -euo pipefail',
        `PG=('${stub}')`,
        `source '${rendered}'`,
      ].join('\n') + '\n', { mode: 0o755 });

      let failed = false;
      let stderr = '';
      try {
        execFileSync('bash', [runner], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err: any) {
        failed = true;
        stderr = String(err.stderr ?? '');
      }

      // A failing migration must still abort the remote script (non-zero) and
      // the reason must be on stderr.
      expect(failed).toBe(true);
      expect(stderr).toContain('ERROR:');
      expect(stderr).toContain('does not exist');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync('/tmp/jale-mig.sql', { force: true });
      fs.rmSync('/tmp/jale-mig.err', { force: true });
    }
  });

  it('lists every migration on disk, in sorted order', () => {
    const script = readScript();
    const onDisk = fs.readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort();

    const block = script.match(/^MIGRATIONS=\(([\s\S]*?)^\)/m);
    expect(block).not.toBeNull();

    const listed = block![1].match(/\d{3}b?_[a-zA-Z0-9_]+\.sql/g) ?? [];
    expect(listed).toEqual(onDisk);
  });
});

// ===========================================================================
// Least-privilege credential preparation.
//
//   --prepare-logins  creates each new login's secret from an AWS-generated
//                     password (or reuses the secret that exists), sets the
//                     database password from a SCRAM-SHA-256 verifier, and
//                     proves the login signs in.
//   posture control   every run first reads, as the master login, the
//                     row_security_active reading on public.users and the
//                     engine version, and stops if either moved. The
//                     reading's baseline comes from the operator
//                     (POSTURE_BASELINE_MASTER_ROW_SECURITY, t or f), never
//                     from the script, and a run without a valid one is
//                     refused before anything reaches AWS.
//   --rotate-secrets  now sends verifiers, never plaintext, and no secret
//                     value travels through argv.
//
// The static checks pin the shape; the harness below proves the behaviour by
// running the REAL script against a fake AWS CLI that executes every SSM
// payload on a fake ops host, where every external command is a recording
// wrapper, so "no secret in argv" is checked against what actually ran.
// ===========================================================================

/**
 * The least-privilege logins the migrations create, with their connection
 * limits and kinds, as the access manifest lists them. The script itself
 * holds no such list: it reads the manifest's entries marked
 * "prepare_secret": true.
 */
const LEAST_PRIVILEGE_LOGINS: ReadonlyArray<readonly [string, number, string]> = [
  ['jale_api', -1, 'request'],
  ['jale_api_public', -1, 'public'],
  ['jale_job_email_sender', 5, 'job'],
  ['jale_job_visibility_drain', 5, 'job'],
  ['jale_job_digest', 5, 'job'],
  ['jale_job_ses_feedback', 5, 'job'],
  ['jale_job_retention', 5, 'job'],
  ['jale_posture', 2, 'posture'],
];
const REAL_MANIFEST = path.join(repoRoot, 'infra', 'db', 'access', 'manifest.json');
const REAL_FRAGMENT_DIR = path.join(repoRoot, 'infra', 'db', 'access', 'manifest.d');
const SYNC_LOGIN = 'jale_ai';
/** The WhatsApp login's secret, as --rotate-secrets names it (read from the script, not restated). */
const WA_SECRET = readScript().match(/^WA_DB_SECRET_NAME="([^"]+)"$/m)![1];
const ALL_PREPARED = [...LEAST_PRIVILEGE_LOGINS.map(([login]) => login), SYNC_LOGIN];

/** The agreed secret-name rule, restated here so this file never spells a name out. */
function ruleSecretName(login: string): string {
  return `jale/${login.replace(/^jale_/, '').replace(/_/g, '-')}/db`;
}

/**
 * The agreed login-name rule, restated: "jale_" and lowercase ASCII words
 * joined by single underscores. The CDK secret-name helper enforces it too.
 */
const SHARED_LOGIN_NAME = /^jale_[a-z0-9]+(?:_[a-z0-9]+)*$/;
const LOGIN_NAME_SAMPLES = [
  'jale_api', 'jale_api_public', 'jale_2fa_sender', 'jale_job_report_cleanup',
  'jale_job__doubled', 'jale_job_trailing_', 'jale_', 'jale_API', 'jale_job_\u00e9',
  'jale_job-x', 'jale_a b', "x'; DROP ROLE y; --", 'api',
];
const CDK_NAME_HELPER = path.join(repoRoot, 'infra', 'lib', 'constructs', 'db-login-secrets.ts');

/** The operator's baseline for the posture control's master reading: t or f. */
const POSTURE_BASELINE_VARIABLE = 'POSTURE_BASELINE_MASTER_ROW_SECURITY';
type PostureReading = 't' | 'f';
const POSTURE_READINGS: readonly PostureReading[] = ['t', 'f'];
const otherReading = (reading: PostureReading): PostureReading => (reading === 't' ? 'f' : 't');
/**
 * The harness's default baseline, and the fake ops host's default reading,
 * which agree. Picked per run, like the fake database address below, so the
 * default favours neither value; the posture tests run both explicitly.
 */
const HARNESS_POSTURE: PostureReading = POSTURE_READINGS[crypto.randomInt(POSTURE_READINGS.length)];

/**
 * A heredoc's body as written in the script. For an unquoted heredoc (such as
 * ROTATE) that is the source text, where `\$` is a literal `$` on the ops host.
 */
function heredocBody(script: string, tag: string): string {
  const m = script.match(new RegExp(`<<(?:'${tag}'|${tag})\\n([\\s\\S]*?)^${tag}$`, 'm'));
  if (!m) throw new Error(`heredoc ${tag} not found`);
  return m[1];
}

describe('run-migrations.sh: credential preparation and the posture control (static)', () => {
  it('documents --prepare-logins, --only and --accept-posture-change, and --help prints exactly the usage block', () => {
    const script = readScript();
    expect(script).toMatch(/^#\s+--prepare-logins\b/m);
    expect(script).toMatch(/^#\s+--only LOGIN\b/m);
    expect(script).toMatch(/^#\s+--accept-posture-change\b/m);

    const help = execFileSync('bash', [scriptPath, '--help'], { encoding: 'utf8' });
    expect(help).toContain('--prepare-logins');
    expect(help).toContain('--only LOGIN');
    expect(help).toContain('--accept-posture-change');
    expect(help).toContain('--yes');
    expect(help).not.toContain('Why this script is shaped');
  });

  it('holds no login list of its own: the new logins come from the access manifest', () => {
    const script = readScript();
    for (const [login] of LEAST_PRIVILEGE_LOGINS) {
      expect(script).not.toMatch(new RegExp(`\\b${login}\\b`));
    }
    expect(script).toMatch(/^PREPARE_NEW_LOGINS=\(\)$/m);
    expect(script).toContain('infra/db/access');
    expect(script).toMatch(/^ACCESS_MANIFEST="\$ACCESS_DIR\/manifest\.json"$/m);
    // The fragments in manifest.d/ are part of the manifest: merged, never overriding.
    expect(script).toMatch(/^ACCESS_FRAGMENT_DIR="\$ACCESS_DIR\/manifest\.d"$/m);
    expect(script).toContain('"$ACCESS_FRAGMENT_DIR"/*.json');
    expect(script).toContain("map(.logins // {}) | add");
    expect(script).toContain('lists a login in more than one file');
    expect(script).toContain('select(.value.prepare_secret == true)');
    expect(script).toContain('.value.connection_limit');
    // jale_ai keeps its own path: synced from its CDK-generated secret.
    expect(script).toMatch(/^PREPARE_SYNC_LOGINS=\("jale_ai"\)$/m);
  });

  it('checks a login name with the agreed naming rule, through one function, in the C locale', () => {
    // The rule the CDK secret-name helper enforces: a login the stacks accept is
    // never refused here, and nothing else gets through, whatever the
    // operator's locale makes of a range such as [a-z].
    const script = readScript();
    const defs = script.match(/^is_login_name\(\) \{.*\}$/gm) ?? [];
    expect(defs).toHaveLength(1);
    expect(defs[0]).toContain('local LC_ALL=C;');
    expect(script).toContain('is_login_name "$name"');
    expect(script).not.toMatch(/\[\[ "\$name" =~/);
    for (const locale of ['C.UTF-8', 'en_US.UTF-8']) {
      for (const sample of LOGIN_NAME_SAMPLES) {
        const r = spawnSync('bash', ['-c', `${defs[0]}\nis_login_name "$1"`, 'rule', sample], {
          encoding: 'utf8',
          env: { ...process.env, LC_ALL: locale },
        });
        expect({ locale, sample, accepted: r.status === 0 })
          .toEqual({ locale, sample, accepted: SHARED_LOGIN_NAME.test(sample) });
      }
    }
  });

  it('tells the operator to destroy the bastion with deploy-bastion.sh --destroy, never a bare cdk destroy', () => {
    // A bare `npx cdk destroy JaleBastionStack` synthesizes the whole app without
    // the bastion-only and environment context, which the app refuses.
    const script = readScript();
    expect(script).not.toMatch(/cdk destroy JaleBastionStack/);
    const header = script.slice(0, script.indexOf('# Usage:'));
    expect(header).toContain('bash scripts/deploy-bastion.sh --destroy');
    const closing = script.slice(script.lastIndexOf('All done. Next:'));
    expect(closing).toContain('bash scripts/deploy-bastion.sh --destroy');
  });

  it('derives every new secret name from one function that implements the agreed rule', () => {
    const script = readScript();
    const defs = script.match(/^prepare_secret_name\(\) \{\n[\s\S]*?^\}$/gm) ?? [];
    expect(defs).toHaveLength(1);
    for (const [login] of LEAST_PRIVILEGE_LOGINS) {
      const out = execFileSync('bash', ['-c', `${defs[0]}\nprepare_secret_name "$1"`, 'bash', login], { encoding: 'utf8' });
      expect(out).toBe(ruleSecretName(login));
    }
  });

  it('asks AWS for every new password: 40 characters, no punctuation, every character type', () => {
    expect(readScript()).toMatch(
      /aws secretsmanager get-random-password --password-length 40 --exclude-punctuation --require-each-included-type/,
    );
  });

  it('never puts a plaintext password in a statement: no PASSWORD followed by a shell variable remains', () => {
    const script = readScript();
    // `ALTER ROLE ... WITH PASSWORD '$PW'` puts the plaintext into the
    // statement text (server logs, a future audit log) and, through -c, into
    // psql's argv. Only the verifier form may remain.
    expect(script).not.toMatch(/PASSWORD\s+'\\?\$/);
    expect(script).not.toMatch(/PASSWORD\s+"\\?\$/);
    expect(script).not.toMatch(/-c\s+"ALTER ROLE/);
  });

  it('never passes a secret value through argv', () => {
    const script = readScript();
    expect(script).not.toMatch(/--secret-string\s+"\\?\$/);
    expect(script).not.toMatch(/--arg\s+password\b/);
    expect(script).not.toMatch(/--master-user-password/);
    // Values reach the AWS CLI on stdin instead, as a string parameter's file.
    // Never --cli-input-json from a pipe: the AWS CLI reads that file twice,
    // so a pipe arrives empty and the create fails before any request.
    expect(script).not.toMatch(/--cli-input-json\s+"?file:\/\/\/(dev\/stdin|dev\/fd\/0|proc\/self\/fd\/0)/);
    expect(script).toMatch(/create-secret --region "\$REGION" --name "\$2"/);
    expect(script).toMatch(/--secret-string file:\/\/\/dev\/stdin/);
  });

  it('runs the posture control before the ledger is read, and honours --accept-posture-change', () => {
    const script = readScript();
    expect(script).toContain('row_security_active(c.oid)');
    expect(script).toContain("current_setting('server_version_num')");
    expect(script).toContain('ACCEPT_POSTURE_CHANGE=false');
    expect(script).toMatch(/--accept-posture-change\)\s*ACCEPT_POSTURE_CHANGE=true/);

    const posture = script.indexOf('run_on_bastion "$WORKDIR/posture.sh" "posture control" true');
    const ledger = script.indexOf('run_on_bastion "$WORKDIR/read-ledger.sh"');
    expect(posture).toBeGreaterThan(-1);
    expect(ledger).toBeGreaterThan(-1);
    expect(posture).toBeLessThan(ledger);
  });

  it("takes the master reading's baseline from the operator, never from the script, and checks it before any AWS call", () => {
    const script = readScript();
    const code = script.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
    // No expected reading is written in the script: no variable is assigned a
    // literal t or f, and the reading is compared with the operator's value.
    expect(code).not.toMatch(/^\s*[A-Z_]+=["']?[tf]["']?\s*$/m);
    expect(code).toContain(`"$POSTURE_RLS" != "$${POSTURE_BASELINE_VARIABLE}"`);
    // The refusal comes before the first AWS call, and names the variable
    // without expanding it.
    const check = code.search(new RegExp(`^if \\[\\[ "\\$\\{${POSTURE_BASELINE_VARIABLE}:-\\}" != "t"`, 'm'));
    const firstAws = code.search(/^\s*(?:[A-Za-z_]+=\$\()?aws /m);
    expect(check).toBeGreaterThan(-1);
    expect(firstAws).toBeGreaterThan(check);
    const refusal = code.slice(check, code.indexOf('\nfi\n', check));
    expect(refusal).toContain(`!! ${POSTURE_BASELINE_VARIABLE} `);
    expect(refusal).toMatch(/\n\s*exit 1$/);
    for (const line of refusal.split('\n').filter((l) => /^\s*echo /.test(l))) {
      expect(line).not.toContain('$');
    }
  });

  it('leaves --prepare-logins before the ledger, the migrations and --rotate-secrets, and carries no rotation material', () => {
    const script = readScript();
    // The prepare run is followed by an exit, with no other bastion call in
    // between, and all of it sits before the ledger read and the rotation.
    const run = script.indexOf('run_on_bastion "$WORKDIR/prepare-logins.sh" "prepare database logins"');
    expect(run).toBeGreaterThan(-1);
    const exitAt = script.indexOf('\n  exit 0\n', run);
    expect(exitAt).toBeGreaterThan(run);
    expect(script.slice(run + 1, exitAt)).not.toContain('run_on_bastion');
    expect(exitAt).toBeLessThan(script.indexOf('run_on_bastion "$WORKDIR/read-ledger.sh"'));
    expect(exitAt).toBeLessThan(script.indexOf('run_on_bastion "$WORKDIR/rotate.sh"'));

    const payload = heredocBody(script, 'PREPARE_LOGINS') + heredocBody(script, 'CREDENTIAL_LIB');
    expect(payload).not.toContain('openssl');
    expect(payload).not.toContain('put-secret-value');
    expect(payload).not.toContain('jale_whatsapp');
    expect(script).toMatch(/--prepare-logins never runs with --rotate-secrets/);
  });

  it('prints statuses only: no say/warn/fail line interpolates a password, a secret, a host or a verifier', () => {
    const script = readScript();
    const remote = heredocBody(script, 'CREDENTIAL_LIB') + heredocBody(script, 'PREPARE_LOGINS');
    // Every human-readable line goes through say (stdout), warn or fail (stderr).
    expect(remote).not.toMatch(/^\s*echo\b/m);
    const sensitive = /\$\{?(pw|password|json|secret_json|verifier|secret_id|LOGIN_PW|DB_HOST|DB_PORT|DB_NAME|SECRET_JSON|PGPASSWORD|err)\b/;
    for (const line of remote.split('\n').filter((l) => /\b(say|warn|fail)\s/.test(l))) {
      expect(line).not.toMatch(sensitive);
    }
    // printf never prints to the operator: it either pipes data into a
    // command, or hands one raw value to a command substitution.
    for (const line of remote.split('\n').filter((l) => /^\s*printf\b/.test(l))) {
      expect(/\|\s*\\?$|\|\s*\S/.test(line) || /^\s*printf '%s' "\$\w+"$/.test(line)).toBe(true);
    }
  });
});

// ===========================================================================
// --rotate-secrets: the payload's shape. The harness below proves the same
// properties by running it.
// ===========================================================================
describe('run-migrations.sh: --rotate-secrets (static)', () => {
  /** What the rotate run sends to the ops host: its helpers and its steps. */
  function rotatePayload(): string {
    const script = readScript();
    return heredocBody(script, 'ROTATE_LIB') + heredocBody(script, 'ROTATE');
  }

  it('reads every source password strictly: a missing, non-string or short value stops the run', () => {
    const rotate = rotatePayload();
    // `jq -r .password` turns a missing field into the literal "null", exit 0,
    // and the role would get the verifier of "null".
    expect(rotate).not.toMatch(/jq\s+-r\s+['"]?\.password\b/);
    // One strict filter: a string of at least 20 characters, or a failure.
    expect(rotate).toContain(`jq -er '.password | select(type == "string" and length >= 20)'`);
    // The four logins synced from their CDK secrets each read through it,
    // and the run stops at the first one that fails.
    const reads = [...rotate.matchAll(/^(\w+)_PW=\\\$\(read_source_password (jale_\w+) "\$(\w+)"\) \|\| exit 1$/gm)]
      .map((m) => [m[1], m[2], m[3]]);
    expect(reads).toEqual([
      ['MATCHING', 'jale_matching', 'MATCHING_SECRET_ARN'],
      ['ADMIN_CONSOLE', 'jale_admin_console', 'ADMIN_CONSOLE_SECRET_ARN'],
      ['BILLING', 'jale_billing', 'BILLING_SECRET_ARN'],
      ['PUBLIC_JOBS', 'jale_public_jobs', 'REFERRALS_SECRET_ARN'],
    ]);
    // Those four are the only secrets the payload reads.
    expect(rotate.match(/get-secret-value/g)).toHaveLength(1);
  });

  it('writes the WhatsApp login\'s secret before it sets the role, from the one value it generated, then proves the login', () => {
    const rotate = heredocBody(readScript(), 'ROTATE');
    /** Where a step sits; each step appears exactly once. */
    const step = (needle: string): number => {
      const i = rotate.indexOf(needle);
      expect(i).toBeGreaterThan(-1);
      expect(rotate.indexOf(needle, i + 1)).toBe(-1);
      return i;
    };
    const order = [
      // 1. Generate.
      step('WA_PW=\\$(openssl rand'),
      // 2. Check in memory that the JSON about to be written carries exactly it.
      step('"\\$WA_JSON_PW" == "\\$WA_PW"'),
      // 3. Write the secret: update it, or create it.
      step('aws secretsmanager put-secret-value --secret-id "$WA_DB_SECRET_NAME"'),
      step('aws secretsmanager create-secret --name "$WA_DB_SECRET_NAME"'),
      // 4. Only then set the database, from the same in-memory value.
      step('WA_VERIFIER=\\$(printf \'%s\' "\\$WA_PW" | scram_verifier)'),
      step('ALTER ROLE jale_whatsapp WITH PASSWORD'),
      // 5. Prove the login.
      step('-U jale_whatsapp'),
      step('jale_whatsapp credential check OK'),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // One value: generated once, and the secret is never read back.
    expect(rotate.match(/^\s*WA_PW=/gm)).toHaveLength(1);
    expect(rotate).not.toContain('get-secret-value');
    expect(rotate).not.toMatch(/read_source_password[^\n]*WA_DB_SECRET_NAME/);
    // A failed secret write stops the run before the database is touched.
    expect(rotate).toMatch(/put-secret-value(?:[^\n]*\\\n)+\s+\|\| fail "jale_whatsapp: writing its secret failed/);
    expect(rotate).toMatch(/create-secret(?:[^\n]*\\\n)+\s+\|\| fail "jale_whatsapp: creating its secret failed/);
  });

  it('never prints the WhatsApp login\'s secret name: it is only ever an AWS argument', () => {
    const script = readScript();
    const uses = script.split('\n').filter((l) => l.includes('WA_DB_SECRET_NAME'));
    // No note, echo or other message line interpolates it.
    for (const line of uses) expect(line).not.toMatch(/^\s*(note|echo|die|say|warn|fail)\b/);
    // Every use is its definition or the secret id / name of an AWS call.
    for (const line of uses) {
      const rest = line
        .replace(/^WA_DB_SECRET_NAME="[^"]+"$/, '')
        .replace(/ --(?:secret-id|name) "\$WA_DB_SECRET_NAME"/g, '');
      expect(rest).not.toContain('WA_DB_SECRET_NAME');
    }
    // The AWS calls still address the secret by it.
    expect(script).toContain('aws secretsmanager describe-secret --secret-id "$WA_DB_SECRET_NAME"');
    expect(script).toContain('aws secretsmanager put-secret-value --secret-id "$WA_DB_SECRET_NAME"');
    expect(script).toContain('aws secretsmanager create-secret --name "$WA_DB_SECRET_NAME"');
  });
});

// ===========================================================================
// Engine audit logging and the ops-command output record (static).
//
//   --enable-pgaudit        the preflight (pgaudit loaded, terse errors), then
//                           the extension and every personal login; the
//                           master only with --confirm-cutover-verified.
//   --disable-master-audit  the rollback step: ALTER ROLE jale_admin RESET
//                           pgaudit.log.
//   output record           every send-command asks Run Command to copy its
//                           output to the ops-command log group.
//
// The harness further down proves the same by running the script.
// ===========================================================================

/** The handle rule jale_ops.provision_person enforces, as a login name. */
const PERSON_LOGIN_RULE = '^jale_person_[a-z][a-z0-9]{1,15}$';

describe('run-migrations.sh: engine audit modes and the ops-command output record (static)', () => {
  /** What the engine audit runs send to the ops host. */
  function auditPayloads(): { master: string; lib: string; enable: string; reset: string } {
    const script = readScript();
    return {
      master: heredocBody(script, 'MASTER_OPS_LIB'),
      lib: heredocBody(script, 'ENGINE_AUDIT_LIB'),
      enable: heredocBody(script, 'PGAUDIT_ENABLE'),
      reset: heredocBody(script, 'MASTER_AUDIT_RESET'),
    };
  }

  it('documents --enable-pgaudit, --confirm-cutover-verified, --disable-master-audit and --without-command-log', () => {
    const script = readScript();
    for (const flag of ['--enable-pgaudit', '--confirm-cutover-verified', '--disable-master-audit', '--without-command-log']) {
      expect(script).toMatch(new RegExp(`^#\\s+${flag}\\b`, 'm'));
    }
    const help = execFileSync('bash', [scriptPath, '--help'], { encoding: 'utf8' });
    expect(help).toContain('--enable-pgaudit [--confirm-cutover-verified]');
    expect(help).toContain('--disable-master-audit');
    expect(help).toContain('--without-command-log');
    expect(help).toContain("before the audit stack's first deploy");
    expect(help).not.toContain('Why this script is shaped');
  });

  it('sends every command through one send-command, whose request carries the ops-command output config, checked before it leaves', () => {
    const script = readScript();
    // One call site, inside run_on_bastion (the other mention is the header's history).
    const code = script.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(code.match(/aws ssm send-command/g)).toHaveLength(1);
    const runOnBastion = script.match(/^run_on_bastion\(\) \{\n[\s\S]*?^\}$/m)![0];
    expect(runOnBastion).toContain('aws ssm send-command');
    // The group has one fixed name, the audit stack's, defined once.
    expect(script.match(/^OPS_COMMAND_LOG_GROUP="[^"]+"$/gm)).toEqual(['OPS_COMMAND_LOG_GROUP="/jale/audit/ops-command"']);
    // The request names it, enabled, whenever this run records its output...
    expect(runOnBastion).toContain('CloudWatchOutputConfig:{CloudWatchOutputEnabled:true,CloudWatchLogGroupName:$group}');
    expect(runOnBastion).toContain('--arg group "$OPS_COMMAND_LOG_GROUP" --argjson logged "$COMMAND_LOG"');
    // ...and the built request is checked for exactly that before it is sent.
    const check = runOnBastion.indexOf(".CloudWatchOutputConfig == {CloudWatchOutputEnabled: true, CloudWatchLogGroupName: $group}");
    const send = runOnBastion.indexOf('aws ssm send-command');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(send);
    expect(runOnBastion).toContain('does not carry the ops-command output config');
  });

  it('checks that the ops-command log group exists before anything is sent, and stops without it unless --without-command-log', () => {
    const script = readScript();
    const check = script.indexOf('aws logs describe-log-groups');
    expect(check).toBeGreaterThan(-1);
    // Before the first command reaches the ops host, and before any secret is resolved.
    expect(check).toBeLessThan(script.indexOf('run_on_bastion "$WORKDIR/bastion-ready.sh"'));
    expect(check).toBeLessThan(script.indexOf('describe_secret_arn "StackResources'));
    // A count only.
    expect(script).toContain(`--query "length(logGroups[?logGroupName=='$OPS_COMMAND_LOG_GROUP'])" --output text`);
    // COMMAND_LOG starts false and only an existing group turns it on.
    expect(script.match(/^\s*COMMAND_LOG=true$/gm)).toHaveLength(1);
    expect(script).toMatch(/^COMMAND_LOG=false$/m);
    expect(script).toContain('the ops-command log group does not exist, so this run\'s output would not be recorded');
    expect(script).toContain('--without-command-log is only for a run before the audit stack\'s first deploy, and the ops-command log group exists');
    expect(script).toContain("this run's output is NOT recorded");
  });

  it('--enable-pgaudit refuses unless the preflight shows pgaudit loaded and terse errors, before it changes anything', () => {
    const { lib, enable } = auditPayloads();
    // The state read covers both preflight facts and the login signed in.
    expect(lib).toContain("pg_catalog.current_setting('shared_preload_libraries')");
    expect(lib).toContain("pg_catalog.current_setting('log_error_verbosity')");
    expect(lib).toContain('fail "the ops host did not sign in as the master login; $1"');
    // The refusal comes before the one change, and it exits.
    const refusal = enable.indexOf('fail "refusing to enable engine audit logging before the audit parameter group is attached; nothing was changed"');
    const guard = enable.indexOf('if [[ "$PGAUDIT_LOADED" != t || "$ERROR_VERBOSITY" != terse ]]; then');
    const change = enable.indexOf('enable_sql | master_psql -1 -f -');
    expect(guard).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(guard);
    expect(change).toBeGreaterThan(refusal);
    expect(enable.indexOf('read_audit_state "nothing was changed"')).toBeLessThan(guard);
    // One transaction, on stdin, and a read-back that checks every part.
    expect(enable).toContain('CREATE EXTENSION IF NOT EXISTS pgaudit;');
    expect(enable).toContain('[[ "$PGAUDIT_EXTENSION" == t ]] || fail');
    expect(enable).toContain('[[ "$PERSONS_AUDITED" == "$PERSONS" ]]');
  });

  it("sets the master's pgaudit.log only with --confirm-cutover-verified", () => {
    const script = readScript();
    const { enable } = auditPayloads();
    // The one statement that sets it sits behind AUDIT_SET_MASTER...
    expect(script.match(/ALTER ROLE jale_admin SET pgaudit\.log/g)).toHaveLength(1);
    expect(enable).toContain(`if $AUDIT_SET_MASTER; then printf '%s\\n' "ALTER ROLE jale_admin SET pgaudit.log = 'all';"; fi`);
    // ...which only the flag sets, and the flag needs the mode.
    expect(script).toContain(`printf 'AUDIT_DRY_RUN=%s\\nAUDIT_SET_MASTER=%s\\n' "$DRY_RUN" "$CONFIRM_CUTOVER_VERIFIED"`);
    expect(script).toMatch(/--confirm-cutover-verified\)\s*CONFIRM_CUTOVER_VERIFIED=true/);
    expect(script.match(/CONFIRM_CUTOVER_VERIFIED=true/g)).toHaveLength(1);
    expect(script).toContain('usage_error "--confirm-cutover-verified needs --enable-pgaudit"');
  });

  it('audits every personal login by the handle rule provision_person enforces, and names none of them', () => {
    const { lib, enable } = auditPayloads();
    expect(enable).toContain(`WHERE p.rolname ~ '${PERSON_LOGIN_RULE}' ORDER BY p.rolname LOOP`);
    expect(enable).toContain("EXECUTE pg_catalog.format('ALTER ROLE %I SET pgaudit.log = %L', r.rolname, 'all');");
    expect(lib.split(PERSON_LOGIN_RULE).length - 1).toBe(2);
    // No status line carries a role name.
    for (const line of (lib + enable).split('\n').filter((l) => /\b(say|warn|fail)\s/.test(l))) {
      expect(line).not.toMatch(/rolname|jale_person/);
    }
  });

  it('--disable-master-audit resets the master and nothing else', () => {
    const script = readScript();
    const { reset } = auditPayloads();
    expect(reset).toContain(`printf '%s\\n' "ALTER ROLE jale_admin RESET pgaudit.log;" | master_psql -f -`);
    expect(reset).not.toMatch(/ALTER ROLE (?!jale_admin RESET pgaudit\.log;)/);
    expect(reset).toContain('[[ -z "$MASTER_AUDIT" ]] || fail');
    expect(script).toMatch(/--disable-master-audit\)\s*DISABLE_MASTER_AUDIT=true/);
  });

  it('the engine audit payloads print statuses only', () => {
    const { master, lib, enable, reset } = auditPayloads();
    const remote = master + lib + enable + reset;
    expect(remote).not.toMatch(/^\s*echo\b/m);
    const sensitive = /\$\{?(pw|password|SECRET_JSON|PGPASSWORD|DB_HOST|DB_PORT|DB_NAME|DB_USER|row|err|ERR)\b/;
    for (const line of remote.split('\n').filter((l) => /\b(say|warn|fail)\s/.test(l))) {
      expect(line).not.toMatch(sensitive);
    }
    // psql's own error text never reaches the output: every call goes through
    // master_psql (terse) with stderr captured.
    expect(remote).not.toMatch(/"\$\{PG\[@\]\}"(?! -X -q -At -v VERBOSITY=(terse|sqlstate) "\$@")/);
    for (const call of remote.split('\n').filter((l) => l.includes('| master_psql'))) {
      expect(call).toMatch(/2>"\$ERR"/);
    }
  });

  it('leaves the engine audit modes before the ledger, the migrations and --rotate-secrets, and keeps them separate runs', () => {
    const script = readScript();
    const run = script.indexOf('run_on_bastion "$audit_payload" "$audit_comment" true');
    expect(run).toBeGreaterThan(-1);
    const exitAt = script.indexOf('\n  exit 0\n', run);
    expect(script.slice(run + 1, exitAt)).not.toContain('run_on_bastion');
    expect(exitAt).toBeLessThan(script.indexOf('run_on_bastion "$WORKDIR/read-ledger.sh"'));
    expect(exitAt).toBeLessThan(script.indexOf('run_on_bastion "$WORKDIR/rotate.sh"'));
    // After the posture control.
    expect(run).toBeGreaterThan(script.indexOf('run_on_bastion "$WORKDIR/posture.sh" "posture control" true'));
    expect(script).toContain('--prepare-logins, --enable-pgaudit, --disable-master-audit, --audit-status, --list-holds, --release-hold, --redact-and-release and --report are separate runs');
    const { lib, enable, reset } = auditPayloads();
    for (const body of [lib, enable, reset]) {
      expect(body).not.toMatch(/secretsmanager|WITH PASSWORD|schema_migrations/);
    }
  });

  it('asks psql for terse errors wherever it applies, records or verifies migrations', () => {
    const script = readScript();
    const rotate = heredocBody(script, 'ROTATE');
    // Every direct psql call outside the rotation (which hides psql's text
    // itself) carries -v VERBOSITY=terse; the payloads' helpers do too.
    const calls = script.split('\n').filter((l) => /"\\?\$\{PG\[@\]\}"/.test(l) && !rotate.includes(l));
    expect(calls.length).toBeGreaterThanOrEqual(8);
    for (const call of calls) expect(call).toMatch(/-v VERBOSITY=(terse|sqlstate)\b/);
    // The apply itself, and its ledger INSERT, by name.
    const applyOne = script.match(/<<APPLY_ONE\n([\s\S]*?)^APPLY_ONE$/m)![1];
    expect(applyOne).toContain('"\\${PG[@]}" -v VERBOSITY=terse -f /tmp/jale-mig.sql');
    expect(applyOne).toContain('"\\${PG[@]}" -v VERBOSITY=terse -q -c "INSERT INTO $LEDGER_TABLE');
  });

  it('charges the APPLY_ONE wrapper at exactly its rendered size', () => {
    const script = readScript();
    const emit = script.match(/(^ *cat >> "\$script" <<APPLY_ONE\n[\s\S]*?^APPLY_ONE$)/m)![1];
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jale-mig-bytes-'));
    try {
      // The measurement the script's comment describes: f, sum and b64 empty.
      const rendered = path.join(tmp, 'rendered.sh');
      execFileSync('bash', ['-c', emit], {
        env: { ...process.env, f: '', sum: '', b64: '', LEDGER_TABLE: 'public.schema_migrations', script: rendered },
      });
      const declared = Number(script.match(/^APPLY_ONE_FIXED_BYTES=(\d+)$/m)![1]);
      expect(fs.statSync(rendered).size).toBe(declared);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  /**
   * psql's terse verbosity keeps a notice's primary message and drops DETAIL
   * lines. The stub below behaves that way, so this proves the apply asks
   * for it: a failing migration's DETAIL (which can quote a row) reaches
   * neither stream, while the self-check notices still come back.
   */
  it('keeps a migration\'s notices and drops the DETAIL of a failing one', () => {
    const script = readScript();
    const emit = script.match(/(^ *cat >> "\$script" <<APPLY_ONE\n[\s\S]*?^APPLY_ONE$)/m)![1];
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jale-mig-terse-'));
    try {
      const sql = 'SELECT 1;\n';
      const b64 = zlib.gzipSync(Buffer.from(sql)).toString('base64');
      const sum = crypto.createHash('sha256').update(sql).digest('hex');
      const stub = path.join(tmp, 'psql');
      fs.writeFileSync(stub, [
        '#!/bin/bash',
        'terse=false; file=false',
        'for a in "$@"; do [[ "$a" == "VERBOSITY=terse" ]] && terse=true; [[ "$a" == "-f" ]] && file=true; done',
        '$file || exit 0',
        'echo "psql:/tmp/jale-mig.sql:9: NOTICE:  self-check passed: 3 objects" >&2',
        '$terse || echo "DETAIL:  checked against FAKE-NOTICE-DETAIL" >&2',
        'echo "psql:/tmp/jale-mig.sql:12: ERROR:  new row violates check constraint" >&2',
        '$terse || echo "DETAIL:  Failing row contains (FAKE-ROW-VALUE)." >&2',
        'exit 3',
      ].join('\n') + '\n', { mode: 0o755 });
      const rendered = path.join(tmp, 'rendered.sh');
      execFileSync('bash', ['-c', emit], {
        env: { ...process.env, f: '095_data_backfill.sql', sum, b64, LEDGER_TABLE: 'public.schema_migrations', script: rendered },
      });
      const r = spawnSync('bash', ['-c', `set -euo pipefail; PG=('${stub}'); source '${rendered}'`], { encoding: 'utf8' });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('NOTICE:  self-check passed: 3 objects');
      expect(r.stderr).toContain('ERROR:  new row violates check constraint');
      expect(r.stdout + r.stderr).not.toContain('FAKE-ROW-VALUE');
      expect(r.stdout + r.stderr).not.toContain('FAKE-NOTICE-DETAIL');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync('/tmp/jale-mig.sql', { force: true });
      fs.rmSync('/tmp/jale-mig.err', { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The harness: the real script, a fake AWS CLI, a fake ops host.
// ---------------------------------------------------------------------------

const PYTHON = execFileSync('bash', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim();

const FAKE_AWS = String.raw`#!__PYTHON__
import json, os, pathlib, re, subprocess, sys

STATE = pathlib.Path(os.environ["FAKE_STATE"])
ARGV = sys.argv[1:]
with open(STATE / "argv.log", "a") as f:
    f.write(json.dumps({"tool": "aws", "side": os.environ.get("FAKE_SIDE", "local"), "argv": ARGV}) + "\n")

def opt(name):
    if name in ARGV:
        i = ARGV.index(name)
        if i + 1 < len(ARGV):
            return ARGV[i + 1]
    return None

def param(value):
    # AWS CLI v2 paramfile semantics: file://PATH is read from PATH.
    if value is not None and value.startswith("file://"):
        p = value[len("file://"):]
        return sys.stdin.read() if p == "/dev/stdin" else pathlib.Path(p).read_text()
    return value

def input_json(value):
    # AWS CLI v2 (seen on 2.36) reads --cli-input-json's file twice, so a pipe
    # (/dev/stdin, /dev/fd/0) is empty on the second read and the call fails
    # before any request, with no AWS error code. Only a regular file works.
    if value is not None and value.startswith("file://") and value[len("file://"):] in ("/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"):
        sys.stderr.write("\naws: [ERROR]: An error occurred (ParamValidation): Error parsing parameter 'cli-input-json': Invalid JSON received.\n")
        sys.exit(252)
    return json.loads(param(value))

def secret_file(sid):
    return STATE / "secrets" / (sid.replace("/", "__") + ".json")

def fail(code, op):
    sys.stderr.write("\nAn error occurred (%s) when calling the %s operation: FAKE-ERROR-DETAIL-MUST-NOT-PRINT\n" % (code, op))
    sys.exit(254)

def bump(name):
    p = STATE / (name + ".count")
    n = int(p.read_text()) + 1 if p.exists() else 1
    p.write_text(str(n))
    return n

service, command = ARGV[0], ARGV[1]
op = "".join(w.capitalize() for w in command.split("-"))

# A call refused the way AWS refuses one, with text that must never be shown.
# FAKE_FAIL_CALLS lists service:command, or service:command:query.
for spec in filter(None, os.environ.get("FAKE_FAIL_CALLS", "").split(",")):
    parts = spec.split(":")
    if parts[:2] == [service, command] and (len(parts) == 2 or parts[2] == (opt("--query") or "")):
        fail(os.environ.get("FAKE_FAIL_CALL_CODE", "AccessDeniedException"), op)

if service == "cloudformation" and command == "describe-stacks":
    print("test-bastion")
elif service == "cloudformation" and command == "describe-stack-resources":
    m = re.search(r"starts_with\(LogicalResourceId, '([A-Za-z]+)'\)", opt("--query") or "")
    prefix = m.group(1) if m else "Unknown"
    print("None" if prefix in os.environ.get("FAKE_MISSING_STACK_SECRETS", "").split(",") else "test-secret-" + prefix)
elif service == "ssm" and command == "send-command":
    req = input_json(opt("--cli-input-json"))
    n = bump("ssm")
    d = STATE / "ssm"
    d.mkdir(exist_ok=True)
    (d / ("%d.sh" % n)).write_text(req["Parameters"]["commands"][0])
    with open(STATE / "ssm-comments.log", "a") as f:
        f.write(req["Comment"] + "\n")
    with open(STATE / "ssm-output.log", "a") as f:
        f.write(json.dumps(req.get("CloudWatchOutputConfig")) + "\n")
    env = dict(os.environ, PATH=os.environ["FAKE_REMOTE_PATH"], FAKE_SIDE="remote", TMPDIR=str(STATE / "remote-tmp"))
    r = subprocess.run(["/bin/bash", str(d / ("%d.sh" % n))], env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True)
    (d / ("%d.out" % n)).write_text(r.stdout)
    (d / ("%d.err" % n)).write_text(r.stderr)
    (d / ("%d.rc" % n)).write_text(str(r.returncode))
    print("cmd-%d" % n)
elif service == "ssm" and command == "get-command-invocation":
    n = opt("--command-id").split("-")[1]
    d = STATE / "ssm"
    q = opt("--query")
    if q == "Status":
        # Every status read refused with this code, or the first N refused
        # the way SSM answers just after a send.
        if os.environ.get("FAKE_SSM_STATUS_FAIL_CODE"):
            fail(os.environ["FAKE_SSM_STATUS_FAIL_CODE"], op)
        if bump("status-read") <= int(os.environ.get("FAKE_SSM_INVISIBLE_READS", "0")):
            fail("InvocationDoesNotExist", op)
        print("Success" if (d / (n + ".rc")).read_text() == "0" else "Failed")
    elif q == "StandardOutputContent":
        sys.stdout.write((d / (n + ".out")).read_text())
    elif q == "StandardErrorContent":
        sys.stdout.write((d / (n + ".err")).read_text())
elif service == "logs" and command == "describe-log-groups":
    if os.environ.get("FAKE_LOGS_FAIL_CODE"):
        fail(os.environ["FAKE_LOGS_FAIL_CODE"], op)
    print(os.environ.get("FAKE_COMMAND_LOG_GROUPS", "1"))
elif service == "secretsmanager":
    if command in os.environ.get("FAKE_SM_FAIL_COMMANDS", "").split(","):
        fail(os.environ.get("FAKE_SM_FAIL_CODE", "AccessDeniedException"), op)
    if command == "get-secret-value":
        p = secret_file(opt("--secret-id"))
        if not p.exists():
            fail("ResourceNotFoundException", op)
        print(p.read_text())
    elif command == "describe-secret":
        if not secret_file(opt("--secret-id")).exists():
            fail("ResourceNotFoundException", op)
        print(json.dumps({"Name": "FAKE-NAME-MUST-NOT-PRINT", "ARN": "FAKE-ARN-MUST-NOT-PRINT"}))
    elif command == "get-random-password":
        n = bump("random-password")
        head = "test-generated-%02d-" % n
        print(head + "x" * (40 - len(head) - 3) + "-pw")
    elif command == "create-secret":
        if opt("--cli-input-json"):
            req = input_json(opt("--cli-input-json"))
        else:
            req = {"Name": opt("--name"), "Description": opt("--description"), "SecretString": param(opt("--secret-string"))}
            if opt("--tags") is not None:
                req["Tags"] = json.loads(opt("--tags"))
        p = secret_file(req["Name"])
        if p.exists():
            fail("ResourceExistsException", op)
        p.write_text(req["SecretString"])
        (STATE / "secret-meta").mkdir(exist_ok=True)
        (STATE / "secret-meta" / p.name).write_text(json.dumps({k: v for k, v in req.items() if k != "SecretString"}))
        print(json.dumps({"ARN": "FAKE-ARN-MUST-NOT-PRINT", "Name": "FAKE-NAME-MUST-NOT-PRINT"}))
    elif command == "put-secret-value":
        secret_file(opt("--secret-id")).write_text(param(opt("--secret-string")))
        print(json.dumps({"ARN": "FAKE-ARN-MUST-NOT-PRINT"}))
    else:
        sys.stderr.write("fake aws: unsupported secretsmanager command %s\n" % command)
        sys.exit(2)
else:
    sys.stderr.write("fake aws: unsupported command %s %s\n" % (service, command))
    sys.exit(2)
`;

const FAKE_PSQL = String.raw`#!__PYTHON__
import base64, hashlib, hmac, json, os, pathlib, re, sys

STATE = pathlib.Path(os.environ["FAKE_STATE"])
ARGV = sys.argv[1:]
with open(STATE / "argv.log", "a") as f:
    f.write(json.dumps({"tool": "psql", "side": "remote", "argv": ARGV}) + "\n")

if ARGV == ["--version"]:
    print("psql (PostgreSQL) 15.0 (fake)")
    sys.exit(0)

TAKES_VALUE = set("hpUdvFcfoPT")
user, cmds, script_file, variables = None, [], None, {}
i = 0
while i < len(ARGV):
    a = ARGV[i]
    if a.startswith("-") and not a.startswith("--") and len(a) > 1:
        j = 1
        while j < len(a):
            ch = a[j]
            if ch in TAKES_VALUE:
                if j + 1 < len(a):
                    val = a[j + 1:]
                else:
                    i += 1
                    val = ARGV[i]
                if ch == "U":
                    user = val
                elif ch == "c":
                    cmds.append(val)
                elif ch == "f":
                    script_file = val
                elif ch == "v":
                    k, _, v = val.partition("=")
                    variables[k] = v
                break
            j += 1
    i += 1

master = json.loads((STATE / "secrets" / "test-secret-JaleDatabaseStackDatabaseSecret.json").read_text())
password = os.environ.get("PGPASSWORD", "")
roles = STATE / "roles"

def scram_ok(verifier, pw):
    m = re.match(r"^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$", verifier)
    if not m:
        return False
    salted = hashlib.pbkdf2_hmac("sha256", pw.encode(), base64.b64decode(m.group(2)), int(m.group(1)))
    client_key = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
    server_key = hmac.new(salted, b"Server Key", hashlib.sha256).digest()
    return (hashlib.sha256(client_key).digest() == base64.b64decode(m.group(3))
            and server_key == base64.b64decode(m.group(4)))

def deny():
    # Shaped like real psql output, host and address included, so a script
    # that echoes psql's stderr verbatim is caught leaking them.
    sys.stderr.write('psql: error: connection to server at "%s" (%s), port 5432 failed: '
                     'FATAL:  password authentication failed for user "%s"\n' % (master["host"], os.environ["FAKE_DB_ADDRESS"], user))
    sys.exit(2)

if user == master["username"]:
    if password != master["password"]:
        deny()
elif user in os.environ.get("FAKE_DENY_LOGIN", "").split(","):
    deny()
else:
    v, plain = roles / (user + ".verifier"), roles / (user + ".plaintext")
    if v.exists():
        if not scram_ok(v.read_text(), password):
            deny()
    elif plain.exists():
        if plain.read_text() != password:
            deny()
    else:
        deny()

parts = list(cmds)
if script_file is not None:
    parts.append(sys.stdin.read() if script_file == "-" else pathlib.Path(script_file).read_text())
elif not cmds:
    parts.append(sys.stdin.read())
sql = "\n".join(parts)
if script_file is not None or not cmds:
    for k, v in variables.items():
        sql = sql.replace(":'%s'" % k, "'" + v.replace("'", "''") + "'")

out = []
if "BEGIN READ ONLY;" in sql:
    # --report: the statements as psql received them, the session options and the login.
    with open(STATE / "report.log", "a") as f:
        f.write(json.dumps({"sql": sql, "argv": ARGV, "user": user, "pgoptions": os.environ.get("PGOPTIONS"), "vars": variables}) + "\n")
    if os.environ.get("FAKE_REPORT_FAIL"):
        # psql prints the results of the statements before the one that fails.
        sys.stdout.write(" item | queued\n PARTIAL-RESULT\n")
        sys.stderr.write("psql:<stdin>:3: ERROR:  25006\n" if variables.get("VERBOSITY") == "sqlstate" else
                         "psql:<stdin>:3: ERROR:  cannot execute INSERT in a read-only transaction\nLINE 1: INSERT INTO FAKE-VALUE-MUST-NOT-PRINT\n")
        sys.exit(3)
    out.extend([" item | queued", "------+--------", " f19  |      0", "(1 row)", ""])
elif "server_version_num" in sql:
    out.append("%s|%s" % (os.environ["FAKE_MASTER_RLS"], os.environ.get("FAKE_SERVER_VERSION_NUM", "160008")))
elif "jale_ops.audit_export_status()" in sql or "jale_ops.audit_event_counts(" in sql or "jale_audit.list_holds()" in sql \
        or "jale_audit.release_hold(" in sql or "jale_audit.redact_and_release(" in sql or "AT TIME ZONE 'UTC'" in sql:
    verbosity = variables.get("VERBOSITY", "default")
    stmt = "\n".join(parts).strip()
    with open(STATE / "audit-ops.log", "a") as f:
        f.write(json.dumps({"sql": stmt, "vars": {k: v for k, v in variables.items() if k not in ("VERBOSITY", "ON_ERROR_STOP")}, "verbosity": verbosity}) + "\n")
    holds = json.loads(os.environ.get("FAKE_HOLDS", "[]"))
    if "audit_export_status" in sql:
        out.append("events|2026-10-05T10:00:00Z|3|12|2026-10-05T09:55:00Z|4|1|0")
        out.append("changes|never|0|0|never|0|0|0")
    elif "audit_event_counts" in sql:
        out.append("read|allowed|api.worker.profile|5")
        out.append("attempt|denied|admin.users.reveal|1")
    elif sql.startswith("SELECT to_char("):
        out.append(variables.get("since") or "2026-10-04T10:00:00Z")
    elif "count(*) FROM jale_audit.list_holds()" in sql:
        out.append(str(len(holds)))
    elif "FROM jale_audit.list_holds() h" in sql:
        out.extend("|".join(row) for row in holds)
    else:
        stream = variables.get("stream", "events")
        seq = variables.get("seq")
        if not any(row[0] == stream and row[1] == seq for row in holds) or ("redact" in sql and stream != "events"):
            sys.stderr.write("psql:<stdin>:1: ERROR:  22023\n" if verbosity == "sqlstate" else
                             "psql:<stdin>:1: ERROR:  invalid p_seq\nDETAIL:  FAKE-VALUE-MUST-NOT-PRINT\n")
            sys.exit(3)
        out.append("902" if "redact" in sql else "901")
elif "shared_preload_libraries" in sql:
    preload = [x.strip() for x in os.environ.get("FAKE_PRELOAD", "rdsutils,pg_stat_statements").split(",")]
    persons = sorted(p.name[:-len(".attrs")] for p in roles.glob("jale_person_*.attrs"))
    def audit_log(role):
        f = roles / (role + ".pgaudit")
        return f.read_text() if f.exists() else ""
    out.append("|".join([
        "t" if "pgaudit" in preload else "f",
        os.environ.get("FAKE_ERROR_VERBOSITY", "default"),
        user,
        "t" if (STATE / "extension-pgaudit").exists() else "f",
        audit_log("jale_admin"),
        str(len(persons)),
        str(sum(1 for p in persons if audit_log(p) == "all")),
    ]))
elif "pgaudit" in sql:
    with open(STATE / "pgaudit-sql.log", "a") as f:
        f.write(json.dumps({"sql": sql, "single_transaction": "-1" in ARGV, "via": "argv" if cmds else "stdin"}) + "\n")
    if os.environ.get("FAKE_PGAUDIT_FAIL"):
        sys.stderr.write('psql:<stdin>:2: ERROR:  fake failure on "%s"\nDETAIL:  Failing row contains (FAKE-VALUE-MUST-NOT-PRINT).\n' % master["host"])
        sys.exit(3)
    if "CREATE EXTENSION IF NOT EXISTS pgaudit;" in sql:
        (STATE / "extension-pgaudit").write_text("1")
    if "ALTER ROLE jale_admin SET pgaudit.log = 'all';" in sql:
        (roles / "jale_admin.pgaudit").write_text("all")
    if "ALTER ROLE jale_admin RESET pgaudit.log;" in sql:
        (roles / "jale_admin.pgaudit").unlink(missing_ok=True)
    if "DO $persons$" in sql and "ALTER ROLE %I SET pgaudit.log = %L" in sql:
        for p in roles.glob("jale_person_*.attrs"):
            name = p.name[:-len(".attrs")]
            if name != os.environ.get("FAKE_PGAUDIT_SKIP_PERSON"):
                (roles / (name + ".pgaudit")).write_text("all")
elif re.search(r"SHOW\s+password_encryption", sql, re.I):
    out.append(os.environ.get("FAKE_PASSWORD_ENCRYPTION", "scram-sha-256"))
elif "pg_roles" in sql:
    m = re.search(r"rolname\s*=\s*'([a-z0-9_]+)'", sql)
    p = roles / (m.group(1) + ".attrs")
    if p.exists():
        out.append(p.read_text().strip())
elif re.search(r"ALTER\s+ROLE", sql, re.I):
    for m in re.finditer(r"ALTER\s+ROLE\s+([a-z0-9_]+)\s+WITH\s+PASSWORD\s+'([^']*)'", sql, re.I):
        role, value = m.group(1), m.group(2)
        if role in os.environ.get("FAKE_FAIL_ALTER_ROLE", "").split(","):
            sys.stderr.write("psql:<stdin>:1: ERROR:  fake failure setting the password of %s\n" % role)
            sys.exit(3)
        with open(STATE / "alter.log", "a") as f:
            f.write(json.dumps({"role": role, "value": value, "via": "argv" if cmds else "stdin"}) + "\n")
        for stale in (roles / (role + ".verifier"), roles / (role + ".plaintext")):
            if stale.exists():
                stale.unlink()
        (roles / (role + (".verifier" if value.startswith("SCRAM-SHA-256$") else ".plaintext"))).write_text(value)
elif "current_user" in sql and "row_security_active" in sql:
    out.append("%s|%s" % (user, os.environ.get("FAKE_LOGIN_RLS", "t")))
elif re.fullmatch(r"\s*SELECT\s+current_user\s*;?\s*", sql, re.I):
    out.append(user)
elif "public_listing_enabled" in sql:
    out.append("0")
elif "SELECT filename, checksum FROM" in sql or "SELECT filename, coalesce(checksum" in sql:
    out.append((STATE / "ledger.txt").read_text().rstrip("\n"))
if out:
    print("\n".join(out))
`;

/** Real tools the fake ops host may run, each behind a recording wrapper. */
const WRAPPED_TOOLS = [
  'jq', 'python3', 'base64', 'gunzip', 'gzip', 'sha256sum', 'cut', 'tr', 'mktemp', 'rm', 'cat',
  'sed', 'grep', 'head', 'tail', 'timeout', 'openssl', 'sleep', 'wc', 'sort', 'mkdir', 'chmod',
];

const MASTER_SECRET = {
  username: 'jale_admin', password: 'test-master-admin-pw', host: 'db.test.invalid', port: 5432, dbname: 'jale', engine: 'postgres',
};
const SEEDED_SECRETS: Record<string, Record<string, unknown>> = {
  'test-secret-JaleDatabaseStackDatabaseSecret': MASTER_SECRET,
  'test-secret-MatchingDbSecret': { username: 'jale_matching', password: 'test-matching-seed-pw' },
  'test-secret-AdminConsoleDbSecret': { username: 'jale_admin_console', password: 'test-adminconsole-seed-pw', host: 'db.test.invalid', port: 5432, dbname: 'jale' },
  'test-secret-BillingDbSecret': { username: 'jale_billing', password: 'test-billing-seed-pw', host: 'db.test.invalid', port: 5432, dbname: 'jale' },
  'test-secret-ReferralsDbSecret': { username: 'jale_public_jobs', password: 'test-publicjobs-seed-pw', host: 'db.test.invalid', port: 5432, dbname: 'jale' },
  'test-secret-AiDbSecret': { username: 'jale_ai', password: 'test-ai-seed-password-pw', host: 'db.test.invalid', port: 5432, dbname: 'jale' },
};
const SEEDED_PASSWORDS = Object.values(SEEDED_SECRETS).map((s) => String(s.password));
/** An address for the fake database, made up per run so none is written into the repo. */
const FAKE_DB_ADDRESS = `10.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}`;
/** Strings that may appear in a fake's output but must never reach the operator. */
const NEVER_PRINTED = ['db.test.invalid', FAKE_DB_ADDRESS, 'FAKE-ERROR-DETAIL-MUST-NOT-PRINT', 'FAKE-ARN-MUST-NOT-PRINT', 'FAKE-NAME-MUST-NOT-PRINT', 'test-secret-', 'SCRAM-SHA-256$'];

interface Harness {
  dir: string;
  bin: string;
  remote: string;
  state: string;
  home: string;
  /** A repo layout around a copy of the real script: its own manifest, the real migrations. */
  repo: string;
}

/** The access manifest's shape: logins keyed by name, the prepared ones marked. */
function fixtureManifest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const logins: Record<string, unknown> = {};
  for (const [login, limit, kind] of LEAST_PRIVILEGE_LOGINS) {
    logins[login] = { kind, created_by: '104', connection_limit: limit, prepare_secret: true, workloads: 'fixture', reason: 'fixture' };
  }
  for (const login of ['jale_whatsapp', 'jale_ai', 'jale_billing']) {
    logins[login] = { kind: 'service', created_by: 'pre-104', connection_limit: -1, workloads: 'fixture', reason: 'fixture' };
  }
  return { version: 1, logins: { ...logins, ...extra } };
}

function writeManifest(h: Harness, manifest: Record<string, unknown> | null): void {
  const f = path.join(h.repo, 'infra', 'db', 'access', 'manifest.json');
  if (manifest === null) fs.rmSync(f, { force: true });
  else fs.writeFileSync(f, JSON.stringify(manifest, null, 2));
}

/** A manifest fragment in manifest.d/: an object (written as JSON) or raw text. */
function writeFragment(h: Harness, name: string, fragment: Record<string, unknown> | string): void {
  const dir = path.join(h.repo, 'infra', 'db', 'access', 'manifest.d');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), typeof fragment === 'string' ? fragment : JSON.stringify(fragment, null, 2));
}

function fixtureLogin(kind: string, limit: number, prepared: boolean): Record<string, unknown> {
  return { kind, created_by: '1xx', connection_limit: limit, ...(prepared ? { prepare_secret: true } : {}), workloads: 'fixture', reason: 'fixture' };
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function makeHarness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jale-runmig-'));
  const h: Harness = {
    dir,
    bin: path.join(dir, 'bin'),
    remote: path.join(dir, 'remote-bin'),
    state: path.join(dir, 'state'),
    home: path.join(dir, 'home'),
    repo: path.join(dir, 'repo'),
  };
  for (const d of [h.bin, h.remote, h.state, h.home, path.join(h.state, 'secrets'), path.join(h.state, 'roles'), path.join(h.state, 'remote-tmp'),
    path.join(h.repo, 'scripts', 'lib'), path.join(h.repo, 'infra', 'db', 'access')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  // The script finds its helper, the migrations and the manifest relative to
  // itself, so a copy in this layout runs exactly as it does in the repo.
  fs.copyFileSync(scriptPath, path.join(h.repo, 'scripts', 'run-migrations.sh'));
  fs.copyFileSync(path.join(repoRoot, 'scripts', 'lib', 'scram-verifier.py'), path.join(h.repo, 'scripts', 'lib', 'scram-verifier.py'));
  fs.symlinkSync(migrationsDir, path.join(h.repo, 'infra', 'db', 'migrations'));
  writeManifest(h, fixtureManifest());
  const fakeAws = FAKE_AWS.replace('__PYTHON__', PYTHON);
  fs.writeFileSync(path.join(h.bin, 'aws'), fakeAws, { mode: 0o755 });
  fs.writeFileSync(path.join(h.remote, 'aws'), fakeAws, { mode: 0o755 });
  fs.writeFileSync(path.join(h.remote, 'psql'), FAKE_PSQL.replace('__PYTHON__', PYTHON), { mode: 0o755 });
  fs.writeFileSync(path.join(h.remote, 'cloud-init'), '#!/bin/bash\necho "status: done"\n', { mode: 0o755 });
  for (const tool of WRAPPED_TOOLS) {
    const real = execFileSync('bash', ['-c', `command -v ${tool} || true`], { encoding: 'utf8' }).trim();
    if (!real) continue;
    fs.writeFileSync(path.join(h.remote, tool), [
      '#!/bin/bash',
      `{ printf '%s' "\${0##*/}"; printf ' %q' "$@"; printf '\\n'; } >> "$FAKE_STATE/argv-wrapped.log"`,
      `exec ${real} "$@"`,
    ].join('\n') + '\n', { mode: 0o755 });
  }
  for (const [id, value] of Object.entries(SEEDED_SECRETS)) setSecret(h, id, value);
  for (const [login, limit] of LEAST_PRIVILEGE_LOGINS) setRoleAttrs(h, login, `t|f|f|f|f|f|f|${limit}|0`);
  // jale_ai was created by 012 with plain `CREATE ROLE jale_ai LOGIN`: INHERIT, no limit.
  setRoleAttrs(h, SYNC_LOGIN, 't|f|t|f|f|f|f|-1|0');
  // Every migration applied, with matching checksums: a run with nothing to apply.
  const ledger = fs.readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort().map((n) => {
    const sum = crypto.createHash('sha256').update(fs.readFileSync(path.join(migrationsDir, n))).digest('hex');
    return `${n}|${sum}`;
  });
  fs.writeFileSync(path.join(h.state, 'ledger.txt'), ledger.join('\n') + '\n');
  return h;
}

function secretFile(h: Harness, id: string): string {
  return path.join(h.state, 'secrets', `${id.replace(/\//g, '__')}.json`);
}

function setSecret(h: Harness, id: string, value: Record<string, unknown>): void {
  fs.writeFileSync(secretFile(h, id), JSON.stringify(value));
}

function readSecret(h: Harness, id: string): Record<string, unknown> | undefined {
  const f = secretFile(h, id);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : undefined;
}

function secretMeta(h: Harness, id: string): Record<string, unknown> | undefined {
  const f = path.join(h.state, 'secret-meta', `${id.replace(/\//g, '__')}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : undefined;
}

function setRoleAttrs(h: Harness, login: string, attrs: string | null): void {
  const f = path.join(h.state, 'roles', `${login}.attrs`);
  if (attrs === null) fs.rmSync(f, { force: true });
  else fs.writeFileSync(f, attrs);
}

function readLines(h: Harness, name: string): string[] {
  const f = path.join(h.state, name);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
}

function alters(h: Harness): Array<{ role: string; value: string; via: string }> {
  return readLines(h, 'alter.log').map((l) => JSON.parse(l));
}

function awsCalls(h: Harness): string[][] {
  return readLines(h, 'argv.log').map((l) => JSON.parse(l)).filter((r) => r.tool === 'aws').map((r) => r.argv as string[]);
}

function argvText(h: Harness): string {
  return readLines(h, 'argv.log').join('\n') + '\n' + readLines(h, 'argv-wrapped.log').join('\n');
}

function scramMatches(verifier: string, password: string): boolean {
  const m = verifier.match(/^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/);
  if (!m) return false;
  const salted = crypto.pbkdf2Sync(password, Buffer.from(m[2], 'base64'), Number(m[1]), 32, 'sha256');
  const clientKey = crypto.createHmac('sha256', salted).update('Client Key').digest();
  const serverKey = crypto.createHmac('sha256', salted).update('Server Key').digest();
  return crypto.createHash('sha256').update(clientKey).digest().equals(Buffer.from(m[3], 'base64'))
    && serverKey.equals(Buffer.from(m[4], 'base64'));
}

/**
 * Runs the real script against the fakes. The posture baseline and the fake
 * ops host's master reading default to HARNESS_POSTURE; `env` overrides
 * either, and a null value leaves that variable unset.
 */
function runScript(h: Harness, args: string[], env: Record<string, string | null> = {}, timeoutMs = 180_000): RunResult {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // No real AWS identity can leak into a test run.
    if (v !== undefined && !k.startsWith('AWS_')) base[k] = v;
  }
  const merged: Record<string, string | null> = {
    ...base,
    HOME: h.home,
    PATH: `${h.bin}:${process.env.PATH ?? ''}`,
    AWS_REGION: 'us-east-2',
    AWS_CONFIG_FILE: path.join(h.home, 'no-aws-config'),
    AWS_SHARED_CREDENTIALS_FILE: path.join(h.home, 'no-aws-credentials'),
    AWS_EC2_METADATA_DISABLED: 'true',
    FAKE_STATE: h.state,
    FAKE_REMOTE_PATH: h.remote,
    FAKE_DB_ADDRESS,
    [POSTURE_BASELINE_VARIABLE]: HARNESS_POSTURE,
    FAKE_MASTER_RLS: HARNESS_POSTURE,
    ...env,
  };
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) if (v !== null) childEnv[k] = v;
  const r = spawnSync('bash', [path.join(h.repo, 'scripts', 'run-migrations.sh'), ...args], {
    cwd: h.repo,
    input: '',
    encoding: 'utf8',
    timeout: timeoutMs,
    env: childEnv,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** A local `sleep` that returns at once and records how long it was asked to wait. */
function installRecordingSleep(h: Harness): void {
  fs.writeFileSync(path.join(h.bin, 'sleep'), '#!/bin/bash\nprintf \'%s\\n\' "$*" >> "$FAKE_STATE/sleeps.log"\n', { mode: 0o755 });
}

/**
 * An ops host whose commands never finish: every status read answers
 * InProgress, from a bash stub (the Python fake is too slow to be asked
 * a thousand times), and every other call goes to the fake AWS CLI.
 */
function installNeverFinishingOpsHost(h: Harness): void {
  fs.renameSync(path.join(h.bin, 'aws'), path.join(h.bin, 'aws-fake'));
  fs.writeFileSync(path.join(h.bin, 'aws'), [
    '#!/bin/bash',
    'if [[ "$1 $2" == "ssm get-command-invocation" && " $* " == *" --query Status "* ]]; then',
    '  printf \'x\\n\' >> "$FAKE_STATE/status-reads.log"',
    '  echo InProgress',
    '  exit 0',
    'fi',
    'exec "${0%/*}/aws-fake" "$@"',
  ].join('\n') + '\n', { mode: 0o755 });
}

/** Passwords the fakes handed out or seeded, plus every created secret's value. */
function knownPasswords(h: Harness): string[] {
  const found = new Set(SEEDED_PASSWORDS);
  for (const f of fs.readdirSync(path.join(h.state, 'secrets'))) {
    const v = JSON.parse(fs.readFileSync(path.join(h.state, 'secrets', f), 'utf8'));
    // An empty password cannot leak (and every string "contains" it).
    if (typeof v.password === 'string' && v.password !== '') found.add(v.password);
  }
  return [...found];
}

function expectNoLeaks(h: Harness, r: RunResult): void {
  const printed = r.stdout + r.stderr;
  const argv = argvText(h);
  for (const pw of knownPasswords(h)) {
    expect(argv).not.toContain(pw);
    expect(printed).not.toContain(pw);
  }
  for (const marker of NEVER_PRINTED) expect(printed).not.toContain(marker);
  for (const login of ALL_PREPARED) expect(printed).not.toContain(ruleSecretName(login));
  expect(printed).not.toContain(WA_SECRET);
}

function statusLines(r: RunResult): string[] {
  return r.stdout.split('\n').filter((l) => /^\s+jale_[a-z0-9_]+: /.test(l)).map((l) => l.trim());
}

describe('run-migrations.sh against a fake AWS CLI and a fake ops host', () => {
  jest.setTimeout(240_000);
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
    // The fake must be the aws that resolves; a real CLI is never reachable.
    const resolved = execFileSync('bash', ['-c', 'command -v aws'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${h.bin}:${process.env.PATH ?? ''}` },
    }).trim();
    expect(resolved).toBe(path.join(h.bin, 'aws'));
  });

  afterEach(() => {
    fs.rmSync(h.dir, { recursive: true, force: true });
  });

  describe('posture control', () => {
    it.each(POSTURE_READINGS)('reads the master posture before anything else, records both readings, and continues when the reading equals the baseline (%s)', (reading) => {
      const r = runScript(h, ['--dry-run'], { [POSTURE_BASELINE_VARIABLE]: reading, FAKE_MASTER_RLS: reading });
      expect(r.status).toBe(0);
      expect(readLines(h, 'ssm-comments.log')).toEqual(['bastion readiness', 'posture control', 'read migration ledger']);
      expect(r.stdout).toContain(`Posture control: master row_security_active(public.users)=${reading}, server_version_num=160008 (baseline ${reading}, major 16): unchanged`);
      expectNoLeaks(h, r);
    });

    it.each(POSTURE_READINGS.map((baseline) => [baseline, otherReading(baseline)]))(
      'stops before the ledger is touched when the master reading moved from the baseline %s to %s',
      (baseline, reading) => {
        const r = runScript(h, ['--dry-run'], { [POSTURE_BASELINE_VARIABLE]: baseline, FAKE_MASTER_RLS: reading });
        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain(`master row_security_active(public.users) is ${reading}, baseline ${baseline}`);
        expect(r.stderr).toMatch(/--accept-posture-change/);
        expect(readLines(h, 'ssm-comments.log')).toEqual(['bastion readiness', 'posture control']);
      },
    );

    it.each([
      ['public.users is absent', { FAKE_MASTER_RLS: '' }, /public\.users was not found/],
      ['the engine major moved to 17', { FAKE_SERVER_VERSION_NUM: '170004' }, /engine major is 17 \(server_version_num=170004\), baseline 16/],
    ])('stops before the ledger is touched when %s', (_label, env, reason) => {
      const r = runScript(h, ['--dry-run'], env);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(reason);
      expect(r.stderr).toMatch(/--accept-posture-change/);
      expect(readLines(h, 'ssm-comments.log')).toEqual(['bastion readiness', 'posture control']);
    });

    it.each(POSTURE_READINGS.map((baseline) => [baseline, otherReading(baseline)]))(
      '--accept-posture-change continues past a changed reading and says so (baseline %s, reading %s)',
      (baseline, reading) => {
        const r = runScript(h, ['--dry-run', '--accept-posture-change'], {
          [POSTURE_BASELINE_VARIABLE]: baseline, FAKE_MASTER_RLS: reading, FAKE_SERVER_VERSION_NUM: '170004',
        });
        expect(r.status).toBe(0);
        expect(r.stderr).toMatch(/Posture control CHANGED/);
        expect(r.stderr).toContain(`row_security_active(public.users) is ${reading}, baseline ${baseline}`);
        expect(r.stderr).toMatch(/engine major is 17/);
        expect(r.stderr).toMatch(/continuing because --accept-posture-change was given/);
        expect(readLines(h, 'ssm-comments.log')).toContain('read migration ledger');
      },
    );

    it('runs in --prepare-logins too, and a changed reading stops it before any credential work', () => {
      const r = runScript(h, ['--prepare-logins', '--yes'], { FAKE_MASTER_RLS: otherReading(HARNESS_POSTURE) });
      expect(r.status).not.toBe(0);
      expect(readLines(h, 'ssm-comments.log')).toEqual(['bastion readiness', 'posture control']);
      expect(awsCalls(h).some((a) => a[0] === 'secretsmanager' && a[1] !== 'get-secret-value')).toBe(false);
    });

    describe('the operator baseline', () => {
      /** A value unique to this run, so a printed value cannot go unnoticed. */
      const marker = `baseline-${crypto.randomBytes(6).toString('hex')}`;

      it.each([
        ['unset', null],
        ['empty', ''],
        ['upper case', 'T'],
        ['upper case', 'F'],
        ['a word', 'true'],
        ['a word', 'false'],
        ['a digit', '1'],
        ['a digit', '0'],
        ['padded', ' t'],
        ['padded', 'f '],
        ['both letters', 'tf'],
        ['any other value', marker],
      ])('refuses a dry run before any AWS call when it is %s (%j), naming the variable and printing no value', (_state, value) => {
        const r = runScript(h, ['--dry-run'], { [POSTURE_BASELINE_VARIABLE]: value });
        expect(r.status).toBe(1);
        expect(awsCalls(h)).toEqual([]);
        expect(readLines(h, 'ssm-comments.log')).toEqual([]);
        expect(r.stderr).toContain(POSTURE_BASELINE_VARIABLE);
        // One fixed message whatever was given, so no value can be in it.
        const unset = runScript(h, ['--dry-run'], { [POSTURE_BASELINE_VARIABLE]: null });
        expect(r.stdout + r.stderr).toBe(unset.stdout + unset.stderr);
        expect(r.stdout + r.stderr).not.toContain(marker);
      });

      it.each([
        [[] as string[]],
        [['--prepare-logins', '--dry-run']],
        [['--enable-pgaudit', '--dry-run']],
        [['--disable-master-audit', '--dry-run']],
        [['--audit-status']],
        [['--list-holds']],
        [['--report', 'report.sql']],
      ])('refuses every form without it, before any AWS call (args: %j)', (args) => {
        // A report file that passes its own check, so the baseline is what stops the run.
        fs.writeFileSync(path.join(h.repo, 'report.sql'), 'SELECT 1;\n');
        const r = runScript(h, args, { [POSTURE_BASELINE_VARIABLE]: null });
        expect(r.status).toBe(1);
        expect(awsCalls(h)).toEqual([]);
        expect(readLines(h, 'ssm-comments.log')).toEqual([]);
        expect(r.stderr).toContain(POSTURE_BASELINE_VARIABLE);
      });
    });
  });

  describe('--prepare-logins', () => {
    it('creates each missing secret from an AWS-generated password, syncs the login from a SCRAM verifier and proves it', () => {
      const r = runScript(h, ['--prepare-logins', '--yes']);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);

      expect(statusLines(r)).toEqual([
        ...LEAST_PRIVILEGE_LOGINS.map(([login]) => `${login}: secret created, password synced, login verified`),
        `${SYNC_LOGIN}: secret exists, password synced, login verified`,
      ]);

      // One AWS-generated password per new login, asked for with the agreed shape.
      const generated = awsCalls(h).filter((a) => a[1] === 'get-random-password');
      expect(generated).toHaveLength(LEAST_PRIVILEGE_LOGINS.length);
      for (const a of generated) {
        expect(a).toEqual(expect.arrayContaining(['--password-length', '40', '--exclude-punctuation', '--require-each-included-type']));
      }

      for (const [login] of LEAST_PRIVILEGE_LOGINS) {
        const secret = readSecret(h, ruleSecretName(login))!;
        expect(secret).toBeDefined();
        expect(Object.keys(secret).sort()).toEqual(['dbname', 'host', 'password', 'port', 'username']);
        expect(secret).toMatchObject({ username: login, host: MASTER_SECRET.host, port: 5432, dbname: 'jale' });
        expect(String(secret.password)).toHaveLength(40);
        const meta = secretMeta(h, ruleSecretName(login))!;
        expect(meta.Tags).toEqual(expect.arrayContaining([{ Key: 'db-login', Value: login }]));
      }
      // Every create sent its value through stdin: the secret never rode on argv.
      for (const a of awsCalls(h).filter((c) => c[1] === 'create-secret')) {
        expect(a).toEqual(expect.arrayContaining(['--secret-string', 'file:///dev/stdin']));
        expect(a).not.toContain('--cli-input-json');
        expect(a.join(' ')).not.toMatch(/test-generated-/);
      }

      // Each login's database password is the verifier of its secret's password,
      // sent on psql's stdin.
      const set = alters(h);
      expect(set.map((a) => a.role)).toEqual(ALL_PREPARED);
      for (const a of set) {
        expect(a.via).toBe('stdin');
        expect(a.value).toMatch(/^SCRAM-SHA-256\$4096:/);
        const id = a.role === SYNC_LOGIN ? 'test-secret-AiDbSecret' : ruleSecretName(a.role);
        expect(scramMatches(a.value, String(readSecret(h, id)!.password))).toBe(true);
      }

      // The CDK-generated secret is synced, never rewritten.
      expect(readSecret(h, 'test-secret-AiDbSecret')).toEqual(SEEDED_SECRETS['test-secret-AiDbSecret']);
      expectNoLeaks(h, r);
    });

    it('never reaches --rotate-secrets: no rotation payload, no minted WhatsApp password, no other role touched', () => {
      const r = runScript(h, ['--prepare-logins', '--yes']);
      expect(r.status).toBe(0);
      expect(readLines(h, 'ssm-comments.log')).toEqual(['bastion readiness', 'posture control', 'prepare database logins']);
      expect(readLines(h, 'argv-wrapped.log').some((l) => l.startsWith('openssl'))).toBe(false);
      expect(awsCalls(h).some((a) => a[1] === 'put-secret-value')).toBe(false);
      expect(readSecret(h, WA_SECRET)).toBeUndefined();
      expect(alters(h).map((a) => a.role)).not.toEqual(expect.arrayContaining(['jale_whatsapp']));
      for (const role of ['jale_matching', 'jale_admin_console', 'jale_billing', 'jale_public_jobs', 'jale_whatsapp']) {
        expect(alters(h).some((a) => a.role === role)).toBe(false);
      }
    });

    it('is idempotent: a second run reuses every secret, asks for no new password and keeps every value', () => {
      expect(runScript(h, ['--prepare-logins', '--yes']).status).toBe(0);
      const before = Object.fromEntries(ALL_PREPARED.map((l) => [l, readSecret(h, l === SYNC_LOGIN ? 'test-secret-AiDbSecret' : ruleSecretName(l))]));
      const generatedBefore = awsCalls(h).filter((a) => a[1] === 'get-random-password').length;

      const r = runScript(h, ['--prepare-logins', '--yes']);
      expect(r.status).toBe(0);
      expect(statusLines(r)).toEqual(ALL_PREPARED.map((l) => `${l}: secret exists, password synced, login verified`));
      expect(awsCalls(h).filter((a) => a[1] === 'get-random-password')).toHaveLength(generatedBefore);
      expect(awsCalls(h).filter((a) => a[1] === 'create-secret')).toHaveLength(LEAST_PRIVILEGE_LOGINS.length);
      for (const l of ALL_PREPARED) {
        expect(readSecret(h, l === SYNC_LOGIN ? 'test-secret-AiDbSecret' : ruleSecretName(l))).toEqual(before[l]);
      }
      // Re-synced from the same password: a fresh salt, the same secret.
      const second = alters(h).slice(ALL_PREPARED.length);
      expect(second.map((a) => a.role)).toEqual(ALL_PREPARED);
      for (const a of second) {
        expect(scramMatches(a.value, String(before[a.role]!.password))).toBe(true);
      }
      expectNoLeaks(h, r);
    });

    it('stops with "apply migrations first" at a missing role, and creates nothing for it or after it', () => {
      setRoleAttrs(h, 'jale_job_digest', null);
      const r = runScript(h, ['--prepare-logins', '--yes']);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/jale_job_digest: role not found; apply migrations first/);
      expect(readSecret(h, ruleSecretName('jale_job_visibility_drain'))).toBeDefined();
      expect(readSecret(h, ruleSecretName('jale_job_digest'))).toBeUndefined();
      expect(readSecret(h, ruleSecretName('jale_job_ses_feedback'))).toBeUndefined();
      expect(alters(h).some((a) => a.role === 'jale_job_digest')).toBe(false);
      expectNoLeaks(h, r);
    });

    it.each([
      ['INHERIT', 't|f|t|f|f|f|f|-1|0', 'rolinherit'],
      ['BYPASSRLS', 't|f|f|f|f|f|t|-1|0', 'rolbypassrls'],
      ['a membership', 't|f|f|f|f|f|f|-1|1', 'memberships'],
      ['a connection limit', 't|f|f|f|f|f|f|20|0', 'rolconnlimit'],
      ['NOLOGIN', 'f|f|f|f|f|f|f|-1|0', 'rolcanlogin'],
    ])('refuses a login with %s, which the least-privilege definition forbids, before touching its secret', (_label, attrs, attribute) => {
      setRoleAttrs(h, 'jale_api', attrs);
      const r = runScript(h, ['--prepare-logins', '--yes']);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(`jale_api: role attributes differ from the least-privilege definition (${attribute})`);
      expect(readSecret(h, ruleSecretName('jale_api'))).toBeUndefined();
      expect(alters(h)).toHaveLength(0);
    });

    it('refuses to set any password unless password_encryption is scram-sha-256', () => {
      const r = runScript(h, ['--prepare-logins', '--yes'], { FAKE_PASSWORD_ENCRYPTION: 'md5' });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/password_encryption is md5, not scram-sha-256/);
      expect(awsCalls(h).some((a) => a[1] === 'create-secret' || a[1] === 'get-random-password')).toBe(false);
      expect(alters(h)).toHaveLength(0);
    });

    it('refuses an existing secret that does not belong to the login, and changes nothing', () => {
      setSecret(h, ruleSecretName('jale_api'), { ...MASTER_SECRET, username: 'jale_admin', password: 'test-wrong-owner-password-pw' });
      const r = runScript(h, ['--prepare-logins', '--yes']);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/jale_api: its secret does not match this login/);
      expect(readSecret(h, ruleSecretName('jale_api'))!.username).toBe('jale_admin');
      expect(alters(h)).toHaveLength(0);
      expectNoLeaks(h, r);
    });

    it('reports an AWS failure by its error code only', () => {
      const r = runScript(h, ['--prepare-logins', '--yes'], { FAKE_SM_FAIL_COMMANDS: 'describe-secret', FAKE_SM_FAIL_CODE: 'AccessDeniedException' });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/jale_api: checking its secret failed \(AccessDeniedException\); nothing was changed/);
      expect(alters(h)).toHaveLength(0);
      expectNoLeaks(h, r);
    });

    it('reports a failed login proof without echoing psql\'s connection error', () => {
      // A login that answers as itself but is not under row-level security.
      const r = runScript(h, ['--prepare-logins', '--yes', '--only', 'jale_api'], { FAKE_LOGIN_RLS: 'f' });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/jale_api: login check failed/);
      expectNoLeaks(h, r);
    });

    it('--only prepares exactly one login', () => {
      const r = runScript(h, ['--prepare-logins', '--only', 'jale_api_public', '--yes']);
      expect(r.status).toBe(0);
      expect(statusLines(r)).toEqual(['jale_api_public: secret created, password synced, login verified']);
      expect(alters(h).map((a) => a.role)).toEqual(['jale_api_public']);
      for (const login of ALL_PREPARED.filter((l) => l !== 'jale_api_public' && l !== SYNC_LOGIN)) {
        expect(readSecret(h, ruleSecretName(login))).toBeUndefined();
      }
    });

    it('--only jale_ai syncs just jale_ai from its CDK secret', () => {
      const r = runScript(h, ['--prepare-logins', '--only', 'jale_ai', '--yes']);
      expect(r.status).toBe(0);
      expect(statusLines(r)).toEqual(['jale_ai: secret exists, password synced, login verified']);
      expect(alters(h).map((a) => a.role)).toEqual(['jale_ai']);
      expect(awsCalls(h).some((a) => a[1] === 'create-secret' || a[1] === 'get-random-password')).toBe(false);
    });

    it('--dry-run checks every login and changes nothing', () => {
      // jale_ai already signs in with its secret; nothing else is prepared yet.
      fs.writeFileSync(path.join(h.state, 'roles', 'jale_ai.verifier'), execFileSync(PYTHON, [path.join(repoRoot, 'scripts', 'lib', 'scram-verifier.py')], { input: 'test-ai-seed-password-pw', encoding: 'utf8' }).trim());
      const r = runScript(h, ['--prepare-logins', '--dry-run']);
      expect(r.status).toBe(0);
      expect(statusLines(r)).toEqual([
        ...LEAST_PRIVILEGE_LOGINS.map(([login]) => `${login}: role ok, secret missing (would be created), password not set yet`),
        'jale_ai: role ok, secret exists, login verified (no change)',
      ]);
      expect(awsCalls(h).some((a) => ['create-secret', 'get-random-password', 'put-secret-value'].includes(a[1]))).toBe(false);
      expect(alters(h)).toHaveLength(0);
      expectNoLeaks(h, r);
    });

    it('takes its logins from the access manifest: a login added there is prepared, an unmarked one is not', () => {
      // A login a later change adds: one manifest entry plus its migration.
      writeManifest(h, fixtureManifest({
        jale_job_added_later: { kind: 'job', created_by: '1xx', connection_limit: 5, prepare_secret: true, workloads: 'fixture', reason: 'fixture' },
      }));
      setRoleAttrs(h, 'jale_job_added_later', 't|f|f|f|f|f|f|5|0');
      const r = runScript(h, ['--prepare-logins', '--yes']);
      expect(r.status).toBe(0);
      expect(statusLines(r).map((l) => l.split(':')[0])).toEqual([...ALL_PREPARED.slice(0, -1), 'jale_job_added_later', SYNC_LOGIN]);
      expect(readSecret(h, ruleSecretName('jale_job_added_later'))).toMatchObject({ username: 'jale_job_added_later' });
      // Unmarked service logins are never touched.
      for (const role of ['jale_whatsapp', 'jale_billing']) {
        expect(alters(h).some((a) => a.role === role)).toBe(false);
      }
      // Only names, limits and secret names reach the bastion, never the manifest.
      const payload = fs.readFileSync(path.join(h.state, 'ssm', '3.sh'), 'utf8');
      expect(payload).not.toContain('prepare_secret');
      expect(payload).not.toContain('fixture');
      expectNoLeaks(h, r);
    });

    it('refuses clearly, before any AWS call, when the access manifest is missing', () => {
      writeManifest(h, null);
      const r = runScript(h, ['--prepare-logins', '--yes']);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/the access manifest is missing/);
      expect(readLines(h, 'argv.log')).toHaveLength(0);
    });

    it.each([
      ['marks no login', { version: 1, logins: {} }, /marks no login with "prepare_secret": true/],
      ['has no logins section', { version: 1 }, /marks no login with "prepare_secret": true/],
      ['marks a service login', fixtureManifest({ jale_whatsapp: { kind: 'service', created_by: 'pre-104', connection_limit: -1, prepare_secret: true } }), /jale_whatsapp for preparation, but its kind is 'service'/],
      ['marks jale_ai', fixtureManifest({ jale_ai: { kind: 'job', created_by: 'pre-104', connection_limit: -1, prepare_secret: true } }), /jale_ai for preparation, but it is synced/],
      ['marks a name that is not a login', fixtureManifest({ "x'; DROP ROLE y; --": { kind: 'job', connection_limit: 5, prepare_secret: true } }), /whose name is not a login name/],
      ['marks a name with a doubled underscore', fixtureManifest({ jale_job__doubled: { kind: 'job', connection_limit: 5, prepare_secret: true } }), /whose name is not a login name/],
      ['marks a name with a trailing underscore', fixtureManifest({ jale_job_trailing_: { kind: 'job', connection_limit: 5, prepare_secret: true } }), /whose name is not a login name/],
      ['marks a name with a letter outside ASCII', fixtureManifest({ 'jale_job_\u00e9': { kind: 'job', connection_limit: 5, prepare_secret: true } }), /whose name is not a login name/],
      ['gives no connection limit', fixtureManifest({ jale_job_nolimit: { kind: 'job', prepare_secret: true } }), /jale_job_nolimit no whole-number connection_limit/],
    ])('refuses, before any AWS call, a manifest that %s', (_label, manifest, message) => {
      writeManifest(h, manifest as Record<string, unknown>);
      const r = runScript(h, ['--prepare-logins', '--yes']);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(message);
      expect(readLines(h, 'argv.log')).toHaveLength(0);
    });

    it('refuses a manifest that is not JSON', () => {
      fs.writeFileSync(path.join(h.repo, 'infra', 'db', 'access', 'manifest.json'), '{ not json');
      const r = runScript(h, ['--prepare-logins', '--yes']);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/the access manifest is not readable JSON/);
    });

    it('reads the manifest fragments too: a login listed only in a fragment is prepared, an unmarked one is not', () => {
      // How a later change adds a job login: one fragment in manifest.d/ plus its migration.
      writeFragment(h, 'later.json', {
        version: 1,
        logins: {
          jale_job_from_fragment: fixtureLogin('job', 3, true),
          jale_svc_from_fragment: fixtureLogin('service', -1, false),
        },
      });
      setRoleAttrs(h, 'jale_job_from_fragment', 't|f|f|f|f|f|f|3|0');
      const r = runScript(h, ['--prepare-logins', '--yes']);
      expect(r.status).toBe(0);
      expect(statusLines(r).map((l) => l.split(':')[0])).toEqual([...ALL_PREPARED.slice(0, -1), 'jale_job_from_fragment', SYNC_LOGIN]);
      expect(readSecret(h, ruleSecretName('jale_job_from_fragment'))).toMatchObject({ username: 'jale_job_from_fragment' });
      const payload = fs.readFileSync(path.join(h.state, 'ssm', '3.sh'), 'utf8');
      expect(payload).toMatch(/^run_login 'jale_job_from_fragment' new '3' /m);
      expect(payload).not.toContain('jale_svc_from_fragment');
      expect(alters(h).some((a) => a.role === 'jale_svc_from_fragment')).toBe(false);
      expectNoLeaks(h, r);
    });

    it('prepares a login whose name the agreed naming rule accepts, a word that starts with a digit included', () => {
      writeFragment(h, 'digit-word.json', { logins: { jale_2fa_sender: fixtureLogin('job', 2, true) } });
      setRoleAttrs(h, 'jale_2fa_sender', 't|f|f|f|f|f|f|2|0');
      const r = runScript(h, ['--prepare-logins', '--yes']);
      expect(r.status).toBe(0);
      expect(statusLines(r).map((l) => l.split(':')[0])).toContain('jale_2fa_sender');
      expect(readSecret(h, ruleSecretName('jale_2fa_sender'))).toMatchObject({ username: 'jale_2fa_sender' });
      expect(alters(h).some((a) => a.role === 'jale_2fa_sender')).toBe(true);
      expectNoLeaks(h, r);
    });

    it('treats an empty manifest.d/ as no fragments', () => {
      fs.mkdirSync(path.join(h.repo, 'infra', 'db', 'access', 'manifest.d'), { recursive: true });
      const r = runScript(h, ['--prepare-logins', '--dry-run']);
      expect(r.status).toBe(0);
      expect(statusLines(r).map((l) => l.split(':')[0])).toEqual(ALL_PREPARED);
    });

    it.each([
      ['repeats a login from manifest.json', { 'dup.json': { logins: { jale_api: fixtureLogin('request', -1, true) } } },
        /lists a login in more than one file: jale_api \(manifest\.json, manifest\.d\/dup\.json\)/],
      ['repeats an unmarked service login', { 'dup.json': { logins: { jale_whatsapp: fixtureLogin('service', -1, false) } } },
        /lists a login in more than one file: jale_whatsapp \(manifest\.json, manifest\.d\/dup\.json\)/],
      ['repeats a login from another fragment', {
        'a.json': { logins: { jale_job_twice: fixtureLogin('job', 5, true) } },
        'b.json': { logins: { jale_job_twice: fixtureLogin('job', 2, true) } },
      }, /lists a login in more than one file: jale_job_twice \(manifest\.d\/a\.json, manifest\.d\/b\.json\)/],
    ])('refuses, before any AWS call, a fragment that %s', (_label, fragments, message) => {
      for (const [name, fragment] of Object.entries(fragments)) writeFragment(h, name, fragment);
      const r = runScript(h, ['--prepare-logins', '--yes']);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(message);
      expect(readLines(h, 'argv.log')).toHaveLength(0);
    });

    it.each([
      ['is not JSON', '{ not json'],
      ['has a logins section that is not an object', JSON.stringify({ logins: [{ name: 'jale_job_listed' }] })],
      ['is not an object', JSON.stringify(['jale_job_listed'])],
    ])('refuses, before any AWS call, a fragment that %s, naming the file', (_label, text) => {
      writeFragment(h, 'broken.json', text);
      const r = runScript(h, ['--prepare-logins', '--yes']);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/the access manifest is not readable JSON with a logins object \(manifest\.d\/broken\.json\)/);
      expect(readLines(h, 'argv.log')).toHaveLength(0);
    });

    it.each([
      ['--prepare-logins with --rotate-secrets', ['--prepare-logins', '--rotate-secrets'], /never runs with --rotate-secrets/],
      ['--only without --prepare-logins', ['--only', 'jale_api'], /--only needs --prepare-logins/],
      ['--only with an unknown login', ['--prepare-logins', '--only', 'jale_nobody'], /not a login --prepare-logins prepares/],
      ['--prepare-logins with --baseline-through', ['--prepare-logins', '--baseline-through', '001_initial_schema.sql'], /applies no migrations/],
      ['--prepare-logins with --force-replay', ['--prepare-logins', '--force-replay'], /applies no migrations/],
    ])('rejects %s before any AWS call', (_label, args, message) => {
      const r = runScript(h, args);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(message);
      expect(readLines(h, 'argv.log')).toHaveLength(0);
    });
  });

  describe('--rotate-secrets', () => {
    it('sends every password as a SCRAM verifier on stdin and keeps every secret value out of argv', () => {
      const r = runScript(h, ['--rotate-secrets', '--yes']);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);

      const set = alters(h);
      expect(set.map((a) => a.role)).toEqual(['jale_matching', 'jale_admin_console', 'jale_billing', 'jale_public_jobs', 'jale_whatsapp']);
      const passwordOf: Record<string, string> = {
        jale_matching: 'test-matching-seed-pw',
        jale_admin_console: 'test-adminconsole-seed-pw',
        jale_billing: 'test-billing-seed-pw',
        jale_public_jobs: 'test-publicjobs-seed-pw',
        jale_whatsapp: String(readSecret(h, WA_SECRET)!.password),
      };
      for (const a of set) {
        expect(a.via).toBe('stdin');
        expect(scramMatches(a.value, passwordOf[a.role])).toBe(true);
      }

      // The WhatsApp secret is still written with its usual shape.
      const wa = readSecret(h, WA_SECRET)!;
      expect(wa).toMatchObject({ username: 'jale_whatsapp', host: MASTER_SECRET.host, port: 5432, dbname: 'jale' });
      expect(String(wa.password)).toMatch(/^[A-Za-z0-9]{20,24}$/);
      expect(r.stdout).toContain('jale_public_jobs credential check OK');
      expectNoLeaks(h, r);
    });

    /** The logins --rotate-secrets syncs from their CDK secrets, in its order. */
    const ROTATE_SOURCES: ReadonlyArray<readonly [string, string]> = [
      ['jale_matching', 'test-secret-MatchingDbSecret'],
      ['jale_admin_console', 'test-secret-AdminConsoleDbSecret'],
      ['jale_billing', 'test-secret-BillingDbSecret'],
      ['jale_public_jobs', 'test-secret-ReferralsDbSecret'],
    ];

    function expectStoppedAt(r: RunResult, login: string, reason: RegExp): void {
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`!! ${login}: `);
      expect(r.stderr).toMatch(reason);
      // Every login before it was synced; it and everything after it, the
      // WhatsApp login included, was left alone.
      const before = ROTATE_SOURCES.map(([l]) => l).slice(0, ROTATE_SOURCES.findIndex(([l]) => l === login));
      expect(alters(h).map((a) => a.role)).toEqual(before);
      expect(readSecret(h, WA_SECRET)).toBeUndefined();
      expectNoLeaks(h, r);
    }

    it.each(ROTATE_SOURCES)('stops at %s when its secret is {}, before that role or any later one changes', (login, id) => {
      setSecret(h, id, {});
      const r = runScript(h, ['--rotate-secrets', '--yes']);
      expectStoppedAt(r, login, /its secret has no usable password \(missing, not a string, or shorter than 20 characters\)/);
    });

    it.each([
      ['null', null],
      ['a number', 123456789012345678901234],
      ['an object', { value: 'test-nested-object-value-pw' }],
      ['an empty string', ''],
      ['19 characters', 'test-nineteen-ch-pw'],
    ])('stops when a source password is %s', (_label, password) => {
      setSecret(h, 'test-secret-BillingDbSecret', { username: 'jale_billing', password, host: 'db.test.invalid', port: 5432, dbname: 'jale' });
      const r = runScript(h, ['--rotate-secrets', '--yes']);
      expectStoppedAt(r, 'jale_billing', /its secret has no usable password/);
    });

    it('accepts a source password of exactly 20 characters', () => {
      setSecret(h, 'test-secret-BillingDbSecret', { username: 'jale_billing', password: 'test-twenty-chars-pw', host: 'db.test.invalid', port: 5432, dbname: 'jale' });
      const r = runScript(h, ['--rotate-secrets', '--yes']);
      expect(r.status).toBe(0);
      const billing = alters(h).find((a) => a.role === 'jale_billing')!;
      expect(scramMatches(billing.value, 'test-twenty-chars-pw')).toBe(true);
    });

    it('stops with the AWS error code only when a source secret cannot be read', () => {
      fs.rmSync(secretFile(h, 'test-secret-AdminConsoleDbSecret'));
      const r = runScript(h, ['--rotate-secrets', '--yes']);
      expectStoppedAt(r, 'jale_admin_console', /reading its secret failed \(ResourceNotFoundException\)/);
    });

    // The WhatsApp login: its secret is written first, the role is set only
    // after that write succeeded, from the same value, and the login is proven.
    const WA_PREVIOUS = 'test-whatsapp-previous-pw';
    const waRoleFile = (kind: 'plaintext' | 'verifier'): string => path.join(h.state, 'roles', `jale_whatsapp.${kind}`);

    /** An earlier rotation left the WhatsApp login's secret and its role in step. */
    function seedWhatsAppInStep(): void {
      setSecret(h, WA_SECRET, { host: MASTER_SECRET.host, port: 5432, dbname: 'jale', username: 'jale_whatsapp', password: WA_PREVIOUS });
      fs.writeFileSync(waRoleFile('plaintext'), WA_PREVIOUS);
    }

    /** The secret holds a new password and the role accepts exactly it. */
    function expectWhatsAppInStep(): void {
      const wa = readSecret(h, WA_SECRET)!;
      expect(wa).toMatchObject({ username: 'jale_whatsapp', host: MASTER_SECRET.host, port: 5432, dbname: 'jale' });
      expect(wa.password).not.toBe(WA_PREVIOUS);
      expect(fs.existsSync(waRoleFile('plaintext'))).toBe(false);
      expect(scramMatches(fs.readFileSync(waRoleFile('verifier'), 'utf8'), String(wa.password))).toBe(true);
    }

    it('proves the WhatsApp login signs in with the password its secret now holds', () => {
      seedWhatsAppInStep();
      const r = runScript(h, ['--rotate-secrets', '--yes']);
      expect(r.status).toBe(0);
      expectWhatsAppInStep();
      expect(r.stdout).toContain('jale_whatsapp credential check OK');
      const signIns = readLines(h, 'argv.log').map((l) => JSON.parse(l))
        .filter((c) => c.tool === 'psql' && (c.argv as string[]).includes('jale_whatsapp'));
      expect(signIns).toHaveLength(1);
      expectNoLeaks(h, r);
    });

    it('leaves the WhatsApp login on its previous password when updating its secret fails, and a re-run converges', () => {
      seedWhatsAppInStep();
      const failed = runScript(h, ['--rotate-secrets', '--yes'], { FAKE_SM_FAIL_COMMANDS: 'put-secret-value' });
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain(
        "!! jale_whatsapp: writing its secret failed (AccessDeniedException); the database was not changed and the login keeps its previous password");
      expect(alters(h).map((a) => a.role)).not.toContain('jale_whatsapp');
      expect(readSecret(h, WA_SECRET)!.password).toBe(WA_PREVIOUS);
      expect(fs.readFileSync(waRoleFile('plaintext'), 'utf8')).toBe(WA_PREVIOUS);
      expectNoLeaks(h, failed);

      const rerun = runScript(h, ['--rotate-secrets', '--yes']);
      expect(rerun.status).toBe(0);
      expectWhatsAppInStep();
      expect(rerun.stdout).toContain('jale_whatsapp credential check OK');
      expectNoLeaks(h, rerun);
    });

    it('changes nothing in the database when creating the WhatsApp login\'s secret fails', () => {
      const r = runScript(h, ['--rotate-secrets', '--yes'], { FAKE_SM_FAIL_COMMANDS: 'create-secret' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('!! jale_whatsapp: creating its secret failed (AccessDeniedException); the database was not changed');
      expect(alters(h).map((a) => a.role)).not.toContain('jale_whatsapp');
      expect(readSecret(h, WA_SECRET)).toBeUndefined();
      expectNoLeaks(h, r);
    });

    it('says to re-run when setting the role fails after its secret was written, and the re-run converges', () => {
      seedWhatsAppInStep();
      const failed = runScript(h, ['--rotate-secrets', '--yes'], { FAKE_FAIL_ALTER_ROLE: 'jale_whatsapp' });
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain(
        '!! jale_whatsapp: setting its database password failed after its secret was written; re-run --rotate-secrets');
      // The one state a re-run repairs: a new secret, the role on its previous password.
      expect(readSecret(h, WA_SECRET)!.password).not.toBe(WA_PREVIOUS);
      expect(fs.readFileSync(waRoleFile('plaintext'), 'utf8')).toBe(WA_PREVIOUS);
      expectNoLeaks(h, failed);

      const rerun = runScript(h, ['--rotate-secrets', '--yes']);
      expect(rerun.status).toBe(0);
      expectWhatsAppInStep();
      expectNoLeaks(h, rerun);
    });

    it('names the WhatsApp login\'s secret by its role in the dry run and in the confirmation prompt', () => {
      const dry = runScript(h, ['--rotate-secrets', '--dry-run']);
      expect(dry.status).toBe(0);
      expect(dry.stdout).toContain("--rotate-secrets would reset role passwords and reseed the WhatsApp login's secret.");
      expectNoLeaks(h, dry);

      // No --yes and nothing on stdin: the prompt is shown, and the run stops there.
      const prompt = runScript(h, ['--rotate-secrets']);
      expect(prompt.status).not.toBe(0);
      expect(prompt.stdout).toContain("Also rotating role passwords and reseeding the WhatsApp login's secret.");
      expect(alters(h)).toHaveLength(0);
      expectNoLeaks(h, prompt);
    });

    it('fails the run when the WhatsApp login does not sign in afterwards, without echoing psql\'s error', () => {
      const r = runScript(h, ['--rotate-secrets', '--yes'], { FAKE_DENY_LOGIN: 'jale_whatsapp' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('!! jale_whatsapp credential check FAILED');
      expect(r.stdout).not.toContain('jale_whatsapp credential check OK');
      // The refusal names the host and its address; neither reaches the operator.
      expectNoLeaks(h, r);
    });
  });

  describe('AWS failures, reported by their error code only', () => {
    it.each([
      ['bastion stack read', 'cloudformation:describe-stacks',
        '!! reading JaleBastionStack failed (AccessDeniedException); if it is not deployed, deploy it first: bash scripts/deploy-bastion.sh'],
      ['database stack read', 'cloudformation:describe-stack-resources',
        '!! reading the resources of JaleDatabaseStack failed (AccessDeniedException)'],
      ['send', 'ssm:send-command', '!! send-command failed for bastion readiness (AccessDeniedException)'],
      ['output read', 'ssm:get-command-invocation:StandardOutputContent',
        "!! 'bastion readiness' ended Success, but reading its output failed (AccessDeniedException). Check the ops-command log, and the ledger before re-running."],
    ])('stops at a refused %s with a fixed line and the code', (_what, call, line) => {
      const r = runScript(h, ['--dry-run'], { FAKE_FAIL_CALLS: call });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(line);
      expectNoLeaks(h, r);
    });

    it('reduces a refused master secret read on the ops host to its code, in the relayed error output', () => {
      const r = runScript(h, ['--dry-run'], { FAKE_SM_FAIL_COMMANDS: 'get-secret-value' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("!! bastion command 'posture control' ended: Failed");
      expect(r.stderr).toContain("!! the ops host could not read the master login's secret (AccessDeniedException)");
      expectNoLeaks(h, r);
    });

    it('reports a refused read of a failed command\'s error output by its code', () => {
      const r = runScript(h, ['--dry-run'], {
        FAKE_SM_FAIL_COMMANDS: 'get-secret-value',
        FAKE_FAIL_CALLS: 'ssm:get-command-invocation:StandardErrorContent',
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("!! bastion command 'posture control' ended: Failed");
      expect(r.stderr).toContain('!! reading its error output failed (AccessDeniedException)');
      expectNoLeaks(h, r);
    });
  });

  describe('waiting for a command on the ops host', () => {
    const UNKNOWN = 'its outcome is unknown. Check the ops-command log, and the ledger before re-running.';

    it('stops at a refused status read at once, with its error code only', () => {
      installRecordingSleep(h);
      const r = runScript(h, ['--dry-run'], { FAKE_SSM_STATUS_FAIL_CODE: 'AccessDeniedException' }, 60_000);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`!! waiting for 'bastion readiness' on the ops host failed (AccessDeniedException); ${UNKNOWN}`);
      expect(readLines(h, 'sleeps.log')).toEqual([]);
      expectNoLeaks(h, r);
    });

    it('asks again while the invocation is not visible yet, then carries on', () => {
      installRecordingSleep(h);
      const r = runScript(h, ['--dry-run'], { FAKE_SSM_INVISIBLE_READS: '2' }, 60_000);
      expect(r.status).toBe(0);
      expect(readLines(h, 'sleeps.log')).toEqual(['5', '5']);
      expectNoLeaks(h, r);
    });

    it('gives up on a command that never finishes after the bounded wait, and says its outcome is unknown', () => {
      installRecordingSleep(h);
      installNeverFinishingOpsHost(h);
      const r = runScript(h, ['--dry-run'], {}, 90_000);
      expect(r.status).toBe(1);
      const script = readScript();
      const poll = Number(script.match(/^SSM_POLL_SECONDS=(\d+)$/m)![1]);
      const polls = Number(script.match(/^SSM_MAX_POLLS=(\d+)$/m)![1]);
      const minutes = Math.floor(((polls - 1) * poll) / 60);
      expect(r.stderr).toContain(`!! 'bastion readiness' did not finish on the ops host after ${polls} status reads (at least ${minutes} minutes); ${UNKNOWN}`);
      expect(r.stderr).not.toContain('did not finish on the ops host within');
      expect(readLines(h, 'status-reads.log')).toHaveLength(1500);
      const sleeps = readLines(h, 'sleeps.log');
      expect(sleeps).toHaveLength(1499);
      expect(new Set(sleeps)).toEqual(new Set(['5']));
      expectNoLeaks(h, r);
    });
  });
});

// ---------------------------------------------------------------------------
// The ops-command output record and the engine audit modes, run against the
// fakes. The fake AWS CLI answers the log-group count from
// FAKE_COMMAND_LOG_GROUPS and records each request's CloudWatchOutputConfig;
// the fake ops host keeps the engine audit state in files: the extension, the
// master's pgaudit.log and each personal login's.
// ---------------------------------------------------------------------------

// A missing definition fails the static checks above, not the whole file.
const OPS_COMMAND_LOG_GROUP = readScript().match(/^OPS_COMMAND_LOG_GROUP="([^"]+)"$/m)?.[1] ?? 'no-ops-command-log-group-defined';
const PERSONS = ['jale_person_alpha', 'jale_person_beta2'];

function outputConfigs(h: Harness): Array<Record<string, unknown> | null> {
  return readLines(h, 'ssm-output.log').map((l) => JSON.parse(l));
}

function auditSql(h: Harness): Array<{ sql: string; single_transaction: boolean; via: string }> {
  return readLines(h, 'pgaudit-sql.log').map((l) => JSON.parse(l));
}

function setPerson(h: Harness, login: string, pgauditLog: string | null): void {
  setRoleAttrs(h, login, 't|f|t|f|f|f|f|2|1');
  const f = path.join(h.state, 'roles', `${login}.pgaudit`);
  if (pgauditLog === null) fs.rmSync(f, { force: true });
  else fs.writeFileSync(f, pgauditLog);
}

function personAudit(h: Harness, login: string): string | null {
  const f = path.join(h.state, 'roles', `${login}.pgaudit`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
}

function masterAudit(h: Harness): string | null {
  return personAudit(h, 'jale_admin');
}

function setMasterAudit(h: Harness, value: string | null): void {
  const f = path.join(h.state, 'roles', 'jale_admin.pgaudit');
  if (value === null) fs.rmSync(f, { force: true });
  else fs.writeFileSync(f, value);
}

function hasExtension(h: Harness): boolean {
  return fs.existsSync(path.join(h.state, 'extension-pgaudit'));
}

/** The status lines a payload printed with say(). */
function sayLines(r: RunResult): string[] {
  return r.stdout.split('\n').filter((l) => /^ {3}\S/.test(l)).map((l) => l.trim());
}

/** No secret, no personal login name, no value and not the group name in a run's output. */
function expectNoAuditOutputLeaks(h: Harness, r: RunResult): void {
  expectNoLeaks(h, r);
  const printed = r.stdout + r.stderr;
  for (const person of PERSONS) expect(printed).not.toContain(person);
  expect(printed).not.toContain('FAKE-VALUE-MUST-NOT-PRINT');
  expect(printed).not.toContain(OPS_COMMAND_LOG_GROUP);
}

/** The server state the audit parameter group gives. */
const GROUP_ATTACHED = { FAKE_PRELOAD: 'rdsutils,pg_stat_statements,pgaudit', FAKE_ERROR_VERBOSITY: 'terse' };

describe('run-migrations.sh: the ops-command output record and the engine audit modes, against the fakes', () => {
  jest.setTimeout(240_000);
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    fs.rmSync(h.dir, { recursive: true, force: true });
  });

  function expectNoAuditLeaks(r: RunResult): void {
    expectNoAuditOutputLeaks(h, r);
  }

  describe('ops-command output', () => {
    it('checks the group before the first command, and every command of a migration run carries the output config', () => {
      const r = runScript(h, ['--dry-run']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('>>    ops-command output: recorded');
      const calls = readLines(h, 'argv.log').map((l) => JSON.parse(l)).filter((c) => c.tool === 'aws').map((c) => c.argv as string[]);
      const check = calls.findIndex((a) => a[0] === 'logs' && a[1] === 'describe-log-groups');
      const firstSend = calls.findIndex((a) => a[0] === 'ssm' && a[1] === 'send-command');
      expect(check).toBeGreaterThan(-1);
      expect(check).toBeLessThan(firstSend);
      expect(calls[check]).toEqual(expect.arrayContaining(['--log-group-name-prefix', OPS_COMMAND_LOG_GROUP]));
      const configs = outputConfigs(h);
      expect(configs).toHaveLength(readLines(h, 'ssm-comments.log').length);
      for (const c of configs) expect(c).toEqual({ CloudWatchOutputEnabled: true, CloudWatchLogGroupName: OPS_COMMAND_LOG_GROUP });
      expectNoAuditLeaks(r);
    });

    it.each([
      [['--prepare-logins', '--yes']],
      [['--rotate-secrets', '--yes']],
      [['--enable-pgaudit', '--yes']],
      [['--disable-master-audit', '--yes']],
    ])('every command of %j carries the output config', (args) => {
      const r = runScript(h, args, GROUP_ATTACHED);
      expect(r.status).toBe(0);
      const configs = outputConfigs(h);
      expect(configs.length).toBeGreaterThanOrEqual(3);
      for (const c of configs) expect(c).toEqual({ CloudWatchOutputEnabled: true, CloudWatchLogGroupName: OPS_COMMAND_LOG_GROUP });
    });

    it('stops before anything reaches the ops host when the group does not exist', () => {
      const r = runScript(h, ['--dry-run'], { FAKE_COMMAND_LOG_GROUPS: '0' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("the ops-command log group does not exist, so this run's output would not be recorded");
      expect(readLines(h, 'ssm-comments.log')).toEqual([]);
      expectNoAuditLeaks(r);
    });

    it('--without-command-log sends without the config only while the group is missing, and says so', () => {
      const r = runScript(h, ['--dry-run', '--without-command-log'], { FAKE_COMMAND_LOG_GROUPS: '0' });
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("!! --without-command-log: the ops-command log group does not exist, and this run's output is NOT recorded.");
      expect(r.stderr).toContain("!! That is expected only before the audit stack's first deploy.");
      expect(outputConfigs(h).length).toBeGreaterThan(0);
      for (const c of outputConfigs(h)) expect(c).toBeNull();
    });

    it('refuses --without-command-log once the group exists, before anything is sent', () => {
      const r = runScript(h, ['--dry-run', '--without-command-log']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('--without-command-log is only for a run before the audit stack\'s first deploy, and the ops-command log group exists');
      expect(readLines(h, 'ssm-comments.log')).toEqual([]);
    });

    it('reports a failed check by its error code only, and sends nothing', () => {
      const r = runScript(h, ['--dry-run'], { FAKE_LOGS_FAIL_CODE: 'AccessDeniedException' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('checking the ops-command log group failed (AccessDeniedException)');
      expect(readLines(h, 'ssm-comments.log')).toEqual([]);
      expectNoAuditLeaks(r);
    });

    it('refuses an answer that is not a count of 0 or 1', () => {
      const r = runScript(h, ['--dry-run'], { FAKE_COMMAND_LOG_GROUPS: 'None' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('could not tell whether the ops-command log group exists');
      expect(readLines(h, 'ssm-comments.log')).toEqual([]);
    });
  });

  describe('--enable-pgaudit', () => {
    beforeEach(() => {
      for (const person of PERSONS) setPerson(h, person, null);
    });

    it('refuses before the audit parameter group is attached, and changes nothing', () => {
      const r = runScript(h, ['--enable-pgaudit', '--confirm-cutover-verified', '--yes']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('!! preflight: shared_preload_libraries does not include pgaudit');
      expect(r.stderr).toContain('!! preflight: log_error_verbosity is default, not terse');
      expect(r.stderr).toContain('refusing to enable engine audit logging before the audit parameter group is attached; nothing was changed');
      expect(auditSql(h)).toEqual([]);
      expect(hasExtension(h)).toBe(false);
      expect(masterAudit(h)).toBeNull();
      expectNoAuditLeaks(r);
    });

    it.each([
      [{ FAKE_PRELOAD: 'rdsutils,pgaudit', FAKE_ERROR_VERBOSITY: 'default' }, 'log_error_verbosity is default, not terse'],
      [{ FAKE_PRELOAD: 'rdsutils, pg_stat_statements', FAKE_ERROR_VERBOSITY: 'terse' }, 'shared_preload_libraries does not include pgaudit'],
      [{ FAKE_PRELOAD: 'rdsutils,pgauditlogtofile', FAKE_ERROR_VERBOSITY: 'terse' }, 'shared_preload_libraries does not include pgaudit'],
    ])('refuses when only one preflight fact holds (%j)', (env, why) => {
      const r = runScript(h, ['--enable-pgaudit', '--yes'], env);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`!! preflight: ${why}`);
      expect(auditSql(h)).toEqual([]);
    });

    it('creates the extension and audits every personal login in one transaction, leaving the master without --confirm-cutover-verified', () => {
      const r = runScript(h, ['--enable-pgaudit', '--yes'], GROUP_ATTACHED);
      expect(r.status).toBe(0);
      expect(readLines(h, 'ssm-comments.log')).toEqual(['bastion readiness', 'posture control', 'enable engine audit logging']);
      expect(sayLines(r)).toEqual([
        'preflight: pgaudit is loaded and log_error_verbosity is terse',
        'pgaudit extension: created',
        'master pgaudit.log: not set (not changed without --confirm-cutover-verified)',
        'personal logins: 2 of 2 log every statement (2 set by this run)',
      ]);
      const changes = auditSql(h);
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({ single_transaction: true, via: 'stdin' });
      expect(changes[0].sql).toContain('CREATE EXTENSION IF NOT EXISTS pgaudit;');
      expect(changes[0].sql).not.toContain('jale_admin');
      expect(hasExtension(h)).toBe(true);
      expect(masterAudit(h)).toBeNull();
      for (const person of PERSONS) expect(personAudit(h, person)).toBe('all');
      expect(r.stdout).toContain('>> Engine audit settings verified.');
      expectNoAuditLeaks(r);
    });

    it('with --confirm-cutover-verified also logs every master statement, and a second run changes nothing', () => {
      const first = runScript(h, ['--enable-pgaudit', '--confirm-cutover-verified', '--yes'], GROUP_ATTACHED);
      expect(first.status).toBe(0);
      expect(sayLines(first)).toContain('master pgaudit.log: set to all (was not set)');
      expect(auditSql(h)[0].sql).toContain("ALTER ROLE jale_admin SET pgaudit.log = 'all';");
      expect(masterAudit(h)).toBe('all');

      const second = runScript(h, ['--enable-pgaudit', '--confirm-cutover-verified', '--yes'], GROUP_ATTACHED);
      expect(second.status).toBe(0);
      expect(sayLines(second)).toEqual([
        'preflight: pgaudit is loaded and log_error_verbosity is terse',
        'pgaudit extension: present (no change)',
        'master pgaudit.log: all (no change)',
        'personal logins: 2 of 2 log every statement (0 set by this run)',
      ]);
      expectNoAuditLeaks(second);
    });

    it('--dry-run reports what it would do and changes nothing', () => {
      setPerson(h, PERSONS[0], 'all');
      const r = runScript(h, ['--enable-pgaudit', '--confirm-cutover-verified', '--dry-run'], GROUP_ATTACHED);
      expect(r.status).toBe(0);
      expect(sayLines(r)).toEqual([
        'preflight: pgaudit is loaded and log_error_verbosity is terse',
        'pgaudit extension: would be created',
        'master pgaudit.log: not set, would be set to all',
        'personal logins: 1 of 2 log every statement; 1 would be set',
        'dry run: nothing was changed',
      ]);
      expect(auditSql(h)).toEqual([]);
      expect(hasExtension(h)).toBe(false);
      expect(r.stdout).toContain('>> Engine audit check complete. Nothing was changed.');
    });

    it('reports a failed change by its kind only', () => {
      const r = runScript(h, ['--enable-pgaudit', '--yes'], { ...GROUP_ATTACHED, FAKE_PGAUDIT_FAIL: '1' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('enabling engine audit logging failed (query failed); the transaction was rolled back and nothing was changed');
      expect(hasExtension(h)).toBe(false);
      expectNoAuditLeaks(r);
    });

    it('fails when the read-back does not show every personal login audited', () => {
      const r = runScript(h, ['--enable-pgaudit', '--yes'], { ...GROUP_ATTACHED, FAKE_PGAUDIT_SKIP_PERSON: PERSONS[1] });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('1 personal login(s) do not log every statement after the change');
      expectNoAuditLeaks(r);
    });

    it('stops at a changed posture before the engine audit payload is sent', () => {
      const r = runScript(h, ['--enable-pgaudit', '--yes'], { ...GROUP_ATTACHED, FAKE_MASTER_RLS: otherReading(HARNESS_POSTURE) });
      expect(r.status).toBe(1);
      expect(readLines(h, 'ssm-comments.log')).toEqual(['bastion readiness', 'posture control']);
    });
  });

  describe('--disable-master-audit', () => {
    beforeEach(() => {
      for (const person of PERSONS) setPerson(h, person, 'all');
      fs.writeFileSync(path.join(h.state, 'extension-pgaudit'), '1');
    });

    it("resets the master's pgaudit.log and leaves every personal login as it is", () => {
      setMasterAudit(h, 'all');
      const r = runScript(h, ['--disable-master-audit', '--yes'], GROUP_ATTACHED);
      expect(r.status).toBe(0);
      expect(readLines(h, 'ssm-comments.log')).toEqual(['bastion readiness', 'posture control', 'reset master audit logging']);
      expect(sayLines(r)).toEqual([
        'master pgaudit.log: reset (was all)',
        'personal logins: unchanged (2 of 2 log every statement)',
      ]);
      expect(auditSql(h).map((c) => c.sql.trim())).toEqual(['ALTER ROLE jale_admin RESET pgaudit.log;']);
      expect(masterAudit(h)).toBeNull();
      for (const person of PERSONS) expect(personAudit(h, person)).toBe('all');
      expectNoAuditLeaks(r);
    });

    it('changes nothing when the master is not set, and in a dry run', () => {
      const unset = runScript(h, ['--disable-master-audit', '--yes'], GROUP_ATTACHED);
      expect(unset.status).toBe(0);
      expect(sayLines(unset)[0]).toBe('master pgaudit.log: not set (no change)');
      setMasterAudit(h, 'all');
      const dry = runScript(h, ['--disable-master-audit', '--dry-run'], GROUP_ATTACHED);
      expect(dry.status).toBe(0);
      expect(sayLines(dry)).toEqual([
        'master pgaudit.log: all, would be reset',
        'personal logins: unchanged (2 of 2 log every statement)',
        'dry run: nothing was changed',
      ]);
      expect(auditSql(h)).toEqual([]);
      expect(masterAudit(h)).toBe('all');
    });

    it('works whatever the parameter group says: a rollback may come before window 1', () => {
      setMasterAudit(h, 'all');
      const r = runScript(h, ['--disable-master-audit', '--yes']);
      expect(r.status).toBe(0);
      expect(masterAudit(h)).toBeNull();
    });
  });

  describe('argument rules', () => {
    it.each([
      [['--confirm-cutover-verified'], '--confirm-cutover-verified needs --enable-pgaudit'],
      [['--disable-master-audit', '--confirm-cutover-verified'], '--confirm-cutover-verified needs --enable-pgaudit'],
      [['--enable-pgaudit', '--prepare-logins'], 'are separate runs'],
      [['--enable-pgaudit', '--disable-master-audit'], 'are separate runs'],
      [['--enable-pgaudit', '--rotate-secrets'], 'apply no migrations and change no password'],
      [['--disable-master-audit', '--baseline-through', '001_initial_schema.sql'], 'apply no migrations and change no password'],
      [['--enable-pgaudit', '--force-replay'], 'apply no migrations and change no password'],
      [['--enable-pgaudit', '--skip-secrets'], 'apply no migrations and change no password'],
      [['--disable-master-audit', '--only', 'jale_api'], '--only needs --prepare-logins'],
    ])('%j is refused before any AWS call', (args, why) => {
      const r = runScript(h, args);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(why);
      expect(awsCalls(h)).toEqual([]);
    });
  });
});

// ===========================================================================
// The master's audit operations: --audit-status, --list-holds,
// --release-hold and --redact-and-release. Each runs one fixed statement as
// the master login, with its inputs checked here and passed as psql
// variables, and prints codes, counts, stream names, seqs and times only.
// ===========================================================================

/** The statements, exactly as the payload sends them. */
const AUDIT_OPS_SQL = {
  exportStatus: "SELECT s.stream, coalesce(to_char(s.watermark_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), 'never'), s.unexported_rows, s.batches, coalesce(to_char(s.last_batch_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), 'never'), coalesce(s.last_batch_rows, 0), s.held_rows, s.released_pending FROM jale_ops.audit_export_status() s ORDER BY s.stream;",
  eventCounts: "SELECT c.kind, c.outcome, c.surface, c.events FROM jale_ops.audit_event_counts(coalesce(nullif(:'since', '')::timestamptz, now() - interval '24 hours')) c ORDER BY c.kind, c.outcome, c.surface;",
  sinceText: "SELECT to_char(coalesce(nullif(:'since', '')::timestamptz, now() - interval '24 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"');",
  holdsCount: 'SELECT count(*) FROM jale_audit.list_holds();',
  listHolds: "SELECT h.stream, h.seq, to_char(h.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), coalesce(h.surface, 'none'), to_char(h.held_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), h.pattern_kind FROM jale_audit.list_holds() h ORDER BY h.held_at, h.stream, h.seq LIMIT 200;",
  releaseHold: "SELECT jale_audit.release_hold(:'stream', :'seq'::bigint);",
  redactAndRelease: "SELECT jale_audit.redact_and_release('events', :'seq'::bigint);",
};

describe('run-migrations.sh: the master\'s audit operations (static)', () => {
  function opsPayload(): string {
    const script = readScript();
    return heredocBody(script, 'MASTER_OPS_LIB') + heredocBody(script, 'AUDIT_OPS');
  }

  it('documents --audit-status, --since, --list-holds, --release-hold and --redact-and-release', () => {
    const script = readScript();
    for (const flag of ['--audit-status', '--since', '--list-holds', '--release-hold', '--redact-and-release']) {
      expect(script).toMatch(new RegExp(`^#\\s+${flag}\\b`, 'm'));
    }
    const help = execFileSync('bash', [scriptPath, '--help'], { encoding: 'utf8' });
    expect(help).toContain('--audit-status [--since');
    expect(help).toContain('--release-hold STREAM SEQ');
    expect(help).toContain('--redact-and-release SEQ');
  });

  it('sends exactly the pinned statements, each once, with every input as a psql variable', () => {
    const payload = heredocBody(readScript(), 'AUDIT_OPS');
    for (const [name, sql] of Object.entries(AUDIT_OPS_SQL)) {
      expect({ name, count: payload.split(sql).length - 1 }).toEqual({ name, count: 1 });
    }
    // The signatures migration 109 and 112 define: release_hold(stream, seq),
    // redact_and_release(stream, seq) with the events stream only,
    // audit_export_status(), audit_event_counts(since).
    expect(payload).not.toMatch(/release_hold\((?!:'stream', :'seq'::bigint\))/);
    expect(payload).not.toMatch(/redact_and_release\((?!'events', :'seq'::bigint\))/);
    // Inputs reach the statements only as :'var'; no shell value is spliced in.
    for (const sql of Object.values(AUDIT_OPS_SQL)) expect(sql).not.toMatch(/\$\{?\w/);
    expect(payload).toContain('-v stream="$HOLD_STREAM" -v seq="$HOLD_SEQ"');
    expect(payload).toContain('-v since="$AUDIT_SINCE"');
  });

  it('selects no value column: export status, event counts and holds are codes, counts, stream names, seqs and times', () => {
    const allowed = new Set([
      's.stream', 's.unexported_rows', 's.batches', 's.held_rows', 's.released_pending',
      'c.kind', 'c.outcome', 'c.surface', 'c.events', 'h.stream', 'h.seq', "coalesce(h.surface, 'none')", 'h.pattern_kind',
    ]);
    const timeOrCount = /^(coalesce\()?(to_char\()?[a-z]\.(watermark_at|last_batch_at|last_batch_rows|occurred_at|held_at)\b/;
    for (const name of ['exportStatus', 'eventCounts', 'listHolds'] as const) {
      const select = AUDIT_OPS_SQL[name].match(/^SELECT (.*?) FROM /)![1];
      // Split on top-level commas.
      const cols: string[] = [];
      let depth = 0; let cur = '';
      for (const ch of select) {
        if (ch === '(') depth += 1;
        if (ch === ')') depth -= 1;
        if (ch === ',' && depth === 0) { cols.push(cur.trim()); cur = ''; } else cur += ch;
      }
      cols.push(cur.trim());
      for (const col of cols) expect({ name, col, ok: allowed.has(col) || timeOrCount.test(col) }).toEqual({ name, col, ok: true });
    }
    // --list-holds selects exactly the columns of jale_audit.list_holds() (stream, seq,
    // occurred_at, surface, held_at, pattern_kind), surface NULL printed as none.
    expect(AUDIT_OPS_SQL.listHolds).toMatch(/^SELECT h\.stream, h\.seq, to_char\(h\.occurred_at [^)]*\), coalesce\(h\.surface, 'none'\), to_char\(h\.held_at [^)]*\), h\.pattern_kind FROM jale_audit\.list_holds\(\) h /);
    // The watermark itself (a transaction id) is not printed, only its time.
    expect(AUDIT_OPS_SQL.exportStatus).not.toMatch(/s\.watermark[,\s]/);
  });

  it('checks every input here, before anything is sent', () => {
    const script = readScript();
    expect(script).toContain('AUDIT_STREAMS=(events changes admin_actions_legacy)');
    expect(script).toMatch(/^is_hold_seq\(\) \{.*\}$/m);
    expect(script).toMatch(/^is_utc_timestamp\(\) \{.*\}$/m);
  });

  it('asks before a hold is released or redacted, and reports a refusal by its code only', () => {
    const script = readScript();
    const payload = opsPayload();
    expect(script).toContain("About to release held row");
    expect(script).toContain("About to redact the reason of held event");
    // The two changing statements run with sqlstate verbosity: an error is its code.
    expect(payload).toContain('master_psql_code -v stream="$HOLD_STREAM" -v seq="$HOLD_SEQ"');
    expect(payload).toMatch(/"\$\{PG\[@\]\}" -X -q -At -v VERBOSITY=sqlstate "\$@"/);
    expect(payload).not.toMatch(/^\s*echo\b/m);
    const sensitive = /\$\{?(SECRET_JSON|PGPASSWORD|DB_HOST|DB_PORT|DB_NAME|DB_USER|ERR)\b/;
    for (const line of payload.split('\n').filter((l) => /\b(say|warn|fail)\s/.test(l))) expect(line).not.toMatch(sensitive);
  });

  it('runs each operation after the posture control and leaves before the ledger, the migrations and --rotate-secrets', () => {
    const script = readScript();
    const run = script.indexOf('run_on_bastion "$WORKDIR/audit-ops.sh" "$audit_ops_comment" true');
    expect(run).toBeGreaterThan(script.indexOf('run_on_bastion "$WORKDIR/posture.sh" "posture control" true'));
    const exitAt = script.indexOf('\n  exit 0\n', run);
    expect(script.slice(run + 1, exitAt)).not.toContain('run_on_bastion');
    expect(exitAt).toBeLessThan(script.indexOf('run_on_bastion "$WORKDIR/read-ledger.sh"'));
    const payload = heredocBody(script, 'AUDIT_OPS');
    expect(payload).not.toMatch(/secretsmanager|WITH PASSWORD|schema_migrations|ALTER ROLE/);
  });
});

describe('run-migrations.sh: the master\'s audit operations, against the fakes', () => {
  jest.setTimeout(240_000);
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    fs.rmSync(h.dir, { recursive: true, force: true });
  });

  const expectNoAuditLeaks = (r: RunResult): void => expectNoAuditOutputLeaks(h, r);

  function opsCalls(): Array<{ sql: string; vars: Record<string, string>; verbosity: string }> {
    return readLines(h, 'audit-ops.log').map((l) => JSON.parse(l));
  }

  const HOLDS = [
    ['events', '41', '2026-10-04T10:00:00Z', 'admin.users.reveal', '2026-10-04T10:05:00Z', 'phone'],
    ['admin_actions_legacy', '7', '2026-10-03T09:00:00Z', 'none', '2026-10-04T10:05:00Z', 'several'],
  ];

  it('--audit-status prints the export state and the access-event counts since 24 hours ago', () => {
    const r = runScript(h, ['--audit-status']);
    expect(r.status).toBe(0);
    expect(readLines(h, 'ssm-comments.log')).toEqual(['bastion readiness', 'posture control', 'audit status']);
    expect(sayLines(r)).toEqual([
      'export events: watermark at 2026-10-05T10:00:00Z, 3 unexported row(s), 12 batch(es), last batch at 2026-10-05T09:55:00Z with 4 row(s), 1 held, 0 released and waiting',
      'export changes: watermark at never, 0 unexported row(s), 0 batch(es), last batch at never with 0 row(s), 0 held, 0 released and waiting',
      'access events since 2026-10-04T10:00:00Z:',
      'read allowed api.worker.profile: 5',
      'attempt denied admin.users.reveal: 1',
    ]);
    expect(opsCalls().find((c) => c.sql.includes('audit_event_counts'))!.vars).toEqual({ since: '' });
    for (const c of outputConfigs(h)) expect(c).toEqual({ CloudWatchOutputEnabled: true, CloudWatchLogGroupName: OPS_COMMAND_LOG_GROUP });
    expectNoAuditLeaks(r);
  });

  it('--audit-status --since passes a checked UTC time, and refuses anything else before any AWS call', () => {
    expect(runScript(h, ['--audit-status', '--since', '2026-10-01T00:00:00Z']).status).toBe(0);
    expect(opsCalls().find((c) => c.sql.includes('audit_event_counts'))!.vars).toEqual({ since: '2026-10-01T00:00:00Z' });
    const before = awsCalls(h).length;
    for (const bad of ['2026-10-01', '2026-10-01T00:00:00', '2026-10-01T00:00:00+00:00', '2026-13-01T00:00:00Z',
      "2026-10-01T00:00:00Z'; DROP TABLE x; --", 'yesterday', '']) {
      const r = runScript(h, ['--audit-status', '--since', bad]);
      expect({ bad, status: r.status }).toEqual({ bad, status: 2 });
      expect(r.stderr).toContain('--since must be a UTC time like 2026-10-01T00:00:00Z');
    }
    expect(runScript(h, ['--list-holds', '--since', '2026-10-01T00:00:00Z']).status).toBe(2);
    expect(awsCalls(h).length).toBe(before);
  });

  it('--list-holds prints the holds and their count, codes and times only', () => {
    const r = runScript(h, ['--list-holds'], { FAKE_HOLDS: JSON.stringify(HOLDS) });
    expect(r.status).toBe(0);
    expect(sayLines(r)).toEqual([
      'held rows: 2',
      'hold: stream events, seq 41, occurred 2026-10-04T10:00:00Z, surface admin.users.reveal, held 2026-10-04T10:05:00Z, pattern phone',
      'hold: stream admin_actions_legacy, seq 7, occurred 2026-10-03T09:00:00Z, surface none, held 2026-10-04T10:05:00Z, pattern several',
    ]);
    expectNoAuditLeaks(r);
  });

  it('--release-hold releases one held row by stream and seq, after a prompt', () => {
    const prompt = runScript(h, ['--release-hold', 'events', '41'], { FAKE_HOLDS: JSON.stringify(HOLDS) });
    expect(prompt.status).toBe(1);
    expect(prompt.stdout).toContain('About to release held row events 41');
    expect(opsCalls().filter((c) => c.sql.includes('release_hold'))).toEqual([]);

    const r = runScript(h, ['--release-hold', 'events', '41', '--yes'], { FAKE_HOLDS: JSON.stringify(HOLDS) });
    expect(r.status).toBe(0);
    expect(sayLines(r)).toEqual(['released: stream events, seq 41 (hold record 901)']);
    const call = opsCalls().find((c) => c.sql.includes('release_hold'))!;
    expect(call).toEqual({ sql: AUDIT_OPS_SQL.releaseHold, vars: { stream: 'events', seq: '41' }, verbosity: 'sqlstate' });
    expectNoAuditLeaks(r);
  });

  it('--redact-and-release redacts and releases one held event by seq, after a prompt', () => {
    const r = runScript(h, ['--redact-and-release', '41', '--yes'], { FAKE_HOLDS: JSON.stringify(HOLDS) });
    expect(r.status).toBe(0);
    expect(sayLines(r)).toEqual(['redacted and released: stream events, seq 41 (hold record 902)']);
    const call = opsCalls().find((c) => c.sql.includes('redact_and_release'))!;
    expect(call).toEqual({ sql: AUDIT_OPS_SQL.redactAndRelease, vars: { seq: '41' }, verbosity: 'sqlstate' });
  });

  it('reports a refused release by its code only', () => {
    const r = runScript(h, ['--release-hold', 'changes', '999', '--yes'], { FAKE_HOLDS: JSON.stringify(HOLDS) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('!! release_hold refused (22023): the row is not held, or is already released; nothing was changed');
    expect(r.stdout + r.stderr).not.toContain('FAKE-VALUE-MUST-NOT-PRINT');
    expectNoAuditLeaks(r);
  });

  it.each([
    [['--release-hold', 'event', '41'], 'the stream must be events, changes or admin_actions_legacy'],
    [['--release-hold', 'events', '0'], 'the seq must be a whole number from 1'],
    [['--release-hold', 'events', '41x'], 'the seq must be a whole number from 1'],
    [['--release-hold', 'events', '99999999999999999999'], 'the seq must be a whole number from 1'],
    [['--release-hold', 'events'], '--release-hold needs a stream and a seq'],
    [['--redact-and-release', "41' OR '1"], 'the seq must be a whole number from 1'],
    [['--redact-and-release'], '--redact-and-release needs a seq'],
    [['--audit-status', '--list-holds'], 'are separate runs'],
    [['--list-holds', '--prepare-logins'], 'are separate runs'],
    [['--release-hold', 'events', '1', '--enable-pgaudit'], 'are separate runs'],
    [['--redact-and-release', '1', '--disable-master-audit'], 'are separate runs'],
    [['--audit-status', '--rotate-secrets'], 'apply no migrations and change no password'],
    [['--list-holds', '--baseline-through', '001_initial_schema.sql'], 'apply no migrations and change no password'],
    [['--audit-status', '--dry-run'], '--dry-run does not apply to'],
    [['--release-hold', 'events', '1', '--dry-run'], '--dry-run does not apply to'],
    [['--since', '2026-10-01T00:00:00Z'], '--since needs --audit-status'],
  ])('%j is refused before any AWS call', (args, why) => {
    const r = runScript(h, args);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(why);
    expect(awsCalls(h)).toEqual([]);
  });
});

// ===========================================================================
// --report FILE: a read-only report, run as the master login. The file is
// checked here before anything is sent (SELECT, WITH, VALUES and TABLE
// statements only, comments only on lines of their own), sent without its
// comments, and run in one read-only transaction that is rolled back, in a
// session whose default is read-only. The output is the results only.
// ===========================================================================

/** The report file the harness tests write, relative to the run's working directory. */
const REPORT_FILE = 'report.sql';

function writeReport(h: Harness, text: string): void {
  fs.writeFileSync(path.join(h.repo, REPORT_FILE), text);
}

/** The statements a report payload carries, decoded the way the ops host decodes them. */
function reportPayloadSql(payload: string): string {
  const m = payload.match(/^REPORT_SQL_B64='([A-Za-z0-9+/=]+)'$/m);
  if (!m) throw new Error('no REPORT_SQL_B64 in the payload');
  return zlib.gunzipSync(Buffer.from(m[1], 'base64')).toString('utf8');
}

describe('run-migrations.sh: the read-only report (static)', () => {
  it('documents --report FILE, and --help prints it', () => {
    const script = readScript();
    expect(script).toMatch(/^#\s+bash scripts\/run-migrations\.sh --report FILE$/m);
    expect(script).toMatch(/^#\s+--report FILE\b/m);
    const help = execFileSync('bash', [scriptPath, '--help'], { encoding: 'utf8' });
    expect(help).toContain('--report FILE');
    expect(help).not.toContain('Why this script is shaped');
  });

  it('runs the statements in one read-only transaction that is rolled back, in a read-only session, stopping at the first error', () => {
    const payload = heredocBody(readScript(), 'REPORT_OPS');
    expect(payload).toContain("printf '%s\\n' 'BEGIN READ ONLY;'");
    expect(payload).toContain("printf '%s\\n' 'ROLLBACK;'");
    const calls = payload.split('\n').filter((l) => /"\$\{PG\[@\]\}"/.test(l));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`PGOPTIONS='-c default_transaction_read_only=on' "\${PG[@]}" -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate -f -`);
    // psql's own transaction wrapper would send its BEGIN first, and READ ONLY would not apply.
    expect(payload).not.toMatch(/(^|\s)(-1|--single-transaction)(\s|$)/m);
    // The checked statements arrive encoded and checksum-verified, as a migration does.
    expect(payload).toContain('base64 -d | gunzip > "$REPORT_SQL"');
    expect(payload).toContain('sha256sum "$REPORT_SQL"');
  });

  it('prints the results only once the transaction ended without an error, and reports a failure by its code', () => {
    const payload = heredocBody(readScript(), 'REPORT_OPS');
    expect(payload).not.toMatch(/^\s*echo\b/m);
    const run = payload.indexOf('>"$AUDIT_DIR/report.out" 2>"$ERR"');
    const failed = payload.indexOf('|| report_failed', run);
    const printed = payload.indexOf('cat "$AUDIT_DIR/report.out"');
    expect(run).toBeGreaterThan(-1);
    expect(failed).toBeGreaterThan(run);
    expect(printed).toBeGreaterThan(failed);
    const sensitive = /\$\{?(SECRET_JSON|PGPASSWORD|DB_HOST|DB_PORT|DB_NAME|DB_USER|ERR|REPORT_SQL_B64)\b/;
    for (const line of payload.split('\n').filter((l) => /\b(say|warn|fail)\s/.test(l))) expect(line).not.toMatch(sensitive);
    expect(payload).not.toMatch(/secretsmanager|WITH PASSWORD|schema_migrations|ALTER ROLE/);
  });

  it('checks the file before the posture baseline, so a refused file sends nothing', () => {
    const script = readScript();
    const check = script.indexOf('check_report_file "$REPORT_FILE"');
    const baseline = script.search(new RegExp(`^if \\[\\[ "\\$\\{${POSTURE_BASELINE_VARIABLE}:-\\}" != "t"`, 'm'));
    expect(check).toBeGreaterThan(-1);
    expect(baseline).toBeGreaterThan(check);
  });
});

describe('run-migrations.sh --report, against the fakes', () => {
  jest.setTimeout(240_000);
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    fs.rmSync(h.dir, { recursive: true, force: true });
  });

  function reportRuns(): Array<{ sql: string; argv: string[]; user: string; pgoptions: string | null; vars: Record<string, string> }> {
    return readLines(h, 'report.log').map((l) => JSON.parse(l));
  }

  const ACCEPTED = [
    '-- REPORT-COMMENT-ONE: what the counts are for',
    "SELECT 'f19' AS item, count(*) AS queued",
    '  FROM report_fixture_table',
    " WHERE status IN ('pending', 'send_unknown');",
    '',
    '    -- REPORT-COMMENT-TWO, indented: expected to return 0 rows',
    'WITH recent AS (',
    "  SELECT id FROM report_fixture_table WHERE created_at > now() - interval '1 day'",
    ')',
    'SELECT count(*) AS recent FROM recent;',
    'values (1), (2);',
    'TABLE report_fixture_view;',
    '(SELECT 1 AS one);',
    '',
  ].join('\n');
  /** What is sent: the file, its comment lines left empty. */
  const SENT = ACCEPTED.split('\n').map((l) => (/^\s*--/.test(l) ? '' : l)).join('\n');

  it('sends the statements without their comments, runs them read-only and rolls back, and prints the results only', () => {
    writeReport(h, ACCEPTED);
    const ledgerBefore = fs.readFileSync(path.join(h.state, 'ledger.txt'), 'utf8');
    const r = runScript(h, ['--report', REPORT_FILE]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(readLines(h, 'ssm-comments.log')).toEqual(['bastion readiness', 'posture control', 'read-only report']);

    // The payload: the read-only wrapper and session setting, and the checked statements, comments gone.
    const payload = fs.readFileSync(path.join(h.state, 'ssm', '3.sh'), 'utf8');
    expect(payload).toContain('BEGIN READ ONLY;');
    expect(payload).toContain('ROLLBACK;');
    expect(payload).toContain('default_transaction_read_only=on');
    expect(payload).not.toContain('REPORT-COMMENT');
    const sent = reportPayloadSql(payload);
    expect(sent).toBe(SENT);
    expect(sent).not.toContain('REPORT-COMMENT');
    expect(sent).not.toContain('--');

    // What psql received, and how.
    const runs = reportRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].sql).toBe(`BEGIN READ ONLY;\n${SENT}ROLLBACK;\n`);
    expect(runs[0].pgoptions).toBe('-c default_transaction_read_only=on');
    expect(runs[0].user).toBe('jale_admin');
    expect(runs[0].argv).toEqual(expect.arrayContaining(['-X', '-q', '-f', '-']));
    expect(runs[0].argv).not.toContain('-1');
    expect(runs[0].argv).not.toContain('--single-transaction');
    expect(runs[0].vars).toMatchObject({ ON_ERROR_STOP: '1', VERBOSITY: 'sqlstate' });

    // Nothing is written anywhere: no secret is put, updated or rotated, no
    // password is set, the ledger and the logins are as they were, and the
    // report's payload carries no migration, ledger or password statement.
    expect(awsCalls(h).filter((argv) => argv[0] === 'secretsmanager' && !['get-secret-value', 'describe-secret'].includes(argv[1])))
      .toEqual([]);
    for (const [id, value] of Object.entries(SEEDED_SECRETS)) expect(readSecret(h, id)).toEqual(value);
    expect(alters(h)).toEqual([]);
    expect(fs.readFileSync(path.join(h.state, 'ledger.txt'), 'utf8')).toBe(ledgerBefore);
    expect(fs.readdirSync(path.join(h.state, 'roles')).filter((f) => !f.endsWith('.attrs'))).toEqual([]);
    expect(payload).not.toMatch(/schema_migrations|ALTER ROLE|WITH PASSWORD|put-secret-value|jale-mig\.sql/);

    // The results reach the operator; the statements and the comments do not.
    expect(r.stdout).toContain(' item | queued\n------+--------\n f19  |      0\n(1 row)');
    expect(sayLines(r)).toContain('read-only report: complete; its transaction was rolled back');
    const printed = r.stdout + r.stderr;
    for (const text of ['report_fixture', 'REPORT-COMMENT', 'BEGIN READ ONLY', "interval '1 day'"]) expect(printed).not.toContain(text);
    expect(outputConfigs(h)).toHaveLength(3);
    for (const c of outputConfigs(h)) expect(c).toEqual({ CloudWatchOutputEnabled: true, CloudWatchLogGroupName: OPS_COMMAND_LOG_GROUP });
    expectNoAuditOutputLeaks(h, r);
  });

  it('reports a failed report by its code only, and prints none of its results', () => {
    writeReport(h, ACCEPTED);
    const r = runScript(h, ['--report', REPORT_FILE], { FAKE_REPORT_FAIL: '1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("!! bastion command 'read-only report' ended: Failed");
    expect(r.stderr).toContain('!! the report stopped (25006): the read-only transaction refused a statement; nothing was changed');
    const printed = r.stdout + r.stderr;
    expect(printed).not.toContain('PARTIAL-RESULT');
    expect(printed).not.toContain('report_fixture');
    expectNoAuditOutputLeaks(h, r);
  });

  it('stops at a changed posture before the report is sent', () => {
    writeReport(h, ACCEPTED);
    const r = runScript(h, ['--report', REPORT_FILE], { FAKE_MASTER_RLS: otherReading(HARNESS_POSTURE) });
    expect(r.status).toBe(1);
    expect(readLines(h, 'ssm-comments.log')).toEqual(['bastion readiness', 'posture control']);
    expect(reportRuns()).toEqual([]);
  });

  it.each([
    ['a backslash (a psql command)', 'SELECT 1;\n\\copy (SELECT 1) TO report_fixture.csv\n', 'line 2 holds a backslash; psql commands are refused'],
    ['a backslash inside a string', "SELECT 'report_fixture\\n';\n", 'line 1 holds a backslash'],
    ['transaction control', 'BEGIN;\nSELECT 1 FROM report_fixture_table;\n',
      'the statement on line 1 starts with BEGIN; transaction control and session statements are refused'],
    ['a session statement', 'SELECT 1;\n\nSET search_path = report_fixture;\n',
      'the statement on line 3 starts with SET; transaction control and session statements are refused'],
    ['a schema change at statement start', 'SELECT 1;\nDROP TABLE report_fixture_table;\n',
      'the statement on line 2 starts with DROP; data and schema changes are refused'],
    ['a data change at statement start', 'TRUNCATE report_fixture_table;\n',
      'the statement on line 1 starts with TRUNCATE; data and schema changes are refused'],
    ['an INSERT', 'INSERT INTO report_fixture_table VALUES (1);\n', 'line 1 holds INSERT; a report only reads'],
    ['a data-modifying WITH', 'WITH gone AS (\n  delete FROM report_fixture_table RETURNING id\n)\nSELECT count(*) FROM gone;\n',
      'line 2 holds DELETE; a report only reads'],
    ['SELECT INTO', 'SELECT * INTO report_fixture_copy FROM report_fixture_table;\n', 'line 1 holds INTO; a report only reads'],
    ['a row lock', 'SELECT id FROM report_fixture_table FOR UPDATE;\n', 'line 1 holds UPDATE; a report only reads'],
    ['another statement', 'EXPLAIN SELECT 1 FROM report_fixture_table;\n',
      'the statement on line 1 does not start with SELECT, WITH, VALUES or TABLE'],
    ['a comment after a statement', 'SELECT 1 FROM report_fixture_table; -- note\n',
      'line 1 holds a comment that is not on a line of its own'],
    ['a block comment', '/* note */\nSELECT 1 FROM report_fixture_table;\n', 'line 1 holds a comment that is not on a line of its own'],
    ['a comment marker inside a string', "SELECT '--' AS report_fixture; DELETE FROM report_fixture_table;\n",
      'line 1 holds a comment that is not on a line of its own'],
    ['a last statement without a semicolon', 'SELECT 1 FROM report_fixture_table;\nSELECT 2\n',
      'the last statement does not end with a semicolon'],
    ['comments only', '-- report_fixture: nothing to run\n', 'the file holds no statement'],
    ['an empty file', '', 'the file is empty'],
  ])('refuses %s before any AWS call, naming the rule and not the text', (_label, text, why) => {
    writeReport(h, text);
    const r = runScript(h, ['--report', REPORT_FILE]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`!! --report: ${why}`);
    expect(r.stderr).not.toContain('report_fixture');
    expect(awsCalls(h)).toEqual([]);
    expect(readLines(h, 'ssm-comments.log')).toEqual([]);
  });

  it('refuses a file that does not exist before any AWS call', () => {
    const r = runScript(h, ['--report', 'no-such-report.sql']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('!! --report: the file does not exist or cannot be read');
    expect(awsCalls(h)).toEqual([]);
  });

  describe('argument rules', () => {
    beforeEach(() => {
      writeReport(h, 'SELECT 1;\n');
    });

    it.each([
      [['--report', REPORT_FILE, '--prepare-logins'], 'are separate runs'],
      [['--report', REPORT_FILE, '--enable-pgaudit'], 'are separate runs'],
      [['--report', REPORT_FILE, '--disable-master-audit'], 'are separate runs'],
      [['--report', REPORT_FILE, '--audit-status'], 'are separate runs'],
      [['--report', REPORT_FILE, '--list-holds'], 'are separate runs'],
      [['--report', REPORT_FILE, '--release-hold', 'events', '1'], 'are separate runs'],
      [['--report', REPORT_FILE, '--redact-and-release', '1'], 'are separate runs'],
      [['--report', REPORT_FILE, '--report', REPORT_FILE], '--report may be given once'],
      [['--report', REPORT_FILE, '--rotate-secrets'], 'apply no migrations and change no password'],
      [['--report', REPORT_FILE, '--baseline-through', '001_initial_schema.sql'], 'apply no migrations and change no password'],
      [['--report', REPORT_FILE, '--force-replay'], 'apply no migrations and change no password'],
      [['--report', REPORT_FILE, '--skip-secrets'], 'apply no migrations and change no password'],
      [['--report', REPORT_FILE, '--only', 'jale_api'], '--only needs --prepare-logins'],
      [['--report', REPORT_FILE, '--since', '2026-10-01T00:00:00Z'], '--since needs --audit-status'],
      [['--report', REPORT_FILE, '--confirm-cutover-verified'], '--confirm-cutover-verified needs --enable-pgaudit'],
      [['--report', REPORT_FILE, '--dry-run'], '--dry-run does not apply to --audit-status, --list-holds, --report,'],
      [['--report'], '--report needs a SQL file'],
    ])('%j is refused before any AWS call', (args, why) => {
      const r = runScript(h, args);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(why);
      expect(awsCalls(h)).toEqual([]);
    });
  });
});

// A tree can carry this file without the real access manifest. Where the
// manifest is present, --prepare-logins must select from it exactly the
// least-privilege logins, with their limits.
if (!fs.existsSync(REAL_MANIFEST)) {
  test('CONCERN: the access manifest is absent from this tree; the real-manifest selection check is skipped', () => {
    console.warn('[run-migrations-sh] infra/db/access/manifest.json absent; real-manifest selection check skipped');
    expect(fs.existsSync(REAL_MANIFEST)).toBe(false);
  });
}
(fs.existsSync(REAL_MANIFEST) ? describe : describe.skip)('run-migrations.sh --prepare-logins with the real access manifest', () => {
  jest.setTimeout(240_000);

  it('selects exactly the marked logins of the manifest and its fragments, with their connection limits, in a dry run', () => {
    const h = makeHarness();
    try {
      fs.copyFileSync(REAL_MANIFEST, path.join(h.repo, 'infra', 'db', 'access', 'manifest.json'));
      const fragments = fs.existsSync(REAL_FRAGMENT_DIR) ? fs.readdirSync(REAL_FRAGMENT_DIR).filter((n) => n.endsWith('.json')) : [];
      for (const name of fragments) writeFragment(h, name, fs.readFileSync(path.join(REAL_FRAGMENT_DIR, name), 'utf8'));

      // The expectation, read from the same files independently of the script.
      const marked: Array<[string, number]> = [];
      for (const file of [REAL_MANIFEST, ...fragments.map((n) => path.join(REAL_FRAGMENT_DIR, n))]) {
        const logins = (JSON.parse(fs.readFileSync(file, 'utf8')).logins ?? {}) as Record<string, { prepare_secret?: boolean; connection_limit: number }>;
        for (const [login, entry] of Object.entries(logins)) {
          if (entry.prepare_secret === true) marked.push([login, entry.connection_limit]);
        }
      }
      // The least-privilege logins are always among them, with their limits.
      for (const [login, limit] of LEAST_PRIVILEGE_LOGINS) expect(marked).toContainEqual([login, limit]);
      for (const [login, limit] of marked) setRoleAttrs(h, login, `t|f|f|f|f|f|f|${limit}|0`);

      const r = runScript(h, ['--prepare-logins', '--dry-run']);
      expect(r.status).toBe(0);
      const statuses = statusLines(r).map((l) => l.split(':')[0]);
      expect(statuses.slice(0, -1).sort()).toEqual(marked.map(([login]) => login).sort());
      expect(statuses[statuses.length - 1]).toBe(SYNC_LOGIN);
      const payload = fs.readFileSync(path.join(h.state, 'ssm', '3.sh'), 'utf8');
      const calls = [...payload.matchAll(/^run_login '([a-z0-9_]+)' new '(-?\d+)'/gm)].map((m): [string, number] => [m[1], Number(m[2])]);
      const byName = (a: [string, number], b: [string, number]) => a[0].localeCompare(b[0]);
      expect([...calls].sort(byName)).toEqual([...marked].sort(byName));
    } finally {
      fs.rmSync(h.dir, { recursive: true, force: true });
    }
  });
});

// A tree can carry this file without the CDK secret-name helper. Where the
// helper is present, its login-name rule must accept exactly the names
// --prepare-logins accepts.
if (!fs.existsSync(CDK_NAME_HELPER)) {
  test('CONCERN: the CDK secret-name helper is absent from this tree; the shared login-name rule check is skipped', () => {
    console.warn('[run-migrations-sh] infra/lib/constructs/db-login-secrets.ts absent; shared login-name rule check skipped');
    expect(fs.existsSync(CDK_NAME_HELPER)).toBe(false);
  });
} else {
  test('the CDK secret-name helper accepts exactly the login names --prepare-logins accepts', () => {
    const m = fs.readFileSync(CDK_NAME_HELPER, 'utf8').match(/^const LOGIN_NAME = \/(.+)\/;$/m);
    expect(m).not.toBeNull();
    const cdkRule = new RegExp(m![1]);
    for (const sample of LOGIN_NAME_SAMPLES) {
      expect({ sample, accepted: cdkRule.test(sample) }).toEqual({ sample, accepted: SHARED_LOGIN_NAME.test(sample) });
    }
  });
}

// ---------------------------------------------------------------------------
// Legacy PowerShell runners: refused outright.
// ---------------------------------------------------------------------------

const LEGACY_RUNNERS = [
  'run-migrations.ps1',
  'run-migration-022.ps1',
  'run-migration-034.ps1',
  'run-migration-055.ps1',
  'run-admin-migration.ps1',
];

/** The text after the script's param(...) block, which PowerShell requires first. */
function afterParamBlock(text: string): { before: string; params: string; rest: string } {
  const start = text.indexOf('[CmdletBinding()]');
  if (start < 0) throw new Error('no [CmdletBinding()] header');
  const open = text.indexOf('param(', start);
  let depth = 0;
  let i = open + 'param'.length;
  for (; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return { before: text.slice(0, start), params: text.slice(open, i + 1), rest: text.slice(i + 1) };
}

describe('legacy PowerShell migration runners', () => {
  it.each(LEGACY_RUNNERS)('%s refuses before doing any work, and points to run-migrations.sh', (name) => {
    const text = fs.readFileSync(path.join(repoRoot, 'scripts', name), 'utf8');
    const { before, params, rest } = afterParamBlock(text);

    // Nothing runs ahead of the param block: comments only.
    for (const line of before.split('\n')) {
      expect(line.trim() === '' || line.trim().startsWith('#')).toBe(true);
    }
    // Binding the parameters does no work either: defaults read the
    // environment, nothing is invoked.
    expect(params).not.toMatch(/\baws\b|Invoke-|Get-Content|Resolve-Path|Start-Process|&\s*\S/);

    // The first statement after the parameters is the refusal, and it exits.
    const statements = rest.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
    expect(statements[0]).toMatch(/^\[Console\]::Error\.WriteLine\(/);
    expect(statements[0]).toContain('run-migrations.sh');
    expect(statements[1]).toBe('exit 1');
    // No override: exactly one statement, the message, comes before the exit,
    // so no condition, switch or environment variable can skip it.
    expect(statements.indexOf('exit 1')).toBe(1);
    expect(statements[0]).not.toMatch(/\$env:|\$\w+/);
  });

  it.each([
    ['run-migrations.ps1', /no migration ledger/],
    ['run-migration-022.ps1', /no migration ledger/],
    ['run-migration-034.ps1', /no migration ledger/],
    ['run-migration-055.ps1', /no migration ledger/],
    ['run-admin-migration.ps1', /no migration ledger/],
  ])('%s says why it is refused', (name, why) => {
    const { rest } = afterParamBlock(fs.readFileSync(path.join(repoRoot, 'scripts', name), 'utf8'));
    const refusal = rest.split('\n').find((l) => l.includes('[Console]::Error.WriteLine('))!;
    expect(refusal).toMatch(why);
  });
});

// ---------------------------------------------------------------------------
// scripts/deploy-bastion.sh: the bastion session starts here, so its output
// must not carry resource identifiers either (the alarm topic's ARN, CDK's
// stack outputs, the stack ARN). A fake npx plays CDK, with identifiers made
// up at run time so none is ever written into the repo. It records the
// arguments it was given, so no CDK or AWS command ever runs.
//
// The CDK app needs the engine's default preload list to synthesize
// production, and `cdk destroy` synthesizes the app as well, so both
// directions pass AUDIT_DB_SHARED_PRELOAD_LIBRARIES_DEFAULT as context and
// neither runs CDK without it. The value is a library list, not a secret, but
// the script still never prints it.
// ---------------------------------------------------------------------------

const PRELOAD_VARIABLE = 'AUDIT_DB_SHARED_PRELOAD_LIBRARIES_DEFAULT';

describe('deploy-bastion.sh', () => {
  const deployScript = path.join(repoRoot, 'scripts', 'deploy-bastion.sh');
  const hex = (n: number) => crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
  const digits = (n: number) => Array.from(crypto.randomBytes(n), (b) => String(b % 10)).join('');
  /** A valid library list unique to this run, so a printed value cannot go unnoticed. */
  const preloadList = () => `pg_stat_statements,lib_${hex(12)}`;

  /**
   * Runs the script against the fake npx. `preload` is the variable's value,
   * or null to leave it unset; it is never inherited from this process.
   * `argv` is what npx was given, or null when npx never ran.
   */
  function runDeploy(args: string[], options: { exitCode?: number; preload?: string | null } = {}) {
    const exitCode = options.exitCode ?? 0;
    const preload = options.preload === undefined ? preloadList() : options.preload;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jale-deploy-bastion-'));
    const ids = {
      instance: `i-${hex(17)}`,
      account: digits(12),
      securityGroup: `sg-${hex(17)}`,
      ip: `10.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}`,
    };
    const topicArn = `arn:aws:sns:us-east-2:${ids.account}:test-alarm-topic`;
    const stackArn = `arn:aws:cloudformation:us-east-2:${ids.account}:stack/JaleBastionStack/${crypto.randomUUID()}`;
    const argvFile = path.join(dir, 'npx-argv');
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'bin', 'npx'), [
      '#!/bin/bash',
      `printf '%s\\n' "$@" > '${argvFile}'`,
      'echo "JaleBastionStack: deploying... [1/1]"',
      `echo "JaleBastionStack | CREATE_COMPLETE | AWS::EC2::SecurityGroup | Bastion/Resource (${ids.securityGroup})" >&2`,
      'echo " ✅  JaleBastionStack"',
      'echo "Outputs:"',
      `echo "JaleBastionStack.BastionInstanceId = ${ids.instance}"`,
      `echo "JaleBastionStack.PrivateIp = ${ids.ip}"`,
      'echo "Stack ARN:"',
      `echo "${stackArn}"`,
      `exit ${exitCode}`,
    ].join('\n') + '\n', { mode: 0o755 });

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith('AWS_') && k !== PRELOAD_VARIABLE) env[k] = v;
    }
    if (preload !== null) env[PRELOAD_VARIABLE] = preload;
    const r = spawnSync('bash', [deployScript, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...env,
        HOME: dir,
        PATH: `${path.join(dir, 'bin')}:${process.env.PATH ?? ''}`,
        AWS_CONFIG_FILE: path.join(dir, 'none'),
        AWS_SHARED_CREDENTIALS_FILE: path.join(dir, 'none'),
        WHATSAPP_ALARM_TOPIC_ARN: topicArn,
      },
    });
    const argv = fs.existsSync(argvFile) ? fs.readFileSync(argvFile, 'utf8').split('\n').slice(0, -1) : null;
    fs.rmSync(dir, { recursive: true, force: true });
    return { r, ids, topicArn, stackArn, argv, preload, printed: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  }

  /** Every value given to a `-c` flag (each flag and its value are two arguments). */
  const contextValues = (argv: string[]) => argv.flatMap((arg, i) => (arg === '-c' ? [argv[i + 1]] : []));

  it.each([[[] as string[]], [['--destroy']]])('masks every resource identifier CDK prints (args: %j)', (args) => {
    const { r, ids, topicArn, stackArn, printed } = runDeploy(args);
    expect(r.status).toBe(0);
    for (const id of [ids.instance, ids.account, ids.securityGroup, ids.ip, topicArn, stackArn]) {
      expect(printed).not.toContain(id);
    }
    // The run is still readable: the lines are there, only the ids are masked.
    expect(printed).toContain('JaleBastionStack.BastionInstanceId = <instance-id>');
    expect(printed).toContain('<arn>');
  });

  it('still fails when CDK fails', () => {
    const { r, argv } = runDeploy([], { exitCode: 1 });
    // CDK ran, so the failure is CDK's own and not the preload refusal.
    expect(argv).not.toBeNull();
    expect(r.status).not.toBe(0);
  });

  it.each([
    ['deploy', [] as string[]],
    ['destroy', ['--destroy']],
  ])('passes the engine preload default to the %s as CDK context, exclusively for the bastion', (verb, args) => {
    const { r, argv, preload } = runDeploy(args);
    expect(r.status).toBe(0);
    expect(argv).not.toBeNull();
    const given = argv ?? [];
    expect(given[0]).toBe('cdk');
    expect(given[given.indexOf(verb) + 1]).toBe('JaleBastionStack');
    expect(given).toContain('--exclusively');
    expect(contextValues(given)).toEqual(expect.arrayContaining([
      'bastionOnly=true',
      `dbSharedPreloadLibrariesDefault=${preload}`,
    ]));
  });

  it.each([
    ['unset', [] as string[], null],
    ['unset', ['--destroy'], null],
    ['empty', [] as string[], ''],
    ['empty', ['--destroy'], ''],
    ['blank', [] as string[], '  '],
  ])('refuses before any CDK call when the preload default is %s (args: %j), naming the variable', (_state, args, preload) => {
    const { r, argv, printed } = runDeploy(args, { preload });
    expect(r.status).not.toBe(0);
    expect(argv).toBeNull();
    expect(printed).toContain(PRELOAD_VARIABLE);
  });

  it.each([[[] as string[]], [['--destroy']]])('never prints the preload value (args: %j)', (args) => {
    const { r, printed, preload } = runDeploy(args);
    expect(r.status).toBe(0);
    const value = preload ?? '';
    expect(value).not.toBe('');
    expect(printed).not.toContain(value);
    expect(printed).not.toContain(value.split(',')[1]);
  });
});

// scripts/deploy-bastion.ps1 is the Windows twin of deploy-bastion.sh, and the
// PowerShell migration runners point Windows operators at it. No PowerShell
// runs here, and CI only parses .ps1 files, so its preload guard, its alarm
// topic and its output masking are checked on the script's text: comment
// lines are ignored.
describe('deploy-bastion.ps1 (static)', () => {
  const codeLines = () => fs.readFileSync(path.join(repoRoot, 'scripts', 'deploy-bastion.ps1'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  const PRELOAD_ENV = /\$env:AUDIT_DB_SHARED_PRELOAD_LIBRARIES_DEFAULT\b/;

  it('refuses before any CDK call when the preload default is missing, naming the variable', () => {
    const code = codeLines();
    const check = code.findIndex((line) => /^if\s*\(/.test(line) && PRELOAD_ENV.test(line));
    const firstNpx = code.findIndex((line) => /\bnpx\b/.test(line));
    expect(check).toBeGreaterThan(-1);
    expect(firstNpx).toBeGreaterThan(check);
    const refusal = code.slice(check, firstNpx);
    const message = refusal.find((line) => line.startsWith('Write-Error'));
    expect(message).toBeDefined();
    expect(message).toContain(PRELOAD_VARIABLE);
    // Named, never interpolated: no variable reference inside the message.
    expect(message).not.toMatch(/\$/);
    expect(refusal).toContain('exit 1');
  });

  it.each(['deploy', 'destroy'])('passes the preload default to the %s, exclusively for the bastion', (verb) => {
    const calls = codeLines().filter((line) => new RegExp(`^npx cdk .*\\b${verb} JaleBastionStack\\b`).test(line));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('--exclusively');
    expect(calls[0]).toContain('-c "dbSharedPreloadLibrariesDefault=$env:AUDIT_DB_SHARED_PRELOAD_LIBRARIES_DEFAULT"');
  });

  it('never prints the preload value', () => {
    const printing = codeLines().filter((line) => /^(Write-Host|Write-Output|Write-Error|Write-Warning|Write-Verbose|Write-Information|echo)\b/i.test(line));
    expect(printing.length).toBeGreaterThan(0);
    for (const line of printing) expect(line).not.toMatch(PRELOAD_ENV);
  });

  // The alarm topic, as deploy-bastion.sh passes it: optional, on the deploy
  // only, and only when set, because an empty `-c whatsappAlarmTopicArn=`
  // would read as a supplied topic and fail at synth.
  const ALARM_ENV = /\$env:WHATSAPP_ALARM_TOPIC_ARN\b/;

  it('passes the alarm topic to the deploy only, through a context built only when the variable is set', () => {
    const code = codeLines();
    const deploy = code.filter((line) => /^npx cdk .*\bdeploy JaleBastionStack\b/.test(line));
    const destroy = code.filter((line) => /^npx cdk .*\bdestroy JaleBastionStack\b/.test(line));
    expect(deploy).toHaveLength(1);
    expect(destroy).toHaveLength(1);
    // Splatted ahead of the verb, with the other context flags.
    expect(deploy[0]).toMatch(/ @alarmContext deploy JaleBastionStack\b/);
    expect(destroy[0]).not.toMatch(/alarmContext|whatsappAlarmTopicArn|WHATSAPP_ALARM_TOPIC_ARN/);
    // Empty by default; the flag and its value only under the check.
    const assignments = code.flatMap((line, i) => (/^\$alarmContext\s*=/.test(line) ? [i] : []));
    expect(assignments.map((i) => code[i])).toEqual([
      '$alarmContext = @()',
      `$alarmContext = @('-c', "whatsappAlarmTopicArn=$env:WHATSAPP_ALARM_TOPIC_ARN")`,
    ]);
    expect(code[assignments[1] - 1]).toMatch(/^if\s*\(\s*-not\s+\[string\]::IsNullOrEmpty\(\$env:WHATSAPP_ALARM_TOPIC_ARN\)\s*\)\s*\{$/);
    expect(code[assignments[0] + 1]).toBe(code[assignments[1] - 1]);
    expect(Math.max(...assignments)).toBeLessThan(code.indexOf(deploy[0]));
    expect(code.filter((line) => ALARM_ENV.test(line))).toHaveLength(2);
  });

  it('says whether the alarm topic is set, naming the variable, and never prints its value', () => {
    const printing = codeLines().filter((line) => /^(Write-Host|Write-Output|Write-Error|Write-Warning|Write-Verbose|Write-Information|echo)\b/i.test(line));
    for (const line of printing) {
      expect(line).not.toMatch(ALARM_ENV);
      expect(line).not.toMatch(/\$alarmContext\b/);
    }
    const naming = printing.filter((line) => line.includes('WHATSAPP_ALARM_TOPIC_ARN'));
    expect(naming).toHaveLength(2);
    expect(naming.filter((line) => /\bwill notify\b/.test(line))).toHaveLength(1);
    expect(naming.filter((line) => /\bis not set\b/.test(line))).toHaveLength(1);
  });

  // CDK's output, masked as deploy-bastion.sh masks it with redact_ids: the
  // stack ARN in the outputs carries the account, and the bastion session's
  // terminal shows no resource identifier. Both CDK calls merge stderr into
  // stdout and print every line through Hide-ResourceId, whose rules are the
  // .sh's, in its order, case-sensitive as sed is.
  const PRINTING = /^(Write-Host|Write-Output|Write-Error|Write-Warning|Write-Verbose|Write-Information|echo)\b/i;

  /** One top-level function of the script: its code lines, from its declaration to its closing brace. */
  function ps1Function(name: string): string[] {
    const raw = fs.readFileSync(path.join(repoRoot, 'scripts', 'deploy-bastion.ps1'), 'utf8').split('\n');
    const start = raw.indexOf(`function ${name} {`);
    const end = raw.findIndex((line, i) => i > start && line === '}');
    if (start === -1 || end === -1) return [];
    return raw.slice(start, end + 1).map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
  }

  /** The mask's rules: each `-creplace` line as [pattern, replacement], with PowerShell's '' read as '. */
  function ps1MaskRules(): Array<[string, string]> {
    const quoted = "'((?:[^']|'')*)'";
    const rule = new RegExp(`^\\$text = \\$text -creplace ${quoted}, ${quoted}$`);
    return ps1Function('Hide-ResourceId').flatMap((line) => {
      const match = rule.exec(line);
      return match ? [[match[1].replace(/''/g, "'"), match[2].replace(/''/g, "'")] as [string, string]] : [];
    });
  }

  /** deploy-bastion.sh's redact_ids rules: each `-e` expression as [pattern, replacement], in order. */
  function shMaskRules(): Array<[string, string]> {
    const text = fs.readFileSync(path.join(repoRoot, 'scripts', 'deploy-bastion.sh'), 'utf8');
    const start = text.indexOf('redact_ids() {');
    const body = text.slice(start, text.indexOf('\n}\n', start));
    return [...body.matchAll(/-e (?:"((?:[^"\\]|\\.)*)"|'([^']*)')/g)].map((match) => {
      // Inside double quotes, bash drops the backslash before " \ $ and `.
      const expression = match[1] !== undefined ? match[1].replace(/\\(["\\$`])/g, '$1') : match[2];
      const parts = /^s#(.*)#(.*)#g$/.exec(expression);
      if (!parts) throw new Error(`not an s#…#…#g expression: ${expression}`);
      return [parts[1], parts[2]] as [string, string];
    });
  }

  it('prints everything both CDK calls write, stdout and stderr, through the mask, and fails when CDK fails', () => {
    const code = codeLines();
    const calls = code.filter((line) => /\bnpx\b/.test(line));
    expect(calls.map((line) => / (deploy|destroy) JaleBastionStack /.exec(line)?.[1]).sort()).toEqual(['deploy', 'destroy']);
    for (const call of calls) {
      expect(call).toMatch(/^npx cdk .* 2>&1 \| Hide-ResourceId$/);
      const at = code.indexOf(call);
      expect(code.slice(at - 1, at + 3)).toEqual([
        '$cdkExitCode = Invoke-MaskedCdk {',
        call,
        '}',
        'if ($cdkExitCode -ne 0) {',
      ]);
      expect(code[at + 3]).toMatch(/^throw "CDK bastion (deployment|destroy) failed with exit code \$cdkExitCode\."$/);
    }
  });

  it('runs each CDK call with the error preference at Continue, returns its exit code and restores the preference', () => {
    // Under 'Stop', Windows PowerShell 5.1 ends the script at the first line
    // a native command writes to a redirected stderr; the repo's other
    // scripts relax the preference around such calls the same way.
    expect(ps1Function('Invoke-MaskedCdk')).toEqual([
      'function Invoke-MaskedCdk {',
      'param([Parameter(Mandatory = $true)][scriptblock]$Command)',
      '$previousErrorActionPreference = $ErrorActionPreference',
      "$ErrorActionPreference = 'Continue'",
      'try {',
      '& $Command',
      '$LASTEXITCODE',
      '}',
      'finally {',
      '$ErrorActionPreference = $previousErrorActionPreference',
      '}',
      '}',
    ]);
  });

  it("applies deploy-bastion.sh's masking rules, in its order, case-sensitive as sed is", () => {
    const sh = shMaskRules();
    expect(sh).toHaveLength(7);
    // sed's [:space:] class is .NET's \s, and sed's \1 is .NET's ${1}.
    const expected = sh.map(([pattern, replacement]) => [
      pattern.replace(/\[:space:\]/g, '\\s'),
      replacement.replace(/\\(\d)/g, (_match, group: string) => `\${${group}}`),
    ]);
    expect(ps1MaskRules()).toEqual(expected);
    const replacing = ps1Function('Hide-ResourceId').filter((line) => /-[a-z]*replace\b/i.test(line));
    expect(replacing).toHaveLength(expected.length);
    for (const line of replacing) expect(line).toMatch(/ -creplace /);
  });

  it('prints only the masked line, once every rule has run', () => {
    const body = ps1Function('Hide-ResourceId');
    expect(body.filter((line) => /\$Line\b/.test(line))).toEqual([
      'param([Parameter(ValueFromPipeline = $true)] $Line)',
      '$text = "$Line"',
    ]);
    expect(body.filter((line) => PRINTING.test(line))).toEqual(['Write-Host $text']);
    expect(body).not.toContain('$text');
    const lastRule = Math.max(...body.flatMap((line, i) => (/ -creplace /.test(line) ? [i] : [])));
    expect(body.indexOf('Write-Host $text')).toBeGreaterThan(lastRule);
  });

  it('masks every identifier shape CDK prints, with its rules as written', () => {
    const hex = (n: number) => crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
    const digits = (n: number) => Array.from(crypto.randomBytes(n), (b) => String(b % 10)).join('');
    const address = () => `10.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}`;
    const ids = {
      instance: `i-${hex(17)}`,
      securityGroup: `sg-${hex(17)}`,
      subnet: `subnet-${hex(8)}`,
      account: digits(12),
      otherAccount: digits(12),
      ip: address(),
      otherIp: address(),
    };
    const topicArn = `arn:aws:sns:us-east-2:${ids.account}:test-alarm-topic`;
    const stackArn = `arn:aws:cloudformation:us-east-2:${ids.account}:stack/JaleBastionStack/${crypto.randomUUID()}`;
    // .NET's ${1} is JavaScript's $1; the patterns read the same in both.
    const rules = ps1MaskRules().map(([pattern, replacement]) =>
      [new RegExp(pattern, 'g'), replacement.replace(/\$\{(\d)\}/g, '$$$1')] as const);
    const mask = (line: string) => rules.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), line);
    const printed = [
      `JaleBastionStack | CREATE_COMPLETE | AWS::EC2::SecurityGroup | Bastion/Resource (${ids.securityGroup})`,
      `JaleBastionStack.BastionInstanceId = ${ids.instance}`,
      `JaleBastionStack.PrivateIp = ${ids.ip}`,
      'Stack ARN:',
      stackArn,
      `Context: whatsappAlarmTopicArn="${topicArn}", subnet ${ids.subnet}`,
      `accounts ${ids.account} ${ids.otherAccount}; hosts ${ids.ip},${ids.otherIp}`,
    ].map(mask).join('\n');
    for (const id of [...Object.values(ids), topicArn, stackArn]) expect(printed).not.toContain(id);
    expect(printed).toContain('JaleBastionStack.BastionInstanceId = <instance-id>');
    expect(printed).toContain('JaleBastionStack.PrivateIp = <ip>');
    expect(printed).toContain('Bastion/Resource (<resource-id>)');
    expect(printed).toContain('Context: whatsappAlarmTopicArn="<arn>", subnet <resource-id>');
    // Adjacent values: each numeric rule runs twice.
    expect(printed).toContain('accounts <account-id> <account-id>; hosts <ip>,<ip>');
  });
});
