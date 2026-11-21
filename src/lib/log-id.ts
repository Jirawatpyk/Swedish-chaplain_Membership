import { pgErrorCode, walkCauses } from './db-errors';

/**
 * Privacy-preserving ID hash for log output.
 *
 * Raw user IDs and session IDs MUST NOT appear in logs — see
 * `docs/observability.md § 3` and `CLAUDE.md § Secrets`. This helper
 * produces a stable, short correlation key so log lines for the same
 * user can be grouped without storing the identity.
 *
 * Algorithm: djb2 — fast, non-cryptographic, ~4 ns per call. Chosen
 * over SHA-256 because it's called on every authenticated log line
 * and the correlation window (a single production shift) doesn't
 * need collision resistance; auditing uses the raw IDs in the
 * `audit_log` table, not log output.
 *
 * NOT suitable for: password comparison, session token comparison,
 * CSRF token comparison, or any other security-critical equality
 * check. Only use for log correlation.
 *
 * Previously duplicated inline in `sign-in.ts` and `create-user.ts`;
 * consolidated here as a single source of truth.
 */
export function hashId(id: string): string {
  let hash = 5381;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 33) ^ id.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

/**
 * F5R3 SIMPLIFY-H1 (2026-05-16) — H-4 PCI/PDPA hygiene: log only the
 * error CLASS name, never `e.message`. Drizzle/Postgres errors carry
 * SQL fragments + table names + partial parameter bindings in
 * `.message`; Stripe SDK errors carry endpoint URLs + idempotency
 * keys; OTel trace spans + pino logs aggregate at the line-string
 * level so a single leaked stack trace lands in dashboards visible
 * across the org.
 *
 * Use at every `catch (e) { ... }` site that logs the error class:
 *
 *   logger.error({ err: errKind(e), …context }, 'op.failed');
 *
 * Previously inlined as
 *   `e instanceof Error ? e.constructor.name : 'unknown'`
 * at 15+ sites across F5 (route handlers, use-cases, audit adapter,
 * cron handlers, log-optimistic-flip route).
 */
export function errKind(e: unknown): string {
  // #739 B3b — a `DOMException` is not an `Error` in every runtime, and its
  // class name hides which one it is; its `name` (`AbortError`,
  // `TimeoutError`) is the class, when it is token-shaped.
  if (typeof DOMException !== 'undefined' && e instanceof DOMException) {
    return ERROR_CLASS.test(e.name) ? e.name : 'DOMException';
  }
  return e instanceof Error ? e.constructor.name : 'unknown';
}

/**
 * #739 B3b — an error class name as `errKind` writes it: one word that starts
 * with a capital, at most 64 characters. A driver message has a space, an
 * address an `@`, so neither passes.
 */
const ERROR_CLASS = /^[A-Z][A-Za-z0-9]{0,63}$/;

/** #739 — true when `text` is a bare error class name (one capitalised word, at most 64 characters). */
export function isErrorClassToken(text: unknown): text is string {
  return typeof text === 'string' && ERROR_CLASS.test(text);
}
/**
 * #739 PR 2 — the optional `:<SQLSTATE>` suffix {@link errClassWithCode}
 * writes: five digits or capitals with at least one digit (the
 * `firstSqlStateError` shape in `db-errors.ts`).
 */
const CLASS_AND_CODE = /^([A-Z][A-Za-z0-9]{0,63})(?::((?=[0-9A-Z]*\d)[0-9A-Z]{5}))?$/;
const STEP_AND_CLASS = /^([a-z][a-z0-9_-]{0,47}): ([A-Z][A-Za-z0-9]{0,63})(?::((?=[0-9A-Z]*\d)[0-9A-Z]{5}))?$/;

/**
 * #739 PR 2 — what a catch writes into a Result's `message` when the Result
 * keeps no `cause`: the error class, and the Postgres SQLSTATE when the cause
 * chain holds one (`NeonDbError:23505`). Never the error's text. A Result that
 * kept only `errKind(e)` lost the one field that tells a unique violation from
 * a statement timeout; `errLogFields` reads both halves back.
 */
