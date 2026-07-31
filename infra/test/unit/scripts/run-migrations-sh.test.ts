import * as fs from 'node:fs';
import * as path from 'node:path';

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

  it('bounds --baseline-through so it can never skip un-applied work', () => {
    const script = readScript();

    expect(script).toContain('--baseline-through');
    // It must name a real manifest entry.
    expect(script).toMatch(/is not in the manifest/);
    // The loop stops at the named file, so migrations after it are still
    // executed rather than recorded. That boundary is the whole safety
    // property: a too-generous baseline can be wrong about history, never
    // about work still to do.
    expect(script).toMatch(/if \[\[ "\$f" == "\$BASELINE_THROUGH" \]\]; then found=true; break; fi/);
    // Baseline membership decides per file, not globally.
    expect(script).toMatch(/if \[\[ -n "\$\{BASELINE_ONLY\[\$f\]:-\}" \]\]/);
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

    // Names every role left without a usable password, and the secret that
    // will not exist.
    expect(script).toMatch(/jale_matching, jale_admin_console, jale_billing, jale_whatsapp/);
    expect(script).toContain('$WA_DB_SECRET_NAME does not exist');

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

  it('lists every migration on disk, in sorted order', () => {
    const script = readScript();
    const onDisk = fs.readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort();

    const block = script.match(/^MIGRATIONS=\(([\s\S]*?)^\)/m);
    expect(block).not.toBeNull();

    const listed = block![1].match(/\d{3}b?_[a-zA-Z0-9_]+\.sql/g) ?? [];
    expect(listed).toEqual(onDisk);
  });
});
