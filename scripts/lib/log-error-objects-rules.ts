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
  /**
   * #740 B2 — every function whose own parameter reaches a log line (directly,
   * as a spread, or through a registered wrapper's checked argument), with that
   * parameter's index. The runner fails on a {@link LOG_WRAPPERS} entry that no
   * longer matches one.
   */
  readonly wrappers: ReadonlyArray<{ readonly name: string; readonly index: number }>;
}

/**
 * #740 B2 — reviewed log wrappers: a function that puts one of its parameters
 * into a log line, keyed by name, with the argument indexes its call sites
 * must keep free of error text. Each call `name(…)` (or `x.name(…)`) has those
 * arguments checked exactly like a logger call's. A new wrapper fails the gate
 * until it is listed here, so a wrapper is a visible decision, not a blind spot
 * — for the shapes discovery follows: a parameter logged as the value, as a
 * spread, or under an error-detail key (`ERRORISH_KEYS`). Not followed: a
 * parameter copied into a local first, a destructured parameter, a property of
 * a parameter, and a call through an alias. Names are global: a generic one
 * (`fail`) would match unrelated calls, so a wrapper gets a specific name.
 * A LoggerPort adapter's level method (`warn(message, meta)`) is not listed:
 * its callers write `deps.logger.<level>(…)`, which is read already.
 */
export const LOG_WRAPPERS: Readonly<Record<string, readonly number[]>> = {
  // lib/logger.ts — `logger.child(context)`.
  loggerFor: [0],
  // broadcasts: the audit-emit failure line (context, log key).
  logAuditEmitFailure: [1, 2],
  // broadcasts `_dispatch-retry-epoch.ts` — the audit event names it logs.
  dispatchRetryEpoch: [4],
  resetDispatchRetryClock: [2],
  // broadcasts `_dispatch-standing-gate.ts` / `_probe-refused-send.ts` — ids only.
  deleteDraftBeforeErasedRefusal: [1],
  probeRefusedSend: [1],
  // broadcasts `_safe-audit-emit.ts` — extra context on the failure line.
  safeAuditEmit: [3],
  // broadcasts `build-audience-tick.ts` — the lease-lost fields.
  logLeaseLostAfterSend: [0],
  // broadcasts `cancel-in-flight-broadcasts-for-member.ts` — messages and extra context.
  countUnexpected: [3],
  orphanUnexpected: [2, 3],
  reportStuck: [2],
  // the same file's outcome map, which forwards to `orphanUnexpected`.
  undecided: [1, 2],
  // events `import-csv.ts` — the audit-emit failure line (message, context).
  recordAuditEmitFailure: [3, 4],
  // invoicing `drizzle-credit-note-repo.ts` — the idempotent read's log context.
  findOneIdempotent: [3],
  // members `submit-change-request.ts` / `drizzle-change-request-repo.ts` — ids only.
  mapLoadError: [1],
  corruptRow: [1],
  // renewals `_lib/` — shared warning and unexpected-error lines.
  logSupersedeWarnings: [1],
  logUnexpectedError: [2],
  // #740 B2 review: parameters logged under an error-detail key (`err: code`, `{ reason }`).
  /** payments sweep-stale-pending-refunds: `reason` of an escalated refund. */
  escalate: [4],
  maybeEscalate: [4],
  /** renewals verify-renewal-link-token: the token-invalid `reason`. */
  emitTokenInvalid: [3],
  /** renewals drizzle-renewal-audit-emitter: the fallback log's `reason`. */
  pinoFallback: [2],
  /** admin change-requests and member-changes pages: the failure `code`. */
  failQueuePage: [1],
  failMemberChangesPage: [1],
  /** admin broadcasts version route: the 500's `kind`. */
  logVersionServerError: [0],
  /** outbox-dispatch: the receipt gate's skip `code`. */
  gateFail: [0],
  /** resend-broadcasts webhook: the unattributed opt-out `reason`. */
  auditUnattributedOptOut: [0],
  /** stripe webhook: the rejected delivery's `reason`. */
  auditReject: [1],
};

const LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'child']);
/** #739 B3b — `console.<method>` calls a server file makes land in the function log like a logger call. */
const CONSOLE_LEVELS = new Set(['log', 'info', 'warn', 'error', 'debug', 'trace']);

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
 * (`src/lib/db-errors.ts`), or null; never the message. #739 PR 2 —
 * `errClassWithCode` an error class, plus `:` and a SQLSTATE matched by
 * `[0-9A-Z]{5}` when the cause chain holds one (`src/lib/log-id.ts`).
 */
const SAFE_CALLS = new Set([
  'errKind',
  'errClassWithCode',
  'pgErrorCode',
  'pgErrorMeta',
  'hashId',
  'errLogFields',
  'errStep',
  'stepToken',
  'gatewayField',
  'approvalErrKind',
  'retryableSubKind',
  'isTimeout',
  'Number.isFinite',
  'primaryContactTriggerViolation',
  // renewals `renewal-gateway.ts` — an exhaustive switch over the closed
  // `SendRenewalEmailError['kind']` union that returns a boolean (#740 B1).
  'isPermanentGatewayError',
  // events `_helpers/format-error-with-cause.ts` — the class chain
  // `Outer(cause:Inner)` from `errKind` / a token-shaped `.name` (#739).
  'formatErrorClass',
  // `src/lib/otel-tracer.ts` — sets the span status to `errKind(e)` (#739).
  'markSpanFailed',
]);
/** The only fields of `classifyThrown(e)` that are closed tokens (`reason` carries the message). */
const CLASSIFY_SAFE_FIELDS = new Set(['kind', 'subKind', 'resourceType']);
/** Error fields that carry text from the error itself. */
const TEXT_FIELDS = new Set(['message', 'stack']);
/** Accesses that yield an error object. */
const OBJECT_FIELDS = new Set(['error', 'cause']);
/** The only fields read off an error-ish base: closed tokens. */
const TOKEN_FIELDS = new Set(['code', 'kind', 'name']);

function isLoggerTarget(target: ts.Expression, aliases: ReadonlySet<string>): boolean {
  if (ts.isIdentifier(target)) return target.text === 'logger' || aliases.has(target.text);
  return ts.isPropertyAccessExpression(target) && target.name.text === 'logger';
}

