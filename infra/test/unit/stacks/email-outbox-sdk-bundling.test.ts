import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * `lib/email-outbox.ts` constructs its SESv2Client at MODULE scope, and
 * `JaleLambdaFunction` externalizes every `@aws-sdk/*` import (see
 * lambda-function.ts `externalModules`). So EVERY Lambda whose entry imports
 * email-outbox -- not only the sweeper that actually sends -- must ship the
 * package via `nodeModules`, or its cold start dies with
 * "Cannot find module '@aws-sdk/client-sesv2'". The 2026-09-01 adversarial
 * review found the digest producer and the billing processor missing it: two
 * dead-lettered lanes on the first deploy. This test walks the import graph
 * from each stack's Lambda entries and enforces the declaration.
 */
const STACKS_DIR = path.join(__dirname, '../../../lib/stacks');
const LAMBDA_DIR = path.join(__dirname, '../../../lambda');
const OUTBOX = path.join(LAMBDA_DIR, 'lib/email-outbox.ts');

function importsOutbox(file: string, seen = new Set<string>()): boolean {
  if (seen.has(file) || !fs.existsSync(file)) return false;
  seen.add(file);
  if (path.resolve(file) === path.resolve(OUTBOX)) return true;
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) {
    const base = path.resolve(path.dirname(file), m[1]);
    for (const cand of [base + '.ts', path.join(base, 'index.ts')]) {
      if (importsOutbox(cand, seen)) return true;
    }
  }
  return false;
}

describe('every Lambda that imports lib/email-outbox.ts ships @aws-sdk/client-sesv2', () => {
  const offenders: string[] = [];
  const covered: string[] = [];
  for (const stackFile of fs.readdirSync(STACKS_DIR).filter((f) => f.endsWith('.ts'))) {
    const src = fs.readFileSync(path.join(STACKS_DIR, stackFile), 'utf8');
    // Each `new JaleLambdaFunction(this, 'Id', { ... })` block up to its closing `});`
    for (const m of src.matchAll(/new JaleLambdaFunction\(this, '([^']+)', \{([\s\S]*?)\n\s*\}\);/g)) {
      const [, id, body] = m;
      const entry = body.match(/entry:\s*path\.join\(__dirname,\s*'([^']+)'\)/)?.[1];
      if (!entry) continue;
      const entryFile = path.resolve(STACKS_DIR, entry);
      if (!importsOutbox(entryFile)) continue;
      covered.push(`${stackFile}:${id}`);
      if (!/nodeModules:\s*\[[^\]]*'@aws-sdk\/client-sesv2'/.test(body)) offenders.push(`${stackFile}:${id}`);
    }
  }

  test('the import walk finds the three known email-outbox consumers', () => {
    expect(covered.sort()).toEqual([
      'billing-stack.ts:BillingProcessorLambda',
      'billing-stack.ts:EmailOutboxSweeperLambda',
      'notifications-stack.ts:EmployerDigestProducerLambda',
    ]);
  });

  test('none of them omits the package from nodeModules', () => {
    expect(offenders).toEqual([]);
  });
});
