/**
 * audit-writers.test.ts -- every Lambda that writes a change-log table states
 * its actor first.
 *
 * The change-record triggers name the actor from the audit context of the
 * transaction the write runs in. So every covered write (see
 * audit-source-scan.ts for what counts) that a Lambda entry can reach must run
 * in a transaction that has already called setAuditContext, or the entry is on
 * the exclusion list below with its reason. The transaction walk below checks
 * this write by write: an entry that states the context in one transaction
 * and writes in another does not pass. Scheduled and queue jobs are excluded
 * by design: each runs on a dedicated job login, which the change record
 * names, and the audit context has no job channel.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import {
  CASCADE_PARENTS,
  LAMBDA_ROOT,
  coveredWrites,
  coveredWriteSites,
  coveredWritesOf,
  directCoveredWrites,
  entryModules,
  lambdaModules,
  loadChangeLogTables,
  reach,
  writerFunctions,
  type ChangeLogTables,
} from './audit-source-scan';

/** Lambda entries that reach a covered write and set no context, with the reason. */
const WRITER_EXCLUSIONS: Readonly<Record<string, string>> = {
  // Queue and scheduled jobs on a login of their own: the login names the
  // writer, and the audit context has no job channel to state.
  'billing/processor.ts': 'The billing event queue job, on its own database login (jale_billing); the login identifies the writer and the audit context has no job channel.',
};

const log = loadChangeLogTables();

// ── The transaction walk ────────────────────────────────────────────────────
//
// For one entry, the walk runs the handler from "no transaction" and follows
// the transaction state through the code:
//   - `.query('BEGIN')` (or START TRANSACTION) opens a transaction, and
//     `.query('COMMIT' | 'END' | 'ROLLBACK' | 'ABORT')` closes it. SAVEPOINT
//     and RELEASE leave it as it is; ROLLBACK TO SAVEPOINT keeps it open but
//     returns to the state the savepoint was taken in, since it undoes a
//     context stated after the savepoint (when the savepoint was taken in
//     another function, the state is left as it is);
//   - setAuditContext states the context of the open transaction, and is lost
//     outside one;
//   - branches join, a return or a throw ends its path, a catch (and a
//     finally) can start from any state its try passed through, and loops run
//     to a fixed point;
//   - a call runs the callee from the caller's state, and the caller goes on
//     from the state the callee leaves (a helper that commits closes the
//     caller's transaction). A function that is only referenced, such as a
//     dependency handed to an engine or a callback, is run from the state at
//     the reference, as the source scan assumes. A named local function runs
//     where it is called or referenced, never where it is defined;
//   - a declaration that is not a function (a SQL constant, an object of
//     methods) is read from the state at the reference, and a module's own
//     top-level statements run from "no transaction", when it loads.
// A covered write is the SQL literal that performs it. It passes only when
// every state that reaches it is an open transaction whose context is stated.
// Like the source scan, the walk stops at other entries and does not tell
// shadowed names apart, which can only add paths.

/** Outside any transaction; in an open one that has not stated the context; in one that has. */
type Txn = 'none' | 'open' | 'stated';
type States = ReadonlySet<Txn>;

const NO_STATES: States = new Set<Txn>();
const TXN_OPEN = /^\s*(?:BEGIN|START\s+TRANSACTION)\b/i;
// A savepoint's name may be a template substitution, which reads as `${}`.
const SAVEPOINT_NAME = String.raw`(\$\{\}|"?[A-Za-z_][A-Za-z0-9_$]*)`;
const TXN_SAVEPOINT = new RegExp(String.raw`^\s*SAVEPOINT\s+` + SAVEPOINT_NAME, 'i');
const TXN_ROLLBACK_TO = new RegExp(String.raw`^\s*ROLLBACK\s+(?:(?:WORK|TRANSACTION)\s+)?TO\s+(?:SAVEPOINT\s+)?` + SAVEPOINT_NAME, 'i');
const TXN_CLOSE = /^\s*(?:COMMIT|END|ABORT|ROLLBACK(?!\s+(?:(?:WORK|TRANSACTION)\s+)?TO\b))\b/i;

const STATE_WORDS: Readonly<Record<Exclude<Txn, 'stated'>, string>> = {
  none: 'outside any transaction',
  open: 'in a transaction that has not stated the context',
};

/** The sources a walk reads. Module paths are relative to infra/lambda, with forward slashes. */
interface WalkProgram {
  source(file: string): ts.SourceFile | undefined;
  /** The module a relative import specifier resolves to, or null. */
  resolve(from: string, specifier: string): string | null;
}

interface WalkModule {
  readonly file: string;
  readonly isEntry: boolean;
  /** Top-level declarations by each name they bind. */
  readonly locals: ReadonlyMap<string, ts.Node>;
  /** Local import names to the module and the name they import (`*` for a namespace). */
  readonly imports: ReadonlyMap<string, { module: string; name: string }>;
  /** Exported names to a local name (`module` null) or to a re-exported one. */
  readonly exports: ReadonlyMap<string, { module: string | null; name: string }>;
  readonly starExports: readonly string[];
  /** The other top-level statements: they run when the module loads. */
  readonly onLoad: readonly ts.Statement[];
}

interface WalkFinding {
  /** `module#declaration`, the source scan's name for the declaration holding the SQL. */
  readonly site: string;
  readonly write: string;
  readonly state: Exclude<Txn, 'stated'>;
}

interface WalkResult {
  readonly findings: readonly WalkFinding[];
  /** Every `module#declaration` whose covered write the walk reached from some state. */
  readonly classified: ReadonlySet<string>;
}

type FunctionNode = (
  ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration
  | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration | ts.ConstructorDeclaration
) & { readonly body: ts.ConciseBody };