function isLoggerCall(node: ts.CallExpression, aliases: ReadonlySet<string> = new Set()): boolean {
  const callee = node.expression;
  // #739 B3b — `logger[level](…)`: a computed level is still a logger call.
  if (ts.isElementAccessExpression(callee)) {
    if (ts.isIdentifier(callee.expression) && callee.expression.text === 'console') return aliases.has(SERVER_CONSOLE);
    return isLoggerTarget(callee.expression, aliases);
  }
  if (!ts.isPropertyAccessExpression(callee)) return false;
  // #739 B3b — a server file's `console.warn(…)` reaches the same log stream.
  if (ts.isIdentifier(callee.expression) && callee.expression.text === 'console') {
    return aliases.has(SERVER_CONSOLE) && CONSOLE_LEVELS.has(callee.name.text);
  }
  if (!LEVELS.has(callee.name.text)) return false;
  return isLoggerTarget(callee.expression, aliases);
}

/**
 * #739 B3b — a marker in the alias set: the file is server code (no leading
 * `'use client'` directive), so its `console.*` calls are logger calls. A
 * client component's console stays in the browser. Read from the parsed
 * directive, so a BOM, CRLF or a leading comment cannot hide it.
 */
const SERVER_CONSOLE = '\u0000server-console';

function isClientFile(sf: ts.SourceFile): boolean {
  for (const stmt of sf.statements) {
    if (!ts.isExpressionStatement(stmt) || !ts.isStringLiteral(stmt.expression)) return false;
    if (stmt.expression.text === 'use client') return true;
  }
  return false;
}

/**
 * #740 B2 review — locals that hold a logger: `const log = deps.logger`,
 * `const log = logger.child({ … })`. Calls on them are logger calls too, so a
 * file cannot step around the rule by renaming its logger. Matched by name in
 * the whole file: a tripwire, not a scope analysis.
 */
function loggerAliases(sf: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  const holdsLogger = (init: ts.Expression): boolean => {
    const n = unwrap(init);
    if (isLoggerTarget(n, names)) return true;
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'child') {
      return isLoggerTarget(unwrap(n.expression.expression), names);
    }
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined && holdsLogger(node.initializer)) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!isClientFile(sf)) names.add(SERVER_CONSOLE);
  return names;
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

/**
 * #739 B3b — what a file holds from `Promise.allSettled`: the identifiers
 * bound to a settled list (`const s = await Promise.allSettled(…)`, an alias
 * `const t = s`, or `s.filter(…)`), and the identifiers bound to one element
 * (`const [a, b] = await Promise.allSettled(…)`). An element's `.reason` is a
 * rejection value, an error like a catch binding's.
 */
