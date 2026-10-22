#!/usr/bin/env node
/**
 * The database posture gate, run by the deploy workflow on both sides of
 * "Deploy CDK stacks":
 *
 *   node scripts/db-posture-gate.mjs --phase pre --expected <file>   # the gate, before the deploy
 *   node scripts/db-posture-gate.mjs --phase post                    # the verification, after it
 *
 * In this order, it:
 *   1. reads the posture metric history (CloudWatch GetMetricData) and settles
 *      the mode BEFORE anything runs the check, so a run can never change its
 *      own mode. Only completed UTC days count;
 *   2. finds the posture function through the database stack's output;
 *   3. invokes it and reads its report;
 *   4. passes, warns or fails, and appends a short summary to the run.
 *
 * The invoke:
 *   - before the deploy, the database already holds the incoming release's
 *     migrations, so the gate checks it against that release's expectation,
 *     not the one the deployed function bundles. `<file>` is the output of
 *     scripts/write-posture-expectation.ts: the merged manifest, the change
 *     log and their digests. The gate sends
 *     `{ trigger: 'deploy', phase: 'pre', expected: { manifest, change_log } }`
 *     from a file in its temporary directory (`fileb://`), since the payload
 *     is larger than one command-line argument may be. It accepts the report
 *     only when it says `expected_source: 'supplied'` with both digests equal
 *     to the file's; any other supplied report is unavailable
 *     (expectation-mismatch). A report without `expected_source` comes from a
 *     function that predates supplied checks and checked its own bundle: it is
 *     accepted, with a note, only when its manifest digest is the incoming
 *     one, and is otherwise unavailable (stale-manifest). The function
 *     publishes a supplied run under Trigger=deploy-pre only, so this run
 *     never enters the history read in step 1;
 *   - after the deploy, the gate sends `{ trigger: 'deploy' }`, and the newly
 *     deployed function checks against its own bundle.
 *   A missing or unreadable expectation before the deploy, or one passed
 *   after it, is a usage error (exit 2) before any AWS call.
 *
 * The mode:
 *   - report-only until a qualifying window has occurred: 14 consecutive
 *     completed UTC days, each with at least one clean run and no not-clean
 *     run, with at least one clean deploy-triggered run among them. A
 *     not-clean run, or a day without a clean run, restarts the count;
 *   - enforcing from then on. Enforcement is sticky: the gate looks for a
 *     qualifying window anywhere in the history CloudWatch keeps at a daily
 *     period (455 days), so a later failure fails the step without dropping
 *     the gate back to report-only;
 *   - when enforcing, violations, an incomplete check or an unavailable check
 *     fail the step. When report-only, each is a warning;
 *   - an unreadable history: the history is the gate's only record of whether
 *     enforcement has begun, so the gate fails closed on anything but a clean
 *     result, whether the check ran or was unavailable too. The invoke and the
 *     history read come from the same managed policy, so losing that policy
 *     after enforcement began looks exactly like the bootstrap case, before
 *     the policy is attached; both go through the reasoned override;
 *   - POSTURE_OVERRIDE=true with a non-empty POSTURE_OVERRIDE_REASON lets the
 *     step pass whatever the check says, and the reason goes into the summary.
 *     An override without a reason fails before any AWS call.
 *
 * It never writes violation objects or details, AWS error text, the
 * expectation it sends, or any value read from the account: the repository
 * and its run logs are public, and the posture function's own logs hold the
 * details.
 *
 * Node built-ins and the AWS CLI only; credentials come from the job.
 */
import { execFile } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NAMESPACE = 'Jale/Database';
const STACK_NAME = 'JaleDatabaseStack';
const FUNCTION_OUTPUT_KEY = 'DbPostureFunctionName';
const WINDOW_DAYS = 14;
/** How long CloudWatch keeps data at a period of an hour or more. */
const HISTORY_DAYS = 455;
const DAY_MS = 86_400_000;

const TITLES = {
  pre: 'Database posture gate (before deploy)',
  post: 'Database posture verification (after deploy)',
};

const UNAVAILABLE_REASONS = {
  'not-found': 'the posture function was not found',
  'missing-permissions': 'missing permissions',
  'function-error': 'the function failed',
  'bad-response': 'the response was not a posture report',
  'no-cli': 'the AWS CLI is not installed',
  'stale-manifest': 'the posture function checked a manifest other than the incoming one',
  'expectation-mismatch': 'the report does not match the incoming expectation',
  error: 'the call failed',
};