export function errClassWithCode(e: unknown): string {
  // Review round 1 (security L2) — `constructor.name` comes from code, but a
  // value merged from untrusted JSON can carry its own; write only a token.
  const kind = errKind(e);
  const cls = ERROR_CLASS.test(kind) || kind === 'unknown' ? kind : 'unknown';
  const code = pgErrorCode(e);
  return code === undefined ? cls : `${cls}:${code}`;
}

/**
 * #739 B3b — a Result error's `message` that a catch wrote as `errKind(e)`, or
 * as `<step>: ${errKind(e)}`: the class, and the step when there is one.
 * Anything else is `undefined`, so no other text reaches a log line.
 */
function classFromMessage(
  text: unknown,
): { readonly err: string; readonly step?: string; readonly code?: string } | undefined {
  if (typeof text !== 'string') return undefined;
  const bare = CLASS_AND_CODE.exec(text);
  if (bare?.[1] !== undefined) return { err: bare[1], ...(bare[2] !== undefined ? { code: bare[2] } : {}) };
  const m = STEP_AND_CLASS.exec(text);
  return m?.[1] !== undefined && m[2] !== undefined
    ? { err: m[2], step: m[1], ...(m[3] !== undefined ? { code: m[3] } : {}) }
    : undefined;
}

/**
 * Single-step unwrap of a `Result` error's underlying `cause` — the real Error
 * thrown by infra (e.g. a `NeonDbError`) that a repo wraps as
 * `{ code: 'repo.unexpected', cause }`. Pair with `errKind` for PII-safe
 * diagnostics: `errKind(rootCause(result.error))` (a single `.cause` unwrap on
 * the plain wrapper, then the error CLASS — never `e.message`).
 *
 * Returns the `.cause` (or `undefined` when there is none). Centralises the
 * `(x as { cause?: unknown }).cause` cast hand-rolled at ~9 route + use-case
 * logging sites (code-review Round 2 cleanup) so the unwrap depth + field name
 * live in ONE place. Single-level BY DESIGN — the RepoError wrapper is exactly
 * one `.cause` deep; this does NOT walk a multi-level chain (for that see
 * `errorChainMessage` in `db-errors.ts`).
 */
export function rootCause(error: unknown): unknown {
  return (error as { cause?: unknown } | null | undefined)?.cause;
}

/** A code-authored step thrown as an Error message: `audit_failed`, `lookup_failed:repo.unexpected`. */
const CODE_AUTHORED_STEP = /^[a-z_]+(?::[a-z0-9_.]+)?$/;

/**
 * Spec 140 s2d (#736c) — the message of a thrown Error ONLY when code wrote it
 * as a step token (`throw new Error(\`lookup_failed:${repoError.code}\`)`),
 * else `undefined`. A driver's or a Drizzle wrapper's message never matches:
 * it has spaces, and a `Failed query:` message quotes the bound parameters. For
 * a log line's `step` field beside `err: errKind(e)`. The one step regex:
 * `erase-member.ts` imports it (review round 2 removed its `eraseStep` copy).
 */
export function errStep(e: unknown): string | undefined {
  return e instanceof Error && CODE_AUTHORED_STEP.test(e.message) ? e.message : undefined;
}

/**
 * #740 B2 review — the string form of {@link errStep}, for a Result error whose
 * `message` code wrote as `<op>: <code>` (`count-pending: repo.unexpected`,
 * the change-request use cases) or as a bare step token. Anything else, and
 * any text over 64 characters, is `undefined`: a driver message has capitals
 * or more than one space, and an address has an `@`. For a log line's `step`.
 */
const STEP_TOKEN = /^[a-z][a-z0-9_-]*(?:: ?[a-z][a-z0-9_.]*)?$/;

export function stepToken(text: unknown): string | undefined {
  return typeof text === 'string' && text.length <= 64 && STEP_TOKEN.test(text) ? text : undefined;
}

