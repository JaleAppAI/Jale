/**
 * audit-source-scan.ts -- the static reading behind audit-coverage.test.ts and
 * audit-writers.test.ts.
 *
 * It parses every module under infra/lambda with the TypeScript parser and
 * keeps, per module: its relative imports, the text of every string and
 * template literal (a template's substitutions read as `${}`), the names it
 * calls, its top-level declarations with what each references, and whether it
 * is a Lambda entry. What an entry can run is its handler and everything that
 * references, declaration by declaration, through imports, stopping at other
 * entries: a dispatcher's delegates are entries of their own and answer for
 * themselves. Shadowed names are not told apart, which can only add reach.
 *
 * Two classifiers read the SQL literals:
 *   - personalDataReads: a read of a personal-data table;
 *   - coveredWrites: a write that leaves a change record, using
 *     infra/db/access/audit-change-log.json. An UPDATE counts only when it sets
 *     a covered column, because the change-record trigger writes nothing
 *     otherwise; INSERT, DELETE, TRUNCATE and a SET list built at run time
 *     always count. Calls to database functions whose bodies write a covered
 *     table count, and so does a DELETE on a table whose foreign keys cascade
 *     into one.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

export const INFRA_ROOT = path.join(__dirname, '..', '..', '..');
export const LAMBDA_ROOT = path.join(INFRA_ROOT, 'lambda');
const MIGRATIONS_DIR = path.join(INFRA_ROOT, 'db', 'migrations');
const CHANGE_LOG_FILE = path.join(INFRA_ROOT, 'db', 'access', 'audit-change-log.json');

export interface LambdaModule {
  /** Relative to infra/lambda, with forward slashes. */
  readonly file: string;
  readonly imports: readonly string[];
  readonly literals: readonly string[];
  readonly calls: ReadonlySet<string>;
  readonly exportsHandler: boolean;
  readonly usesApiGatewayEvent: boolean;
  /** Top-level declarations by name; `<module>` holds the module's other top-level statements. */
  readonly declarations: ReadonlyMap<string, Declaration>;
  /** Local name of every import to the module and the name it imports (`*` for a namespace, `default`). */
  readonly importBindings: ReadonlyMap<string, { module: string; name: string }>;
  readonly exportBindings: ReadonlyMap<string, ExportBinding>;
  readonly starExports: readonly string[];
}

export interface Declaration {
  readonly key: string;
  readonly literals: readonly string[];
  /** Identifiers the declaration references (shadowing is ignored, which over-approximates). */
  readonly refs: ReadonlySet<string>;
  /** `ns.member` references, for namespace imports. */
  readonly memberRefs: ReadonlyArray<{ ns: string; member: string }>;
}

type ExportBinding = { kind: 'local'; name: string } | { kind: 'reexport'; module: string; name: string };

function listTypeScript(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') out.push(...listTypeScript(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function relative(file: string): string {
  return path.relative(LAMBDA_ROOT, file).split(path.sep).join('/');
}

function resolveImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts'), base]) {
    if (candidate.endsWith('.ts') && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []).some((modifier) => modifier.kind === kind);
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => `\${}${span.literal.text}`).join('');
  }
  return null;
}

function boundNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : boundNames(element.name)));
}

/** True when this identifier names a property, not a binding in scope. */
function isPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent)
      || ts.isPropertySignature(parent) || ts.isMethodSignature(parent) || ts.isGetAccessor(parent)
      || ts.isSetAccessor(parent) || ts.isEnumMember(parent)) && parent.name === node) return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  return false;
}

