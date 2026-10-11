import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The deploy-time database posture gate (scripts/db-posture-gate.mjs).
 *
 * The script is run exactly the way the deploy workflow runs it: a real
 * `node` process, with a fake `aws` CLI first on PATH. The fake answers the
 * three calls the gate makes (the metric history, the stack outputs, the
 * invoke) from a per-test scenario and records every call, so these tests pin
 * the observable contract: the exit status, what lands in the run summary,
 * the order of the calls, and that nothing identifying leaks.
 *
 * Metric history is described in completed UTC days counted back from the
 * end of the window the gate asks for (1 = the most recent completed day), so
 * no test depends on the wall clock.
 */

const SCRIPT = path.join(__dirname, '../../../scripts/db-posture-gate.mjs');

interface Day {
  clean?: number;
  notClean?: number;
  cleanDeploy?: number;
}

interface CliFailure {
  stderr: string;
  exitCode?: number;
}

interface Scenario {
  metrics?: { error?: CliFailure; days?: Record<string, Day>; statusCode?: string };
  describe?: { error?: CliFailure; functionName?: string | null };
  invoke?: { error?: CliFailure; payload?: unknown; functionError?: string };
}

interface CallRecord {
  service: string;
  operation: string;
  args: string[];
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  summary: string;
  calls: CallRecord[];
}

// What the fake stack output holds. It must never be echoed anywhere.
const FUNCTION_NAME = 'FakeDatabaseStack-PostureFn-QX7Y2Z';

// Violations as the posture check reports them: object names, never data.
// Neither the object names nor the details may reach the run summary or the
// log of a public repository.
const TWO_VIOLATIONS = {
  complete: true,
  violations: [
    { check: 'login_attributes', object: 'jale_example_login', detail: 'carries a forbidden attribute' },
    { check: 'table_rls', object: 'public.example_table', detail: 'FORCE ROW LEVEL SECURITY differs from the manifest' },
  ],
  serverVersion: '16.99',
};
const CLEAN_REPORT = { complete: true, violations: [], serverVersion: '16.99' };
const INCOMPLETE_REPORT = { complete: false, violations: [], serverVersion: null };

// An AccessDenied message the way AWS writes one: full of identifiers.
const ACCESS_DENIED: CliFailure = {
  stderr:
    'An error occurred (AccessDeniedException) when calling the Invoke operation: User: '
    + 'arn:aws:sts::111122223333:assumed-role/ExampleDeployRole/session is not authorized to perform: '
    + 'lambda:InvokeFunction on resource: arn:aws:lambda:us-east-2:111122223333:function:'
    + `${FUNCTION_NAME} because no identity-based policy allows the lambda:InvokeFunction action`,
  exitCode: 254,
};
const FUNCTION_NOT_FOUND: CliFailure = {
  stderr:
    'An error occurred (ResourceNotFoundException) when calling the Invoke operation: Function not found: '
    + `arn:aws:lambda:us-east-2:111122223333:function:${FUNCTION_NAME}`,
  exitCode: 254,
};
const METRICS_DENIED: CliFailure = {
  stderr:
    'An error occurred (AccessDenied) when calling the GetMetricData operation: User: '
    + 'arn:aws:sts::111122223333:assumed-role/ExampleDeployRole/session is not authorized to perform: '
    + 'cloudwatch:GetMetricData',
  exitCode: 254,
};
// The stack read refused the same way: the policy that grants the history
// read and the invoke grants this read too.
const DESCRIBE_DENIED: CliFailure = {
  stderr: METRICS_DENIED.stderr
    .replace('GetMetricData operation', 'DescribeStacks operation')
    .replace('cloudwatch:GetMetricData', 'cloudformation:DescribeStacks'),
  exitCode: 254,
};

const CLEAN: Day = { clean: 1 };
const CLEAN_WITH_DEPLOY: Day = { clean: 2, cleanDeploy: 1 };
const NOT_CLEAN: Day = { clean: 1, notClean: 1 };

