import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const patchedVersion = '5.0.8';
const installRoot = resolve('node_modules');
const sourcePath = resolve(installRoot, 'brace-expansion');
const targetPath = resolve(installRoot, 'aws-cdk-lib/node_modules/brace-expansion');
const hiddenLockPath = resolve(installRoot, '.package-lock.json');
const sourceLockKey = 'node_modules/brace-expansion';
const targetLockKey = 'node_modules/aws-cdk-lib/node_modules/brace-expansion';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sourcePackage = readJson(resolve(sourcePath, 'package.json'));

if (sourcePackage.version !== patchedVersion) {
  throw new Error(
    `Expected brace-expansion ${patchedVersion}, found ${sourcePackage.version}`,
  );
}

if (!existsSync(targetPath)) {
  console.log('CDK no longer bundles brace-expansion; no patch needed.');
  process.exit(0);
}

rmSync(targetPath, { recursive: true, force: true });
cpSync(sourcePath, targetPath, { recursive: true });

if (existsSync(hiddenLockPath)) {
  const hiddenLock = readJson(hiddenLockPath);
  const sourceLock = hiddenLock.packages?.[sourceLockKey];

  if (!sourceLock) {
    throw new Error(`Missing ${sourceLockKey} in ${hiddenLockPath}`);
  }

  hiddenLock.packages[targetLockKey] = { ...sourceLock, inBundle: true };
  writeFileSync(hiddenLockPath, `${JSON.stringify(hiddenLock, null, 2)}\n`);
}

console.log(`Patched CDK bundled brace-expansion to ${patchedVersion}.`);