function isFunctionNode(node: ts.Node): node is FunctionNode {
  return (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
    || ts.isConstructorDeclaration(node)) && node.body !== undefined;
}

function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
      || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) {
    node = node.expression;
  }
  return node;
}

/** True for a function that a local `const name = …` binds: it runs where that name is called or referenced. */
function isNamedLocal(fn: FunctionNode): boolean {
  let holder: ts.Node = fn.parent;
  while (ts.isParenthesizedExpression(holder) || ts.isAsExpression(holder) || ts.isSatisfiesExpression(holder)
      || ts.isNonNullExpression(holder) || ts.isTypeAssertionExpression(holder)) {
    holder = holder.parent;
  }
  return ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name);
}

/** The function a declaration names: a function declaration, or a variable initialised with one. */
function declaredFunction(node: ts.Node): FunctionNode | null {
  if (isFunctionNode(node)) return node;
  if (ts.isVariableDeclaration(node) && node.initializer) {
    const init = unwrap(node.initializer);
    if (isFunctionNode(init)) return init;
  }
  return null;
}

/** The text of a string or template literal, a template's substitutions reading as `${}` (as the source scan reads them). */
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

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []).some((modifier) => modifier.kind === kind);
}

/** The top-level statement holding `node`, or the variable declaration when it is a top-level variable statement. */
function topLevelOf(node: ts.Node): ts.Node {
  let current = node;
  while (current.parent && !ts.isSourceFile(current.parent)) {
    const list = current.parent;
    if (ts.isVariableDeclaration(current) && ts.isVariableDeclarationList(list)
        && ts.isVariableStatement(list.parent) && ts.isSourceFile(list.parent.parent)) return current;
    current = list;
  }
  return current;
}

/** The source scan's key for a top-level declaration. */
function declarationKey(top: ts.Node): string {
  if (ts.isVariableDeclaration(top)) return boundNames(top.name).join(',');
  if (ts.isFunctionDeclaration(top) || ts.isClassDeclaration(top)) return top.name?.text ?? 'default';
  if (ts.isEnumDeclaration(top)) return top.name.text;
  if (ts.isExportAssignment(top)) return 'default';
  if (ts.isInterfaceDeclaration(top) || ts.isTypeAliasDeclaration(top)) return `type:${top.name.text}`;
  return '<module>';
}

/** The named functions declared inside a top-level declaration, by name. */
function localFunctions(top: ts.Node): Map<string, FunctionNode[]> {
  const out = new Map<string, FunctionNode[]>();
  const add = (name: string, fn: FunctionNode): void => { out.set(name, [...(out.get(name) ?? []), fn]); };
  const visit = (node: ts.Node): void => {
    if (node !== top) {
      if (ts.isFunctionDeclaration(node) && node.name && isFunctionNode(node)) add(node.name.text, node);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const init = unwrap(node.initializer);
        if (isFunctionNode(init)) add(node.name.text, init);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(top);
  return out;
}

/** True when this identifier is read as a value, not a name being declared or a property name. */
function isReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent)
      || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent) || ts.isEnumMember(parent)
      || ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)
      || ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent)
      || ts.isClassExpression(parent) || ts.isPropertySignature(parent) || ts.isMethodSignature(parent))
      && (parent as { name?: ts.Node }).name === node) return false;
  if ((ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) && parent.label === node) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  return true;
}

function readModule(program: WalkProgram, file: string): WalkModule | null {
  const source = program.source(file);
  if (!source) return null;
  const locals = new Map<string, ts.Node>();
  const imports = new Map<string, { module: string; name: string }>();
  const exports = new Map<string, { module: string | null; name: string }>();
  const starExports: string[] = [];
  const onLoad: ts.Statement[] = [];
  const declare = (name: string, node: ts.Node, exported: boolean, exportedAs = name): void => {
    // An overloaded function keeps the declaration with the body.
    if (!locals.has(name) || declaredFunction(node)) locals.set(name, node);
    if (exported) exports.set(exportedAs, { module: null, name });
  };
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      const target = ts.isStringLiteral(statement.moduleSpecifier) ? program.resolve(file, statement.moduleSpecifier.text) : null;
      if (!target || !clause || clause.isTypeOnly) continue;
      if (clause.name) imports.set(clause.name.text, { module: target, name: 'default' });
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) imports.set(bindings.name.text, { module: target, name: '*' });
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (!element.isTypeOnly) imports.set(element.name.text, { module: target, name: (element.propertyName ?? element.name).text });
        }
      }
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      const target = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        ? program.resolve(file, statement.moduleSpecifier.text)
        : null;
      if (statement.moduleSpecifier && !target) continue;
      if (!statement.exportClause) {
        if (target) starExports.push(target);
      } else if (ts.isNamespaceExport(statement.exportClause)) {
        if (target) exports.set(statement.exportClause.name.text, { module: target, name: '*' });
      } else {
        for (const element of statement.exportClause.elements) {
          exports.set(element.name.text, { module: target, name: (element.propertyName ?? element.name).text });
        }
      }
      continue;
    }
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      const name = statement.name?.text ?? 'default';
      declare(name, statement, exported, isDefault ? 'default' : name);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of boundNames(declaration.name)) declare(name, declaration, exported);
      }
    } else if (ts.isEnumDeclaration(statement)) {
      declare(statement.name.text, statement, exported);
    } else if (ts.isExportAssignment(statement)) {
      declare('default', statement, true);
    } else if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) {
      onLoad.push(statement);
    }
  }
  return { file, isEntry: exports.has('handler'), locals, imports, exports, starExports, onLoad };
}

/** The parsed modules a walk reads, shared by the walks over one program. */
class WalkSources {
  private readonly modules = new Map<string, WalkModule | null>();
  private readonly tops = new Map<ts.Node, { file: string; key: string; functions: Map<string, FunctionNode[]> }>();