interface SettledInfo {
  readonly lists: ReadonlySet<string>;
  readonly elements: ReadonlySet<string>;
}
const settledInfoCache = new WeakMap<ts.SourceFile, SettledInfo>();
/** The list methods whose result is still a settled list. */
const SETTLED_LIST_METHODS = new Set(['filter', 'slice', 'concat', 'reverse', 'sort', 'toReversed', 'toSorted']);
function isSettledListExpr(expr: ts.Expression, lists: ReadonlySet<string>): boolean {
  const n = unwrap(expr);
  if (ts.isIdentifier(n)) return lists.has(n.text);
  if (!ts.isCallExpression(n)) return false;
  if (calleeName(n) === 'Promise.allSettled') return true;
  const callee = unwrap(n.expression);
  return ts.isPropertyAccessExpression(callee) && SETTLED_LIST_METHODS.has(callee.name.text) && isSettledListExpr(callee.expression, lists);
}
function settledInfo(sf: ts.SourceFile): SettledInfo {
  const cached = settledInfoCache.get(sf);
  if (cached !== undefined) return cached;
  const lists = new Set<string>();
  const elements = new Set<string>();
  // Two passes, so an alias declared before its source is read too.
  for (let pass = 0; pass < 2; pass += 1) {
    const visit = (n: ts.Node): void => {
      // `Promise.allSettled(ps).then((rs) => …)`: the callback's parameter is the list.
      if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isCallExpression(n.parent) && n.parent.arguments[0] === n) {
        const callee = unwrap(n.parent.expression);
        const p0 = n.parameters[0];
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'then' && isSettledListExpr(callee.expression, lists) && p0 !== undefined && ts.isIdentifier(p0.name)) {
          lists.add(p0.name.text);
        }
      }
      if (ts.isVariableDeclaration(n) && n.initializer !== undefined && isSettledListExpr(n.initializer, lists)) {
        if (ts.isIdentifier(n.name)) lists.add(n.name.text);
        else if (ts.isArrayBindingPattern(n.name)) {
          for (const el of n.name.elements) {
            if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
              (el.dotDotDotToken !== undefined ? lists : elements).add(el.name.text);
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  const info = { lists, elements };
  settledInfoCache.set(sf, info);
  return info;
}

/**
 * A marker in the caught set: in a file that holds allSettled results, a
 * `.reason` read off one element in a form with no name of its own
 * (`s[0].reason`, a destructured `a.reason`) is a caught value.
 */
const SETTLED_REASON = '\u0000settled-reason';

/** The callback of `s.map(…)` / `.forEach(…)` / … over an allSettled list, whose first parameter is one settled element. */
const SETTLED_ITERATORS = new Set(['map', 'forEach', 'flatMap', 'filter', 'find', 'findLast', 'some', 'every', 'reduce']);
function isSettledCallback(fn: ts.Node): fn is ts.ArrowFunction | ts.FunctionExpression {
  if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return false;
  const call = fn.parent;
  if (!ts.isCallExpression(call) || !call.arguments.includes(fn)) return false;
  const callee = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || !SETTLED_ITERATORS.has(callee.name.text)) return false;
  return isSettledListExpr(callee.expression, settledInfo(fn.getSourceFile()).lists);
}
/** The caught names one enclosing node binds from an allSettled element: `r.reason`, or a destructured `reason`. */
function settledCaughtNames(cur: ts.Node): string[] {
  let binding: ts.BindingName | undefined;
  if (isSettledCallback(cur)) {
    const call = cur.parent as ts.CallExpression;
    const callee = unwrap(call.expression) as ts.PropertyAccessExpression;
    binding = cur.parameters[callee.name.text === 'reduce' ? 1 : 0]?.name;
  } else if (ts.isForOfStatement(cur) && ts.isVariableDeclarationList(cur.initializer)) {
    const lists = settledInfo(cur.getSourceFile()).lists;
    const decl = cur.initializer.declarations[0]?.name;
    const iterated = unwrap(cur.expression);
    if (isSettledListExpr(iterated, lists)) binding = decl;
    // `for (const [i, r] of settled.entries())`: the element is the second binding.
    else if (
      ts.isCallExpression(iterated) &&
      ts.isPropertyAccessExpression(unwrap(iterated.expression)) &&
      (unwrap(iterated.expression) as ts.PropertyAccessExpression).name.text === 'entries' &&
      isSettledListExpr((unwrap(iterated.expression) as ts.PropertyAccessExpression).expression, lists) &&
      decl !== undefined &&
      ts.isArrayBindingPattern(decl)
    ) {
      const el = decl.elements[1];
      if (el !== undefined && ts.isBindingElement(el)) binding = el.name;
    }
  }
  if (binding === undefined) return [];
  if (ts.isIdentifier(binding)) return [`${binding.text}.reason`];
  if (ts.isObjectBindingPattern(binding)) {
    const out: string[] = [];
    for (const el of binding.elements) {
      const key = el.propertyName ?? el.name;
      if (ts.isIdentifier(key) && key.text === 'reason' && ts.isIdentifier(el.name)) out.push(el.name.text);
    }
    return out;
  }
  return [];
}

/**
 * #739 B3b part 2 — the rejection handler of `.catch(h)` or `.then(ok, h)`:
 * its first parameter is a caught value.
 */
function isRejectionHandler(fn: ts.Node): fn is ts.ArrowFunction | ts.FunctionExpression {
  if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return false;
  const call = fn.parent;
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return false;
  const method = call.expression.name.text;
  return (method === 'catch' && call.arguments[0] === fn) || (method === 'then' && call.arguments[1] === fn);
}

/** Untyped parameters with one of these names are read as an error a caller caught. */
const ERROR_PARAM_NAMES = new Set(['e', 'err', 'error', 'cause']);

/**
 * #739 B3b part 2 — the parameters of a plain function that may hold an error
 * its caller caught: typed `unknown`, or untyped and named like an error. A
 * helper that turns such a parameter into a Result has no catch around it.
 * Only their text counts ({@link caughtTextRefusal}'s `textOnly`): passing the
 * value on (`parse(e)`, `errKind(e)`) is what such a parameter is for.
 */
function errorParamNames(fn: ts.Node): string[] {
  if (!ts.isFunctionLike(fn) || isRejectionHandler(fn) || isSettledCallback(fn)) return [];
  const out: string[] = [];
  for (const p of fn.parameters) {
    if (!ts.isIdentifier(p.name)) continue;
    const typedUnknown = p.type?.kind === ts.SyntaxKind.UnknownKeyword;
    if (typedUnknown || (p.type === undefined && ERROR_PARAM_NAMES.has(p.name.text))) out.push(p.name.text);
  }
  return out;
}

/** #739 B3b part 2 — the locals a binding pattern takes from an error's text: `{ message }`, `{ stack: s }`. */
function textBindings(binding: ts.BindingName | undefined): string[] {
  if (binding === undefined || !ts.isObjectBindingPattern(binding)) return [];
  const out: string[] = [];
  for (const el of binding.elements) {
    const key = el.propertyName ?? el.name;
    if (ts.isIdentifier(key) && TEXT_FIELDS.has(key.text) && ts.isIdentifier(el.name)) out.push(el.name.text);
  }
  return out;
}

/**
 * Where a caught value is in scope: a catch block, a rejection handler, an
 * allSettled element callback, a `for (r of settled)` body, or the body of a
 * function whose parameter may hold a caught error.
 */
function catchScopeBody(cur: ts.Node): ts.Node | null {
  if (ts.isCatchClause(cur)) return cur.block;
  if (isRejectionHandler(cur)) return cur.body;
  if (settledCaughtNames(cur).length > 0) return isSettledCallback(cur) ? cur.body : (cur as ts.ForOfStatement).statement;
  if (errorParamNames(cur).length > 0) return (cur as ts.FunctionLikeDeclaration).body ?? null;
  return null;
}

/** #739 B3b part 2 — the error-like parameters of every enclosing function (see {@link errorParamNames}). */
function paramTextNames(node: ts.Node): ReadonlySet<string> {
  const names = new Set<string>();
  for (let cur: ts.Node | undefined = node.parent; cur !== undefined; cur = cur.parent) {
    for (const n of errorParamNames(cur)) names.add(n);
  }
  return names;
}

/**
 * #739 B3b part 2 — catch, rejection-handler, settled and error-parameter
 * scopes in a file: the real-tree floor, so a parse that rots fails loudly.
 */
export function countCaughtScopes(fileName: string, source: string): number {
  const kind = /\.tsx$/i.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  let count = 0;
  const visit = (n: ts.Node): void => {
    if (ts.isCatchClause(n) ? n.variableDeclaration !== undefined : catchScopeBody(n) !== null) count += 1;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return count;
}

/**
 * Names bound by every enclosing `catch (x)` clause and `.catch((x) => …)`
 * callback, plus `r.reason` for the element `r` of an enclosing allSettled
 * callback (#739 B3b; matched by its text, see {@link exprKey}).
 */
function caughtNames(node: ts.Node): ReadonlySet<string> {
  const names = new Set<string>();
  for (let cur: ts.Node | undefined = node; cur !== undefined; cur = cur.parent) {
    for (const n of settledCaughtNames(cur)) names.add(n);
    if (ts.isSourceFile(cur)) {
      const info = settledInfo(cur);
      if (info.lists.size > 0 || info.elements.size > 0) names.add(SETTLED_REASON);
    }
    if (ts.isCatchClause(cur) && cur.variableDeclaration) {
      const b = cur.variableDeclaration.name;
      if (ts.isIdentifier(b)) names.add(b.text);
      // #739 B3b part 2 — `catch ({ message })`: the local is the text.
      for (const n of textBindings(b)) names.add(n);
    }
    // `.catch((x) => …)`, and (#739 B3b part 2) `.then(ok, (x) => …)`.
    if (isRejectionHandler(cur)) {
      const p = cur.parameters[0];
      if (p !== undefined && ts.isIdentifier(p.name)) names.add(p.name.text);
      for (const n of textBindings(p?.name)) names.add(n);
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
  // renewals `cancel-in-flight-cycles-for-member.ts` — its one construction
  // site sets `errClass: errKind(e)`, an error class name (#711).
  CancelInFlightCyclesForMemberError: new Set(['errClass']),
  // auth `EnqueueInvitationError` — its one construction site
  // (`src/lib/auth-deps.ts`) sets `errClass: errKind(e)`, an error class
  // name (#739 B3b), and `sqlState: pgErrorCode(e)`, a SQLSTATE (B3b part 2).
  EnqueueInvitationError: new Set(['errClass', 'sqlState']),
  // renewals `restore-cycle-for-member.ts` — `errName` is an Error's `.name`
  // or `'UnknownError'`, as above.
  RestoreCycleForMemberError: new Set(['errName']),
  // `mark-invitation-bounced.ts` — `type` is the literal `'server_error'`.
  MarkInvitationBouncedError: new Set(['type']),
  // `build-audience-tick.ts` — a descriptor the tick builds, not a thrown
  // error: `reason` is `ImportFailureReason` (a const tuple of literals),
  // `importId` an opaque Resend import id or null, `observed` / `expected`
  // numbers or null. #740 B2: `errClass` is `errKind(e)`, a literal, a
  // `classifyThrown(e).kind`, `ResolveSegmentError['errClass']` or the
  // standing gate's closed class; `resourceType` a closed union; `resourceId`
  // an opaque Resend id (or the row's broadcast uuid); `step` a code-authored
  // `leaseGate` step literal.
  BuildAudienceTickError: new Set([
    'reason',
    'importId',
    'observed',
    'expected',
    'errClass',
    'resourceType',
    'resourceId',
    'step',
  ]),
  // payments `stripe-gateway.ts` (#740) — `statusCode` is the SDK's HTTP
  // status number; never Stripe's message text.
  StripeErrorShape: new Set(['statusCode']),
  // invoicing `credit-note.ts` `assertCreditNoteVatBalance` (#740) — three
  // bigint satang amounts copied from the CN row's money columns.
  CreditNoteBalanceError: new Set(['creditAmountSatang', 'vatSatang', 'totalSatang']),
  // events `drizzle-events-repository.ts` / `drizzle-registrations-repository.ts`
  // (#740) — `invariant` is a code-authored sentence at every construction
  // site (a literal, or a template over a closed method-name union); never
  // driver or row text.
  EventsRepositoryError: new Set(['invariant']),
  RegistrationsRepositoryError: new Set(['invariant']),
  // events `process-attendee-in-tx.ts` (#740) — `stage` is `FailureStage`, a
  // closed union of literals.
  TxStageError: new Set(['stage']),
  // events `tenant-webhook-config.ts` (#740) — two booleans (whether the
  // grace secret / rotated-at column was set); never the secret.
  GraceStateInvariantError: new Set(['rawSecretWasSet', 'rawRotatedAtWasSet']),
  // renewals `drizzle-renewal-cycle-repo.ts` (#740) — invoice uuids, or the
  // literal `'<unexpected-null>'`.
  InvoiceLinkConflictError: new Set(['attemptedInvoiceId', 'existingInvoiceId']),
  // renewals `cancel-in-flight-cycles-for-member.ts` (#740) — its one
  // construction site sets `underlyingErrorName: errKind(auditErr)` and
  // `underlyingErrorCode` from the thrown error's own string `.code` — the
  // same value the rule accepts as `e.code` inline.
  AuditEmitError: new Set(['underlyingErrorName', 'underlyingErrorCode']),
  // renewals `mark-paid-offline.ts` (#740) — the F4 bridge's issued invoice uuid.
  OrphanInvoiceRollback: new Set(['orphanInvoiceId']),
  // renewals `renewal-cycle-repo.ts` (#740) — both `CycleStatus`, a DB enum.
  CycleTransitionConflictError: new Set(['expectedFrom', 'actualStatus']),
  // renewals `drizzle-tier-upgrade-suggestion-repo.ts` (#740) — the row's
  // `status` enum column, or a status literal (`accept-tier-upgrade.ts`).
  TierUpgradeStatusConflictError: new Set(['actualStatus']),
  // renewals `create-cycle-in-tx.ts` (#740) — `'not_found' | 'plan_inactive'`.
  PlanNotResolvableError: new Set(['planStatus']),
  // events `relink-registration.ts` (#740 B2) — branded `EventId` /
  // `RegistrationId` uuids: the path's UUID-gated id, the row's `event_id`.
  RelinkRegistrationError: new Set(['eventIdInPath', 'eventIdOnRegistration', 'registrationId']),
  // broadcasts `cancel-in-flight-broadcasts-for-member.ts` (#740 B2) — each
  // construction site passes a closed `DeleteKind`, or `${DeleteKind}_probe_${ProbedStatus}`
  // (both closed unions; `normaliseStatus` maps Resend's status to a literal).
  ResendUnsettledError: new Set(['outcome']),
  // broadcasts approval `list-broadcast-versions.ts` / `get-member-version-thread.ts`
  // (#740 B2) — the one `server_error` construction sets `errKind: errKind(e)`.
  ListBroadcastVersionsError: new Set(['errKind']),
  GetMemberVersionThreadError: new Set(['errKind']),
  // broadcasts `cancel-broadcast.ts`, `approve-broadcast.ts`, `reject-broadcast.ts`,
  // approval `send-version-to-member.ts`, `confirm-schedule.ts`,
  // `record-member-decision.ts` (#740 B2) — the one `server_error`
  // construction in each sets `errKind: errKind(e)` or `approvalErrKind(e)`.
  CancelBroadcastError: new Set(['errKind']),
  ApproveBroadcastError: new Set(['errKind']),
  RejectBroadcastError: new Set(['errKind']),
  SendVersionToMemberError: new Set(['errKind']),
  ConfirmScheduleError: new Set(['errKind']),
  RecordMemberDecisionError: new Set(['errKind']),
  // broadcasts `set-brand-settings.ts`, `expire-stale-member-approvals.ts`,
  // `read-formatting-warnings.ts` (#740 B2) — `errKind(e)` / `approvalErrKind(e)`.
  SetBrandSettingsError: new Set(['errKind']),
  ExpireStaleMemberApprovalsError: new Set(['errKind']),
  ReadFormattingWarningsError: new Set(['errKind']),
  // broadcasts `read-dispatch-hold.ts` (#740 B2) — `errClass` comes from
  // `_dispatch-standing-gate.ts`: a literal, `errKind(e)`, or a
  // `MembershipAccessLookupError['kind']` union member.
  ReadDispatchHoldError: new Set(['errClass']),
  // broadcasts `cleanup-orphaned-audiences.ts` (#740 B2) — `errClass: errKind(e)`;
  // `orphans` is `OrphanDrainOutput`, numbers and booleans only.
  CleanupOrphanedAudiencesError: new Set(['errClass', 'orphans']),
  // broadcasts `reconcile-stuck-sending.ts` (#740 B2) — `errClass: errKind(e)`.
  ReconcileStuckSendingError: new Set(['errClass']),
  // Two types share this name (#740 B2): broadcasts `process-webhook-event.ts`
  // — `errClass: errKind(e)`, `step: errStep(e)`, `reason` a literal plus an
  // `EmailLowerError` code; payments `process-webhook-event.ts` — `detail` a
  // sub-use-case code or `errKind` (an error class),
  // `subDetail` the F4 bridge code or `F5_SETTINGS_MISSING_DETAIL` /
  // `'invoice_payability_read_failed'`, a boolean, and `DispatchPermanence`.
  ProcessWebhookEventError: new Set([
    'errClass',
    'step',
    'reason',
    'detail',
    'subDetail',
    'retryCeilingExceeded',
    'permanence',
  ]),
  // broadcasts `sweep-expired-broadcasts.ts` (#740 B2) — a row count.
  SweepExpiredBroadcastsError: new Set(['sweptCount']),
  // auth `redeem-invite.ts` / `reset-password.ts` (#740 B2) — `reason` is
  // `TokenFailureReason`, `'not-found' | 'used' | 'expired'`.
  RedeemInviteError: new Set(['reason']),
  ResetPasswordError: new Set(['reason']),
  // invoicing `create-invoice-draft.ts` / renewals `mark-paid-offline.ts`
  // (#740 B2) — the live bill's `invoice_id` uuid and `status` enum column;
  // `stage` is the F4 bridge error's `kind`; `orphanInvoiceId` the bridge's
  // issued invoice uuid. NOT `reason`: on `f4_failure` / `f4_orphan_invoice`
  // it is error text.
  CreateInvoiceDraftError: new Set(['existingInvoiceId', 'existingStatus']),
  MarkPaidOfflineError: new Set(['existingInvoiceId', 'existingStatus', 'stage', 'orphanInvoiceId']),
  // invoicing `get-{invoice,receipt,credit-note}-pdf-signed-url.ts` (#740 B2) —
  // `key` is a server-built `invoicing/<tenant>/<fy>/<uuid>…_v<n>.pdf` path
  // (`issue-invoice.ts`, `render-receipt-pdf.ts`, `issue-credit-note.ts`, …),
  // read only on `blob_missing`: the object is gone, so the key opens nothing
  // (PG-1 holds), and the missing-PDF runbook reads it.
  GetInvoicePdfSignedUrlError: new Set(['key']),
  GetReceiptPdfSignedUrlError: new Set(['key']),
  GetCreditNotePdfSignedUrlError: new Set(['key']),
  // the mark-paid-offline route's own alias for the `f4_permanent_failure`
  // variant (#740 B2) — `reason` is `MarkPaidOfflinePermanentReason`, literals.
  MarkPaidOfflinePermanentFailure: new Set(['reason']),
  // lib `events-admin-integration-deps.ts` (#740 B2) — `errKind` is the
  // config repo error's own `kind`.
  TestWebhookConfigLoadFailed: new Set(['errKind']),
  // plans `search-plans.ts` (#740 B2) — `errKind: errKind(e)`.
  SearchPlansError: new Set(['errKind']),
  // payments `sweep-stale-pending-refunds.ts` (#740 B2) — `cause` is an error
  // class name, `'unknown'`, a literal, or a code-authored bound message.
  SweepStalePendingRefundsError: new Set(['cause']),
  // renewals `end-membership-coverage.ts` (#740 B2) — `errName` is an
  // Error's `.name` or `'UnknownError'` (its local `errName` helper).
  EndMembershipCoverageError: new Set(['errName']),
  // plans `scheduled-plan-change.ts` (#740 B2) — `'invalid_payload' | 'persist_failed'`.
  CancelScheduledPlanChangeError: new Set(['auditErrorType']),
  // members `invite-colleague.ts` (#740 B2) — `reason` is `InviteUnavailableReason`, literals.
  InviteColleagueError: new Set(['reason']),
  // the refunds initiate route's alias for the `f4_preflight_credit_note_blocked`
  // variant (#740 B2) — `reason` is `RefundCreditNoteBlockReason`, closed
  // literals and an `InvoiceStatus` enum value.
  RefundCreditNoteGateBlocked: new Set(['reason']),
  // events `ingest-webhook-attendee.ts` (#740 B2) — `FailureStage`, a closed
  // union of literals, and a boolean. Never `errorMessage`.
  IngestError: new Set(['failureStage', 'auditFallbackFailed']),
  // broadcasts `start-formatted-version.ts` / `save-formatted-version.ts`
  // (#740 B2 review) — the one `server_error` construction sets `errKind: errKind(e)`.
  StartFormattedVersionError: new Set(['errKind']),
  SaveFormattedVersionError: new Set(['errKind']),
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

/** `r.reason` as a name: a property access on an identifier, by text. */
function exprKey(node: ts.Expression): string | null {
  if (!ts.isPropertyAccessExpression(node)) return null;
  const base = unwrap(node.expression);
  if (node.name.text === 'reason') {
    const info = settledInfo(node.getSourceFile());
    // `a.reason` of a destructured element, or `s[0].reason` / `s.at(-1).reason` of a settled list.
    if (ts.isIdentifier(base) && info.elements.has(base.text)) return SETTLED_REASON;
    if (ts.isElementAccessExpression(base) && isSettledListExpr(base.expression, info.lists)) return SETTLED_REASON;
    if (ts.isCallExpression(base)) {
      const callee = unwrap(base.expression);
      if (ts.isPropertyAccessExpression(callee) && ['at', 'find', 'findLast'].includes(callee.name.text) && isSettledListExpr(callee.expression, info.lists)) {
        return SETTLED_REASON;
      }
    }
  }
  return ts.isIdentifier(base) ? `${base.text}.${node.name.text}` : null;
}

function shapeOf(expr: ts.Expression, scope: Scope): Shape {
  const node = unwrap(expr);
  if (ts.isIdentifier(node)) return isErrorIdentifier(node.text, scope) ? 'error' : null;
  const key = exprKey(node);
  if (key !== null && scope.errors.has(key)) return 'error';
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

  const settledKey = exprKey(node);
  if (settledKey !== null && scope.errors.has(settledKey)) return `the rejection value \`${node.getText()}\``;

  if (ts.isPropertyAccessExpression(node)) {
    const field = node.name.text;
    const base = unwrap(node.expression);
    if (ts.isCallExpression(base) && calleeName(base) === 'classifyThrown') {
      return CLASSIFY_SAFE_FIELDS.has(field) ? null : `\`classifyThrown(…).${field}\` (only .kind is a closed token)`;
    }
    if (TEXT_FIELDS.has(field)) return `\`.${field}\``;
    // A zod error's issue count is a number (#740 B2 review): `parsed.error.issues.length`.
    if (field === 'length' && ts.isPropertyAccessExpression(base) && base.name.text === 'issues') return null;
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

const LOGICAL_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
]);

/** Whether a value is, or has in a conditional / logical arm, an object or array literal. */
function hasContainer(node: ts.Expression): boolean {
  const n = unwrap(node);
  if (ts.isObjectLiteralExpression(n) || ts.isArrayLiteralExpression(n)) return true;
  if (ts.isConditionalExpression(n)) return hasContainer(n.whenTrue) || hasContainer(n.whenFalse);
  if (ts.isBinaryExpression(n) && LOGICAL_OPERATORS.has(n.operatorToken.kind)) {
    if (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return hasContainer(n.right);
    return hasContainer(n.left) || hasContainer(n.right);
  }
  return false;
}

/**
 * One value in a log line. An object or array literal is walked field by
 * field; the arms of a conditional or a `??` / `||` / `&&` are walked the same
 * way (#740 B2: `err: ok ? { message: e.message } : …`), so an object literal
 * in an arm is never skipped; anything else is a leaf `refusal` reports at `at`.
 */
function checkValue(
  sf: ts.SourceFile,
  node: ts.Expression,
  scope: Scope,
  out: LogErrorFinding[],
  describe: (why: string) => string,
  at: ts.Node,
): void {
  const n = unwrap(node);
  if (!hasContainer(n)) {
    const why = refusal(sf, n, scope);
    if (why !== null) out.push({ line: lineOf(sf, at), message: describe(why) });
    return;
  }
  if (ts.isConditionalExpression(n)) {
    checkValue(sf, n.whenTrue, scope, out, describe, at);
    checkValue(sf, n.whenFalse, scope, out, describe, at);
    return;
  }
  if (ts.isBinaryExpression(n) && LOGICAL_OPERATORS.has(n.operatorToken.kind)) {
    // `a && b` logs `a` only when it is falsy, so it carries nothing (#740 B2 review).
    if (n.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) checkValue(sf, n.left, scope, out, describe, at);
    checkValue(sf, n.right, scope, out, describe, at);
    return;
  }
  if (ts.isObjectLiteralExpression(n)) {
    for (const prop of n.properties) {
      if (ts.isShorthandPropertyAssignment(prop)) {
        if (isErrorIdentifier(prop.name.text, scope)) {
          out.push({ line: lineOf(sf, prop), message: `shorthand \`{ ${prop.name.text} }\` logs the error object` });
        }
      } else if (ts.isSpreadAssignment(prop)) {
        checkValue(sf, prop.expression, scope, out, (why) => `spread of ${why}`, prop);
      } else if (ts.isPropertyAssignment(prop)) {
        const key = prop.name.getText(sf);
        checkValue(sf, prop.initializer, scope, out, (why) => `${key}: ${why}`, prop);
      }
    }
    return;
  }
  if (ts.isArrayLiteralExpression(n)) {
    for (const el of n.elements) checkValue(sf, el, scope, out, describe, el);
    return;
  }
  const why = refusal(sf, n, scope);
  if (why !== null) out.push({ line: lineOf(sf, at), message: describe(why) });
}

function checkContainer(sf: ts.SourceFile, node: ts.Expression, scope: Scope, out: LogErrorFinding[]): void {
  checkValue(sf, node, scope, out, (why) => why, node);
}

/** The last name of a call's callee: `f(…)` → `f`, `a.b.f(…)` → `f`. */
function lastCalleeName(call: ts.CallExpression): string | null {
  const c = unwrap(call.expression);
  if (ts.isIdentifier(c)) return c.text;
  if (ts.isPropertyAccessExpression(c)) return c.name.text;
  return null;
}

/** The registered argument indexes of a log-wrapper call, or null. */
function wrapperIndexes(call: ts.CallExpression): readonly number[] | null {
  const name = lastCalleeName(call);
  return name !== null && Object.prototype.hasOwnProperty.call(LOG_WRAPPERS, name) ? (LOG_WRAPPERS[name] ?? null) : null;
}

type FunctionLike = ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression;

function functionName(fn: FunctionLike): string | null {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name !== undefined) return fn.name.getText();
  const parent = fn.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent)) return parent.name.getText();
  return null;
}

/**
 * Keys whose value is error detail by name. A parameter logged under one of
 * them (`err: code`, `{ detail }`) makes its function a log wrapper, the same
 * as a spread parameter does (#740 B2 review). Other keys (`tenantId`, `count`)
 * are not followed: they would make every use case a wrapper.
 */
const ERRORISH_KEYS = new Set([
  'err', 'error', 'cause', 'detail', 'details', 'reason', 'message', 'msg',
  'errMessage', 'errorMessage', 'errorDetail', 'stack', 'description', 'why',
]);

/**
 * Identifiers that reach a log argument as the value itself, as a spread, or
 * as the value of an {@link ERRORISH_KEYS} key (nested objects included).
 */
function reachingIdentifiers(arg: ts.Expression, out: ts.Identifier[] = []): ts.Identifier[] {
  const n = unwrap(arg);
  if (ts.isIdentifier(n)) out.push(n);
  else if (ts.isConditionalExpression(n)) {
    reachingIdentifiers(n.whenTrue, out);
    reachingIdentifiers(n.whenFalse, out);
  } else if (ts.isBinaryExpression(n) && LOGICAL_OPERATORS.has(n.operatorToken.kind)) {
    reachingIdentifiers(n.right, out);
    if (n.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) reachingIdentifiers(n.left, out);
  } else if (ts.isObjectLiteralExpression(n)) {
    for (const p of n.properties) {
      if (ts.isSpreadAssignment(p)) reachingIdentifiers(p.expression, out);
      else if (ts.isShorthandPropertyAssignment(p)) {
        if (ERRORISH_KEYS.has(p.name.text)) out.push(p.name);
      } else if (ts.isPropertyAssignment(p)) {
        const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
        const value = unwrap(p.initializer);
        if (key !== null && ERRORISH_KEYS.has(key)) reachingIdentifiers(value, out);
        else if (ts.isObjectLiteralExpression(value)) reachingIdentifiers(value, out);
      }
    }
  }
  return out;
}

/** The nearest enclosing function that declares `name` as a plain parameter, with its index. */
function owningParameter(node: ts.Node, name: string): { fn: FunctionLike; index: number } | null {
  for (let cur: ts.Node | undefined = node.parent; cur !== undefined; cur = cur.parent) {
    if (ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur) || ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) {
      const index = cur.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === name);
      if (index >= 0) return { fn: cur, index };
    }
  }
  return null;
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
  const wrappers: Array<{ name: string; index: number }> = [];
  let loggerCalls = 0;
  const aliases = loggerAliases(sf);
  const discover = (call: ts.CallExpression, args: readonly ts.Expression[]): void => {
    for (const arg of args) {
      for (const id of reachingIdentifiers(arg)) {
        const owner = owningParameter(call, id.text);
        if (owner === null) continue;
        const name = functionName(owner.fn);
        // A LoggerPort adapter's level method: its callers are read as `deps.logger.<level>(…)`.
        if (name !== null && LEVELS.has(name) && ts.isMethodDeclaration(owner.fn)) continue;
        if (name !== null && ts.isPropertyAssignment(owner.fn.parent) && LEVELS.has(name)) continue;
        if (name !== null) wrappers.push({ name, index: owner.index });
        if (name === null || !(LOG_WRAPPERS[name] ?? []).includes(owner.index)) {
          findings.push({
            line: lineOf(sf, call),
            message:
              name === null
                ? `the parameter \`${id.text}\` of an unnamed function reaches a log line; name the function and list it in LOG_WRAPPERS`
                : `the parameter \`${id.text}\` of \`${name}\` reaches a log line, so its callers' values are never read; list \`${name}: [${owner.index}]\` in LOG_WRAPPERS`,
          });
        }
      }
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (isLoggerCall(node, aliases)) {
        loggerCalls += 1;
        const scope: Scope = { errors: new Set([...caughtNames(node), ...taintedNames(sf, node)]), tokens: TOKEN_FIELDS };
        for (const arg of node.arguments) checkContainer(sf, arg, scope, findings);
        discover(node, node.arguments);
      } else {
        const indexes = wrapperIndexes(node);
        if (indexes !== null) {
          const scope: Scope = { errors: new Set([...caughtNames(node), ...taintedNames(sf, node)]), tokens: TOKEN_FIELDS };
          const checked = indexes.flatMap((i) => (node.arguments[i] !== undefined ? [node.arguments[i]] : []));
          for (const arg of checked) checkContainer(sf, arg, scope, findings);
          discover(node, checked);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { findings, loggerCalls, wrappers };
}

/** The findings of {@link scanLogErrorObjects} alone. */
export function findLogErrorObjects(fileName: string, source: string): LogErrorFinding[] {
  return scanLogErrorObjects(fileName, source).findings;
}

// ---------------------------------------------------------------------------
// #739 B3a — caught error text in an object literal (not a log line)
// ---------------------------------------------------------------------------

/**
 * #739 B3a — inside a `catch`, an object literal that is NOT a log or
 * log-wrapper argument must not carry the caught value's text: its
 * `.message` / `.stack`, `String(e)`, `${e}`, or the object itself. Such a
 * literal is an HTTP body, a span status, an audit payload, a stored column
 * or a Result that later reaches one, and a drizzle error's message quotes
 * bound parameters. Only the caught binding (and the locals read off it one
 * hop up, as the log rule taints them) counts, so Result errors and typed
 * error fields stay allowed. Use `errKind(e)` or a closed code.
 */
function caughtTextRefusal(
  expr: ts.Expression,
  names: ReadonlySet<string>,
  // #739 B3b part 2 — error-like parameters: only their text counts. `bare`
  // is true where the value itself becomes text (`String(x)`, `${x}`).
  textOnly: ReadonlySet<string> = NO_NAMES,
  bare = false,
): string | null {
  const node = unwrap(expr);
  const again = (e: ts.Expression, b = bare): string | null => caughtTextRefusal(e, names, textOnly, b);
  if (ts.isIdentifier(node)) {
    if (names.has(node.text)) return `the caught value \`${node.text}\``;
    return bare && textOnly.has(node.text) ? `the text of \`${node.text}\`` : null;
  }
  const key = exprKey(node);
  if (key !== null && names.has(key)) return `the caught value \`${node.getText()}\``;
  if (ts.isPropertyAccessExpression(node)) {
    const base = unwrap(node.expression);
    if (ts.isIdentifier(base) && (names.has(base.text) || textOnly.has(base.text))) {
      return TEXT_FIELDS.has(node.name.text) ? `\`${base.text}.${node.name.text}\`` : null;
    }
    if (TEXT_FIELDS.has(node.name.text)) return again(base, false);
    return null;
  }
  if (ts.isCallExpression(node)) {
    const name = calleeName(node);
    if (name !== null && SAFE_CALLS.has(name)) return null;
    const callee = unwrap(node.expression);
    if (ts.isPropertyAccessExpression(callee)) {
      const inner = again(callee.expression, callee.name.text === 'toString');
      if (inner !== null) return `\`.${callee.name.text}()\` on ${inner}`;
    }
    for (const arg of node.arguments) {
      const a = unwrap(arg);
      if (ts.isObjectLiteralExpression(a) || ts.isArrayLiteralExpression(a) || ts.isFunctionLike(a)) continue;
      const inner = again(arg, name === 'String');
      if (inner !== null) return `\`${name ?? 'a call'}(…)\` of ${inner}`;
    }
    return null;
  }
  if (ts.isTemplateExpression(node)) {
    for (const span of node.templateSpans) {
      const inner = again(span.expression, true);
      if (inner !== null) return `a template embedding ${inner}`;
    }
    return null;
  }
  if (ts.isConditionalExpression(node)) {
    return again(node.whenTrue) ?? again(node.whenFalse);
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return again(node.right);
    if (op === ts.SyntaxKind.PlusToken) return again(node.left, true) ?? again(node.right, true);
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
      return again(node.left) ?? again(node.right);
    }
  }
  return null;
}

const NO_NAMES: ReadonlySet<string> = new Set();

/** #739 B3b part 2 — true when `expr` is (one arm of) an error-like parameter itself: `e instanceof Error ? e : new Error(…)`. */
function holdsParam(expr: ts.Expression, textOnly: ReadonlySet<string>): boolean {
  const node = unwrap(expr);
  if (ts.isIdentifier(node)) return textOnly.has(node.text);
  if (ts.isConditionalExpression(node)) return holdsParam(node.whenTrue, textOnly) || holdsParam(node.whenFalse, textOnly);
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
      return holdsParam(node.left, textOnly) || holdsParam(node.right, textOnly);
    }
  }
  return false;
}

/**
 * The caught bindings plus the locals that hold their text: a declaration or
 * assignment inside an enclosing catch block whose value is caught text by
 * this rule (two passes, so a local read off such a local counts too). Not
 * the log rule's taint, which also taints `errKind(e)`-style values.
 */
function caughtTextNames(
  node: ts.Node,
  caught: ReadonlySet<string>,
  objects?: Set<string>,
  textOnly: Set<string> = new Set(),
): ReadonlySet<string> {
  const names = new Set(caught);
  for (const c of caught) objects?.add(c);
  // A local whose value is the caught object itself (`raw instanceof Error ?
  // raw : new Error(…)`) holds an error, not its text: `cause:` may chain it.
  const record = (name: string, why: string): void => {
    names.add(name);
    if (why.startsWith('the caught value')) objects?.add(name);
    else objects?.delete(name);
  };
  const blocks: ts.Node[] = [];
  for (let cur: ts.Node | undefined = node.parent; cur !== undefined; cur = cur.parent) {
    const body = catchScopeBody(cur);
    if (body !== null) blocks.push(body);
  }
  // #739 B3b review — a destructured or indexed allSettled element has no
  // callback or loop around it: follow its locals through the enclosing
  // function body (or the file).
  if (caught.has(SETTLED_REASON)) {
    let fn: ts.Node | undefined = node.parent;
    while (fn !== undefined && !ts.isFunctionLike(fn) && !ts.isSourceFile(fn)) fn = fn.parent;
    if (fn !== undefined) {
      const body = ts.isSourceFile(fn) ? fn : (fn as ts.FunctionLikeDeclaration).body;
      if (body !== undefined) blocks.push(body);
    }
  }
  for (let pass = 0; pass < 2; pass += 1) {
    for (const block of blocks) {
      const scan = (n: ts.Node): void => {
        if (n.pos >= node.pos) return;
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined) {
          const why = caughtTextRefusal(n.initializer, names, textOnly);
          if (why !== null) record(n.name.text, why);
          // #739 B3b part 2 — a local holding an error-like parameter itself.
          else if (holdsParam(n.initializer, textOnly)) textOnly.add(n.name.text);
        } else if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer !== undefined) {
          // #739 B3b part 2 — `const { reason } = r`, `const { message } = e`.
          const base = unwrap(n.initializer);
          if (ts.isIdentifier(base)) {
            for (const el of n.name.elements) {
              const k = el.propertyName ?? el.name;
              if (!ts.isIdentifier(k) || !ts.isIdentifier(el.name)) continue;
              const fromError = (names.has(base.text) || textOnly.has(base.text)) && TEXT_FIELDS.has(k.text);
              if (fromError || names.has(`${base.text}.${k.text}`)) names.add(el.name.text);
            }
          }
        } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) {
          const why = caughtTextRefusal(n.right, names, textOnly);
          if (why !== null) record(n.left.text, why);
        }
        if (!ts.isFunctionLike(n)) ts.forEachChild(n, scan);
      };
      ts.forEachChild(block, scan);
    }
  }
  return names;
}

