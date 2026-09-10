// Guard tests for scripts/npm-audit-gate.mjs. Run with: node --test scripts/npm-audit-gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_EXCEPTIONS_FILE,
  collectAdvisories,
  evaluateAudit,
  parseExceptions,
} from './npm-audit-gate.mjs';

const TODAY = '2026-09-09';

function advisory(id, severity, name = 'next', title = `${name} problem`) {
  return { source: 1, name, dependency: name, title, url: `https://github.com/advisories/${id}`, severity, range: '<99' };
}

/** A report in the shape `npm audit --json` (npm 10) produces. */
function report(vias, dependency = 'next') {
  return {
    auditReportVersion: 2,
    vulnerabilities: { [dependency]: { name: dependency, severity: 'critical', via: vias, range: '<99', fixAvailable: false } },
    metadata: { vulnerabilities: { critical: vias.length } },
  };
}

const EXCEPTION = {
  id: 'GHSA-aaaa-bbbb-cccc',
  package: 'next',
  reason: 'Not reachable here: images.unoptimized makes /_next/image a 404.',
  expires: '2026-10-15',
};

test('an unexcepted advisory at the gate level blocks', () => {
  const verdict = evaluateAudit(report([advisory('GHSA-zzzz-yyyy-xxxx', 'critical')]), [], { level: 'critical', today: TODAY });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.blocking.length, 1);
  assert.equal(verdict.blocking[0].id, 'GHSA-ZZZZ-YYYY-XXXX');
});

test('an advisory below the gate level is ignored, whatever the exceptions say', () => {
  const verdict = evaluateAudit(report([advisory('GHSA-zzzz-yyyy-xxxx', 'high')]), [], { level: 'critical', today: TODAY });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.blocking.length, 0);
});

test('a listed, unexpired exception lets exactly that advisory through and reports it', () => {
  const exceptions = parseExceptions(JSON.stringify({ exceptions: [EXCEPTION] }));
  const verdict = evaluateAudit(
    report([advisory('GHSA-aaaa-bbbb-cccc', 'critical'), advisory('GHSA-zzzz-yyyy-xxxx', 'critical')]),
    exceptions,
    { level: 'critical', today: TODAY },
  );
  assert.equal(verdict.ok, false, 'the second, unlisted advisory still blocks');
  assert.deepEqual(verdict.excepted.map((e) => e.advisory.id), ['GHSA-AAAA-BBBB-CCCC']);
  assert.deepEqual(verdict.blocking.map((a) => a.id), ['GHSA-ZZZZ-YYYY-XXXX']);
});

test('an exception re-arms the day after it expires', () => {
  const exceptions = parseExceptions(JSON.stringify({ exceptions: [EXCEPTION] }));
  const stillValid = evaluateAudit(report([advisory('GHSA-aaaa-bbbb-cccc', 'critical')]), exceptions, { level: 'critical', today: '2026-10-15' });
  assert.equal(stillValid.ok, true, 'valid through the expiry date itself');
  const expired = evaluateAudit(report([advisory('GHSA-aaaa-bbbb-cccc', 'critical')]), exceptions, { level: 'critical', today: '2026-10-16' });
  assert.equal(expired.ok, false);
  assert.equal(expired.expired.length, 1);
  assert.equal(expired.blocking.length, 0);
});

test('an exception for an advisory that is gone is reported as unused, not as a failure', () => {
  const exceptions = parseExceptions(JSON.stringify({ exceptions: [EXCEPTION] }));
  const verdict = evaluateAudit({ vulnerabilities: {} }, exceptions, { level: 'critical', today: TODAY });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.unused.map((e) => e.id), ['GHSA-AAAA-BBBB-CCCC']);
});

test('the same advisory under two dependencies counts once', () => {
  const rep = {
    vulnerabilities: {
      postcss: { via: [advisory('GHSA-pppp-qqqq-rrrr', 'critical', 'postcss')] },
      next: { via: ['postcss', advisory('GHSA-pppp-qqqq-rrrr', 'critical', 'postcss')] },
    },
  };
  const advisories = collectAdvisories(rep);
  assert.equal(advisories.length, 1);
  assert.deepEqual(advisories[0].dependencies, ['next', 'postcss']);
});

test('an npm audit error body fails loud instead of passing as "no vulnerabilities"', () => {
  assert.throws(
    () => evaluateAudit({ error: { code: 'ENOAUDIT', summary: 'registry unavailable' } }, [], { level: 'critical', today: TODAY }),
    /registry unavailable/,
  );
});

test('a malformed exceptions file is rejected, field by field', () => {
  assert.throws(() => parseExceptions('not json'), /not valid JSON/);
  assert.throws(() => parseExceptions('{"exceptions": {}}'), /"exceptions" array/);
  assert.throws(() => parseExceptions(JSON.stringify({ exceptions: [{ ...EXCEPTION, id: 'CVE-2026-1' }] })), /GHSA id/);
  assert.throws(() => parseExceptions(JSON.stringify({ exceptions: [{ ...EXCEPTION, reason: 'because' }] })), /"reason"/);
  assert.throws(() => parseExceptions(JSON.stringify({ exceptions: [{ ...EXCEPTION, expires: 'someday' }] })), /"expires"/);
  assert.throws(() => parseExceptions(JSON.stringify({ exceptions: [{ ...EXCEPTION, package: '' }] })), /"package"/);
  assert.throws(() => parseExceptions(JSON.stringify({ exceptions: [EXCEPTION, EXCEPTION] })), /duplicate/);
});

test('the committed exceptions file parses and nothing in it has already expired', () => {
  const exceptions = parseExceptions(readFileSync(DEFAULT_EXCEPTIONS_FILE, 'utf8'), '.github/audit-exceptions.json');
  const today = new Date().toISOString().slice(0, 10);
  for (const e of exceptions) {
    assert.ok(e.expires >= today, `${e.id} expired on ${e.expires}: remove it or renew it deliberately`);
  }
});