  constructor(readonly program: WalkProgram) {}

  module(file: string): WalkModule | null {
    if (!this.modules.has(file)) this.modules.set(file, readModule(this.program, file));
    return this.modules.get(file)!;
  }

  /** The top-level declaration holding `node`: its module, its source-scan key and its named local functions. */
  top(node: ts.Node): { file: string; key: string; functions: Map<string, FunctionNode[]> } {
    const top = topLevelOf(node);
    let found = this.tops.get(top);
    if (!found) {
      found = { file: top.getSourceFile().fileName, key: declarationKey(top), functions: localFunctions(top) };
      this.tops.set(top, found);
    }
    return found;
  }
}

interface WalkSummary {
  /** The states the function can return in. */
  readonly exits: States;
  /** Every state the function passes through, which is where an error it throws can leave it. */
  readonly seen: States;
}

interface WalkFrame {
  readonly module: WalkModule;
  readonly top: { file: string; key: string; functions: Map<string, FunctionNode[]> };
  readonly returns: Set<Txn>;
  readonly seen: Set<Txn>;
  /** For each enclosing try (innermost last), the states an error can leave it in. */
  readonly catching: Set<Txn>[];
  readonly jumps: Array<{ loop: boolean; breaks: Set<Txn>; continues: Set<Txn> }>;
  /** The states each savepoint (by lower-cased name) was taken in, in this function. */
  readonly savepoints: Map<string, Set<Txn>>;
}

function union(...sets: States[]): Set<Txn> {
  const out = new Set<Txn>();
  for (const set of sets) for (const state of set) out.add(state);
  return out;
}