/**
 * Spec 140 s2d review round 3 (code-review #1, security #1) — a code-authored
 * code is token-SHAPED: words that start with a letter, joined by `_` or `-`,
 * in segments joined by `.` or `:`, at most 64 characters and at most 4 digits.
 * A shape check, not a closed list: it refuses a uuid (a segment starts with a
 * digit, or more than 4 digits), a digit string, and a mixed-case base64url
 * value, which is what a code laundered from data looks like.
 */
const LOWER_WORDS = '[a-z][a-z0-9]*(?:[_-][a-z][a-z0-9]*)*';
const UPPER_WORDS = '[A-Z][A-Z0-9]*(?:_[A-Z][A-Z0-9]*)*';
/**
 * Review round 4 (code-review #5, #8; security L1) — the one token shape every
 * code-like log value shares, as a regex prefix: a letter first, at most 64
 * characters, at most 4 digits. `RESULT_CODE`, `ERROR_CODE` and the logger's
 * `LOWER_TOKEN` append their own word rules to it.
 */
export const CODE_SHAPE = '^(?=[A-Za-z])(?=.{1,64}$)(?!(?:.*\\d){5})';

/** A Result error's own `code` (`repo.unexpected`, `last-admin-protection`); anything else is `'unrecognised'`. */
const RESULT_CODE = new RegExp(`${CODE_SHAPE}${LOWER_WORDS}(?:[.:]${LOWER_WORDS})*$`);

/** A thrown Error's own `.code`: a Result-style code, or a Node / undici one (`ECONNRESET`, `UND_ERR_SOCKET`). */
const ERROR_CODE = new RegExp(
  `${CODE_SHAPE}(?:${LOWER_WORDS}|${UPPER_WORDS})(?:[.:](?:${LOWER_WORDS}|${UPPER_WORDS}))*$`,
);

/**
 * Spec 140 s2d (#736c) — the log fields for a failure, never its object or its
 * text. drizzle-orm's `DrizzleQueryError` has enumerable `query` and `params`,
 * so a raw error (or a RepoError's `cause`) on a pino line writes the bound
 * parameters; its `.message` quotes them too.
 *
 * - A thrown value: `err` is its class (`errKind`), `code` its SQLSTATE
 *   (`pgErrorCode`) when there is one. Review round 3 (code-review #3): its
 *   own `.code`, when token-shaped and not that SQLSTATE, is `errCode` (Node
 *   `ECONNRESET` / `EPIPE`, Stripe `card_declined`). Review round 4
 *   (reliability LOW-2): the first such `.code` along the bounded cause walk
 *   (`walkCauses`), so a `DrizzleQueryError` over a socket reset keeps
 *   `ECONNRESET`.
 * - A Result error (`{ code, cause? }`, a RepoError and kin): `err` is the
 *   class of its `cause`, `repoCode` its own code, `code` the cause's SQLSTATE.
 * - #740 B1 review: a Result error with no `code` but a `kind` or `type`
 *   (`{ kind, message }`, `{ type, issues }`): `err` is the class of its
 *   `cause`, `resultKind` its own discriminator, never its message — except
 *   that a message {@link stepToken} accepts is `step` (#740 B2 review).
 * - Review round 1 (code-review #8) — a thrown Error that wraps a Result error
 *   at `.cause`, or at `.error` (where `UseCaseAbort` keeps it; the plan row
 *   named only `cause`): `err` is the thrown class, `repoCode` the wrapped
 *   code, `code` the SQLSTATE under it. A driver error is `{ code }`-shaped
 *   too but is an Error, so it is never read as a wrapped Result error.
 *
 * Spread it: `logger.error({ ...errLogFields(e), requestId }, 'op.failed')`.
 */