const USAGE = 'usage: node scripts/db-posture-gate.mjs --phase pre --expected <file> | --phase post\n';
const EXPECTATION_ERROR = '::error::The posture expectation file could not be read. '
  + 'Write it with scripts/write-posture-expectation.ts in the same step.\n';

/** A sha256 digest in hex, as the posture library writes them. */
const DIGEST = /^[0-9a-f]{64}$/;
const EXPECTATION_KEYS = ['change_log', 'change_log_sha256', 'manifest', 'manifest_sha256'];

// ── AWS CLI ─────────────────────────────────────────────────────────────────

/**
 * Runs the AWS CLI without a shell. The CLI's own output is never passed on:
 * AWS error messages carry ARNs and account ids, so a failure is reduced to
 * a kind.
 */
function aws(args) {
  return new Promise((resolve) => {
    execFile('aws', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180_000 }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ ok: true, stdout });
        return;
      }
      resolve({ ok: false, kind: classifyFailure(error, stderr) });
    });
  });
}

function classifyFailure(error, stderr) {
  if (error && error.code === 'ENOENT') return 'no-cli';
  const text = String(stderr ?? '');
  if (/ResourceNotFoundException|Function not found|does not exist/i.test(text)) return 'not-found';
  if (/AccessDenied|not authorized|UnauthorizedOperation|ExpiredToken|InvalidClientTokenId|UnrecognizedClient|Unable to locate credentials/i.test(text)) {
    return 'missing-permissions';
  }
  return 'error';
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'db-posture-gate-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

// ── 1. History and mode ─────────────────────────────────────────────────────

function metricQuery(id, metricName, dimensions) {
  return {
    Id: id,
    MetricStat: {
      Metric: { Namespace: NAMESPACE, MetricName: metricName, ...(dimensions ? { Dimensions: dimensions } : {}) },
      Period: DAY_MS / 1000,
      Stat: 'Sum',
    },
    ReturnData: true,
  };
}

const QUERIES = [
  // The rollups, emitted without dimensions alongside the per-trigger series.
  metricQuery('clean', 'DbPostureRunClean'),
  metricQuery('notclean', 'DbPostureRunNotClean'),
  metricQuery('cleandeploy', 'DbPostureRunClean', [{ Name: 'Trigger', Value: 'deploy' }]),
];

/** Daily sums per query id, keyed by UTC day number; null when unreadable. */
function parseMetricData(stdout) {
  let body;
  try {
    body = JSON.parse(stdout);
  } catch {
    return null;
  }
  const results = body && body.MetricDataResults;
  if (!Array.isArray(results)) return null;

  const series = new Map(QUERIES.map((query) => [query.Id, new Map()]));
  const lastStatus = new Map();
  for (const result of results) {
    if (!result || !series.has(result.Id)) continue;
    const timestamps = result.Timestamps ?? [];
    const values = result.Values ?? [];
    if (!Array.isArray(timestamps) || !Array.isArray(values) || timestamps.length !== values.length) return null;
    const sums = series.get(result.Id);
    for (let i = 0; i < timestamps.length; i += 1) {
      const at = Date.parse(timestamps[i]);
      const value = Number(values[i]);
      if (!Number.isFinite(at) || !Number.isFinite(value)) return null;
      const day = Math.floor(at / DAY_MS);
      sums.set(day, (sums.get(day) ?? 0) + value);
    }
    // The CLI concatenates pages; only the last page of a series says Complete.
    lastStatus.set(result.Id, result.StatusCode ?? 'Complete');
  }
  for (const query of QUERIES) {
    if (lastStatus.get(query.Id) !== 'Complete') return null;
  }
  return series;
}

/**
 * Walks every completed day in the window, oldest first. The streak is the
 * run of clean days ending with the most recent completed day; the gate
 * enforces once any 14-day stretch of the streak, at any point in the
 * history, held a clean deploy-triggered run.
 */
function analyse(series, firstDay, endDay) {
  const clean = series.get('clean');
  const notClean = series.get('notclean');
  const cleanDeploy = series.get('cleandeploy');
  let streak = 0;
  let lastCleanDeployDay = -Infinity;
  let firstQualifiedDay = null;
  for (let day = firstDay; day < endDay; day += 1) {
    const isClean = (clean.get(day) ?? 0) > 0 && (notClean.get(day) ?? 0) === 0;
    if (!isClean) {
      streak = 0;
      continue;
    }
    streak += 1;
    if ((cleanDeploy.get(day) ?? 0) > 0) lastCleanDeployDay = day;
    if (firstQualifiedDay === null && streak >= WINDOW_DAYS && lastCleanDeployDay > day - WINDOW_DAYS) {
      firstQualifiedDay = day;
    }
  }
  return {
    streak,
    enforcing: firstQualifiedDay !== null,
    qualifiedOn: firstQualifiedDay === null ? null : new Date(firstQualifiedDay * DAY_MS).toISOString().slice(0, 10),
  };
}

async function readHistory(now) {
  const endDay = Math.floor(now / DAY_MS); // today, which has not completed
  const firstDay = endDay - HISTORY_DAYS;
  return withTempDir(async (dir) => {
    const queriesFile = join(dir, 'queries.json');
    writeFileSync(queriesFile, JSON.stringify(QUERIES));
    const result = await aws([
      'cloudwatch', 'get-metric-data',
      '--start-time', new Date(firstDay * DAY_MS).toISOString(),
      '--end-time', new Date(endDay * DAY_MS).toISOString(),
      '--scan-by', 'TimestampAscending',
      '--metric-data-queries', `file://${queriesFile}`,
      '--output', 'json',
    ]);
    if (!result.ok) return { readable: false };
    const series = parseMetricData(result.stdout);
    if (!series) return { readable: false };
    return { readable: true, ...analyse(series, firstDay, endDay) };
  });
}

// ── The incoming expectation ────────────────────────────────────────────────

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The expectation file, or null when it cannot be used: exactly the writer's
 * four fields, two objects and two digests. The gate never looks inside the
 * manifest or the change log; the posture function validates them.
 */
function readExpectation(file) {
  let body;
  try {
    body = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!isObject(body) || Object.keys(body).sort().join(' ') !== EXPECTATION_KEYS.join(' ')) return null;
  if (!isObject(body.manifest) || !isObject(body.change_log)) return null;
  if (typeof body.manifest_sha256 !== 'string' || !DIGEST.test(body.manifest_sha256)) return null;
  if (typeof body.change_log_sha256 !== 'string' || !DIGEST.test(body.change_log_sha256)) return null;
  return body;
}

/**
 * Whether a report is a check against the expectation the gate sent:
 * `supplied` when the function says so and both digests match; `predates`
 * for a function without supplied checks whose own manifest is the incoming
 * one; otherwise the reason it is unavailable.
 */
function provenance(report, expectation) {
  if (!Object.prototype.hasOwnProperty.call(report, 'expected_source')) {
    return report.manifest_sha256 === expectation.manifest_sha256
      ? { accepted: 'predates' }
      : { reason: 'stale-manifest' };
  }
  if (report.expected_source === 'supplied'
      && report.manifest_sha256 === expectation.manifest_sha256
      && report.change_log_sha256 === expectation.change_log_sha256) {
    return { accepted: 'supplied' };
  }
  return { reason: 'expectation-mismatch' };
}

// ── 2 and 3. The check ──────────────────────────────────────────────────────

function unavailable(reason) {
  return { status: 'unavailable', reason, violations: null, expectation: null };
}

function failureReason(kind) {
  return kind in UNAVAILABLE_REASONS ? kind : 'error';
}

async function findFunction() {
  const result = await aws(['cloudformation', 'describe-stacks', '--stack-name', STACK_NAME, '--output', 'json']);
  if (!result.ok) return { ok: false, reason: failureReason(result.kind) };
  let body;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    return { ok: false, reason: 'error' };
  }
  const outputs = body && Array.isArray(body.Stacks) && body.Stacks[0] && Array.isArray(body.Stacks[0].Outputs)
    ? body.Stacks[0].Outputs
    : [];
  const output = outputs.find((entry) => entry && entry.OutputKey === FUNCTION_OUTPUT_KEY);
  const name = output && typeof output.OutputValue === 'string' ? output.OutputValue.trim() : '';
  return name ? { ok: true, name } : { ok: false, reason: 'not-found' };
}

