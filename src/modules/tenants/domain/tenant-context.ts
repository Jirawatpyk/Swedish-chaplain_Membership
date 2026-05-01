/**
 * `TenantContext` — branded Domain type for cross-cutting tenant identity.
 *
 * **Why this lives in `src/modules/tenants/` and not `src/modules/plans/domain/`**:
 * `TenantContext` is a platform-level concept. Every F2+ bounded context
 * (plans, F3 members, F4 invoices, F7 broadcasts, …) needs to type its
 * use-case dependencies against it. Placing the type inside plans'
 * Domain layer would force siblings to either deep-import into
 * `@/modules/plans/domain/*` (blocked by ESLint `no-restricted-imports`)
 * or re-export it via the plans barrel (wrong ownership). So tenants is
 * a **Domain-only cross-cutting module**: just this file + the public
 * barrel. No application/, no infrastructure/, no database table.
 * See `specs/002-membership-plans/research.md § 1` + critique E1/X2.
 *
 * **Why branded, not a plain string**:
 * Constitution v1.4.0 Principle I clause 1 requires tenant isolation to
 * fail at compile time when a use case forgets to pass the tenant. A
 * branded type is the only way TypeScript can catch that — a raw string
 * parameter is trivially forgettable and typeable.
 *
 * **Slug format**: `[a-z0-9-]{1,63}` — the same shape enforced by the
 * env-var validator in `src/lib/env.ts` and the future F10 subdomain
 * resolver. Constructing an invalid slug throws synchronously at the
 * call site so the error surfaces exactly where the trust boundary sits.
 *
 * Pure TypeScript — no framework imports.
 */

// Real (not `declare`d) symbol so it carries runtime identity too. The
// symbol is module-private — consumers can't construct a brand by hand
// because they can't import this symbol. The only path to a valid
// `TenantContext` value is the `asTenantContext` constructor below.
const tenantContextBrand = Symbol('TenantContext');

import { unsafeBrandTenantSlug, type TenantSlug } from './tenant-slug';

export type TenantContext = {
  /**
   * Tenant identifier as a branded `TenantSlug`. APIs that take a
   * `TenantSlug` accept `tenant.slug` directly without unsafe coercion.
   */
  readonly slug: TenantSlug;
  readonly [tenantContextBrand]: true;
};

const SLUG_PATTERN = /^[a-z0-9-]{1,63}$/;

export class InvalidTenantSlugError extends Error {
  constructor(public readonly attempted: string) {
    super(
      `Invalid tenant slug: ${JSON.stringify(attempted)}. ` +
        `Must match [a-z0-9-]{1,63} (lowercase alphanumeric + hyphen, 1..63 chars).`,
    );
    this.name = 'InvalidTenantSlugError';
  }
}

/**
 * Construct a validated `TenantContext`. Throws `InvalidTenantSlugError`
 * on a malformed slug — call sites at trust boundaries (env resolver,
 * proxy request handler, test fixtures) are the only places that should
 * catch this.
 */
export function asTenantContext(slug: string): TenantContext {
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
    throw new InvalidTenantSlugError(slug);
  }
  return {
    slug: unsafeBrandTenantSlug(slug),
    [tenantContextBrand]: true,
  } as TenantContext;
}

/** Slug pattern exported for shared validators (env.ts, seed scripts). */
export const TENANT_SLUG_PATTERN = SLUG_PATTERN;
