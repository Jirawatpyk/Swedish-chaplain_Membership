/**
 * Spec 140 s2d (#736c) — the rule behind `pnpm check:log-error-objects`, as a
 * pure function over one source file (I/O lives in
 * `scripts/check-log-error-objects.ts`; tests in
 * `tests/unit/scripts/check-log-error-objects.test.ts`).
 *
 * Why: drizzle-orm's `DrizzleQueryError` carries enumerable `query` and
 * `params`, so a raw error object, its `.cause`, or its `.message` written to a
 * log line copies the statement's bound parameters (emails, names, payloads)
 * into the log. A log line carries an error as its CLASS (`errKind`), its
 * SQLSTATE (`pgErrorCode`), its constraint / table / column names
 * (`pgErrorMeta`), a gateway's closed `classifyThrown(e).kind`, or a
 * code-authored step — never the object. Review round 1 (code-review #2):
 * `src/lib/logger.ts` now reduces an error under `err` / `error` / `cause` at
 * the root; this rule stays the backstop for every other key and for error
 * TEXT, which the logger cannot recognise.
 *
 * Review round 1 (security M1, code-review #1, security L2, L3): on an
 * error-ish base (a caught or error-named identifier, or a chain through
 * `.error` / `.cause`) only `.code`, `.kind` and `.name` are read; element
 * access, a method called on an error or its text (`e.toString()`,
 * `e.message.slice()`), a call whose literal argument holds an error
 * (`JSON.stringify({ e })`), and the arguments of `logger.child(…)` are
 * refused. Safe callees are an explicit set, not a name pattern.
 *
 * Parsed with the TypeScript compiler API, not a regex, so it is CRLF-proof
 * and multi-line-proof; a `.tsx` file is parsed as TSX.
 *
 * Review round 2 (security #4, code-review #8): one hop through a local is
 * followed. `const { x } = e` and `const x = e.y` (also as an arm of `?:` /
 * `??` / `||`) make `x` error-ish unless `y` is a token field, or the local is
 * annotated with a type in the reviewed `TOKEN_FIELDS_BY_TYPE`.
 *
 * Review round 3 (code-review #6, #9, #10; security #5): a local is tainted
 * by any initializer the rule would refuse inline (a template, `+`, `&&`,
 * `String(e)`, an unknown call over an error), by a reassignment
 * (`x = e.message`) and by a `for (const x of e.y)` loop. A
 * `TOKEN_FIELDS_BY_TYPE` annotation counts only over a direct property read,
 * never a cast (`(e as any).reason`, `e!.reason`). Each block's taint is
 * computed once and reused for every logger call in it.
 *
 * Review round 4 (code-review #1–#3; security L2): a reassignment's taint
 * survives the declaration of its binding in an outer block, and compound
 * assignment (`+=`, `||=`, `??=`, `&&=`), destructuring assignment
 * (`({ message: m } = e)`, `[x] = e.errors`) and a `for (x of e.y)` over a
 * binding declared earlier taint too. `await` is looked through, at the log
 * line and in an initializer.
 *
 * A TRIPWIRE, not proof of completeness: it reads each `logger.<level>(…)`
 * call's arguments syntactically. A value laundered through two locals, or
 * through a helper in the safe set, passes. The sweep that preceded it was
 * done by hand.
 */
import ts from 'typescript';

export interface LogErrorFinding {
  /** 1-based line of the offending value. */
  readonly line: number;
  readonly message: string;
}

export interface LogErrorScan {
  readonly findings: LogErrorFinding[];
  /** The `logger.<level>(…)` and `logger.child(…)` calls read — the runner's floor counts them. */
  readonly loggerCalls: number;
}

const LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'child']);

