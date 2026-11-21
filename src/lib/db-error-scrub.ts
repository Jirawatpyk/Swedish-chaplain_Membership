import { logger } from './logger';
import { errKind } from './log-id';

/**
 * #804 — a DB error that leaves our DB layer carries no SQL, no bound
 * parameters and no row values.
 *
 * Next prints an error that escapes a route handler or a page with
 * `console.error` / `logError` (`util.inspect`) BEFORE `onRequestError`
 * runs, and nothing can silence that print. drizzle-orm's
 * `DrizzleQueryError` says `Failed query: <SQL>\nparams: <values>` and keeps
 * enumerable `query` / `params`; its postgres-js cause copies every server
 * field onto itself (`detail` = `Key (email)=(a@b.example)`, `where`, `hint`,
 * `internal_query`). So an escaped DB error printed emails and names into
 * the Vercel runtime logs.
 *
 * `scrubDbError` is applied where an error LEAVES our DB layer
 * (`installDbErrorScrub` in `db.ts`: `db.transaction`, so `runInTenant`, and
 * the root session that serves every query outside a transaction). A catch
 * INSIDE a transaction still sees the raw error.
 *
 * What it keeps, so every reader outside a transaction works unchanged:
 * object identity of app errors and of the drizzle error, the class
 * (`instanceof`, `errKind`), `code` (SQLSTATE), `constraint_name`,
 * `table_name`, `column_name`, `schema_name`, `severity`, and Postgres's own
 * message — names only — except SQLSTATE class `22` (data exception), whose
 * text can quote the input (`invalid input syntax for type uuid: "…"`) and
 * becomes the code alone. Our trigger raises carry ids only
 * (`last-admin-protection`, `primary-contact-invariant …`), and five readers
 * match on that text.
 *
 * What it drops: the drizzle `query` / `params` and the SQL in its message
 * and stack; the driver's `detail`, `hint`, `where`, `internal_query`,
 * `position`, `internal_position`, `file`, `line`, `routine`.
 *
 * Why the driver error is REPLACED, not edited: postgres-js defines `stack`,
 * `query`, `parameters`, `args` and `types` with `Object.defineProperties`
 * (non-writable, non-configurable, `connection.js` queryError), so they can
 * be neither deleted nor rewritten, and its frozen stack starts with the
 * message. A clone built on the same prototype keeps `instanceof` for
 * whichever copy of the package threw it. No reader compares a driver error
 * by identity.
 *
 * Detection is structural as well as by class, so a second copy of
 * `drizzle-orm` / `postgres` in the server bundle cannot make it fail open.
 * The scrub is total: if it throws, the original goes back and
 * `db.error_scrub_failed` is logged, so a scrub bug never turns a 409 into
 * a 500.
 */

const MAX_NODES = 20;

/** Keys under which a wrapper holds the error it caught (`cause`, Result `error`, `AggregateError.errors`). */
const CHILD_KEYS = ['cause', 'error'] as const;

const DRIVER_KEPT_FIELDS = [
  'severity',
  'severity_local',
  'code',
  'schema_name',
  'table_name',
  'column_name',
  'data type_name',
  'constraint_name',
] as const;

const scrubbed = new WeakSet<object>();

type Rec = Record<string, unknown>;

function isObject(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null;
}

/** drizzle-orm `DrizzleQueryError` (0.45: `Failed query: …`, own `query` / `params`). */
export function isDrizzleQueryErrorShape(e: unknown): e is Error & Rec {
  return (
    e instanceof Error &&
    (e.constructor?.name === 'DrizzleQueryError' ||
      (typeof (e as unknown as Rec).query === 'string' &&
        'params' in e &&
        typeof e.message === 'string' &&
        e.message.startsWith('Failed query:')))
  );
}

