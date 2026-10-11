import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

// infra/test/unit/scripts -> repository root
const repoRoot = path.join(__dirname, '..', '..', '..', '..');
const workflowPath = path.join(repoRoot, '.github', 'workflows', '_reusable-validate.yml');

const SKIPPED_DIRS = new Set(['node_modules', '.git', 'cdk.out']);

function shellScriptsOnDisk(dir = repoRoot): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) found.push(...shellScriptsOnDisk(full));
    } else if (entry.name.endsWith('.sh')) {
      found.push('./' + path.relative(repoRoot, full).split(path.sep).join('/'));
    }
  }
  return found;
}

/** The file-list line of the "Validate shell scripts" step, as the job runs it. */
function fileListLine(): string {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const step = workflow.split('- name: Validate shell scripts')[1];
  if (!step) throw new Error('the script syntax job has no "Validate shell scripts" step');
  const line = step.split('\n').find((l) => l.trim().startsWith('mapfile -t scripts'));
  if (!line) throw new Error('the Validate shell scripts step builds no file list with mapfile');
  return line.trim();
}

describe('script syntax job coverage', () => {
  it('checks every shell script in the repository, so a new one cannot be left out', () => {
    const run = spawnSync('bash', ['-c', `${fileListLine()}\nprintf '%s\\n' "\${scripts[@]}"`], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    const covered = new Set(run.stdout.split('\n').filter((l) => l !== ''));
    const missing = shellScriptsOnDisk().filter((f) => !covered.has(f));
    expect(missing).toEqual([]);
    // The directories the old scripts/*.sh glob never reached.
    expect(covered.has('./infra/scripts/run-whatsapp-v2-db-tests.sh')).toBe(true);
    expect(covered.has('./infra/db/local/bootstrap-testbed.sh')).toBe(true);
  });

  it('keeps every script at a depth the list covers (nested directories included)', () => {
    const nested = shellScriptsOnDisk().filter((f) => f.split('/').length > 3);
    expect(nested.length).toBeGreaterThan(0);
  });
});