/** Identifiers that conventionally hold a caught error. */
const ERROR_NAMES = new Set(['e', 'err', 'error', 'ex', 'cause']);
/** `dbError`, `sendErr`, … — but not `errKind`, `errorCode`, `errClass`. */
const ERROR_SUFFIX = /(?:Err|Error)$/;
/** `code`, `pgCode`, `outcomeKind`, `errClass` — values code already reduced to a token. Never a caught name. */
const SAFE_NAME = /^(?:code|.*(?:Code|Kind|Class))$/;
/**
 * Calls whose result is a closed token whatever their argument — an explicit
 * set (review round 1, security L2), never a name pattern. `errStep` returns
 * only a code-authored step token (`src/lib/log-id.ts`; review round 2 removed
 * `erase-member.ts`'s own copy, `eraseStep`); `gatewayField` only a
 * `[a-z0-9_]` token or `'unrecognised'` (`subprocessor-erasure-adapter.ts`); `approvalErrKind` an error class plus
 * `ApprovalDependencyError`'s dependency and `causeKind` (every constructor
 * call passes a repo code, a closed kind, a literal or an `errKind`);
 * `retryableSubKind` one of five literals; `isTimeout` and `Number.isFinite`
 * a boolean. Review round 3 — `primaryContactTriggerViolation` (a local's
 * initializer is now judged like a log value): a count, a member uuid matched
 * by `[0-9a-f-]{36}` and a tenant slug parsed from the trigger's own raise
 * (`src/lib/db-errors.ts`), or null; never the message.
 */
const SAFE_CALLS = new Set([
  'errKind',
  'pgErrorCode',
  'pgErrorMeta',
  'hashId',
  'errLogFields',
  'errStep',
  'gatewayField',
  'approvalErrKind',
  'retryableSubKind',
  'isTimeout',
  'Number.isFinite',
  'primaryContactTriggerViolation',
]);
/** The only fields of `classifyThrown(e)` that are closed tokens (`reason` carries the message). */
const CLASSIFY_SAFE_FIELDS = new Set(['kind', 'subKind', 'resourceType']);
/** Error fields that carry text from the error itself. */
const TEXT_FIELDS = new Set(['message', 'stack']);
/** Accesses that yield an error object. */
const OBJECT_FIELDS = new Set(['error', 'cause']);
/** The only fields read off an error-ish base: closed tokens. */
const TOKEN_FIELDS = new Set(['code', 'kind', 'name']);

function isLoggerCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || !LEVELS.has(callee.name.text)) return false;
  const target = callee.expression;
  if (ts.isIdentifier(target)) return target.text === 'logger';
  return ts.isPropertyAccessExpression(target) && target.name.text === 'logger';
}