function isPostureReport(report) {
  return Boolean(report)
    && typeof report === 'object'
    && typeof report.complete === 'boolean'
    && Array.isArray(report.violations);
}

/** `expectation` is the incoming one before the deploy, and null after it. */
async function runCheck(functionName, expectation) {
  return withTempDir(async (dir) => {
    const responseFile = join(dir, 'response.json');
    let payload = JSON.stringify({ trigger: 'deploy' });
    if (expectation) {
      const payloadFile = join(dir, 'payload.json');
      writeFileSync(payloadFile, JSON.stringify({
        trigger: 'deploy',
        phase: 'pre',
        expected: { manifest: expectation.manifest, change_log: expectation.change_log },
      }));
      payload = `fileb://${payloadFile}`;
    }
    const result = await aws([
      'lambda', 'invoke',
      '--function-name', functionName,
      '--cli-binary-format', 'raw-in-base64-out',
      '--cli-read-timeout', '120',
      '--payload', payload,
      '--output', 'json',
      responseFile,
    ]);
    if (!result.ok) return unavailable(failureReason(result.kind));
    let meta;
    try {
      meta = JSON.parse(result.stdout);
    } catch {
      return unavailable('bad-response');
    }
    if (meta && meta.FunctionError) return unavailable('function-error');
    let report;
    try {
      report = JSON.parse(readFileSync(responseFile, 'utf8'));
    } catch {
      return unavailable('bad-response');
    }
    if (!isPostureReport(report)) return unavailable('bad-response');
    let accepted = null;
    if (expectation) {
      const checked = provenance(report, expectation);
      if (checked.reason) return unavailable(checked.reason);
      accepted = checked.accepted;
    }
    if (report.violations.length > 0) return { status: 'violations', violations: report.violations.length, expectation: accepted };
    if (report.complete !== true) return { status: 'incomplete', violations: 0, expectation: accepted };
    return { status: 'clean', violations: 0, expectation: accepted };
  });
}