/** postgres-js `PostgresError` (a server error: string `code` + `severity`). */
export function isDriverErrorShape(e: unknown): e is Error & Rec {
  if (!(e instanceof Error)) return false;
  if (e.name === 'PostgresError' || e.constructor?.name === 'PostgresError') return true;
  const r = e as unknown as Rec;
  return typeof r.code === 'string' && typeof r.severity === 'string' && typeof e.message === 'string';
}

/**
 * The stack's frames only, fail closed. V8 builds the stack header from the
 * whole message, and a message can quote a parameter on several lines, one
 * of which may look like a frame (`    at …`). So the original message is cut
 * off by position first, and only what follows it is filtered for frames;
 * a stack that does not contain the message keeps no frames at all
 * (review round 1, #804).
 */
function frames(stack: unknown, originalMessage: string): string {
  if (typeof stack !== 'string') return '';
  const at = stack.indexOf(originalMessage);
  if (at === -1) return '';
  return stack
    .slice(at + originalMessage.length)
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .join('\n');
}

function withFrames(header: string, stack: unknown, originalMessage: string): string {
  const f = frames(stack, originalMessage);
  return f ? `${header}\n${f}` : header;
}

function safeDriverMessage(e: Error & Rec): string {
  const code = typeof e.code === 'string' ? e.code : '';
  if (code.startsWith('22')) return code;
  return e.message;
}

function cleanDriverClone(e: Error & Rec): Error {
  const clone = Object.create(Object.getPrototypeOf(e) as object) as Error & Rec;
  const message = safeDriverMessage(e);
  const name = typeof e.name === 'string' ? e.name : 'PostgresError';
  Object.defineProperty(clone, 'message', { value: message, writable: true, configurable: true, enumerable: false });
  Object.defineProperty(clone, 'name', { value: name, writable: true, configurable: true, enumerable: true });
  for (const key of DRIVER_KEPT_FIELDS) {
    if (e[key] !== undefined) clone[key] = e[key];
  }
  Object.defineProperty(clone, 'stack', {
    value: withFrames(`${name}: ${message}`, e.stack, e.message),
    writable: true,
    configurable: true,
    enumerable: false,
  });
  scrubbed.add(clone);
  return clone;
}

function scrubDrizzleInPlace(e: Error & Rec): void {
  const name = e.constructor?.name || 'Error';
  const originalMessage = e.message;
  e.message = 'Failed query';
  delete e.query;
  delete e.params;
  e.stack = withFrames(`${name}: Failed query`, e.stack, originalMessage);
  scrubbed.add(e);
}

/** Replace or scrub `node[key]` when it is a driver link; returns the child to keep walking. */
function cleanChild(parent: Rec, key: string | number, child: unknown): unknown {
  if (!isObject(child) || scrubbed.has(child)) return undefined;
  if (isDriverErrorShape(child) && !isDrizzleQueryErrorShape(child)) {
    (parent as Record<string | number, unknown>)[key] = cleanDriverClone(child);
    return undefined;
  }
  return child;
}

function scrubUnsafe(e: unknown): unknown {
  let top = e;
  if (isObject(top) && !scrubbed.has(top) && isDriverErrorShape(top) && !isDrizzleQueryErrorShape(top)) {
    top = cleanDriverClone(top);
    return top;
  }
  const seen = new Set<object>();
  const queue: unknown[] = [top];
  let visited = 0;
  while (queue.length > 0 && visited < MAX_NODES) {
    const node = queue.shift();
    if (!isObject(node) || seen.has(node)) continue;
    seen.add(node);
    visited += 1;
    if (isDrizzleQueryErrorShape(node) && !scrubbed.has(node)) scrubDrizzleInPlace(node);
    for (const key of CHILD_KEYS) {
      if (!(key in node)) continue;
      const next = cleanChild(node, key, node[key]);
      if (next !== undefined) queue.push(next);
    }
    const errors = node.errors;
    if (Array.isArray(errors)) {
      errors.forEach((child, i) => {
        const next = cleanChild(errors as unknown as Rec, i, child);
        if (next !== undefined) queue.push(next);
      });
    }
  }
  if (queue.some(isObject)) {
    // The bound stopped the walk with links still unread: those may print
    // raw. Rare (a wrapper holding more than MAX_NODES errors); say so.
    logger.warn(
      { event: 'db.error_scrub_truncated', maxNodes: MAX_NODES, unread: queue.length },
      'db error scrub stopped at its node bound; deeper links were not scrubbed',
    );
  }
  return top;
}