function unwrap(node: ts.Expression): ts.Expression {
  let cur = node;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isTypeAssertionExpression(cur) ||
    // Review round 4 (code-review #3) — `await e.response.text()` yields what the call yields.
    ts.isAwaitExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

function calleeName(call: ts.CallExpression): string | null {
  const c = unwrap(call.expression);
  if (ts.isIdentifier(c)) return c.text;
  if (ts.isPropertyAccessExpression(c)) {
    const obj = unwrap(c.expression);
    return ts.isIdentifier(obj) ? `${obj.text}.${c.name.text}` : c.name.text;
  }
  return null;
}

/** Names bound by every enclosing `catch (x)` clause and `.catch((x) => …)` callback. */
function caughtNames(node: ts.Node): ReadonlySet<string> {
  const names = new Set<string>();
  for (let cur: ts.Node | undefined = node; cur !== undefined; cur = cur.parent) {
    if (ts.isCatchClause(cur) && cur.variableDeclaration && ts.isIdentifier(cur.variableDeclaration.name)) {
      names.add(cur.variableDeclaration.name.text);
    }
    if (
      (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) &&
      ts.isCallExpression(cur.parent) &&
      ts.isPropertyAccessExpression(cur.parent.expression) &&
      cur.parent.expression.name.text === 'catch'
    ) {
      const p = cur.parameters[0];
      if (p !== undefined && ts.isIdentifier(p.name)) names.add(p.name.text);
    }
  }
  return names;
}

/** What the rule knows at a logger call: the names that hold an error, and the fields that are tokens. */
interface Scope {
  /** Every enclosing catch binding, plus the locals read off an error one hop up ({@link taintedNames}). */
  readonly errors: ReadonlySet<string>;
  /** The fields read off an error that are closed tokens: {@link TOKEN_FIELDS}, or more for an annotated local. */
  readonly tokens: ReadonlySet<string>;
}

/**
 * Spec 140 s2d review round 2 (security #4, code-review #8) — the reviewed
 * per-type allowlist: a field of a named error class or Result-error type that
 * is a closed token, read off an error-ish base into a local. The local must
 * say which type it reads, as its type annotation: `const x: T['f'] = e.f`, or
 * `Extract<T, …>['f']` for one variant of a union, optionally with `undefined`,
 * `null` or literal members. The initializer may read only that field: tsc
 * checks the value has the annotated type, and this rule checks the type name
 * and the field against the list. A name alone (round 1's `SAFE_NAME` on a
 * caught binding) is never enough. Each entry says why the field is closed.
 */
const TOKEN_FIELDS_BY_TYPE: Readonly<Record<string, ReadonlySet<string>>> = {
  // `resend-broadcasts-gateway.ts` — `GatewayThrowableSubKind`, a closed
  // union of literals set by the gateway's classifier; never Resend's text.
  GatewayThrowable: new Set(['subKind']),
  // `broadcasts-repo.ts` — the row status the CAS read (`BroadcastStatus`, a
  // DB enum, or the `LEASE_LOST` / `LEASE_HELD` constants) and the status a
  // lease-lost probe read (`BroadcastStatus | null`).
  BroadcastConcurrentMutationError: new Set(['observedStatus', 'rowStatus']),
  // `cancel-in-flight-broadcasts-for-member.ts` — its one construction site
  // sets `errClass: errKind(e)`, an error class name.
  CancelInFlightForMemberError: new Set(['errClass']),
  // `resolve-segment-recipients.ts` — every construction site sets
  // `errClass: errKind(e)`, an error class name.
  ResolveSegmentError: new Set(['errClass']),
  // renewals `cancel-in-flight-cycles-for-member.ts` — `errName` is an
  // Error's `.name` (its class or a code-set name) or `'UnknownError'`.
  CancelInFlightCyclesForMemberError: new Set(['errName']),
  // renewals `restore-cycle-for-member.ts` — `errName` is an Error's `.name`
  // or `'UnknownError'`, as above.
  RestoreCycleForMemberError: new Set(['errName']),
  // `mark-invitation-bounced.ts` — `type` is the literal `'server_error'`.
  MarkInvitationBouncedError: new Set(['type']),
  // `build-audience-tick.ts` — a descriptor the tick builds, not a thrown
  // error: `reason` is `ImportFailureReason` (a const tuple of literals),
  // `importId` an opaque Resend import id or null, `observed` / `expected`
  // numbers or null.
  BuildAudienceTickError: new Set(['reason', 'importId', 'observed', 'expected']),
};

/** `T` for `T['f']`, and for `Extract<T, …>['f']`; else null. */
function allowlistedTypeName(node: ts.TypeNode): string | null {
  if (!ts.isTypeReferenceNode(node) || !ts.isIdentifier(node.typeName)) return null;
  if (node.typeName.text !== 'Extract') return node.typeName.text;
  const first = node.typeArguments?.[0];
  return first !== undefined && ts.isTypeReferenceNode(first) && ts.isIdentifier(first.typeName) ? first.typeName.text : null;
}

/**
 * Review round 3 (security #5) — true when every value `expr` can yield is
 * read directly: a property read whose base holds no `as`, `!`, `<T>` or
 * `satisfies`, an arm of `?:` / `??` / `||` that is one, or a value that reads
 * no field at all (a literal, an identifier, a call). A cast tells tsc to stop
 * checking the annotation, so the annotation proves nothing over it.
 */
function isDirectRead(expr: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(expr)) return isDirectRead(expr.expression);
  if (ts.isConditionalExpression(expr)) return isDirectRead(expr.whenTrue) && isDirectRead(expr.whenFalse);
  if (
    ts.isBinaryExpression(expr) &&
    (expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || expr.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return isDirectRead(expr.left) && isDirectRead(expr.right);
  }
  if (isCast(expr)) return false;
  for (let cur: ts.Expression = expr; ts.isPropertyAccessExpression(cur) || ts.isParenthesizedExpression(cur); cur = cur.expression) {
    if (isCast(cur.expression)) return false;
  }
  return true;
}

function isCast(node: ts.Expression): boolean {
  return ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node);
}

