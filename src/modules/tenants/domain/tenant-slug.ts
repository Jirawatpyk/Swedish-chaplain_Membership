/**
 * `TenantSlug` — lightweight branded tenant-identifier string.
 *
 * Distinct from `TenantContext` (which carries the brand + a runtime
 * marker proving an `asTenantContext` constructor was invoked). Use
 * `TenantSlug` when an API boundary needs only the textual tenant id
 * (token payloads, audit `tenant_id` columns, dispatch targets) and
 * carrying the full `TenantContext` would be unnecessary friction.
 *
 * Brand goal: prevent accidental raw-string assignment into APIs that
 * MUST be tenant-scoped. The brand is module-private — outside callers
 * can only obtain a `TenantSlug` via `asTenantSlug` (validated) or
 * `unsafeBrandTenantSlug` (test fixtures + already-validated peek
 * results).
 *
 * Pattern matches the F2 `TenantContext` shape (`[a-z0-9-]{1,63}`).
 *
 * Pure TypeScript — no framework imports (Constitution Principle III).
 */

const tenantSlugBrand = Symbol('TenantSlug');

export type TenantSlug = string & {
  readonly [tenantSlugBrand]: true;
};

const SLUG_PATTERN = /^[a-z0-9-]{1,63}$/;

export class InvalidTenantSlugStringError extends Error {
  constructor(public readonly attempted: string) {
    super(
      `Invalid tenant slug: ${JSON.stringify(attempted)}. ` +
        `Must match [a-z0-9-]{1,63} (lowercase alphanumeric + hyphen, 1..63 chars).`,
    );
    this.name = 'InvalidTenantSlugStringError';
  }
}

/**
 * Validated brand constructor. Throws on malformed input. Use at trust
 * boundaries (env resolver, proxy handler, test fixtures); inside the
 * Domain/Application layers prefer to receive an already-branded
 * `TenantSlug` value.
 */
export function asTenantSlug(slug: string): TenantSlug {
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
    throw new InvalidTenantSlugStringError(slug);
  }
  return slug as TenantSlug;
}

/**
 * Unchecked brand — escape hatch for cases where the slug HAS BEEN
 * VALIDATED upstream and re-running `asTenantSlug` would either be
 * redundant or impossible (e.g., the brand was lost through a JSON
 * round-trip that the upstream validator already verified).
 *
 * **R2 Batch 3g (R2-I15) — allowed call sites are tightly enumerated.**
 * New call sites require ≥2 reviewer approvals per Constitution
 * § Development Workflow (security-sensitive code surface):
 *
 *   1. Test fixtures (`tests/**`) — bypassing validation is acceptable
 *      because the test author owns the input string.
 *   2. Seed scripts (`scripts/**`) — same rationale; tooling not
 *      exposed to untrusted input.
 *   3. Trust-boundary peeks where a structural validator has already
 *      rejected malformed input:
 *      - `src/modules/broadcasts/infrastructure/unsubscribe-token/hmac-signer.ts`
 *        (HMAC token decode — Svix signature + zod schema validate
 *        the payload before this brand is applied)
 *      - `src/lib/tenant-context.ts` (peekTokenTenantId — structural
 *        check before return)
 *      - `src/modules/members/domain/member.ts` (`asTenantId` / `tryTenantId`
 *        — the F3/F6/F8 persisted-tenant-id branders, post-H4 unification of
 *        `TenantId` with `TenantSlug`. `asTenantId` brands a slug already
 *        validated upstream; `tryTenantId` adds a non-empty guard. NOTE:
 *        `tryTenantId` does NOT re-check the [a-z0-9-]{1,63} pattern — callers
 *        on truly untrusted input should prefer `asTenantSlug`.)
 *
 * Any other production call site MUST go through `asTenantSlug`
 * (validates the [a-z0-9-]{1,63} pattern). Importing this function
 * outside the allowed set is a security-review failure.
 */
export function unsafeBrandTenantSlug(slug: string): TenantSlug {
  return slug as TenantSlug;
}
