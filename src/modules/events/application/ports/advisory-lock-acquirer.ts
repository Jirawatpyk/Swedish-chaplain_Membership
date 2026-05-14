/**
 * T085 — `AdvisoryLockAcquirer` Application port (F6).
 *
 * Tenant-scoped Postgres advisory lock primitive used by
 * `apply-quota-effect.ts` to serialise concurrent quota decisions for
 * the same logical (tenant, member, event) seat-allocation (research.md
 * R5 + spec FR-037 strict-tx invariant).
 *
 * The adapter (Phase 6 Infrastructure) implements via
 * `tx.execute(sql\`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))\`)` —
 * the lock is bound to the current transaction and auto-released at
 * COMMIT or ROLLBACK. The Application caller MUST already be inside a
 * tx; this port does NOT open one.
 *
 * Namespace convention (mirrors F4 `invoicing:` / F5 `payments:` /
 * F7 `broadcasts:` / F8 `renewals:` precedents):
 *   `eventcreate-quota:${tenantId}:${memberId}:${eventId}` —
 *   per-(tenant, member, event) coordination key.
 *
 * **I-6 wave-5 batch-3** — `LockKey` brand:
 *   The branded type prevents a typo-class bug where a caller could
 *   silently pass `'eventcreate_quota:...'` (underscore) instead of
 *   `'eventcreate-quota:...'` (hyphen), producing a separate Postgres
 *   advisory-lock partition and bypassing the FR-037 ACID coordination.
 *   The only legitimate way to produce a `LockKey` is through the
 *   `buildQuotaLockKey()` smart constructor in `apply-quota-effect.ts`
 *   (or a future feature-specific builder). Direct casts are blocked
 *   by the symbol brand.
 *
 *   Note: F4/F5/F7/F8 currently pass `string` to their inline
 *   `pg_advisory_xact_lock(hashtextextended(...))` calls — they do NOT
 *   go through a port. F6 is the only module with a port-shaped
 *   advisory-lock surface, so branding here is internally consistent
 *   AND doesn't require touching the other modules. A future
 *   Constitution amendment could mandate the brand cross-module.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */

declare const lockKeyBrand: unique symbol;

/**
 * Branded string for Postgres advisory-lock keys. Construct via a
 * feature-specific builder (e.g., `buildQuotaLockKey()`) — direct
 * casting from `string` is forbidden by the brand.
 */
export type LockKey = string & { readonly [lockKeyBrand]: true };

/**
 * Smart constructor for `LockKey`. Validates the canonical namespace
 * shape:
 *
 *   `<feature-prefix>:<segment>(:<segment>){0,3}`
 *
 * where:
 *   - `<feature-prefix>` MUST contain only `[a-z0-9-]` (rejects
 *     underscore typos like `eventcreate_quota:` vs the canonical
 *     `eventcreate-quota:`)
 *   - Each `<segment>` MUST contain only `[A-Za-z0-9._-]` (UUID-safe
 *     + slug-safe; rejects spaces, control chars, punctuation that
 *     could split a lock partition on a stray character).
 *   - Total segments after the feature prefix: 1-4 (allows
 *     `feature:tenant` through `feature:tenant:scope1:scope2:scope3`).
 *   - Total length ≤256 chars.
 *
 * Tightened in wave-6 batch-3 (TYPE residual A) per Round 2 type-
 * design-analyzer: the prior `[\x20-\x7e]+` tail allowed spaces,
 * quotes, semicolons, and other printable ASCII — fine for the
 * hash-based Postgres call (no SQL injection) but ambiguous against
 * future segment-shape conventions and noisy in observability logs.
 *
 * Throws `InvalidLockKeyError` on malformed input — callers should
 * surface this as a programmer-error / TxStageError, NOT a user-
 * visible error (the call site is a use-case-internal construction
 * that should always pass).
 */
export function asLockKey(value: string): LockKey {
  if (
    typeof value !== 'string' ||
    !/^[a-z0-9-]+(:[A-Za-z0-9._-]+){1,4}$/.test(value) ||
    value.length > 256
  ) {
    throw new InvalidLockKeyError(value);
  }
  return value as LockKey;
}

export class InvalidLockKeyError extends Error {
  constructor(public readonly raw: string) {
    super(
      `Invalid advisory-lock key (must match /^[a-z0-9-]+:[\\x20-\\x7e]+$/ and be ≤256 chars): ${JSON.stringify(raw).slice(0, 200)}`,
    );
    this.name = 'InvalidLockKeyError';
  }
}

export interface AdvisoryLockAcquirer {
  /**
   * Acquire a Postgres transaction-scoped advisory lock keyed by the
   * caller-supplied `LockKey`. The string is hashed via
   * `hashtextextended(_, 0)` to produce the bigint key Postgres expects.
   *
   * The call BLOCKS until the lock is held (or the tx is rolled back).
   * Auto-released at tx-end — caller need not (must not) release
   * explicitly.
   *
   * Throws on DB error (caller wraps in TxStageError to propagate
   * through the strict-tx rollback path).
   */
  acquire(lockKey: LockKey): Promise<void>;
}