/** The fields a local's type annotation names from {@link TOKEN_FIELDS_BY_TYPE}; empty unless EVERY member is listed. */
function annotatedTokenFields(decl: ts.VariableDeclaration): ReadonlySet<string> {
  const type = decl.type;
  if (type === undefined) return new Set();
  if (decl.initializer === undefined || !isDirectRead(decl.initializer)) return new Set();
  const members = ts.isUnionTypeNode(type) ? type.types : [type];
  const fields = new Set<string>();
  for (const m of members) {
    if (m.kind === ts.SyntaxKind.UndefinedKeyword) continue;
    // `null` and a literal (`'audience_import_stuck'`) add no field: they are constants.
    if (ts.isLiteralTypeNode(m)) continue;
    if (ts.isIndexedAccessTypeNode(m) && ts.isLiteralTypeNode(m.indexType) && ts.isStringLiteral(m.indexType.literal)) {
      const typeName = allowlistedTypeName(m.objectType);
      const field = m.indexType.literal.text;
      if (typeName !== null && TOKEN_FIELDS_BY_TYPE[typeName]?.has(field) === true) {
        fields.add(field);
        continue;
      }
    }
    return new Set();
  }
  return fields;
}

/** Every identifier a binding name binds (`x`, `{ a, b: c }`, `[d, ...e]`). */
function boundNames(name: ts.BindingName, out: string[] = []): string[] {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) boundNames(el.name, out);
  return out;
}

/**
 * The locals of one declaration that hold an error or its text: one hop, never
 * chained. Review round 3 (code-review #6) — an identifier-named local is
 * tainted by any initializer the rule would refuse in a log line
 * ({@link refusal}), not only a direct read off an error.
 */
function taintedByDeclaration(sf: ts.SourceFile, decl: ts.VariableDeclaration): string[] {
  const init = decl.initializer;
  if (init === undefined) return [];
  const scope: Scope = { errors: caughtNames(decl), tokens: TOKEN_FIELDS };
  if (ts.isIdentifier(decl.name)) {
    const extra = annotatedTokenFields(decl);
    const tokens = extra.size === 0 ? TOKEN_FIELDS : new Set([...TOKEN_FIELDS, ...extra]);
    return refusal(sf, init, { ...scope, tokens }) !== null ? [decl.name.text] : [];
  }
  const base = shapeOf(init, scope);
  if (base === null || base === 'token') return [];
  if (base === 'text' || ts.isArrayBindingPattern(decl.name)) return boundNames(decl.name);
  const out: string[] = [];
  for (const el of decl.name.elements) {
    const key = el.propertyName ?? el.name;
    const field = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : null;
    if (el.dotDotDotToken !== undefined || field === null || !TOKEN_FIELDS.has(field)) boundNames(el.name, out);
  }
  return out;
}

/** What one statement of a block does to the taint: the names it declares (and which of them are bad), and the names it assigns from a refused value. */
interface StatementTaint {
  readonly end: number;
  readonly declared: ReadonlyArray<string>;
  readonly bad: ReadonlySet<string>;
  readonly assigned: ReadonlyArray<string>;
}

