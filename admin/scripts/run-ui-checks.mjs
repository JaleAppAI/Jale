// Runs every admin UI contract check (`npm run test:ui`): each
// scripts/check-ui-*.mjs, in name order, then check-access-history-view.mjs.
// Each file runs in its own node process, so one failing file never hides the
// others. A new check file joins by matching the check-ui-*.mjs name; nothing
// else lists them.
//
// Exits non-zero when any file fails, or when the pattern matches no file.
import { spawnSync } from 'node:child_process';
import { existsSync, globSync } from 'node:fs';
import { resolve } from 'node:path';

const scriptsDir = import.meta.dirname;
const adminRoot = resolve(scriptsDir, '..');

const contractFiles = globSync('check-ui-*.mjs', { cwd: scriptsDir }).sort();
if (contractFiles.length === 0) {
  console.error('FAIL no scripts/check-ui-*.mjs files found');
  process.exit(1);
}

const files = [...contractFiles, 'check-access-history-view.mjs'];
let failed = 0;
for (const file of files) {
  const path = resolve(scriptsDir, file);
  const label = `scripts/${file}`;
  if (!existsSync(path)) {
    console.error(`FAIL ${label} (missing)`);
    failed += 1;
    continue;
  }
  const result = spawnSync(process.execPath, [path], { cwd: adminRoot, stdio: 'inherit' });
  if (result.status === 0) {
    console.log(`PASS ${label}`);
  } else {
    console.error(`FAIL ${label}`);
    failed += 1;
  }
}

if (failed > 0) {
  console.error(`${failed} of ${files.length} UI check files failed`);
  process.exit(1);
}
console.log(`all ${files.length} UI check files passed`);
