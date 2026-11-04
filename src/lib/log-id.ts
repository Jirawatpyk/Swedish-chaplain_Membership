import { pgErrorCode } from './db-errors';

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
  return e instanceof Error ? e.constructor.name : 'unknown';
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
 * Spec 140 s2d review round 3 (code-review #1, security #1) — a code-authored
 * code is token-SHAPED: words that start with a letter, joined by `_` or `-`,
 * in segments joined by `.` or `:`, at most 64 characters and at most 4 digits.
 * A shape check, not a closed list: it refuses a uuid (a segment starts with a
 * digit, or more than 4 digits), a digit string, and a mixed-case base64url
 * value, which is what a code laundered from data looks like.
 */
const LOWER_WORDS = '[a-z][a-z0-9]*(?:[_-][a-z][a-z0-9]*)*';
const UPPER_WORDS = '[A-Z][A-Z0-9]*(?:_[A-Z][A-Z0-9]*)*';
const CODE_SHAPE = '^(?=.{1,64}$)(?!(?:.*\\d){5})';

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
 *   `ECONNRESET` / `EPIPE`, Stripe `card_declined`).
 * - A Result error (`{ code, cause? }`, a RepoError and kin): `err` is the
 *   class of its `cause`, `repoCode` its own code, `code` the cause's SQLSTATE.
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
    return {
      err: errKind(cause),
      repoCode: RESULT_CODE.test(resultCode) ? resultCode : 'unrecognised',
      ...(sqlState !== undefined ? { code: sqlState } : {}),
    };
  }
  const wrapped = failure instanceof Error ? wrappedResultError(failure) : undefined;
  if (wrapped !== undefined) {
    const sqlState = pgErrorCode(rootCause(wrapped.error));
    const errCode = ownErrorCode(failure, sqlState);
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

/** A thrown Error's own token-shaped `.code` that is not the SQLSTATE already logged as `code`, else `undefined`. */
function ownErrorCode(e: unknown, sqlState: string | undefined): string | undefined {
  if (!(e instanceof Error)) return undefined;
  const own = (e as { code?: unknown }).code;
  return typeof own === 'string' && own !== sqlState && ERROR_CODE.test(own) ? own : undefined;
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