type StatementList = ts.Block | ts.SourceFile | ts.CaseClause | ts.DefaultClause | ts.ModuleBlock;

/** Review round 3 (code-review #10) — each block's statements are judged once, whatever the number of logger calls in it. */
const blockTaints = new WeakMap<StatementList, ReadonlyArray<StatementTaint>>();

/** Review round 4 (code-review #2) — the assignment operators whose result can be the right-hand value. */
const ASSIGNING_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
]);

/** Every identifier an assignment target binds (`x`, `{ a, b: c, ...d }`, `[e, f = 1]`); a property target binds none. */
function assignedNames(target: ts.Expression, out: string[] = []): string[] {
  const t = unwrap(target);
  if (ts.isIdentifier(t)) out.push(t.text);
  else if (ts.isBinaryExpression(t) && t.operatorToken.kind === ts.SyntaxKind.EqualsToken) assignedNames(t.left, out);
  else if (ts.isSpreadElement(t)) assignedNames(t.expression, out);
  else if (ts.isArrayLiteralExpression(t)) for (const el of t.elements) assignedNames(el, out);
  else if (ts.isObjectLiteralExpression(t)) {
    for (const prop of t.properties) {
      if (ts.isShorthandPropertyAssignment(prop)) out.push(prop.name.text);
      else if (ts.isPropertyAssignment(prop)) assignedNames(prop.initializer, out);
      else if (ts.isSpreadAssignment(prop)) assignedNames(prop.expression, out);
    }
  }
  return out;
}

/**
 * Review round 4 (code-review #1) — the names a destructuring assignment
 * (`({ message: m } = e)`, `[x] = e.errors`) takes off an error or its text,
 * the way {@link taintedByDeclaration} judges `const { message: m } = e`: a
 * token field (`code` / `kind` / `name`) stays clean.
 */
function destructuredFromError(target: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression, value: ts.Expression, scope: Scope): string[] {
  const base = shapeOf(value, scope);
  if (base === null || base === 'token') return [];
  if (base === 'text' || ts.isArrayLiteralExpression(target)) return assignedNames(target);
  const out: string[] = [];
  for (const prop of target.properties) {
    const key = ts.isShorthandPropertyAssignment(prop) || ts.isPropertyAssignment(prop) ? prop.name : undefined;
    const field = key !== undefined && (ts.isIdentifier(key) || ts.isStringLiteral(key)) ? key.text : null;
    if (field !== null && TOKEN_FIELDS.has(field)) continue;
    if (ts.isShorthandPropertyAssignment(prop)) out.push(prop.name.text);
    else if (ts.isPropertyAssignment(prop)) assignedNames(prop.initializer, out);
    else if (ts.isSpreadAssignment(prop)) assignedNames(prop.expression, out);
  }
  return out;
}

/**
 * The names `node` assigns from a refused value: an assignment (`=`, `+=`,
 * `||=`, `??=`, `&&=`) to an identifier, a destructuring assignment, or a
 * `for (x of …)` / `for (x in …)` over a binding declared earlier. Empty for
 * anything else.
 */
function assignedHere(sf: ts.SourceFile, node: ts.Node): string[] {
  const scope: Scope = { errors: caughtNames(node), tokens: TOKEN_FIELDS };
  if (ts.isBinaryExpression(node) && ASSIGNING_OPERATORS.has(node.operatorToken.kind)) {
    const left = unwrap(node.left);
    if (ts.isIdentifier(left)) return refusal(sf, node.right, scope) !== null ? [left.text] : [];
    if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken && (ts.isObjectLiteralExpression(left) || ts.isArrayLiteralExpression(left))) {
      return destructuredFromError(left, node.right, scope);
    }
    return [];
  }
  if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) {
    return refusal(sf, node.expression, scope) !== null ? assignedNames(node.initializer) : [];
  }
  return [];
}

