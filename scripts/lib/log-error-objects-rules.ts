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
 * A TRIPWIRE, not proof of completeness: it reads each `logger.<level>(…)`
 * call's arguments syntactically. A value laundered through a local first
 * (`const code = String(e); logger.warn({ err: code })`) or through a helper
 * in the safe set passes. The sweep that preceded it was done by hand.
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
 * set (review round 1, security L2), never a name pattern. `eraseStep` returns
 * only a code-authored step token (`erase-member.ts` STEP_MESSAGE);
 * `gatewayField` only a `[a-z0-9_]` token or `'unrecognised'`
 * (`subprocessor-erasure-adapter.ts`); `approvalErrKind` an error class plus
 * `ApprovalDependencyError`'s dependency and `causeKind` (every constructor
 * call passes a repo code, a closed kind, a literal or an `errKind`);
 * `retryableSubKind` one of five literals; `isTimeout` and `Number.isFinite`
 * a boolean.
 */
const SAFE_CALLS = new Set([
  'errKind',
  'pgErrorCode',
  'pgErrorMeta',
  'hashId',
  'errLogFields',
  'errStep',
  'eraseStep',
  'gatewayField',
  'approvalErrKind',
  'retryableSubKind',
  'isTimeout',
  'Number.isFinite',
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
    ts.isTypeAssertionExpression(cur)
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

function isErrorIdentifier(name: string, caught: ReadonlySet<string>): boolean {
  // Review round 1 — a caught binding is an error whatever it is called.
  if (caught.has(name)) return true;
  if (SAFE_NAME.test(name)) return false;
  return ERROR_NAMES.has(name) || ERROR_SUFFIX.test(name);
}

/** What an expression yields: an error object, error text, a token read off an error, or none of these. */
type Shape = 'error' | 'text' | 'token' | null;

function shapeOf(expr: ts.Expression, caught: ReadonlySet<string>): Shape {
  const node = unwrap(expr);
  if (ts.isIdentifier(node)) return isErrorIdentifier(node.text, caught) ? 'error' : null;
  if (ts.isPropertyAccessExpression(node)) {
    const field = node.name.text;
    const base = shapeOf(node.expression, caught);
    if (TEXT_FIELDS.has(field)) return 'text';
    if (base === 'error') return TOKEN_FIELDS.has(field) ? 'token' : 'error';
    if (base === 'text') return 'text';
    if (base === 'token') return 'token';
    return OBJECT_FIELDS.has(field) ? 'error' : null;
  }
  if (ts.isElementAccessExpression(node)) {
    const base = shapeOf(node.expression, caught);
    return base === 'error' || base === 'text' ? 'error' : null;
  }
  return null;
}

/** The first refusal inside a literal argument, walked like a fields object. */
function literalRefusal(sf: ts.SourceFile, node: ts.Expression, caught: ReadonlySet<string>): string | null {
  const inner: LogErrorFinding[] = [];
  checkContainer(sf, node, caught, inner);
  return inner[0]?.message ?? null;
}

/** Why `expr` would put error text or an error object on the line, or null. */
function refusal(sf: ts.SourceFile, expr: ts.Expression, caught: ReadonlySet<string>): string | null {
  const node = unwrap(expr);

  if (ts.isIdentifier(node)) {
    return isErrorIdentifier(node.text, caught) ? `the error object \`${node.text}\`` : null;
  }

  if (ts.isPropertyAccessExpression(node)) {
    const field = node.name.text;
    const base = unwrap(node.expression);
    if (ts.isCallExpression(base) && calleeName(base) === 'classifyThrown') {
      return CLASSIFY_SAFE_FIELDS.has(field) ? null : `\`classifyThrown(…).${field}\` (only .kind is a closed token)`;
    }
    if (TEXT_FIELDS.has(field)) return `\`.${field}\``;
    const baseShape = shapeOf(base, caught);
    if (baseShape === 'text') return `\`.${field}\` of error text`;
    if (baseShape === 'error') {
      if (TOKEN_FIELDS.has(field)) return null;
      return OBJECT_FIELDS.has(field)
        ? `the error object \`.${field}\``
        : `\`.${field}\` of an error (only .code / .kind / .name)`;
    }
    if (baseShape === null && OBJECT_FIELDS.has(field)) return `the error object \`.${field}\``;
    // `x.error.code` / `x.error.kind`, or a field of a non-error value — allowed.
    return null;
  }

  if (ts.isElementAccessExpression(node)) {
    const baseShape = shapeOf(node.expression, caught);
    return baseShape === 'error' || baseShape === 'text' ? 'element access on an error or its text' : null;
  }

  if (ts.isCallExpression(node)) {
    const name = calleeName(node);
    if (name !== null && SAFE_CALLS.has(name)) return null;
    if (name === 'classifyThrown') return '`classifyThrown(…)` whole (its `reason` is the message)';
    const callee = unwrap(node.expression);
    if (ts.isPropertyAccessExpression(callee)) {
      const receiver = shapeOf(callee.expression, caught);
      if (receiver === 'error' || receiver === 'text') {
        return `\`.${callee.name.text}()\` on an error or its text`;
      }
    }
    for (const arg of node.arguments) {
      const a = unwrap(arg);
      const inner =
        ts.isObjectLiteralExpression(a) || ts.isArrayLiteralExpression(a)
          ? literalRefusal(sf, a, caught)
          : refusal(sf, arg, caught);
      if (inner !== null) return `\`${name ?? 'a call'}(…)\` of ${inner}`;
    }
    return null;
  }

  if (ts.isTemplateExpression(node)) {
    for (const span of node.templateSpans) {
      const inner = refusal(sf, span.expression, caught);
      if (inner !== null) return `a template embedding ${inner}`;
    }
    return null;
  }

  if (ts.isConditionalExpression(node)) {
    return refusal(sf, node.whenTrue, caught) ?? refusal(sf, node.whenFalse, caught);
  }

  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (
      op === ts.SyntaxKind.QuestionQuestionToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.PlusToken
    ) {
      return refusal(sf, node.left, caught) ?? refusal(sf, node.right, caught);
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
  caught: ReadonlySet<string>,
  out: LogErrorFinding[],
): void {
  const n = unwrap(node);
  if (ts.isObjectLiteralExpression(n)) {
    for (const prop of n.properties) {
      if (ts.isShorthandPropertyAssignment(prop)) {
        if (isErrorIdentifier(prop.name.text, caught)) {
          out.push({ line: lineOf(sf, prop), message: `shorthand \`{ ${prop.name.text} }\` logs the error object` });
        }
      } else if (ts.isSpreadAssignment(prop)) {
        const why = refusal(sf, prop.expression, caught);
        if (why !== null) out.push({ line: lineOf(sf, prop), message: `spread of ${why}` });
      } else if (ts.isPropertyAssignment(prop)) {
        const init = unwrap(prop.initializer);
        if (ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init)) {
          checkContainer(sf, init, caught, out);
        } else {
          const why = refusal(sf, prop.initializer, caught);
          if (why !== null) out.push({ line: lineOf(sf, prop), message: `${prop.name.getText(sf)}: ${why}` });
        }
      }
    }
    return;
  }
  if (ts.isArrayLiteralExpression(n)) {
    for (const el of n.elements) checkContainer(sf, el, caught, out);
    return;
  }
  const why = refusal(sf, n, caught);
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
      const caught = caughtNames(node);
      for (const arg of node.arguments) checkContainer(sf, arg, caught, findings);
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