/** The same day for every completed day from `fromAgo` back to `toAgo`, inclusive. */
function span(fromAgo: number, toAgo: number, day: Day): Record<string, Day> {
  const out: Record<string, Day> = {};
  for (let ago = fromAgo; ago >= toAgo; ago -= 1) out[String(ago)] = day;
  return out;
}

/** Later arguments win, so a single day can be overlaid on a span. */
function history(...parts: Array<Record<string, Day>>): Record<string, Day> {
  return Object.assign({}, ...parts);
}

/** Exactly fourteen clean completed days, one with a clean deploy-triggered run. */
const QUALIFIED = history(span(14, 1, CLEAN), { 7: CLEAN_WITH_DEPLOY });

const FAKE_AWS = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_AWS_SCENARIO, 'utf8'));
const args = process.argv.slice(2);
const [service, operation] = args;
fs.appendFileSync(process.env.FAKE_AWS_LOG, JSON.stringify({ service, operation, args }) + '\\n');
const opt = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const fail = (failure) => { process.stderr.write(failure.stderr + '\\n'); process.exit(failure.exitCode ?? 254); };

if (service === 'cloudwatch' && operation === 'get-metric-data') {
  const metrics = scenario.metrics ?? {};
  if (metrics.error) fail(metrics.error);
  const end = Date.parse(opt('--end-time'));
  const raw = opt('--metric-data-queries');
  const queries = JSON.parse(raw.startsWith('file://') ? fs.readFileSync(raw.slice('file://'.length), 'utf8') : raw);
  const results = queries.map((query) => {
    const stat = query.MetricStat ?? {};
    const metric = stat.Metric ?? {};
    const dims = metric.Dimensions ?? [];
    let key = null;
    if (metric.Namespace === 'Jale/Database' && stat.Period === 86400 && stat.Stat === 'Sum') {
      if (metric.MetricName === 'DbPostureRunClean' && dims.length === 0) key = 'clean';
      if (metric.MetricName === 'DbPostureRunNotClean' && dims.length === 0) key = 'notClean';
      if (metric.MetricName === 'DbPostureRunClean' && dims.length === 1
        && dims[0].Name === 'Trigger' && dims[0].Value === 'deploy') key = 'cleanDeploy';
    }
    if (key === null) {
      process.stderr.write('fake aws: unexpected metric query ' + JSON.stringify(query) + '\\n');
      process.exit(99);
    }
    const timestamps = [];
    const values = [];
    const days = Object.entries(metrics.days ?? {}).sort((a, b) => Number(b[0]) - Number(a[0]));
    for (const [ago, day] of days) {
      const value = day[key] ?? 0;
      if (value > 0) {
        timestamps.push(new Date(end - Number(ago) * 86400000).toISOString().replace('.000Z', '+00:00'));
        values.push(value);
      }
    }
    return { Id: query.Id, Label: metric.MetricName, Timestamps: timestamps, Values: values,
      StatusCode: metrics.statusCode ?? 'Complete' };
  });
  process.stdout.write(JSON.stringify({ MetricDataResults: results, Messages: [] }));
  process.exit(0);
}

if (service === 'cloudformation' && operation === 'describe-stacks') {
  const describe = scenario.describe ?? {};
  if (describe.error) fail(describe.error);
  const outputs = [
    { OutputKey: 'SomeOtherOutput', OutputValue: 'arn:aws:example:us-east-2:111122223333:thing/other' },
  ];
  if (describe.functionName) outputs.push({ OutputKey: 'DbPostureFunctionName', OutputValue: describe.functionName });
  process.stdout.write(JSON.stringify({ Stacks: [{ StackName: opt('--stack-name'), Outputs: outputs }] }));
  process.exit(0);
}