/**
 * Review round 3 (code-review #9) — the names a statement assigns from a value
 * the rule would refuse (`x = e.message`), anywhere inside it but not inside a
 * nested function. A later safe assignment does not clear the taint. Review
 * round 4 — every form {@link assignedHere} reads.
 */
function assignedFromRefused(sf: ts.SourceFile, stmt: ts.Statement): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    out.push(...assignedHere(sf, node));
    ts.forEachChild(node, visit);
  };
  visit(stmt);
  return out;
}

function statementTaints(sf: ts.SourceFile, block: StatementList): ReadonlyArray<StatementTaint> {
  const cached = blockTaints.get(block);
  if (cached !== undefined) return cached;
  const taints = block.statements.map((stmt): StatementTaint => {
    const declared: string[] = [];
    const bad = new Set<string>();
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        declared.push(...boundNames(decl.name));
        for (const n of taintedByDeclaration(sf, decl)) bad.add(n);
      }
    }
    return { end: stmt.end, declared, bad, assigned: assignedFromRefused(sf, stmt) };
  });
  blockTaints.set(block, taints);
  return taints;
}

/**
 * Spec 140 s2d review round 2 (security #4, code-review #8) — the locals in
 * scope at `call` that were destructured or assigned off an error-ish base
 * (`const { x } = e`, `const x = e.y`, `const x = e`), unless the field is a
 * token (`code` / `kind` / `name`) or an annotated {@link TOKEN_FIELDS_BY_TYPE}
 * field. Lexical: the `const` / `let` statements before the call in each
 * enclosing block, the innermost declaration of a name deciding it, and a
 * function's parameters shadowing an outer local. One hop only: a local read
 * off a tainted local is not followed.
 *
 * Review round 3 (code-review #6, #9, #10) — any refused initializer taints
 * ({@link taintedByDeclaration}); so does a reassignment from a refused value
 * before the call ({@link assignedFromRefused}), and the binding of an
 * enclosing `for (… of …)` / `for (… in …)` over a refused value. Each block
 * is judged once ({@link blockTaints}).
 *
 * Review round 4 (code-review #1) — an assignment's taint is kept apart from a
 * declaration's: the outer block that declares the binding (`let m = ''`) runs
 * after the inner block that assigned it (`m = e.message`) in this walk, and
 * must not clear it. An enclosing `for (x of e.y)` over an earlier binding
 * taints `x` the same way.
 */
function taintedNames(sf: ts.SourceFile, call: ts.Node): ReadonlySet<string> {
  const tainted = new Set<string>();
  const assignedTaint = new Set<string>();
  const decided = new Set<string>();
  for (let cur: ts.Node | undefined = call.parent; cur !== undefined; cur = cur.parent) {
    if (ts.isFunctionLike(cur)) {
      for (const p of cur.parameters) for (const n of boundNames(p.name)) decided.add(n);
    }
    if ((ts.isForOfStatement(cur) || ts.isForInStatement(cur)) && !ts.isVariableDeclarationList(cur.initializer)) {
      for (const n of assignedHere(sf, cur)) if (!decided.has(n)) assignedTaint.add(n);
      continue;
    }
    if ((ts.isForOfStatement(cur) || ts.isForInStatement(cur)) && ts.isVariableDeclarationList(cur.initializer)) {
      const bad = refusal(sf, cur.expression, { errors: caughtNames(cur), tokens: TOKEN_FIELDS }) !== null;
      for (const decl of cur.initializer.declarations) {
        for (const n of boundNames(decl.name)) {
          if (decided.has(n)) continue;
          decided.add(n);
          if (bad) tainted.add(n);
        }
      }
      continue;
    }
    if (!(ts.isBlock(cur) || ts.isSourceFile(cur) || ts.isCaseClause(cur) || ts.isDefaultClause(cur) || ts.isModuleBlock(cur))) {
      continue;
    }
    const level = new Set<string>();
    for (const stmt of statementTaints(sf, cur)) {
      if (stmt.end > call.pos) continue;
      for (const n of stmt.declared) {
        if (decided.has(n)) continue;
        level.add(n);
        if (stmt.bad.has(n)) tainted.add(n);
        else tainted.delete(n);
      }
      for (const n of stmt.assigned) if (!decided.has(n)) assignedTaint.add(n);
    }
    for (const n of level) decided.add(n);
  }
  for (const n of assignedTaint) tainted.add(n);
  return tainted;
}