export function errLogFields(failure: unknown): {
  readonly err: string;
  readonly repoCode?: string;
  readonly resultKind?: string;
  readonly step?: string;
  readonly code?: string;
  readonly errCode?: string;
} {
  const resultCode =
    !(failure instanceof Error) && typeof failure === 'object' && failure !== null
      ? (failure as { code?: unknown }).code
      : undefined;
  if (typeof resultCode === 'string') {
    const cause = rootCause(failure);
    const sqlState = pgErrorCode(cause);
    // #739 B3b review — a code-keyed Result with no cause reads its class too.
    const fromMessage =
      cause === undefined ? classFromMessage((failure as { message?: unknown }).message) : undefined;
    const code = sqlState ?? fromMessage?.code;
    return {
      err: fromMessage?.err ?? errKind(cause),
      repoCode: RESULT_CODE.test(resultCode) ? resultCode : 'unrecognised',
      ...(fromMessage?.step !== undefined ? { step: fromMessage.step } : {}),
      ...(code !== undefined ? { code } : {}),
    };
  }
  // #740 B1 review — a Result error keyed on `kind` or `type` (`{ kind,
  // message }`, a plan-audit `{ type, issues }`) and no `code`: its own
  // discriminator, when token-shaped, is `resultKind`; never its message.
  const resultKind =
    resultCode === undefined && !(failure instanceof Error) && typeof failure === 'object' && failure !== null
      ? ((failure as { kind?: unknown }).kind ?? (failure as { type?: unknown }).type)
      : undefined;
  if (typeof resultKind === 'string') {
    const cause = rootCause(failure);
    const sqlState = pgErrorCode(cause);
    // #740 B2 review — a `message` code wrote as a step (`count-pending:
    // repo.unexpected`) is the one thing that tells these failures apart.
    const message = (failure as { message?: unknown }).message;
    // #739 B3b — with no `cause`, a catch now writes the class into `message`.
    const fromMessage = cause === undefined ? classFromMessage(message) : undefined;
    const step = fromMessage?.step ?? stepToken(message);
    const code = sqlState ?? fromMessage?.code;
    return {
      err: fromMessage?.err ?? errKind(cause),
      resultKind: RESULT_CODE.test(resultKind) ? resultKind : 'unrecognised',
      ...(step !== undefined ? { step } : {}),
      ...(code !== undefined ? { code } : {}),
    };
  }
  const wrapped = failure instanceof Error ? wrappedResultError(failure) : undefined;
  if (wrapped !== undefined) {
    const sqlState = pgErrorCode(rootCause(wrapped.error));
    const errCode = ownErrorCode(failure, sqlState, wrapped.error);
    return {
      err: errKind(failure),
      repoCode: RESULT_CODE.test(wrapped.code) ? wrapped.code : 'unrecognised',
      ...(sqlState !== undefined ? { code: sqlState } : {}),
      ...(errCode !== undefined ? { errCode } : {}),
    };
  }
  const sqlState = pgErrorCode(failure);
  const errCode = ownErrorCode(failure, sqlState);
  return {
    err: errKind(failure),
    ...(sqlState !== undefined ? { code: sqlState } : {}),
    ...(errCode !== undefined ? { errCode } : {}),
  };
}

/**
 * The first token-shaped `.code` that is not the SQLSTATE already logged as
 * `code`, on a thrown Error or a link of its cause chain (at most
 * `MAX_CAUSE_HOPS` down), else `undefined`. The wrapped Result error is passed
 * over: its code is `repoCode` already.
 */
function ownErrorCode(e: unknown, sqlState: string | undefined, skip?: unknown): string | undefined {
  if (!(e instanceof Error)) return undefined;
  return walkCauses(e, (link) => {
    if (link === skip || typeof link !== 'object') return undefined;
    const own = (link as { code?: unknown }).code;
    return typeof own === 'string' && own !== sqlState && ERROR_CODE.test(own) ? own : undefined;
  });
}

/** A Result error (`{ code: string }`, not itself an Error) at a thrown Error's `.cause`, else its `.error`. */
function wrappedResultError(e: Error): { readonly error: unknown; readonly code: string } | undefined {
  for (const candidate of [e.cause, (e as { error?: unknown }).error]) {
    if (typeof candidate !== 'object' || candidate === null || candidate instanceof Error) continue;
    const code = (candidate as { code?: unknown }).code;
    if (typeof code === 'string') return { error: candidate, code };
  }
  return undefined;
}