// ── 4. Decision and summary ─────────────────────────────────────────────────

/**
 * The override reason is the one free-text value the gate echoes. It goes
 * into the summary on one line, inside a code span, with anything shaped like
 * an identifier masked.
 */
function sanitizeReason(raw) {
  return String(raw ?? '')
    .replace(/arn:\S*/gi, '[masked]')
    .replace(/\bjale\/\S*/gi, '[masked]')
    .replace(/\S+@\S+/g, '[masked]')
    .replace(/\d{7,}/g, '[masked]')
    .replace(/[`<>]/g, '')
    .replace(/[\u0000-\u001f\u007f\s]+/g, ' ')
    .trim()
    .slice(0, 300);
}

function readOverride(env) {
  return {
    active: String(env.POSTURE_OVERRIDE ?? '').trim() === 'true',
    reason: sanitizeReason(env.POSTURE_OVERRIDE_REASON),
  };
}

/** The branch taken when the history could not be read, named in the summary. */
const UNREADABLE_BRANCHES = {
  ran: 'metric history unreadable; check ran; failing closed',
  unavailable: 'metric history unreadable; check unavailable; failing closed',
};

/**
 * Report-only only when a readable history shows that enforcement has not
 * begun. Without the history the gate cannot tell, so it enforces.
 */
function settleMode(history, check) {
  if (history.readable) return { mode: history.enforcing ? 'enforcing' : 'report-only', branch: null };
  if (check.status === 'unavailable') return { mode: 'enforcing', branch: UNREADABLE_BRANCHES.unavailable };
  return { mode: 'enforcing', branch: UNREADABLE_BRANCHES.ran };
}

function decide(history, check, override) {
  const { mode, branch } = settleMode(history, check);
  const settled = (result, exitCode) => ({ mode, branch, result, exitCode });
  if (check.status === 'clean') return settled('passed', 0);
  if (override.active) return settled('passed by override', 0);
  if (mode === 'enforcing') return settled('failed', 1);
  return settled('passed with a warning', 0);
}

function describeMode(history, decision) {
  const { mode, branch } = decision;
  if (branch) return `**${mode}** (${branch}).`;
  if (mode === 'enforcing') {
    return `**enforcing**. A qualifying ${WINDOW_DAYS}-day clean window first completed on ${history.qualifiedOn}.`;
  }
  return `**report-only**. Enforcement starts after ${WINDOW_DAYS} consecutive completed UTC days of clean runs, `
    + 'with a clean deploy-triggered run among them.';
}

function describeExpectation(check) {
  if (check.expectation === 'supplied') return 'checked against the incoming release\'s manifest and change log';
  if (check.expectation === 'predates') {
    return 'posture function predates supplied checks; accepted because its manifest digest is the incoming one';
  }
  return 'not confirmed';
}

function describeCheck(check) {
  switch (check.status) {
    case 'clean': return 'clean';
    case 'violations': return 'violations found';
    case 'incomplete': return 'incomplete (the check did not cover the whole inventory)';
    default: return `unavailable (${UNAVAILABLE_REASONS[check.reason] ?? UNAVAILABLE_REASONS.error})`;
  }
}

function writeSummary(env, lines) {
  const text = `${lines.join('\n')}\n\n`;
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(env.GITHUB_STEP_SUMMARY, text);
      return;
    } catch {
      // Fall through to the log.
    }
  }
  process.stdout.write(text);
}

/**
 * `--phase pre --expected <file>` or `--phase post`, each argument at most
 * once, in either order, as `--name value` or `--name=value`. Anything else
 * is null.
 */
function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const match = /^--(phase|expected)(?:=(.*))?$/s.exec(argv[i]);
    if (!match || match[1] in values) return null;
    if (match[2] !== undefined) {
      values[match[1]] = match[2];
    } else {
      if (i + 1 >= argv.length) return null;
      i += 1;
      values[match[1]] = argv[i];
    }
  }
  const { phase, expected } = values;
  if (!Object.prototype.hasOwnProperty.call(TITLES, phase)) return null;
  if (phase === 'pre' && !expected) return null;
  if (phase === 'post' && expected !== undefined) return null;
  return { phase, expectedFile: expected ?? null };
}

async function main(argv, env, now) {
  const args = parseArgs(argv);
  if (!args) {
    process.stderr.write(USAGE);
    return 2;
  }
  const { phase } = args;
  let expectation = null;
  if (phase === 'pre') {
    expectation = readExpectation(args.expectedFile);
    if (!expectation) {
      process.stdout.write(EXPECTATION_ERROR);
      return 2;
    }
  }
  const title = TITLES[phase];
  const override = readOverride(env);

  if (override.active && override.reason === '') {
    writeSummary(env, [
      `### ${title}`,
      '',
      '- Override: requested without a reason, which is not allowed.',
      '- Result: **failed**',
    ]);
    process.stdout.write('::error::The posture override needs a reason. Re-run the deploy with posture_override_reason set.\n');
    return 1;
  }

  const history = await readHistory(now);
  const target = await findFunction();
  const check = target.ok ? await runCheck(target.name, expectation) : unavailable(target.reason);
  const decision = decide(history, check, override);

  const streak = history.readable ? String(history.streak) : 'unknown';
  const violations = check.violations === null ? 'unknown' : String(check.violations);
  writeSummary(env, [
    `### ${title}`,
    '',
    `- Mode: ${describeMode(history, decision)}`,
    `- Consecutive clean days: ${streak}`,
    `- Check: ${describeCheck(check)}`,
    ...(expectation ? [`- Expectation: ${describeExpectation(check)}`] : []),
    `- Violations: ${violations}`,
    override.active ? `- Override: used. Reason: \`${override.reason}\`` : '- Override: not used',
    `- Result: **${decision.result}**`,
    '',
    'Details stay in the posture function\'s own logs.',
  ]);

  const line = `${title}: mode ${decision.mode}, check ${check.status}, violations ${violations}, ${decision.result}.`;
  if (decision.exitCode !== 0) {
    process.stdout.write(`::error::${line}\n`);
  } else if (check.status !== 'clean') {
    process.stdout.write(`::warning::${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
  if (decision.branch) process.stdout.write(`::warning::${title}: ${decision.branch}.\n`);
  return decision.exitCode;
}

main(process.argv.slice(2), process.env, Date.now()).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.stdout.write('::error::The database posture gate stopped on an unexpected error.\n');
    process.exitCode = 1;
  },
);
