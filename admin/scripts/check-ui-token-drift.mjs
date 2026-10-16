// T1: the admin console's design tokens are the Jale app's. Compares every
// custom property in the top-level :root and .dark rules of
// admin/src/app/globals.css with frontend/src/app/globals.css and lists every
// difference. Runs from a full checkout (CI checks out the whole repository);
// the admin Docker build context holds admin/ only, so it never runs there.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { adminRoot } from './lib/check-harness.mjs';

const ADMIN_CSS = resolve(adminRoot, 'src/app/globals.css');
const FRONTEND_CSS = resolve(adminRoot, '..', 'frontend', 'src', 'app', 'globals.css');
const ADMIN_ONLY_MARKER = '/* ===== ADMIN-ONLY TOKENS';
// 00-FE-INTERFACES §2: the only admin-only tokens, in both themes.
const ADMIN_ONLY_NAMES = [
  '--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6',
  '--chart-grid', '--chart-axis', '--chart-label',
];
const DARK_VARIANT = '@custom-variant dark (&:is(.dark *));';

assert.ok(
  existsSync(FRONTEND_CSS),
  `${FRONTEND_CSS} is missing: run this check from a full checkout of the repository`,
);

const read = (path) => readFileSync(path, 'utf8');

function matchingBrace(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced braces after offset ${open}`);
}

function declarations(body) {
  const vars = new Map();
  for (const part of body.split(';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const name = part.slice(0, colon).trim();
    if (!name.startsWith('--')) continue;
    vars.set(name, part.slice(colon + 1).replace(/\s+/g, ' ').trim());
  }
  return vars;
}

/** Top-level `:root` and `.dark` rules, in source order, with their custom properties. */
function tokenRules(css) {
  // Blank out comments but keep every offset, so a brace in a comment is not code.
  const code = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
  const rules = [];
  let selectorStart = 0;
  for (let i = 0; i < code.length; i += 1) {
    if (code[i] === ';') {
      selectorStart = i + 1; // ends a top-level statement such as @import or @custom-variant
    } else if (code[i] === '{') {
      const selector = code.slice(selectorStart, i).trim();
      const end = matchingBrace(code, i);
      if (selector === ':root' || selector === '.dark') {
        rules.push({ selector, start: i, vars: declarations(code.slice(i + 1, end)) });
      }
      i = end;
      selectorStart = end + 1;
    }
  }
  return rules;
}

const merged = (rules, selector) => {
  const vars = new Map();
  for (const rule of rules) if (rule.selector === selector) for (const [k, v] of rule.vars) vars.set(k, v);
  return vars;
};

const frontendCss = read(FRONTEND_CSS);
const adminCss = read(ADMIN_CSS);
const frontendRules = tokenRules(frontendCss);
const feRoot = merged(frontendRules, ':root');
const feDark = merged(frontendRules, '.dark');
assert.ok(
  feRoot.size >= 55 && feDark.size >= 25,
  `the parser found ${feRoot.size} :root and ${feDark.size} .dark tokens in the frontend; expected at least 55 and 25`,
);

const markerAt = adminCss.indexOf(ADMIN_ONLY_MARKER);
const adminRules = tokenRules(adminCss);
const sharedRules = adminRules.filter((rule) => markerAt === -1 || rule.start < markerAt);
const adminOnlyRules = adminRules.filter((rule) => markerAt !== -1 && rule.start > markerAt);

function differences(label, admin, frontend) {
  const lines = [];
  for (const [name, value] of frontend) {
    if (!admin.has(name)) lines.push(`${label} ${name}: missing in admin (frontend ${value})`);
    else if (admin.get(name) !== value) lines.push(`${label} ${name}: admin ${admin.get(name)} | frontend ${value}`);
  }
  for (const [name, value] of admin) {
    if (!frontend.has(name)) lines.push(`${label} ${name}: not in the frontend (${value}); admin-only tokens go after the ADMIN-ONLY TOKENS marker`);
  }
  return lines;
}

const drift = [
  ...differences(':root', merged(sharedRules, ':root'), feRoot),
  ...differences('.dark', merged(sharedRules, '.dark'), feDark),
];
assert.deepEqual(drift, [], `the admin tokens drifted from the app's (${drift.length}):\n  ${drift.join('\n  ')}`);

assert.ok(frontendCss.includes(DARK_VARIANT) && adminCss.includes(DARK_VARIANT), 'both apps switch dark mode with the same .dark class variant');

assert.notEqual(markerAt, -1, 'globals.css marks its admin-only block');
for (const selector of [':root', '.dark']) {
  assert.deepEqual(
    [...merged(adminOnlyRules, selector).keys()].sort(),
    [...ADMIN_ONLY_NAMES].sort(),
    `the admin-only ${selector} block holds exactly the chart tokens`,
  );
}

// The series colours are the validated palette (dataviz validator, both themes
// against --jale-card; FE-1 plan Task 1 records the run). A changed value needs
// a new validator run, then this list.
const VALIDATED = {
  ':root': ['#0064d6', '#8c3d12', '#168f70', '#6c2cb4', '#836d03', '#9a1366'],
  '.dark': ['#0e6ee6', '#bd4d00', '#29a987', '#894ed6', '#897311', '#db479a'],
};
for (const selector of [':root', '.dark']) {
  const tokens = merged(adminOnlyRules, selector);
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map((n) => tokens.get(`--chart-${n}`)?.toLowerCase()),
    VALIDATED[selector],
    `--chart-1…6 in ${selector} are the validated palette, in order`,
  );
}

// Each series colour reaches 3:1 against the card it is drawn on, in its theme.
function luminance(hex) {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const cards = { ':root': feRoot.get('--jale-card'), '.dark': feDark.get('--jale-card') };
for (const selector of [':root', '.dark']) {
  const tokens = merged(adminOnlyRules, selector);
  for (let n = 1; n <= 6; n += 1) {
    const value = tokens.get(`--chart-${n}`);
    assert.match(value, /^#[0-9a-f]{6}$/i, `--chart-${n} in ${selector} is a 6-digit hex colour`);
    const ratio = contrast(value, cards[selector]);
    assert.ok(ratio >= 3, `--chart-${n} in ${selector} is ${ratio.toFixed(2)}:1 against --jale-card ${cards[selector]}; series colours need 3:1`);
  }
}

console.log(`admin token drift check passed: ${feRoot.size} :root and ${feDark.size} .dark tokens match the app`);
