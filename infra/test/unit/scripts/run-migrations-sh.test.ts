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

  it('lists every migration on disk, in sorted order', () => {
    const script = readScript();
    const onDisk = fs.readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort();

    const block = script.match(/^MIGRATIONS=\(([\s\S]*?)^\)/m);
    expect(block).not.toBeNull();

    const listed = block![1].match(/\d{3}b?_[a-zA-Z0-9_]+\.sql/g) ?? [];
    expect(listed).toEqual(onDisk);
  });
});