function isErrorIdentifier(name: string, scope: Scope): boolean {
  // Review round 1 — a scope binding is an error whatever it is called.
  if (scope.errors.has(name)) return true;
  if (SAFE_NAME.test(name)) return false;
  return ERROR_NAMES.has(name) || ERROR_SUFFIX.test(name);
}

/** What an expression yields: an error object, error text, a token read off an error, or none of these. */
type Shape = 'error' | 'text' | 'token' | null;

function shapeOf(expr: ts.Expression, scope: Scope): Shape {
  const node = unwrap(expr);
  if (ts.isIdentifier(node)) return isErrorIdentifier(node.text, scope) ? 'error' : null;
  if (ts.isPropertyAccessExpression(node)) {
    const field = node.name.text;
    const base = shapeOf(node.expression, scope);
    if (TEXT_FIELDS.has(field)) return 'text';
    if (base === 'error') return scope.tokens.has(field) ? 'token' : 'error';
    if (base === 'text') return 'text';
    if (base === 'token') return 'token';
    return OBJECT_FIELDS.has(field) ? 'error' : null;
  }
  if (ts.isElementAccessExpression(node)) {
    const base = shapeOf(node.expression, scope);
    return base === 'error' || base === 'text' ? 'error' : null;
  }
  return null;
}

/** The first refusal inside a literal argument, walked like a fields object. */
function literalRefusal(sf: ts.SourceFile, node: ts.Expression, scope: Scope): string | null {
  const inner: LogErrorFinding[] = [];
  checkContainer(sf, node, scope, inner);
  return inner[0]?.message ?? null;
}