if (service === 'lambda' && operation === 'invoke') {
  const invoke = scenario.invoke ?? {};
  if (invoke.error) fail(invoke.error);
  fs.writeFileSync(args[args.length - 1], JSON.stringify(invoke.payload));
  const response = { StatusCode: 200, ExecutedVersion: '$LATEST' };
  if (invoke.functionError) response.FunctionError = invoke.functionError;
  process.stdout.write(JSON.stringify(response));
  process.exit(0);
}

process.stderr.write('fake aws: unexpected call ' + JSON.stringify(args) + '\\n');
process.exit(98);
`;

let workDir: string;
let fakeBin: string;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-posture-gate-'));
  fakeBin = path.join(workDir, 'bin');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, 'aws'), FAKE_AWS, { mode: 0o755 });
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

let runCount = 0;

function runGate(
  scenario: Scenario,
  options: { phase?: string | null; override?: string; reason?: string; summarySeed?: string } = {},
): RunResult {
  runCount += 1;
  const dir = path.join(workDir, `run-${runCount}`);
  fs.mkdirSync(dir);
  const scenarioFile = path.join(dir, 'scenario.json');
  const logFile = path.join(dir, 'calls.log');
  const summaryFile = path.join(dir, 'summary.md');
  fs.writeFileSync(scenarioFile, JSON.stringify(scenario));
  fs.writeFileSync(logFile, '');
  fs.writeFileSync(summaryFile, options.summarySeed ?? '');

  const phase = options.phase === undefined ? 'pre' : options.phase;
  const args = [SCRIPT, ...(phase === null ? [] : ['--phase', phase])];
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: {
      // The fake CLI first; only the system directories after it. No AWS
      // configuration or credentials of any kind reach the child.
      PATH: [fakeBin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
      HOME: dir,
      AWS_CONFIG_FILE: path.join(dir, 'no-aws-config'),
      AWS_SHARED_CREDENTIALS_FILE: path.join(dir, 'no-aws-credentials'),
      AWS_EC2_METADATA_DISABLED: 'true',
      AWS_REGION: 'us-east-2',
      FAKE_AWS_SCENARIO: scenarioFile,
      FAKE_AWS_LOG: logFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      ...(options.override === undefined ? {} : { POSTURE_OVERRIDE: options.override }),
      ...(options.reason === undefined ? {} : { POSTURE_OVERRIDE_REASON: options.reason }),
    },
  });

  const calls = fs
    .readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CallRecord);
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    summary: fs.readFileSync(summaryFile, 'utf8'),
    calls,
  };
}

function scenario(days: Record<string, Day>, payload: unknown = CLEAN_REPORT): Scenario {
  return {
    metrics: { days },
    describe: { functionName: FUNCTION_NAME },
    invoke: { payload },
  };
}

/** No identifier of any kind in anything the gate writes. */
const IDENTIFIER_PATTERNS: RegExp[] = [
  /arn:aws/i,
  /\b\d{12}\b/, // an account id
  /jale\/[a-z0-9-]+\/db/, // a login secret name
  /DbPostureFunctionName/,
  new RegExp(FUNCTION_NAME),
  /jale_example_login|public\.example_table/, // violation objects
  /forbidden attribute|differs from the manifest/, // violation details
  /ExampleDeployRole/,
];

function expectNoIdentifiers(run: RunResult): void {
  for (const pattern of IDENTIFIER_PATTERNS) {
    expect(run.summary).not.toMatch(pattern);
    expect(run.stdout).not.toMatch(pattern);
    expect(run.stderr).not.toMatch(pattern);
  }
}

describe('db-posture-gate.mjs', () => {
  describe('report-only, before the clean history exists', () => {
    it('passes a clean check and reports the clean-day count', () => {
      const run = runGate(scenario(history(span(13, 1, CLEAN), { 5: CLEAN_WITH_DEPLOY })));
      expect(run.status).toBe(0);
      expect(run.summary).toMatch(/Mode: \*\*report-only\*\*/);
      expect(run.summary).toMatch(/Consecutive clean days: 13\b/);
      expect(run.summary).toMatch(/Violations: 0\b/);
      expect(run.summary).toMatch(/Result: \*\*passed\*\*/);
    });

    it('passes with a warning when the check finds violations', () => {
      const run = runGate(scenario(history(span(13, 1, CLEAN), { 5: CLEAN_WITH_DEPLOY }), TWO_VIOLATIONS));
      expect(run.status).toBe(0);
      expect(run.summary).toMatch(/Mode: \*\*report-only\*\*/);
      expect(run.summary).toMatch(/Violations: 2\b/);
      expect(run.summary).toMatch(/Result: \*\*passed with a warning\*\*/);
      expect(run.stdout).toMatch(/^::warning::/m);
      expectNoIdentifiers(run);
    });

    it('passes with a warning when there is no history at all', () => {
      const run = runGate(scenario({}, TWO_VIOLATIONS));
      expect(run.status).toBe(0);
      expect(run.summary).toMatch(/Mode: \*\*report-only\*\*/);
      expect(run.summary).toMatch(/Consecutive clean days: 0\b/);
    });

    it('restarts the count after a not-clean run on day 10 of the window', () => {
      // Fourteen completed days, oldest first; day 10 is 5 days back.
      const run = runGate(scenario(history(QUALIFIED, { 5: NOT_CLEAN }), TWO_VIOLATIONS));
      expect(run.status).toBe(0);
      expect(run.summary).toMatch(/Mode: \*\*report-only\*\*/);
      expect(run.summary).toMatch(/Consecutive clean days: 4\b/);
    });

    it('counts a day without any run as a break in the streak', () => {
      const days = history(span(20, 8, CLEAN), { 12: CLEAN_WITH_DEPLOY }, span(6, 1, CLEAN));
      const run = runGate(scenario(days, TWO_VIOLATIONS));
      expect(run.status).toBe(0);
      expect(run.summary).toMatch(/Mode: \*\*report-only\*\*/);
      expect(run.summary).toMatch(/Consecutive clean days: 6\b/);
    });

    it('needs a clean deploy-triggered run inside the window, not only daily runs', () => {
      const run = runGate(scenario(span(30, 1, CLEAN), TWO_VIOLATIONS));
      expect(run.status).toBe(0);
      expect(run.summary).toMatch(/Mode: \*\*report-only\*\*/);
      expect(run.summary).toMatch(/Consecutive clean days: 30\b/);
    });

    it('stays report-only when no 14-day window ever qualified', () => {
      const days = history(
        span(40, 28, CLEAN_WITH_DEPLOY),
        { 27: NOT_CLEAN },
        span(26, 14, CLEAN_WITH_DEPLOY),
        { 13: NOT_CLEAN },
        span(12, 1, CLEAN_WITH_DEPLOY),
      );
      const run = runGate(scenario(days, TWO_VIOLATIONS));
      expect(run.status).toBe(0);
      expect(run.summary).toMatch(/Mode: \*\*report-only\*\*/);
      expect(run.summary).toMatch(/Consecutive clean days: 12\b/);
    });

    it('treats a missing function as unavailable: a pass with a warning', () => {
      const run = runGate({ metrics: { days: {} }, describe: { functionName: null }, invoke: { payload: CLEAN_REPORT } });
      expect(run.status).toBe(0);
      expect(run.summary).toMatch(/Check: unavailable/);
      expect(run.summary).toMatch(/Result: \*\*passed with a warning\*\*/);
      expect(run.calls.some((call) => call.service === 'lambda')).toBe(false);
    });

    it('treats a function the invoke cannot find as unavailable: a pass with a warning', () => {
      const run = runGate({ metrics: { days: {} }, describe: { functionName: FUNCTION_NAME }, invoke: { error: FUNCTION_NOT_FOUND } });
      expect(run.status).toBe(0);
      expect(run.summary).toMatch(/Check: unavailable/);
      expectNoIdentifiers(run);
    });

    it('treats missing permissions as unavailable: a pass with a warning, and echoes none of the error', () => {
      const run = runGate({ metrics: { days: {} }, describe: { functionName: FUNCTION_NAME }, invoke: { error: ACCESS_DENIED } });
      expect(run.status).toBe(0);
      expect(run.summary).toMatch(/Check: unavailable/);
      expectNoIdentifiers(run);
    });

  });

  describe('an unreadable metric history', () => {
    // The history is the gate's only record of whether enforcement has begun,
    // so without it the gate fails closed on anything but a clean check,
    // whether the check ran or not. Only the reasoned override lets such a
    // run through.
    it('fails closed when the check ran and found violations', () => {
      const run = runGate({ metrics: { error: METRICS_DENIED }, describe: { functionName: FUNCTION_NAME }, invoke: { payload: TWO_VIOLATIONS } });
      expect(run.status).toBe(1);
      expect(run.summary).toContain('metric history unreadable; check ran; failing closed');
      expect(run.summary).toMatch(/Consecutive clean days: unknown/);
      expect(run.summary).toMatch(/Result: \*\*failed\*\*/);
      expectNoIdentifiers(run);
    });

    it('fails closed when the check ran but was incomplete', () => {
      const run = runGate({ metrics: { error: METRICS_DENIED }, describe: { functionName: FUNCTION_NAME }, invoke: { payload: INCOMPLETE_REPORT } });
      expect(run.status).toBe(1);
      expect(run.summary).toContain('metric history unreadable; check ran; failing closed');
      expect(run.summary).toMatch(/Check: incomplete/);
    });

    it('fails closed when the check was unavailable too: enforcement may already have begun', () => {
      const run = runGate({ metrics: { error: METRICS_DENIED }, describe: { functionName: FUNCTION_NAME }, invoke: { error: ACCESS_DENIED } });
      expect(run.status).toBe(1);
      expect(run.summary).toContain('metric history unreadable; check unavailable; failing closed');
      expect(run.summary).toMatch(/Mode: \*\*enforcing\*\*/);
      expect(run.summary).toMatch(/Check: unavailable/);
      expect(run.summary).toMatch(/Result: \*\*failed\*\*/);
      expect(run.stdout).toMatch(/^::error::/m);
      expectNoIdentifiers(run);
    });

    it('fails closed when the gate has lost every right it uses, as when its policy is detached after enforcement began', () => {
      const run = runGate({ metrics: { error: METRICS_DENIED }, describe: { error: DESCRIBE_DENIED }, invoke: { payload: CLEAN_REPORT } });
      expect(run.status).toBe(1);
      expect(run.summary).toContain('metric history unreadable; check unavailable; failing closed');
      expect(run.summary).toMatch(/Check: unavailable \(missing permissions\)/);
      expect(run.summary).toMatch(/Result: \*\*failed\*\*/);
      expect(run.calls.some((call) => call.service === 'lambda')).toBe(false);
      expectNoIdentifiers(run);
    });

    it('lets an unavailable check with an unreadable history through only by override', () => {
      const run = runGate(
        { metrics: { error: METRICS_DENIED }, describe: { error: DESCRIBE_DENIED }, invoke: { payload: CLEAN_REPORT } },
        { override: 'true', reason: 'Deploy role posture policy re-attached after this run' },
      );
      expect(run.status).toBe(0);
      expect(run.summary).toContain('metric history unreadable; check unavailable; failing closed');
      expect(run.summary).toMatch(/Result: \*\*passed by override\*\*/);
      expectNoIdentifiers(run);
    });

    it('passes a clean check', () => {
      const run = runGate({ metrics: { error: METRICS_DENIED }, describe: { functionName: FUNCTION_NAME }, invoke: { payload: CLEAN_REPORT } });
      expect(run.status).toBe(0);
      expect(run.summary).toContain('metric history unreadable; check ran; failing closed');
      expect(run.summary).toMatch(/Result: \*\*passed\*\*/);
    });

    it('lets a failing-closed run through only by override', () => {
      const run = runGate(
        { metrics: { error: METRICS_DENIED }, describe: { functionName: FUNCTION_NAME }, invoke: { payload: TWO_VIOLATIONS } },
        { override: 'true', reason: 'CloudWatch outage during the release window' },
      );
      expect(run.status).toBe(0);
      expect(run.summary).toMatch(/Result: \*\*passed by override\*\*/);
    });
  });

  describe('enforcing, after a qualifying 14-day window', () => {
    it('passes a clean check', () => {
      const run = runGate(scenario(QUALIFIED));
      expect(run.status).toBe(0);
      expect(run.summary).toMatch(/Mode: \*\*enforcing\*\*/);
      expect(run.summary).toMatch(/Consecutive clean days: 14\b/);
      expect(run.summary).toMatch(/Result: \*\*passed\*\*/);
    });

    it('fails on violations', () => {
      const run = runGate(scenario(QUALIFIED, TWO_VIOLATIONS));
      expect(run.status).toBe(1);
      expect(run.summary).toMatch(/Mode: \*\*enforcing\*\*/);
      expect(run.summary).toMatch(/Violations: 2\b/);
      expect(run.summary).toMatch(/Result: \*\*failed\*\*/);
      expect(run.stdout).toMatch(/^::error::/m);
      expectNoIdentifiers(run);
    });

    it('fails on an incomplete check', () => {
      const run = runGate(scenario(QUALIFIED, INCOMPLETE_REPORT));
      expect(run.status).toBe(1);
      expect(run.summary).toMatch(/Check: incomplete/);
    });

    it('fails when the function cannot be found', () => {
      const run = runGate({ metrics: { days: QUALIFIED }, describe: { functionName: null }, invoke: { payload: CLEAN_REPORT } });
      expect(run.status).toBe(1);
      expect(run.summary).toMatch(/Check: unavailable/);
    });

    it('fails when the invoke is denied, and echoes none of the error', () => {
      const run = runGate({ metrics: { days: QUALIFIED }, describe: { functionName: FUNCTION_NAME }, invoke: { error: ACCESS_DENIED } });
      expect(run.status).toBe(1);
      expect(run.summary).toMatch(/Check: unavailable/);
      expectNoIdentifiers(run);
    });

    it('fails when the function itself errors', () => {
      const run = runGate({
        metrics: { days: QUALIFIED },
        describe: { functionName: FUNCTION_NAME },
        invoke: { payload: { errorMessage: 'Task timed out' }, functionError: 'Unhandled' },
      });
      expect(run.status).toBe(1);
      expect(run.summary).toMatch(/Check: unavailable/);
      expect(run.summary).not.toMatch(/timed out/);
    });

    it('fails on a response that is not a posture report', () => {
      const run = runGate(scenario(QUALIFIED, { hello: 'world' }));
      expect(run.status).toBe(1);
      expect(run.summary).toMatch(/Check: unavailable/);
    });
  });

  describe('sticky enforcement', () => {
    it('keeps enforcing on the run after an enforced failure', () => {
      // A qualifying window, then the enforced failure the day before.
      const days = history(span(16, 3, CLEAN), { 9: CLEAN_WITH_DEPLOY }, { 2: CLEAN }, { 1: NOT_CLEAN });
      const failing = runGate(scenario(days, TWO_VIOLATIONS));
      expect(failing.status).toBe(1);
      expect(failing.summary).toMatch(/Mode: \*\*enforcing\*\*/);
      expect(failing.summary).toMatch(/Consecutive clean days: 0\b/);

      const clean = runGate(scenario(days, CLEAN_REPORT));
      expect(clean.status).toBe(0);
      expect(clean.summary).toMatch(/Mode: \*\*enforcing\*\*/);
    });

    it('enforces after a qualifying window 30 days ago and a failure yesterday', () => {
      const days = history(span(45, 31, CLEAN), { 40: CLEAN_WITH_DEPLOY }, { 1: NOT_CLEAN });
      const run = runGate(scenario(days, TWO_VIOLATIONS));
      expect(run.status).toBe(1);
      expect(run.summary).toMatch(/Mode: \*\*enforcing\*\*/);
      expect(run.summary).toMatch(/Result: \*\*failed\*\*/);
    });

    it('reads the history as far back as CloudWatch keeps it', () => {
      const run = runGate(scenario(QUALIFIED));
      const metrics = run.calls.find((call) => call.operation === 'get-metric-data');
      expect(metrics).toBeDefined();
      const args = metrics!.args;
      const start = Date.parse(args[args.indexOf('--start-time') + 1]);
      const end = Date.parse(args[args.indexOf('--end-time') + 1]);
      // Hourly-or-coarser data lives 455 days; the window reaches all of it.
      expect((end - start) / 86_400_000).toBe(455);
    });
  });

  describe('the order of the calls', () => {
    it('reads the history before the invoke, and invokes the stack-output function as a deploy run', () => {
      const run = runGate(scenario(QUALIFIED));
      const operations = run.calls.map((call) => `${call.service} ${call.operation}`);
      expect(operations).toEqual([
        'cloudwatch get-metric-data',
        'cloudformation describe-stacks',
        'lambda invoke',
      ]);
      const describe = run.calls[1].args;
      expect(describe[describe.indexOf('--stack-name') + 1]).toBe('JaleDatabaseStack');
      const invoke = run.calls[2].args;
      expect(invoke[invoke.indexOf('--function-name') + 1]).toBe(FUNCTION_NAME);
      expect(JSON.parse(invoke[invoke.indexOf('--payload') + 1])).toEqual({ trigger: 'deploy' });
    });

    it('counts only completed UTC days: the window ends at the start of today', () => {
      const before = Date.now();
      const run = runGate(scenario(QUALIFIED));
      const args = run.calls[0].args;
      const end = new Date(args[args.indexOf('--end-time') + 1]);
      expect(end.getUTCHours()).toBe(0);
      expect(end.getUTCMinutes()).toBe(0);
      expect(end.getUTCSeconds()).toBe(0);
      expect(end.getTime()).toBeLessThanOrEqual(Date.now());
      expect(before - end.getTime()).toBeLessThan(86_400_000);
    });
  });

  describe('the override', () => {
    it('lets an enforced failure through when a reason is given, and echoes the reason', () => {
      const run = runGate(scenario(QUALIFIED, TWO_VIOLATIONS), {
        override: 'true',
        reason: 'Restoring service during the incident review',
      });
      expect(run.status).toBe(0);
      expect(run.summary).toMatch(/Mode: \*\*enforcing\*\*/);
      expect(run.summary).toMatch(/Override: used/);
      expect(run.summary).toContain('Restoring service during the incident review');
      expect(run.summary).toMatch(/Result: \*\*passed by override\*\*/);
      expectNoIdentifiers(run);
    });

    it('fails without a reason, before calling AWS at all', () => {
      const run = runGate(scenario(QUALIFIED, CLEAN_REPORT), { override: 'true', reason: '' });
      expect(run.status).toBe(1);
      expect(run.summary).toMatch(/reason/i);
      expect(run.calls).toEqual([]);
    });

    it('fails with a reason that is only whitespace', () => {
      const run = runGate(scenario({}, CLEAN_REPORT), { override: 'true', reason: '   \n\t ' });
      expect(run.status).toBe(1);
      expect(run.summary).toMatch(/reason/i);
      expect(run.calls).toEqual([]);
    });

    it('is off unless it is exactly true', () => {
      const run = runGate(scenario(QUALIFIED, TWO_VIOLATIONS), { override: 'false', reason: 'not used' });
      expect(run.status).toBe(1);
      expect(run.summary).toMatch(/Override: not used/);
    });

    describe('on the first release, before the deploy role has the posture policy', () => {
      const REASON = 'first release: deploy-role posture policy not yet attached';

      it('lets the gate before the deploy through, and shows the reason', () => {
        // The function does not exist yet; whether or not the history reads.
        const run = runGate(
          { metrics: { error: METRICS_DENIED }, describe: { functionName: null }, invoke: { payload: CLEAN_REPORT } },
          { phase: 'pre', override: 'true', reason: REASON },
        );
        expect(run.status).toBe(0);
        expect(run.summary).toMatch(/Database posture gate \(before deploy\)/);
        expect(run.summary).toContain('metric history unreadable; check unavailable; failing closed');
        expect(run.summary).toContain(`Override: used. Reason: \`${REASON}\``);
        expect(run.summary).toMatch(/Result: \*\*passed by override\*\*/);
      });

      it('fails that gate without the override', () => {
        const run = runGate(
          { metrics: { error: METRICS_DENIED }, describe: { functionName: null }, invoke: { payload: CLEAN_REPORT } },
          { phase: 'pre' },
        );
        expect(run.status).toBe(1);
        expect(run.summary).toMatch(/Result: \*\*failed\*\*/);
      });

      it('lets the verification after the deploy through, and shows the reason', () => {
        // The new function runs, the history cannot be read yet, and the
        // first result is not clean: the branch that fails closed.
        const run = runGate(
          { metrics: { error: METRICS_DENIED }, describe: { functionName: FUNCTION_NAME }, invoke: { payload: INCOMPLETE_REPORT } },
          { phase: 'post', override: 'true', reason: REASON },
        );
        expect(run.status).toBe(0);
        expect(run.summary).toMatch(/Database posture verification \(after deploy\)/);
        expect(run.summary).toContain('metric history unreadable; check ran; failing closed');
        expect(run.summary).toContain(`Override: used. Reason: \`${REASON}\``);
        expect(run.summary).toMatch(/Result: \*\*passed by override\*\*/);
      });

      it('fails that verification without the override', () => {
        const run = runGate(
          { metrics: { error: METRICS_DENIED }, describe: { functionName: FUNCTION_NAME }, invoke: { payload: INCOMPLETE_REPORT } },
          { phase: 'post' },
        );
        expect(run.status).toBe(1);
      });
    });

    it('masks identifier-shaped text in the reason and keeps it on one line', () => {
      const run = runGate(scenario(QUALIFIED, TWO_VIOLATIONS), {
        override: 'true',
        reason: 'see arn:aws:lambda:us-east-2:111122223333:function:x\n## injected heading `code`',
      });
      expect(run.status).toBe(0);
      expectNoIdentifiers(run);
      expect(run.summary).not.toMatch(/^## injected heading/m);
    });
  });

  describe('the run summary', () => {
    it('appends to the summary rather than replacing it', () => {
      const run = runGate(scenario(QUALIFIED), { summarySeed: '## Earlier step\n\n' });
      expect(run.summary.startsWith('## Earlier step\n\n')).toBe(true);
      expect(run.summary).toMatch(/Database posture gate/);
    });

    it('names the verification step after the deploy', () => {
      const run = runGate(scenario(QUALIFIED), { phase: 'post' });
      expect(run.status).toBe(0);
      expect(run.summary).toMatch(/Database posture verification/);
    });
  });

  describe('arguments', () => {
    it.each([[null], ['during'], ['']])('refuses a phase of %j', (phase) => {
      const run = runGate(scenario(QUALIFIED), { phase });
      expect(run.status).toBe(2);
      expect(run.calls).toEqual([]);
    });
  });
});
