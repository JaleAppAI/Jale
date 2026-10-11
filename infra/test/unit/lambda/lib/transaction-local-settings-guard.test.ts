import * as fs from 'node:fs';
import * as path from 'node:path';

// Static guard: request and job code sets the caller context
// (app.current_user_id, app.current_internal_user_id and any other setting)
// ONLY transaction-locally, with set_config(name, value, true) inside an
// explicit transaction. A session-level setting outlives the request on a
// pooled connection and would be read by the next request that reuses it, so
// any set_config whose third argument is not the literal `true`, and any bare
// `SET app.` or `SET SESSION` statement, fails this test.

const LAMBDA_ROOT = path.join(__dirname, '..', '..', '..', '..', 'lambda');

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|js|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Splits the argument list that starts right after an opening parenthesis at
 * `start` into its top-level arguments. Commas inside nested parentheses or
 * quotes do not split. Returns null when the call is never closed.
 */
function topLevelArguments(text: string, start: number): string[] | null {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === ')') {
      if (depth === 0) {
        args.push(current);
        return args;
      }
      depth -= 1;
      current += ch;
      continue;
    }
    if (ch === ',' && depth === 0) {
      args.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  return null;
}

interface SettingViolation {
  line: number;
  kind: 'set_config_not_transaction_local' | 'bare_set_statement';
  excerpt: string;
}

/**
 * Blanks every comment line (`//`, `/*` or a `*` continuation) so prose such
 * as "set_config() instead of SET LOCAL" is not read as a call. Line numbers
 * are preserved. SQL never starts a line with those characters.
 */
function withoutCommentLines(text: string): string {
  return text
    .split('\n')
    .map((line) => (/^\s*(\/\/|\/\*|\*)/.test(line) ? '' : line))
    .join('\n');
}

/** Every session-level setting form in `source`, with its 1-based line. */
function findSessionLevelSettings(source: string): SettingViolation[] {
  const text = withoutCommentLines(source);
  const violations: SettingViolation[] = [];
  const lineOf = (index: number) => text.slice(0, index).split('\n').length;

  const call = /set_config\s*\(/gi;
  for (let match = call.exec(text); match; match = call.exec(text)) {
    const args = topLevelArguments(text, match.index + match[0].length);
    const third = args && args.length === 3 ? args[2].trim().toLowerCase() : null;
    if (third !== 'true') {
      violations.push({
        line: lineOf(match.index),
        kind: 'set_config_not_transaction_local',
        excerpt: text.slice(match.index, match.index + 80).split('\n')[0],
      });
    }
  }

  const bare = /\bSET\s+(SESSION\b|"?app\.)/gi;
  for (let match = bare.exec(text); match; match = bare.exec(text)) {
    violations.push({
      line: lineOf(match.index),
      kind: 'bare_set_statement',
      excerpt: text.slice(match.index, match.index + 80).split('\n')[0],
    });
  }
  return violations;
}

describe('the setting detector itself', () => {
  it('flags a session-level set_config, a non-literal flag and bare SET forms', () => {
    const sample = [
      "await client.query(`SELECT set_config('app.current_internal_user_id', $1, false)`, [id]);",
      "await client.query(`SELECT set_config('app.current_user_id', $1, $2)`, [sub, local]);",
      "await client.query(`SELECT set_config('app.x', $1)`, [v]);",
      "await client.query('SET app.current_user_id = 1');",
      "await client.query('set session authorization other');",
      "await client.query('SET \"app.current_user_id\" TO 1');",
    ].join('\n');
    const found = findSessionLevelSettings(sample);
    expect(found.map((v) => [v.line, v.kind])).toEqual([
      [1, 'set_config_not_transaction_local'],
      [2, 'set_config_not_transaction_local'],
      [3, 'set_config_not_transaction_local'],
      [4, 'bare_set_statement'],
      [5, 'bare_set_statement'],
      [6, 'bare_set_statement'],
    ]);
  });

  it('accepts the transaction-local form, including across lines and with nested calls', () => {
    const sample = [
      "await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [sub]);",
      'await client.query(',
      "  `SELECT set_config('app.current_internal_user_id', coalesce($1, ''), TRUE)`,",
      '  [id],',
      ');',
      '// SET LOCAL is what set_config(..., true) mirrors.',
    ].join('\n');
    expect(findSessionLevelSettings(sample)).toEqual([]);
  });
});

describe('infra/lambda sets caller context transaction-locally only', () => {
  it('has no session-level set_config and no bare SET app. / SET SESSION anywhere', () => {
    const files = listSourceFiles(LAMBDA_ROOT);
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.flatMap((file) =>
      findSessionLevelSettings(fs.readFileSync(file, 'utf8')).map(
        (v) => `${path.relative(LAMBDA_ROOT, file)}:${v.line} ${v.kind}: ${v.excerpt}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