/** Why `expr` would put error text or an error object on the line, or null. */
function refusal(sf: ts.SourceFile, expr: ts.Expression, scope: Scope): string | null {
  const node = unwrap(expr);

  if (ts.isIdentifier(node)) {
    return isErrorIdentifier(node.text, scope) ? `the error object \`${node.text}\`` : null;
  }

  if (ts.isPropertyAccessExpression(node)) {
    const field = node.name.text;
    const base = unwrap(node.expression);
    if (ts.isCallExpression(base) && calleeName(base) === 'classifyThrown') {
      return CLASSIFY_SAFE_FIELDS.has(field) ? null : `\`classifyThrown(…).${field}\` (only .kind is a closed token)`;
    }
    if (TEXT_FIELDS.has(field)) return `\`.${field}\``;
    const baseShape = shapeOf(base, scope);
    if (baseShape === 'text') return `\`.${field}\` of error text`;
    if (baseShape === 'error') {
      if (scope.tokens.has(field)) return null;
      return OBJECT_FIELDS.has(field)
        ? `the error object \`.${field}\``
        : `\`.${field}\` of an error (only .code / .kind / .name)`;
    }
    if (baseShape === null && OBJECT_FIELDS.has(field)) return `the error object \`.${field}\``;
    // `x.error.code` / `x.error.kind`, or a field of a non-error value — allowed.
    return null;
  }

  if (ts.isElementAccessExpression(node)) {
    const baseShape = shapeOf(node.expression, scope);
    return baseShape === 'error' || baseShape === 'text' ? 'element access on an error or its text' : null;
  }

  if (ts.isCallExpression(node)) {
    const name = calleeName(node);
    if (name !== null && SAFE_CALLS.has(name)) return null;
    if (name === 'classifyThrown') return '`classifyThrown(…)` whole (its `reason` is the message)';
    const callee = unwrap(node.expression);
    if (ts.isPropertyAccessExpression(callee)) {
      const receiver = shapeOf(callee.expression, scope);
      if (receiver === 'error' || receiver === 'text') {
        return `\`.${callee.name.text}()\` on an error or its text`;
      }
    }
    for (const arg of node.arguments) {
      const a = unwrap(arg);
      const inner =
        ts.isObjectLiteralExpression(a) || ts.isArrayLiteralExpression(a)
          ? literalRefusal(sf, a, scope)
          : refusal(sf, arg, scope);
      if (inner !== null) return `\`${name ?? 'a call'}(…)\` of ${inner}`;
    }
    return null;
  }

  if (ts.isTemplateExpression(node)) {
    for (const span of node.templateSpans) {
      const inner = refusal(sf, span.expression, scope);
      if (inner !== null) return `a template embedding ${inner}`;
    }
    return null;
  }

  if (ts.isConditionalExpression(node)) {
    return refusal(sf, node.whenTrue, scope) ?? refusal(sf, node.whenFalse, scope);
  }

  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (
      op === ts.SyntaxKind.QuestionQuestionToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.PlusToken
    ) {
      return refusal(sf, node.left, scope) ?? refusal(sf, node.right, scope);
    }
    return null;
  }

  if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) {
    // Nested containers are walked by `checkContainer`; a refusal here is reported there.
    return null;
  }

  return null;
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function checkContainer(
  sf: ts.SourceFile,
  node: ts.Expression,
  scope: Scope,
  out: LogErrorFinding[],
): void {
  const n = unwrap(node);
  if (ts.isObjectLiteralExpression(n)) {
    for (const prop of n.properties) {
      if (ts.isShorthandPropertyAssignment(prop)) {
        if (isErrorIdentifier(prop.name.text, scope)) {
          out.push({ line: lineOf(sf, prop), message: `shorthand \`{ ${prop.name.text} }\` logs the error object` });
        }
      } else if (ts.isSpreadAssignment(prop)) {
        const why = refusal(sf, prop.expression, scope);
        if (why !== null) out.push({ line: lineOf(sf, prop), message: `spread of ${why}` });
      } else if (ts.isPropertyAssignment(prop)) {
        const init = unwrap(prop.initializer);
        if (ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init)) {
          checkContainer(sf, init, scope, out);
        } else {
          const why = refusal(sf, prop.initializer, scope);
          if (why !== null) out.push({ line: lineOf(sf, prop), message: `${prop.name.getText(sf)}: ${why}` });
        }
      }
    }
    return;
  }
  if (ts.isArrayLiteralExpression(n)) {
    for (const el of n.elements) checkContainer(sf, el, scope, out);
    return;
  }
  const why = refusal(sf, n, scope);
  if (why !== null) out.push({ line: lineOf(sf, n), message: why });
}

/**
 * Every refused value inside the arguments of each `logger.<level>(…)` and
 * `logger.child(…)` call, and how many such calls were read. The first
 * argument is the fields object; later arguments (the message and any
 * interpolation) are checked the same way, so a template message that embeds
 * `e.message` is refused too.
 */
export function scanLogErrorObjects(fileName: string, source: string): LogErrorScan {
  const kind = /\.tsx$/i.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const findings: LogErrorFinding[] = [];
  let loggerCalls = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isLoggerCall(node)) {
      loggerCalls += 1;
      const scope: Scope = { errors: new Set([...caughtNames(node), ...taintedNames(sf, node)]), tokens: TOKEN_FIELDS };
      for (const arg of node.arguments) checkContainer(sf, arg, scope, findings);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { findings, loggerCalls };
}

/** The findings of {@link scanLogErrorObjects} alone. */
export function findLogErrorObjects(fileName: string, source: string): LogErrorFinding[] {
  return scanLogErrorObjects(fileName, source).findings;
}
