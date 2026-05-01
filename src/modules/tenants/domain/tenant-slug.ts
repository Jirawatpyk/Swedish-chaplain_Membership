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
 * Unchecked brand — for test fixtures and for cases where validation has
 * already run upstream (e.g. `peekTokenTenantId` does its own structural
 * check before returning, and `runInTenant` binds RLS using the same
 * value). Caller asserts the input is a syntactically valid slug.
 */
export function unsafeBrandTenantSlug(slug: string): TenantSlug {
  return slug as TenantSlug;
}
