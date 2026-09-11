import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * SDK bundling policy (sprint 25, Lane C).
 *
 * The old policy externalized every `@aws-sdk/*` import from the esbuild
 * bundle and bet that the managed Lambda runtime shipped a matching client.
 * nodejs20.x did not ship several of them (s3-request-presigner,
 * client-bedrock-runtime, client-sesv2, client-sqs, client-rekognition,
 * client-lambda), so 21 stack call sites had to re-add the package through
 * `nodeModules`, which makes CDK shell out to `npm install` inside each
 * bundle directory. Every omission was a production outage in waiting: a bare
 * `require('@aws-sdk/...')` that throws "Cannot find module" at cold start,
 * killing EVERY invocation of that Lambda (the 2026-09-01 adversarial review
 * found two such lanes — the employer digest producer and the billing
 * processor — both queueing mail through `lib/email-outbox.ts`, whose
 * SESv2Client is constructed at MODULE scope).
 *
 * The new policy removes the bet entirely: only 'pg-native' stays external,
 * so esbuild inlines the SDK into each artifact and the runtime's built-in
 * SDK version stops mattering. That makes this a three-part invariant, and
 * all three parts have to hold together or the class of bug comes back:
 *
 *   (i)   no stack re-introduces an `@aws-sdk/*` `nodeModules` override;
 *   (ii)  `JaleLambdaFunction` never externalizes `@aws-sdk/*` again;
 *   (iii) every `@aws-sdk/*` package the Lambda sources import is a real
 *         `dependencies` entry of infra/package.json — because esbuild now
 *         has to RESOLVE each one from node_modules at synth time, and a
 *         package that is only a devDependency (or missing) fails the build
 *         on any consumer that installs with --omit=dev.
 *
 * The previous version of this file walked the import graph from each stack's
 * Lambda entries to `lib/email-outbox.ts` and checked that the three
 * consumers it found declared `@aws-sdk/client-sesv2` in `nodeModules`. That
 * walk is deliberately dropped: under the new policy there is no
 * per-call-site declaration left to verify, so it would only pin an
 * unrelated fact ("exactly these three Lambdas import email-outbox") that
 * breaks the moment a fourth Lambda queues mail, while the failure mode it
 * guarded — a module-scope SDK client in a shared lib reaching a Lambda that
 * never declared the package — is structurally gone once (ii) and (iii) hold.
 */
const INFRA_ROOT = path.join(__dirname, '../../..');
const STACKS_DIR = path.join(INFRA_ROOT, 'lib/stacks');
const LAMBDA_DIR = path.join(INFRA_ROOT, 'lambda');
const CONSTRUCT = path.join(INFRA_ROOT, 'lib/constructs/lambda-function.ts');
const PACKAGE_JSON = path.join(INFRA_ROOT, 'package.json');

/** Every `*.ts` under a directory, recursively. */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('SDK bundling policy', () => {
  describe('(i) no stack re-adds an @aws-sdk package through nodeModules', () => {
    // Whole-file scan rather than a `new JaleLambdaFunction(...)` block match:
    // a bug in the block regex could silently make this test vacuous, and no
    // construct in this repo has a legitimate reason to install an SDK client
    // into a bundle directory. Anchored on `nodeModules:` (the property
    // syntax) so prose may still discuss the word.
    const offenders: string[] = [];
    for (const stackFile of fs.readdirSync(STACKS_DIR).filter((f) => f.endsWith('.ts'))) {
      const src = fs.readFileSync(path.join(STACKS_DIR, stackFile), 'utf8');
      for (const m of src.matchAll(/^[^\S\r\n]*nodeModules:\s*(\[[\s\S]*?\])/gm)) {
        if (m[1].includes('@aws-sdk/')) {
          const line = src.slice(0, m.index).split('\n').length;
          offenders.push(`${stackFile}:${line}`);
        }
      }
    }

    test('lib/stacks/*.ts declares no @aws-sdk nodeModules override', () => {
      expect(offenders).toEqual([]);
    });
  });

  describe('(ii) JaleLambdaFunction does not externalize the SDK', () => {
    const src = fs.readFileSync(CONSTRUCT, 'utf8');
    const externals = src.match(/externalModules:\s*\[([\s\S]*?)\]/)?.[1];

    test('the construct still declares externalModules', () => {
      expect(externals).toBeDefined();
    });

    test('externalModules carries no @aws-sdk pattern', () => {
      expect(externals).not.toContain('@aws-sdk');
    });

    test("externalModules still excludes pg-native (pg's optional native binding)", () => {
      expect(externals).toContain('pg-native');
    });
  });

  describe('(iii) every @aws-sdk package the Lambdas import is a runtime dependency', () => {
    // Derived, not hardcoded: adding a new SDK client to any handler must
    // fail this test until package.json catches up.
    const imported = new Set<string>();
    for (const file of tsFiles(LAMBDA_DIR)) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/['"](@aws-sdk\/[a-z0-9][a-z0-9.-]*)['"]/g)) {
        imported.add(m[1]);
      }
    }
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
    const deps: Record<string, string> = pkg.dependencies ?? {};
    const devDeps: Record<string, string> = pkg.devDependencies ?? {};
    const packages = [...imported].sort();

    test('the import scan actually finds SDK usage (guards against a dead regex)', () => {
      expect(packages.length).toBeGreaterThanOrEqual(10);
    });

    test.each(packages)('%s is in dependencies', (name) => {
      expect(Object.keys(deps)).toContain(name);
    });

    test('none of them is left behind in devDependencies', () => {
      expect(packages.filter((name) => name in devDeps)).toEqual([]);
    });

    // One range for the whole SDK. Mixed ranges let npm resolve two copies of
    // the shared @smithy/@aws-sdk core into one bundle, which is how an
    // artifact silently doubles in size and how two clients disagree about
    // credential resolution.
    test('all of them are pinned to the same range', () => {
      const ranges = [...new Set(packages.map((name) => deps[name]))];
      expect(ranges).toHaveLength(1);
    });
  });
});