/** Walks one entry. See the comment above `Txn`. */
function walkEntry(sources: WalkSources, entryFile: string, changeLog: ChangeLogTables): WalkResult {
  const findings = new Map<string, WalkFinding>();
  const classified = new Set<string>();
  const summaries = new Map<FunctionNode, Map<Txn, WalkSummary | 'running'>>();
  const read = new Map<ts.Node, Set<Txn>>();
  const loaded = new Set<string>();

  const unchanged = (state: Txn): WalkSummary => ({ exits: new Set([state]), seen: new Set([state]) });

  function frameFor(node: ts.Node): WalkFrame | null {
    const top = sources.top(node);
    const module = sources.module(top.file);
    return module ? { module, top, returns: new Set(), seen: new Set(), catching: [], jumps: [], savepoints: new Map() } : null;
  }

  function note(frame: WalkFrame, states: States): void {
    for (const state of states) {
      frame.seen.add(state);
      for (const set of frame.catching) set.add(state);
    }
  }

  function resolveLocal(module: WalkModule, name: string, seen = new Set<string>()): Array<{ module: string; name: string }> {
    if (module.locals.has(name)) return [{ module: module.file, name }];
    const imported = module.imports.get(name);
    return imported ? resolveExport(imported.module, imported.name, seen) : [];
  }

  function resolveExport(file: string, name: string, seen = new Set<string>()): Array<{ module: string; name: string }> {
    const key = `${file}:${name}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const module = sources.module(file);
    if (!module) return [];
    if (name === '*') return [...module.exports.keys()].flatMap((exported) => resolveExport(file, exported, seen));
    const binding = module.exports.get(name);
    if (binding) return binding.module === null ? resolveLocal(module, binding.name, seen) : resolveExport(binding.module, binding.name, seen);
    for (const star of module.starExports) {
      const found = resolveExport(star, name, seen);
      if (found.length > 0) return found;
    }
    return [];
  }

  function load(module: WalkModule): void {
    if (loaded.has(module.file)) return;
    loaded.add(module.file);
    for (const statement of module.onLoad) {
      const frame = frameFor(statement);
      if (frame) walkStatement(frame, statement, new Set<Txn>(['none']));
    }
  }

  /** Runs (`call`) or reads (a reference) a top-level declaration from `state`. */
  function enter(target: { module: string; name: string }, state: Txn, call: boolean): WalkSummary {
    const module = sources.module(target.module);
    if (!module || (module.isEntry && module.file !== entryFile)) return unchanged(state);
    load(module);
    const node = module.locals.get(target.name);
    if (!node) return unchanged(state);
    const fn = declaredFunction(node);
    if (fn) {
      const summary = runFunction(fn, state);
      return call ? summary : unchanged(state);
    }
    const states = read.get(node) ?? new Set<Txn>();
    if (!states.has(state)) {
      states.add(state);
      read.set(node, states);
      const frame = frameFor(node);
      if (frame) {
        const start = new Set<Txn>([state]);
        if (ts.isVariableDeclaration(node)) {
          if (node.initializer) walkExpression(frame, node.initializer, start);
        } else {
          walkChildren(frame, node, start);
        }
      }
    }
    return unchanged(state);
  }

  function runFunction(fn: FunctionNode, state: Txn): WalkSummary {
    let byState = summaries.get(fn);
    if (!byState) summaries.set(fn, byState = new Map());
    const known = byState.get(state);
    if (known === 'running') return unchanged(state);
    if (known) return known;
    byState.set(state, 'running');
    const frame = frameFor(fn);
    if (!frame) {
      byState.set(state, unchanged(state));
      return unchanged(state);
    }
    const start = new Set<Txn>([state]);
    note(frame, start);
    const end = ts.isBlock(fn.body) ? walkStatements(frame, fn.body.statements, start) : walkExpression(frame, fn.body, start);
    const summary: WalkSummary = { exits: union(end, frame.returns), seen: new Set(frame.seen) };
    byState.set(state, summary);
    return summary;
  }

  /** Continues the caller after the callees it may have run: from where they leave it. */
  function after(frame: WalkFrame, ran: WalkSummary[]): States {
    const exits = union(...ran.map((summary) => summary.exits));
    note(frame, union(...ran.map((summary) => summary.seen)));
    return exits;
  }

  /** What a name can run: the named local functions and the top-level declarations it may stand for. */
  function named(frame: WalkFrame, name: string, state: Txn, call: boolean): WalkSummary[] {
    return [
      ...(frame.top.functions.get(name) ?? []).map((fn) => {
        const summary = runFunction(fn, state);
        return call ? summary : unchanged(state);
      }),
      ...resolveLocal(frame.module, name).map((target) => enter(target, state, call)),
    ];
  }

  function reference(frame: WalkFrame, id: ts.Identifier, states: States): void {
    for (const state of states) named(frame, id.text, state, false);
  }

  function write(frame: WalkFrame, text: string, states: States): void {
    const writes = coveredWrites(text, changeLog);
    if (writes.length === 0) return;
    const site = `${frame.top.file}#${frame.top.key}`;
    classified.add(site);
    for (const w of writes) {
      const what = `${w.table} (${w.detail})`;
      for (const state of states) {
        if (state !== 'stated') findings.set(`${site}\u0000${what}\u0000${state}`, { site, write: what, state });
      }
    }
  }

  function walkCall(frame: WalkFrame, node: ts.CallExpression, states: States): States {
    const callee = unwrap(node.expression);
    if (ts.isPropertyAccessExpression(callee)) {
      states = walkExpression(frame, callee.expression, states);
    } else if (ts.isElementAccessExpression(callee)) {
      states = walkExpression(frame, callee.argumentExpression, walkExpression(frame, callee.expression, states));
    } else if (!ts.isIdentifier(callee) && !isFunctionNode(callee)) {
      states = walkExpression(frame, callee, states);
    }
    for (const argument of node.arguments) states = walkExpression(frame, argument, states);
    if (states.size === 0) return states;

    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
    if (ts.isPropertyAccessExpression(callee) && name === 'query' && node.arguments.length > 0) {
      // A client's query: its SQL literal was checked above as an argument.
      const sql = literalText(node.arguments[0]);
      const rollbackTo = sql === null ? null : TXN_ROLLBACK_TO.exec(sql);
      const savepoint = sql === null ? null : TXN_SAVEPOINT.exec(sql);
      if (rollbackTo) {
        const taken = [...(frame.savepoints.get(rollbackTo[1].replace(/"/g, '').toLowerCase()) ?? [])].filter((state) => state !== 'none');
        if (taken.length > 0) states = new Set(taken);
      } else if (savepoint) {
        const key = savepoint[1].replace(/"/g, '').toLowerCase();
        frame.savepoints.set(key, union(frame.savepoints.get(key) ?? NO_STATES, states));
      } else if (sql !== null && TXN_OPEN.test(sql)) {
        states = new Set<Txn>(['open']);
      } else if (sql !== null && TXN_CLOSE.test(sql)) {
        states = new Set<Txn>(['none']);
      }
      note(frame, states);
      return states;
    }
    if (name === 'setAuditContext') {
      states = new Set([...states].map((state): Txn => (state === 'open' ? 'stated' : state)));
      note(frame, states);
      return states;
    }
    if (isFunctionNode(callee)) return after(frame, [...states].map((state) => runFunction(callee, state)));
    if (ts.isIdentifier(callee)) {
      if (callee.text === 'require') {
        const first = node.arguments[0];
        const target = first && ts.isStringLiteralLike(first) ? sources.program.resolve(frame.module.file, first.text) : null;
        const module = target ? sources.module(target) : null;
        if (module && !(module.isEntry && module.file !== entryFile)) {
          load(module);
          for (const exported of resolveExport(module.file, '*')) for (const state of states) enter(exported, state, false);
        }
        return states;
      }
      const ran = [...states].flatMap((state) => named(frame, callee.text, state, true));
      return ran.length > 0 ? after(frame, ran) : states;
    }
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
      const namespace = frame.module.imports.get(callee.expression.text);
      if (namespace?.name === '*' && !frame.top.functions.has(callee.expression.text)) {
        const targets = resolveExport(namespace.module, callee.name.text);
        if (targets.length > 0) return after(frame, targets.flatMap((target) => [...states].map((state) => enter(target, state, true))));
      }
    }
    return states;
  }

  function walkExpression(frame: WalkFrame, node: ts.Node, states: States): States {
    if (states.size === 0 || ts.isTypeNode(node)) return states;
    const text = literalText(node);
    if (text !== null) {
      if (ts.isTemplateExpression(node)) {
        for (const span of node.templateSpans) states = walkExpression(frame, span.expression, states);
      }
      write(frame, text, states);
      return states;
    }
    if (ts.isCallExpression(node)) return walkCall(frame, node, states);
    if (ts.isIdentifier(node)) {
      if (isReference(node)) reference(frame, node, states);
      return states;
    }
    if (isFunctionNode(node)) {
      // A function value runs later, from the state it is created in.
      if (!isNamedLocal(node)) for (const state of states) runFunction(node, state);
      return states;
    }
    if (ts.isPropertyAccessExpression(node)) return walkExpression(frame, node.expression, states);
    if (ts.isShorthandPropertyAssignment(node)) {
      reference(frame, node.name, states);
      return node.objectAssignmentInitializer ? walkExpression(frame, node.objectAssignmentInitializer, states) : states;
    }
    if (ts.isPropertyAssignment(node)) {
      if (ts.isComputedPropertyName(node.name)) states = walkExpression(frame, node.name.expression, states);
      return walkExpression(frame, node.initializer, states);
    }
    if (ts.isConditionalExpression(node)) {
      const tested = walkExpression(frame, node.condition, states);
      return union(walkExpression(frame, node.whenTrue, tested), walkExpression(frame, node.whenFalse, tested));
    }
    if (ts.isBinaryExpression(node) && [
      ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
      ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken,
    ].includes(node.operatorToken.kind)) {
      const left = walkExpression(frame, node.left, states);
      return union(left, walkExpression(frame, node.right, left));
    }
    return walkChildren(frame, node, states);
  }

  function walkChildren(frame: WalkFrame, node: ts.Node, states: States): States {
    ts.forEachChild(node, (child) => {
      states = walkExpression(frame, child, states);
    });
    return states;
  }

  function walkStatements(frame: WalkFrame, statements: readonly ts.Statement[], states: States): States {
    for (const statement of statements) {
      if (states.size === 0) break;
      states = walkStatement(frame, statement, states);
    }
    return states;
  }

  function walkVariable(frame: WalkFrame, declaration: ts.VariableDeclaration, states: States): States {
    if (!declaration.initializer) return states;
    // A named local function runs where it is called or referenced.
    const init = unwrap(declaration.initializer);
    if (isFunctionNode(init) && isNamedLocal(init)) return states;
    return walkExpression(frame, declaration.initializer, states);
  }

  function walkStatement(frame: WalkFrame, node: ts.Statement, states: States): States {
    if (states.size === 0) return states;
    note(frame, states);
    if (ts.isBlock(node)) return walkStatements(frame, node.statements, states);
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) states = walkVariable(frame, declaration, states);
      return states;
    }
    if (ts.isExpressionStatement(node)) return walkExpression(frame, node.expression, states);
    if (ts.isIfStatement(node)) {
      const tested = walkExpression(frame, node.expression, states);
      const then = walkStatement(frame, node.thenStatement, tested);
      return union(then, node.elseStatement ? walkStatement(frame, node.elseStatement, tested) : tested);
    }
    if (ts.isReturnStatement(node)) {
      const returned = node.expression ? walkExpression(frame, node.expression, states) : states;
      for (const state of returned) frame.returns.add(state);
      note(frame, returned);
      return NO_STATES;
    }
    if (ts.isThrowStatement(node)) {
      note(frame, walkExpression(frame, node.expression, states));
      return NO_STATES;
    }
    if (ts.isTryStatement(node)) {
      const caught = new Set<Txn>(states);
      frame.catching.push(caught);
      const tried = walkStatement(frame, node.tryBlock, states);
      frame.catching.pop();
      let out: States = tried;
      const abrupt = new Set<Txn>([...caught, ...tried]);
      if (node.catchClause) {
        frame.catching.push(abrupt);
        const handled = walkStatement(frame, node.catchClause.block, caught);
        frame.catching.pop();
        out = union(tried, handled);
      }
      if (node.finallyBlock) {
        // An early return or an error runs the finally block too, from any state seen above.
        walkStatement(frame, node.finallyBlock, abrupt);
        out = walkStatement(frame, node.finallyBlock, out);
      }
      return out;
    }
    if (ts.isIterationStatement(node, false)) {
      if (ts.isForStatement(node) && node.initializer) {
        states = ts.isVariableDeclarationList(node.initializer)
          ? node.initializer.declarations.reduce((s, declaration) => walkVariable(frame, declaration, s), states)
          : walkExpression(frame, node.initializer, states);
      }
      if (ts.isForOfStatement(node) || ts.isForInStatement(node)) states = walkExpression(frame, node.expression, states);
      const jump = { loop: true, breaks: new Set<Txn>(), continues: new Set<Txn>() };
      frame.jumps.push(jump);
      let head = new Set<Txn>(states);
      for (let pass = 0; pass < 8; pass += 1) {
        let entering: States = head;
        if ((ts.isForStatement(node) && node.condition) || ts.isWhileStatement(node)) {
          entering = walkExpression(frame, ts.isForStatement(node) ? node.condition! : (node as ts.WhileStatement).expression, head);
        }
        let back: States = union(walkStatement(frame, node.statement, entering), jump.continues);
        if (ts.isForStatement(node) && node.incrementor) back = walkExpression(frame, node.incrementor, back);
        if (ts.isDoStatement(node)) back = walkExpression(frame, node.expression, back);
        const next = union(head, back);
        if (next.size === head.size) break;
        head = next;
      }
      frame.jumps.pop();
      return union(head, jump.breaks);
    }
    if (ts.isSwitchStatement(node)) {
      const tested = walkExpression(frame, node.expression, states);
      const jump = { loop: false, breaks: new Set<Txn>(), continues: new Set<Txn>() };
      frame.jumps.push(jump);
      let falling: States = NO_STATES;
      let hasDefault = false;
      for (const clause of node.caseBlock.clauses) {
        let entering: States = union(tested, falling);
        if (ts.isCaseClause(clause)) entering = walkExpression(frame, clause.expression, entering);
        else hasDefault = true;
        falling = walkStatements(frame, clause.statements, entering);
      }
      frame.jumps.pop();
      return union(falling, jump.breaks, hasDefault ? NO_STATES : tested);
    }
    if (ts.isBreakStatement(node)) {
      const target = frame.jumps.at(-1);
      if (target) for (const state of states) target.breaks.add(state);
      return NO_STATES;
    }
    if (ts.isContinueStatement(node)) {
      const target = [...frame.jumps].reverse().find((jump) => jump.loop);
      if (target) for (const state of states) target.continues.add(state);
      return NO_STATES;
    }
    if (ts.isLabeledStatement(node)) return walkStatement(frame, node.statement, states);
    // A named local function runs where it is called or referenced.
    if (ts.isFunctionDeclaration(node)) return states;
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEmptyStatement(node)
        || ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return states;
    return walkChildren(frame, node, states);
  }

  const entry = sources.module(entryFile);
  if (entry) {
    load(entry);
    for (const handler of resolveExport(entryFile, 'handler')) enter(handler, 'none', true);
  }
  return {
    findings: [...findings.values()].sort((a, b) => `${a.site} ${a.write} ${a.state}`.localeCompare(`${b.site} ${b.write} ${b.state}`)),
    classified,
  };
}

/** The real Lambda sources, parsed once, for every walk in this file. */
const lambdaSources = new WalkSources({
  source: (() => {
    const parsed = new Map<string, ts.SourceFile | undefined>();
    return (file: string): ts.SourceFile | undefined => {
      if (!parsed.has(file)) {
        const full = path.join(LAMBDA_ROOT, file);
        parsed.set(file, fs.existsSync(full)
          ? ts.createSourceFile(file, fs.readFileSync(full, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
          : undefined);
      }
      return parsed.get(file);
    };
  })(),
  resolve: (from, specifier) => {
    if (!specifier.startsWith('.')) return null;
    const base = path.resolve(path.dirname(path.join(LAMBDA_ROOT, from)), specifier);
    for (const candidate of [`${base}.ts`, path.join(base, 'index.ts'), base]) {
      if (!candidate.endsWith('.ts') || !fs.existsSync(candidate)) continue;
      const relative = path.relative(LAMBDA_ROOT, candidate).split(path.sep).join('/');
      // The same modules the source scan reads: those under infra/lambda.
      return relative.startsWith('../') ? null : relative;
    }
    return null;
  },
});

const walks = new Map<string, WalkResult>();

/** The transaction walk of one Lambda entry, by its path under infra/lambda. */
function walk(file: string): WalkResult {
  if (!walks.has(file)) walks.set(file, walkEntry(lambdaSources, file, log));
  return walks.get(file)!;
}

/** Walks an in-memory set of modules from the entry `handler.ts`. */
function walkFixture(files: Readonly<Record<string, string>>): WalkResult {
  const parsed = new Map(Object.entries(files).map(([file, text]) =>
    [file, ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)] as const));
  return walkEntry(new WalkSources({
    source: (file) => parsed.get(file),
    resolve: (from, specifier) => {
      if (!specifier.startsWith('.')) return null;
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
      return [`${base}.ts`, `${base}/index.ts`].find((candidate) => parsed.has(candidate)) ?? null;
    },
  }), 'handler.ts', log);
}

describe('the covered-write classifier', () => {
  it('counts inserts, deletes, truncates and updates of covered columns', () => {
    expect(directCoveredWrites('INSERT INTO worker_skills (worker_id, skill) VALUES ($1, $2)', log)
      .map((w) => [w.table, w.how])).toEqual([['worker_skills', 'insert']]);
    expect(directCoveredWrites('DELETE FROM public.worker_documents WHERE id = $1', log)
      .map((w) => [w.table, w.how])).toEqual([['worker_documents', 'delete']]);
    expect(directCoveredWrites('UPDATE users u SET phone = $2, updated_at = now() WHERE u.id = $1', log)
      .map((w) => w.detail)).toEqual(['UPDATE sets phone']);
    expect(directCoveredWrites('UPDATE worker_posts SET status = \'deleted\' WHERE id = $1', log)
      .map((w) => w.detail)).toEqual(['UPDATE sets status']);
  });

  it('counts a SET list built at run time', () => {
    expect(directCoveredWrites('UPDATE users SET ${} WHERE id = $1', log).map((w) => w.detail))
      .toEqual(['UPDATE with a SET list built at run time']);
  });

  it('reads past IS DISTINCT FROM inside an assignment', () => {
    const sql = `UPDATE users SET tos_version = $2,
                   tos_accepted_at = CASE WHEN tos_version IS DISTINCT FROM $2 THEN now() ELSE tos_accepted_at END,
                   phone = $3
                 WHERE id = $1`;
    expect(directCoveredWrites(sql, log).map((w) => w.detail)).toEqual(['UPDATE sets phone']);
  });

  it('leaves out updates that set no covered column, which leave no change record', () => {
    expect(directCoveredWrites('UPDATE job_applications SET status = \'talking\', updated_at = now() WHERE id = $1', log)).toEqual([]);
    expect(directCoveredWrites('UPDATE users SET tos_version = $1, tos_accepted_at = NOW() WHERE cognito_sub = $2', log)).toEqual([]);
    expect(directCoveredWrites('SELECT id FROM users WHERE id = $1 FOR UPDATE', log)).toEqual([]);
  });

  it('counts a delete that cascades into a covered table, and calls to writing functions', () => {
    expect(CASCADE_PARENTS).toContain('jobs');
    expect(directCoveredWrites('DELETE FROM jobs WHERE id = $1', log).map((w) => w.how)).toEqual(['cascade']);
    expect(writerFunctions(log).has('jale_cap.upload_token_confirm')).toBe(true);
    expect(coveredWrites('SELECT outcome FROM jale_cap.upload_token_confirm($1, $2)', log).map((w) => w.how))
      .toEqual(['function']);
  });

  it('knows no trigger that writes a covered table from another table', () => {
    // A trigger like that would make writes to its own table covered writes;
    // the scan would need to model it before this can change.
    const writers = writerFunctions(log);
    const migrations = path.join(LAMBDA_ROOT, '..', 'db', 'migrations');
    const offenders: string[] = [];
    for (const file of fs.readdirSync(migrations).filter((f) => f.endsWith('.sql'))) {
      const text = fs.readFileSync(path.join(migrations, file), 'utf8');
      const trigger = /CREATE\s+(?:CONSTRAINT\s+)?TRIGGER[\s\S]*?EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(?:([A-Za-z_]\w*)\.)?([A-Za-z_]\w*)\s*\(/gi;
      for (const m of text.matchAll(trigger)) {
        const name = `${(m[1] ?? 'public').toLowerCase()}.${m[2].toLowerCase()}`;
        if (writers.has(name)) offenders.push(`${file}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the transaction walk', () => {
  // Fixture handlers, walked with the real change log. The names they use
  // need not exist: the walk only reads the source.
  const BEGIN = "await client.query('BEGIN');";
  const STATE = "await setAuditContext(client, caller, 'worker.profile_update');";
  const COMMIT = "await client.query('COMMIT');";
  const ROLLBACK = "await client.query('ROLLBACK');";
  const INSERT = "await client.query('INSERT INTO worker_skills (worker_id, skill) VALUES ($1, $2)', [id, skill]);";
  const DELETE = "await client.query('DELETE FROM worker_skills WHERE worker_id = $1', [id]);";
  /** SAVEPOINT, ROLLBACK TO SAVEPOINT and RELEASE, with the name written out and with it substituted from a constant. */
  const SAVEPOINT_SPELLINGS: Array<[string, string, string, string]> = [
    ['a written name', "await client.query('SAVEPOINT merge');", "await client.query('ROLLBACK TO SAVEPOINT merge');", "await client.query('RELEASE SAVEPOINT merge');"],
    ['a substituted name', 'await client.query(`SAVEPOINT ${MERGE}`);', 'await client.query(`ROLLBACK TO SAVEPOINT ${MERGE}`);', 'await client.query(`RELEASE SAVEPOINT ${MERGE}`);'],
  ];

  /** A handler module: `prelude` at the top level, then a handler running `body`. */
  function handler(body: string[], prelude: string[] = []): string {
    return [...prelude, 'export const handler = async (event: unknown) => {', '  const client = await pool.connect();', ...body, '};', ''].join('\n');
  }

  function findings(files: Readonly<Record<string, string>>): string[] {
    return walkFixture(files).findings.map((finding) => `${finding.site}: ${finding.write} ${finding.state}`);
  }

  describe('fails a covered write that does not run in a transaction with its context stated', () => {
    it('in a second transaction that never states it, although the first one did', () => {
      expect(findings({ 'handler.ts': handler([BEGIN, STATE, DELETE, COMMIT, BEGIN, INSERT, COMMIT]) }))
        .toEqual(['handler.ts#handler: worker_skills (INSERT) open']);
    });

    it('after the commit, outside any transaction', () => {
      expect(findings({ 'handler.ts': handler([BEGIN, STATE, DELETE, COMMIT, INSERT]) }))
        .toEqual(['handler.ts#handler: worker_skills (INSERT) none']);
    });

    it('before the context is stated in the same transaction', () => {
      expect(findings({ 'handler.ts': handler([BEGIN, INSERT, STATE, DELETE, COMMIT]) }))
        .toEqual(['handler.ts#handler: worker_skills (INSERT) open']);
    });

    it('when the context was stated outside any transaction, where it does not last', () => {
      expect(findings({ 'handler.ts': handler([STATE, BEGIN, INSERT, COMMIT]) }))
        .toEqual(['handler.ts#handler: worker_skills (INSERT) open']);
    });

    it('when only one branch states it', () => {
      expect(findings({ 'handler.ts': handler([BEGIN, 'if (event) {', STATE, '}', INSERT, COMMIT]) }))
        .toEqual(['handler.ts#handler: worker_skills (INSERT) open']);
    });

    it.each(SAVEPOINT_SPELLINGS)('when rolling back to a savepoint (%s) undoes a context stated after it', (_spelling, savepoint, rollbackTo) => {
      expect(findings({ 'handler.ts': handler([BEGIN, savepoint, STATE, DELETE, rollbackTo, INSERT, COMMIT]) }))
        .toEqual(['handler.ts#handler: worker_skills (INSERT) open']);
    });

    it('in a helper called after the commit, though the same helper is fine inside the transaction', () => {
      const prelude = ['async function saveSkill(client: unknown) {', INSERT, '}'];
      expect(findings({ 'handler.ts': handler([BEGIN, STATE, 'await saveSkill(client);', COMMIT, 'await saveSkill(client);'], prelude) }))
        .toEqual(['handler.ts#saveSkill: worker_skills (INSERT) none']);
    });

    it('after a local closure that commits', () => {
      const commit = "const commit = async () => { await client.query('COMMIT'); };";
      expect(findings({ 'handler.ts': handler([commit, BEGIN, STATE, DELETE, 'await commit();', INSERT]) }))
        .toEqual(['handler.ts#handler: worker_skills (INSERT) none']);
    });

    it('in a catch block after the rollback', () => {
      expect(findings({ 'handler.ts': handler(['try {', BEGIN, STATE, DELETE, COMMIT, '} catch (err) {', ROLLBACK, INSERT, 'throw err;', '}']) }))
        .toEqual(['handler.ts#handler: worker_skills (INSERT) none']);
    });

    it('in a helper module that opens its own transaction and states nothing', () => {
      expect(findings({
        'helper.ts': ['export async function record(client: unknown) {', BEGIN, INSERT, COMMIT, '}', ''].join('\n'),
        'handler.ts': handler([BEGIN, STATE, DELETE, COMMIT, 'await record(client);'], ["import { record } from './helper';"]),
      })).toEqual(['helper.ts#record: worker_skills (INSERT) open']);
    });

    it('in a function value created outside the transaction, judged from where it is created', () => {
      const deps = ['const deps = { save: async () => {', INSERT, '} };'];
      expect(findings({ 'handler.ts': handler([...deps, BEGIN, STATE, 'await engine(deps);', COMMIT]) }))
        .toEqual(['handler.ts#handler: worker_skills (INSERT) none']);
    });
  });

  describe('passes a covered write that runs in a transaction with its context stated', () => {
    it('after early returns that commit before the context is stated', () => {
      const early = "if (!event) { await client.query('COMMIT'); return { statusCode: 404 }; }";
      expect(findings({ 'handler.ts': handler([BEGIN, early, STATE, INSERT, COMMIT]) })).toEqual([]);
    });

    it('in helpers called inside the transaction, and SQL a helper builds or a constant holds', () => {
      const prelude = [
        'async function saveSkill(client: unknown) {', INSERT, '}',
        "function deleteSql(): string { return 'DELETE FROM worker_skills WHERE worker_id = $1'; }",
        "const INSERT_SKILL = 'INSERT INTO worker_skills (worker_id, skill) VALUES ($1, $2)';",
      ];
      const result = walkFixture({ 'handler.ts': handler(
        [BEGIN, STATE, 'await saveSkill(client);', 'await client.query(deleteSql(), [id]);', 'await client.query(INSERT_SKILL, [id, skill]);', COMMIT],
        prelude,
      ) });
      expect(result.findings).toEqual([]);
      expect([...result.classified].sort()).toEqual(['handler.ts#INSERT_SKILL', 'handler.ts#deleteSql', 'handler.ts#saveSkill']);
    });

    it.each(SAVEPOINT_SPELLINGS)('across savepoints (%s), which keep the transaction and a context stated before them', (_spelling, savepoint, rollbackTo, release) => {
      expect(findings({ 'handler.ts': handler([BEGIN, STATE, savepoint, 'try {', INSERT, release, '} catch {', rollbackTo, DELETE, '}', COMMIT]) }))
        .toEqual([]);
    });

    it('in a transaction per loop iteration, each stating it', () => {
      expect(findings({ 'handler.ts': handler(['for (const id of ids) {', BEGIN, STATE, INSERT, COMMIT, '}']) })).toEqual([]);
    });

    it('in named local functions defined before the transaction and run inside it', () => {
      const commit = "const commit = async () => { await client.query('COMMIT'); };";
      const save = ['const save = async () => {', INSERT, '};'];
      expect(findings({ 'handler.ts': handler([commit, ...save, BEGIN, STATE, 'await save();', 'await commit();']) })).toEqual([]);
    });

    it('in a function value created inside the transaction, such as a dependency handed to an engine', () => {
      const deps = ['const deps = { save: async () => {', INSERT, '} };'];
      expect(findings({ 'handler.ts': handler([BEGIN, STATE, ...deps, 'await engine(deps);', COMMIT]) })).toEqual([]);
    });

    it('in a helper module that owns its transaction and states the context itself', () => {
      expect(findings({
        'helper.ts': ['export async function persist(client: unknown) {', BEGIN, STATE, INSERT, COMMIT, '}', ''].join('\n'),
        'handler.ts': handler(['await persist(client);'], ["import { persist } from './helper';"]),
      })).toEqual([]);
    });
  });
});

describe('change-record context coverage', () => {
  const entries = entryModules();
  const writing = new Map(entries
    .map((entry) => [entry.file, coveredWritesOf(entry, log)] as const)
    .filter(([, writes]) => writes.length > 0));

  it('finds the known writers', () => {
    expect(writing.has('api/worker-profile-update.ts')).toBe(true);
    expect(writing.has('api/employer-jobs-delete.ts')).toBe(true);
    expect(writing.has('api/worker-doc-confirm.ts')).toBe(true);
    expect(writing.has('whatsapp/processor.ts')).toBe(true);
  });

  it('every covered write an entry can reach runs in a transaction that has already stated the audit context, or the entry is excluded', () => {
    // Write by write: an entry that states the context in one transaction is
    // not trusted for another one, nor for a write outside any transaction.
    const unstated: string[] = [];
    for (const [file] of writing) {
      if (file in WRITER_EXCLUSIONS) continue;
      for (const finding of walk(file).findings) {
        unstated.push(`${file} -> ${finding.site}: ${finding.write} runs ${STATE_WORDS[finding.state]}`);
      }
    }
    expect(unstated).toEqual([]);
  });

  it('the transaction walk reaches every covered write the source scan finds', () => {
    // A write the walk never reached would pass unchecked, so it fails here.
    const unreached: string[] = [];
    for (const [file] of writing) {
      const { classified } = walk(file);
      for (const site of coveredWriteSites(lambdaModules().get(file)!, log)) {
        if (!classified.has(`${site.module}#${site.declaration}`)) {
          unreached.push(`${file} -> ${site.module}#${site.declaration}: ${site.writes.join(', ')}`);
        }
      }
    }
    expect(unreached).toEqual([]);
  });

  it('every module with a covered write is reachable from some entry', () => {
    const reachable = new Set(entries.flatMap((entry) => reach(entry).map((m) => m.file)));
    const orphans = [...lambdaModules().values()]
      .filter((m) => m.literals.some((literal) => coveredWrites(literal, log).length > 0))
      .map((m) => m.file)
      .filter((file) => !reachable.has(file));
    expect(orphans).toEqual([]);
  });

  it('keeps the exclusion list exact: entries that write, set no context, and say why', () => {
    const stale: string[] = [];
    for (const [file, reason] of Object.entries(WRITER_EXCLUSIONS)) {
      const module = lambdaModules().get(file);
      if (!module) stale.push(`${file}: no such module`);
      else if (!module.exportsHandler) stale.push(`${file}: not an entry`);
      else if (!writing.has(file)) stale.push(`${file}: reaches no covered write`);
      else if (module.calls.has('setAuditContext')) stale.push(`${file}: sets the context`);
      else if (walk(file).findings.length === 0) stale.push(`${file}: every covered write it reaches runs in a transaction that states the context`);
      if (reason.trim().length < 10) stale.push(`${file}: no reason`);
    }
    expect(stale).toEqual([]);
  });
});