function parseModule(file: string): LambdaModule {
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const imports = new Set<string>();
  const literals: string[] = [];
  const calls = new Set<string>();
  const declarations = new Map<string, Declaration>();
  const importBindings = new Map<string, { module: string; name: string }>();
  const exportBindings = new Map<string, ExportBinding>();
  const starExports: string[] = [];
  let usesApiGatewayEvent = false;

  const resolved = (specifier: string): string | null => {
    const target = resolveImport(file, specifier);
    if (!target) return null;
    const rel = relative(target);
    imports.add(rel);
    return rel;
  };

  /** Collects literals, references and calls under `root` into one declaration. */
  const declare = (key: string, roots: ts.Node[]): void => {
    const existing = declarations.get(key);
    const declLiterals = existing ? [...existing.literals] : [];
    const refs = new Set(existing?.refs ?? []);
    const memberRefs = existing ? [...existing.memberRefs] : [];
    const visit = (node: ts.Node): void => {
      const literal = literalText(node);
      if (literal !== null) {
        declLiterals.push(literal);
        literals.push(literal);
      }
      if (ts.isIdentifier(node) && !isPropertyName(node)) refs.add(node.text);
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        memberRefs.push({ ns: node.expression.text, member: node.name.text });
      }
      if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)
          && /^APIGatewayProxyEvent(V2)?$/.test(node.typeName.text)) {
        usesApiGatewayEvent = true;
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isIdentifier(callee)) calls.add(callee.text);
        if (ts.isPropertyAccessExpression(callee)) calls.add(callee.name.text);
        const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
        const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
        const [first] = node.arguments;
        if ((isRequire || isDynamicImport) && first && ts.isStringLiteralLike(first)) {
          const target = resolved(first.text);
          // A require() binds nothing by name here; the whole module is reachable from this declaration.
          if (target) refs.add(`\u0000require:${target}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    for (const root of roots) visit(root);
    declarations.set(key, { key, literals: declLiterals, refs, memberRefs });
  };

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const target = resolved(statement.moduleSpecifier.text);
      const clause = statement.importClause;
      if (!target || !clause) continue;
      if (clause.name) importBindings.set(clause.name.text, { module: target, name: 'default' });
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) importBindings.set(bindings.name.text, { module: target, name: '*' });
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          importBindings.set(element.name.text, { module: target, name: (element.propertyName ?? element.name).text });
        }
      }
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      const target = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        ? resolved(statement.moduleSpecifier.text)
        : null;
      if (statement.moduleSpecifier && !target) continue;
      if (!statement.exportClause) {
        if (target) starExports.push(target);
      } else if (ts.isNamespaceExport(statement.exportClause)) {
        if (target) exportBindings.set(statement.exportClause.name.text, { kind: 'reexport', module: target, name: '*' });
      } else {
        for (const element of statement.exportClause.elements) {
          const local = (element.propertyName ?? element.name).text;
          exportBindings.set(element.name.text, target
            ? { kind: 'reexport', module: target, name: local }
            : { kind: 'local', name: local });
        }
      }
      continue;
    }
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      const name = statement.name?.text ?? 'default';
      declare(name, [statement]);
      if (exported) exportBindings.set(isDefault ? 'default' : name, { kind: 'local', name });
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const names = boundNames(declaration.name);
        const key = names.join(',');
        declare(key, [declaration]);
        for (const name of names) {
          if (key !== name) declarations.set(name, declarations.get(key)!);
          if (exported) exportBindings.set(name, { kind: 'local', name });
        }
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      declare('default', [statement.expression]);
      exportBindings.set('default', { kind: 'local', name: 'default' });
      continue;
    }
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      declare(`type:${statement.name.text}`, [statement]);
      continue;
    }
    if (ts.isEnumDeclaration(statement)) {
      declare(statement.name.text, [statement]);
      if (exported) exportBindings.set(statement.name.text, { kind: 'local', name: statement.name.text });
      continue;
    }
    declare('<module>', [statement]);
  }

  return {
    file: relative(file),
    imports: [...imports].sort(),
    literals,
    calls,
    exportsHandler: exportBindings.has('handler'),
    usesApiGatewayEvent,
    declarations,
    importBindings,
    exportBindings,
    starExports,
  };
}

let cachedModules: Map<string, LambdaModule> | undefined;

/** Every TypeScript module under infra/lambda, keyed by its relative path. */
export function lambdaModules(): Map<string, LambdaModule> {
  cachedModules ??= new Map(listTypeScript(LAMBDA_ROOT).map((file) => {
    const parsed = parseModule(file);
    return [parsed.file, parsed];
  }));
  return cachedModules;
}

/** Every Lambda entry module: it exports `handler`. */
export function entryModules(): LambdaModule[] {
  return [...lambdaModules().values()].filter((m) => m.exportsHandler).sort((a, b) => a.file.localeCompare(b.file));
}

/** API Gateway handlers: entries typed with the API Gateway event, plus every entry under api/ (the dispatchers). */
export function apiHandlerModules(): LambdaModule[] {
  return entryModules().filter((m) => m.usesApiGatewayEvent || m.file.startsWith('api/'));
}

/** The modules an entry imports, transitively, stopping at other entries. */
export function reach(entry: LambdaModule): LambdaModule[] {
  const modules = lambdaModules();
  const seen = new Set<string>([entry.file]);
  const queue = [entry.file];
  const out: LambdaModule[] = [];
  while (queue.length > 0) {
    const current = modules.get(queue.shift()!);
    if (!current) continue;
    out.push(current);
    for (const imported of current.imports) {
      if (seen.has(imported)) continue;
      seen.add(imported);
      const next = modules.get(imported);
      if (next && !next.exportsHandler) queue.push(imported);
    }
  }
  return out;
}

/** A declaration in a module: `module#name`. */
type NodeKey = string;

function nodeKey(module: string, name: string): NodeKey {
  return `${module}#${name}`;
}

/** The declarations an export resolves to (all of them for a namespace). */
function resolveExport(module: string, name: string, seen = new Set<string>()): NodeKey[] {
  const key = `${module}:${name}`;
  if (seen.has(key)) return [];
  seen.add(key);
  const target = lambdaModules().get(module);
  if (!target) return [];
  if (name === '*') {
    return [...target.exportBindings.keys()].flatMap((exported) => resolveExport(module, exported, seen));
  }
  const binding = target.exportBindings.get(name);
  if (binding?.kind === 'reexport') return resolveExport(binding.module, binding.name, seen);
  if (binding?.kind === 'local') return resolveLocal(target, binding.name, seen);
  for (const star of target.starExports) {
    const found = resolveExport(star, name, seen);
    if (found.length > 0) return found;
  }
  return [];
}

function resolveLocal(module: LambdaModule, name: string, seen = new Set<string>()): NodeKey[] {
  if (module.declarations.has(name)) return [nodeKey(module.file, module.declarations.get(name)!.key)];
  const imported = module.importBindings.get(name);
  if (imported) return resolveExport(imported.module, imported.name, seen);
  return [];
}

/**
 * The declarations an entry can run: its handler and module statements, then
 * every declaration they reference, through imports, stopping at other
 * entries. Each reached module's own top-level statements run on load.
 */
export function reachableDeclarations(entry: LambdaModule): Array<{ module: string; declaration: Declaration }> {
  const modules = lambdaModules();
  const seen = new Set<NodeKey>();
  const queue: NodeKey[] = [...resolveExport(entry.file, 'handler'), nodeKey(entry.file, '<module>')];
  const out: Array<{ module: string; declaration: Declaration }> = [];
  while (queue.length > 0) {
    const key = queue.shift()!;
    if (seen.has(key)) continue;
    seen.add(key);
    const hash = key.lastIndexOf('#');
    const file = key.slice(0, hash);
    const module = modules.get(file);
    if (!module || (module.exportsHandler && file !== entry.file)) continue;
    const declaration = module.declarations.get(key.slice(hash + 1));
    queue.push(nodeKey(file, '<module>'));
    if (!declaration) continue;
    out.push({ module: file, declaration });
    for (const ref of declaration.refs) {
      if (ref.startsWith('\u0000require:')) {
        const required = ref.slice('\u0000require:'.length);
        queue.push(...resolveExport(required, '*'), nodeKey(required, '<module>'));
        continue;
      }
      queue.push(...resolveLocal(module, ref));
    }
    for (const { ns, member } of declaration.memberRefs) {
      const imported = module.importBindings.get(ns);
      if (imported?.name === '*') queue.push(...resolveExport(imported.module, member));
    }
  }
  return out;
}

// ── Personal-data reads ──────────────────────────────────────────────────

/** Tables whose rows are personal data in full. */
export const PERSONAL_DATA_TABLES = [
  'worker_documents',
  'job_conversation_messages',
  'worker_trust_assessments',
  'worker_trust_extractions',
  'worker_profile_ai_extractions',
  'worker_profiles',
] as const;

const READ_FROM = (table: string): RegExp =>
  new RegExp(`(?<!\\bDELETE\\s+)\\bFROM\\s+(?:ONLY\\s+)?(?:public\\.)?${table}\\b|\\bJOIN\\s+(?:public\\.)?${table}\\b`, 'i');

/** What a SQL text reads that is personal data, by table (or table and columns). */
export function personalDataReads(sql: string): string[] {
  const found: string[] = [];
  for (const table of PERSONAL_DATA_TABLES) {
    if (READ_FROM(table).test(sql)) found.push(table);
  }
  if (READ_FROM('job_applications').test(sql) && /\bapplication_answers\b/i.test(sql)) {
    found.push('job_applications.application_answers');
  }
  if (READ_FROM('users').test(sql) && /\b(?:phone|email|whatsapp_number)\b/i.test(sql)) {
    found.push('users contact columns');
  }
  return found;
}

/**
 * The personal-data reads an entry can run, as `module: what`: in its own SQL,
 * and inside the database functions that SQL calls.
 */
export function personalDataReadsOf(entry: LambdaModule): string[] {
  const out = new Set<string>();
  for (const { module, declaration } of reachableDeclarations(entry)) {
    for (const literal of declaration.literals) {
      for (const what of personalDataReads(literal)) out.add(`${module}: ${what}`);
      for (const what of personalDataReadsThroughFunctions(literal)) out.add(`${module}: ${what}`);
    }
  }
  return [...out].sort();
}

// ── Covered writes ───────────────────────────────────────────────────────

export interface ChangeLogTables {
  /** Table name (no schema) to its covered columns. */
  readonly columns: ReadonlyMap<string, ReadonlySet<string>>;
}

export function loadChangeLogTables(): ChangeLogTables {
  const parsed = JSON.parse(fs.readFileSync(CHANGE_LOG_FILE, 'utf8')) as {
    tables: Record<string, { columns: string[] }>;
  };
  const columns = new Map<string, Set<string>>();
  for (const [qualified, entry] of Object.entries(parsed.tables)) {
    const [schema, table] = qualified.split('.');
    if (schema !== 'public') throw new Error(`change log: unexpected schema in ${qualified}`);
    columns.set(table, new Set(entry.columns));
  }
  return { columns };
}

/**
 * Tables that are not in the change log but whose foreign keys cascade (or
 * set null) into one, so a DELETE on them changes covered rows.
 * d-app-cascade-parents.integration.test.ts checks this list against the
 * catalog.
 */
export const CASCADE_PARENTS: readonly string[] = ['jobs', 'whatsapp_conversations'];

/** Splits a SET list at its top-level commas, up to the clause that ends it. */
function setAssignments(sql: string, start: number): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < sql.length; i += 1) {
    const ch = sql[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') {
      if (depth === 0) break;
      depth -= 1;
    }
    if (depth === 0) {
      if (ch === ';') break;
      if (ch === ',') {
        parts.push(current);
        current = '';
        continue;
      }
      const keyword = /^\s(WHERE|FROM|RETURNING)\b/i.exec(sql.slice(i));
      if (keyword && !(keyword[1].toUpperCase() === 'FROM' && /\bDISTINCT\s*$/i.test(current))) break;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** The columns an UPDATE's SET list assigns; null when a target is built at run time. */
function setTargets(sql: string, start: number): string[] | null {
  const targets: string[] = [];
  for (const assignment of setAssignments(sql, start)) {
    const lhs = assignment.split('=')[0] ?? '';
    if (lhs.includes('${}')) return null;
    const multi = /^\s*\(([^)]*)\)\s*$/.exec(lhs);
    if (multi) {
      targets.push(...multi[1].split(',').map((name) => name.trim().replace(/"/g, '').toLowerCase()));
      continue;
    }
    const single = /^\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s*(?:\[[^\]]*\]|\.[A-Za-z_][A-Za-z0-9_]*)?\s*$/.exec(lhs);
    if (!single) return null;
    targets.push(single[1].toLowerCase());
  }
  return targets;
}

export interface CoveredWrite {
  readonly table: string;
  readonly how: 'insert' | 'update' | 'delete' | 'truncate' | 'cascade' | 'function';
  readonly detail: string;
}

/** The covered writes a SQL text performs directly (no function calls). */
export function directCoveredWrites(sql: string, log: ChangeLogTables): CoveredWrite[] {
  const out: CoveredWrite[] = [];
  const tableRef = '(?:ONLY\\s+)?(?:public\\.)?([A-Za-z_][A-Za-z0-9_]*)';
  for (const m of sql.matchAll(new RegExp(`\\bINSERT\\s+INTO\\s+${tableRef}`, 'gi'))) {
    const table = m[1].toLowerCase();
    if (log.columns.has(table)) out.push({ table, how: 'insert', detail: 'INSERT' });
  }
  for (const m of sql.matchAll(new RegExp(`\\bDELETE\\s+FROM\\s+${tableRef}`, 'gi'))) {
    const table = m[1].toLowerCase();
    if (log.columns.has(table)) out.push({ table, how: 'delete', detail: 'DELETE' });
    else if (CASCADE_PARENTS.includes(table)) out.push({ table, how: 'cascade', detail: 'DELETE cascades into a covered table' });
  }
  for (const m of sql.matchAll(new RegExp(`\\bTRUNCATE\\s+(?:TABLE\\s+)?${tableRef}`, 'gi'))) {
    const table = m[1].toLowerCase();
    if (log.columns.has(table) || CASCADE_PARENTS.includes(table)) out.push({ table, how: 'truncate', detail: 'TRUNCATE' });
  }
  const update = new RegExp(`\\bUPDATE\\s+${tableRef}(?:\\s+(?:AS\\s+)?(?!SET\\b)[A-Za-z_][A-Za-z0-9_]*)?\\s+SET\\s`, 'gi');
  for (const m of sql.matchAll(update)) {
    const table = m[1].toLowerCase();
    const covered = log.columns.get(table);
    if (!covered) continue;
    const targets = setTargets(sql, (m.index ?? 0) + m[0].length);
    if (targets === null) {
      out.push({ table, how: 'update', detail: 'UPDATE with a SET list built at run time' });
      continue;
    }
    const hits = targets.filter((column) => covered.has(column));
    if (hits.length > 0) out.push({ table, how: 'update', detail: `UPDATE sets ${hits.join(', ')}` });
  }
  return out;
}

interface FunctionBody {
  readonly name: string;
  readonly body: string;
  readonly migration: string;
}

/** The latest body of every SQL function the migrations define, by schema-qualified name. */
function migrationFunctions(): Map<string, FunctionBody> {
  const out = new Map<string, FunctionBody>();
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
  const create = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:([A-Za-z_][A-Za-z0-9_]*)\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi;
  for (const migration of files) {
    const text = fs.readFileSync(path.join(MIGRATIONS_DIR, migration), 'utf8');
    for (const m of text.matchAll(create)) {
      const after = text.slice((m.index ?? 0) + m[0].length);
      const quote = /\bAS\s+(\$[A-Za-z_]*\$)/i.exec(after);
      if (!quote) continue;
      const bodyStart = quote.index + quote[0].length;
      const bodyEnd = after.indexOf(quote[1], bodyStart);
      if (bodyEnd < 0) continue;
      const name = `${(m[1] ?? 'public').toLowerCase()}.${m[2].toLowerCase()}`;
      out.set(name, { name, body: after.slice(bodyStart, bodyEnd), migration });
    }
  }
  return out;
}

const FUNCTION_CALL = /\b(?:([A-Za-z_][A-Za-z0-9_]*)\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

function calledFunctions(sql: string): string[] {
  return [...sql.matchAll(FUNCTION_CALL)].map((m) => `${(m[1] ?? 'public').toLowerCase()}.${m[2].toLowerCase()}`);
}

let cachedWriters: Map<string, CoveredWrite[]> | undefined;

/**
 * Database functions whose bodies write a covered table, directly or through
 * another such function, with what they write.
 */
export function writerFunctions(log: ChangeLogTables = loadChangeLogTables()): Map<string, CoveredWrite[]> {
  if (cachedWriters) return cachedWriters;
  const functions = migrationFunctions();
  const writers = new Map<string, CoveredWrite[]>();
  for (const fn of functions.values()) {
    const writes = directCoveredWrites(fn.body, log);
    if (writes.length > 0) writers.set(fn.name, writes);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of functions.values()) {
      if (writers.has(fn.name)) continue;
      const via = calledFunctions(fn.body).find((called) => called !== fn.name && writers.has(called));
      if (via) {
        writers.set(fn.name, [{ table: writers.get(via)![0].table, how: 'function', detail: `calls ${via}` }]);
        changed = true;
      }
    }
  }
  cachedWriters = writers;
  return writers;
}

/** Every covered write a SQL text performs, directly or through a function call. */
export function coveredWrites(sql: string, log: ChangeLogTables = loadChangeLogTables()): CoveredWrite[] {
  const out = directCoveredWrites(sql, log);
  const writers = writerFunctions(log);
  for (const called of calledFunctions(sql)) {
    const writes = writers.get(called);
    if (writes) out.push({ table: writes[0].table, how: 'function', detail: `${called} writes ${writes.map((w) => w.table).join(', ')}` });
  }
  return out;
}

// ── Personal-data reads inside database functions ────────────────────────

let cachedReaders: Map<string, string[]> | undefined;

/**
 * Database functions whose latest bodies read personal data, directly or
 * through another such function, with what they read. A read that stays
 * inside a function is still a read the handler causes; whether anything
 * personal comes back to the handler is the exclusion list's question.
 */
function readerFunctions(): Map<string, string[]> {
  if (cachedReaders) return cachedReaders;
  const functions = migrationFunctions();
  const readers = new Map<string, Set<string>>();
  for (const fn of functions.values()) {
    const reads = personalDataReads(fn.body);
    if (reads.length > 0) readers.set(fn.name, new Set(reads));
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of functions.values()) {
      const reads = new Set(readers.get(fn.name) ?? []);
      const before = reads.size;
      for (const called of calledFunctions(fn.body)) {
        if (called === fn.name) continue;
        for (const what of readers.get(called) ?? []) reads.add(what);
      }
      if (reads.size > before) {
        readers.set(fn.name, reads);
        changed = true;
      }
    }
  }
  cachedReaders = new Map([...readers].map(([name, reads]) => [name, [...reads].sort()]));
  return cachedReaders;
}

/** What a SQL text reads that is personal data inside the database functions it calls. */
export function personalDataReadsThroughFunctions(sql: string): string[] {
  const readers = readerFunctions();
  const out = new Set<string>();
  for (const called of calledFunctions(sql)) {
    for (const what of readers.get(called) ?? []) out.add(`${what} (inside ${called})`);
  }
  return [...out].sort();
}

/** The covered writes an entry can run, as `module: table (how)`. */
export function coveredWritesOf(entry: LambdaModule, log: ChangeLogTables = loadChangeLogTables()): string[] {
  const out = new Set<string>();
  for (const { module, declaration } of reachableDeclarations(entry)) {
    for (const literal of declaration.literals) {
      for (const write of coveredWrites(literal, log)) out.add(`${module}: ${write.table} (${write.detail})`);
    }
  }
  return [...out].sort();
}

export interface CoveredWriteSite {
  readonly module: string;
  readonly declaration: string;
  readonly writes: readonly string[];
}

/** Each declaration an entry can run that performs a covered write. */
export function coveredWriteSites(entry: LambdaModule, log: ChangeLogTables = loadChangeLogTables()): CoveredWriteSite[] {
  const sites: CoveredWriteSite[] = [];
  for (const { module, declaration } of reachableDeclarations(entry)) {
    const writes = declaration.literals.flatMap((literal) => coveredWrites(literal, log).map((w) => `${w.table} (${w.detail})`));
    if (writes.length === 0) continue;
    sites.push({
      module,
      declaration: declaration.key,
      writes: [...new Set(writes)].sort(),
    });
  }
  return sites;
}