/**
 * Returns the value to rethrow: the same object, scrubbed in place, or —
 * when the thrown value is itself a driver error — its clean clone.
 */
export function scrubDbError(e: unknown): unknown {
  try {
    return scrubUnsafe(e);
  } catch (scrubErr) {
    logger.error(
      {
        event: 'db.error_scrub_failed',
        err: errKind(scrubErr),
      },
      'db error scrub failed; rethrowing the original error',
    );
    return e;
  }
}

function rethrowScrubbed<T>(run: () => T): T {
  let out: T;
  try {
    out = run();
  } catch (e) {
    throw scrubDbError(e);
  }
  if (isObject(out) && typeof (out as { then?: unknown }).then === 'function') {
    return (out as unknown as Promise<unknown>).then(undefined, (e: unknown) => {
      throw scrubDbError(e);
    }) as T;
  }
  return out;
}

type Fn = (...args: unknown[]) => unknown;

const PREPARED_METHODS = ['execute', 'all'] as const;

interface ScrubbableDb {
  transaction: Fn;
  session?: { prepareQuery?: Fn } | undefined;
}

/**
 * Wires {@link scrubDbError} onto our own drizzle instance (instance
 * properties only — no drizzle prototype is touched):
 *
 *   - `db.transaction`: a throw that LEAVES a transaction (from the callback,
 *     the setup statement or COMMIT, e.g. a deferred trigger) is scrubbed.
 *     `runInTenant` goes through it. Inside the callback the error is raw.
 *   - the ROOT session's `prepareQuery`: the prepared query's `execute` /
 *     `all` scrub on reject. drizzle gives every transaction its own session
 *     (`PostgresJsSession.transaction`), so this serves exactly the queries
 *     outside any transaction — every bare `db.select / insert / update /
 *     delete / execute / query.* / $count`, aliased executors included.
 *
 * The session and its prepared query are drizzle internals (0.45). If their
 * shape is not what this expects, it throws at module load: loud in CI and at
 * boot, never a silent fail-open.
 */
export function installDbErrorScrub<D>(db: D): D {
  const target = db as unknown as ScrubbableDb;
  const session = target.session;
  if (typeof target.transaction !== 'function' || !session || typeof session.prepareQuery !== 'function') {
    throw new Error('installDbErrorScrub: drizzle db has no transaction / session.prepareQuery (drizzle upgrade?)');
  }
  const transaction = target.transaction.bind(db);
  target.transaction = (...args: unknown[]) => rethrowScrubbed(() => transaction(...args));

  const prepareQuery = session.prepareQuery.bind(session);
  // Check the prepared query's shape once here, so a drizzle upgrade fails at
  // module load rather than on every query at runtime (review round 1). It
  // builds a prepared query and never runs it.
  const probe = prepareQuery({ sql: 'select 1', params: [] }, undefined, undefined, false) as Record<string, unknown>;
  for (const method of PREPARED_METHODS) {
    if (typeof probe?.[method] !== 'function') {
      throw new Error(`installDbErrorScrub: prepared query has no ${method}() (drizzle upgrade?)`);
    }
  }
  session.prepareQuery = (...args: unknown[]) => {
    const prepared = prepareQuery(...args) as Record<string, unknown>;
    for (const method of PREPARED_METHODS) {
      const bound = (prepared[method] as Fn).bind(prepared);
      prepared[method] = (...a: unknown[]) => rethrowScrubbed(() => bound(...a));
    }
    return prepared;
  };
  return db;
}