/** True when `node` sits in a logger or registered log-wrapper call's arguments. */
function insideLogCall(node: ts.Node, aliases: ReadonlySet<string>, client = false): boolean {
  for (let cur: ts.Node | undefined = node.parent; cur !== undefined; cur = cur.parent) {
    if (ts.isFunctionLike(cur)) return false;
    if (ts.isCallExpression(cur) && (isLoggerCall(cur, aliases) || wrapperIndexes(cur) !== null)) return true;
    // #739 B3b part 2 — a client component's console is the browser's own:
    // it reaches no server log, body or column.
    if (client && ts.isCallExpression(cur) && isConsoleCall(cur)) return true;
  }
  return false;
}

function isConsoleCall(call: ts.CallExpression): boolean {
  const callee = unwrap(call.expression);
  const target = ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee) ? unwrap(callee.expression) : null;
  return target !== null && ts.isIdentifier(target) && target.text === 'console';
}

/** Caught error text in a non-log object literal: one finding per property. */
export function findCaughtErrorLiterals(fileName: string, source: string): LogErrorFinding[] {
  const kind = /\.tsx$/i.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const aliases = loggerAliases(sf);
  const client = isClientFile(sf);
  const out: LogErrorFinding[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      ts.isObjectLiteralExpression(node.parent)
    ) {
      const caught = caughtNames(node);
      const params = paramTextNames(node);
      if ((caught.size > 0 || params.size > 0) && !insideLogCall(node, aliases, client)) {
        const objects = new Set<string>();
        const textOnly = new Set(params);
        const names = caughtTextNames(node, caught, objects, textOnly);
        // Error chaining (`{ cause: e }`) keeps the object in memory; it is
        // not a sink, and the log rule reads it wherever it is logged.
        // Only the caught object (or a local holding that object): a local
        // holding its text is text.
        // A chained DrizzleQueryError keeps `query` / `params` as own
        // enumerable fields, so such a Result must never be serialised whole.
        const chainedName = ts.isShorthandPropertyAssignment(node)
          ? node.name.text
          : ts.isIdentifier(unwrap(node.initializer))
            ? (unwrap(node.initializer) as ts.Identifier).text
            : null;
        const chained = node.name.getText(sf) === 'cause' && chainedName !== null && objects.has(chainedName);
        const why = chained
          ? null
          : ts.isShorthandPropertyAssignment(node)
          ? names.has(node.name.text)
            ? `the caught value \`${node.name.text}\``
            : null
          : caughtTextRefusal(node.initializer, names, textOnly);
        if (why !== null) {
          out.push({ line: lineOf(sf, node), message: `${node.name.getText(sf)}: ${why} outside a log line` });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
