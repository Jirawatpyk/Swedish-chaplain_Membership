/**
 * Public barrel for the `tenants` cross-cutting Domain-only module.
 *
 * This is the ONLY surface that code OUTSIDE `src/modules/tenants/**`
 * may import from. The ESLint `no-restricted-imports` rule in
 * `eslint.config.mjs` blocks deep imports into `./domain/**` from
 * anywhere but inside this module.
 *
 * The module is deliberately minimal — just the branded `TenantContext`
 * type + its constructor. No application/, no infrastructure/, no
 * database table. F2+ bounded contexts (plans, F3 members, F4 invoices,
 * F7 broadcasts, …) each import from here to type their Application
 * dependencies against tenant identity.
 *
 * See `specs/002-membership-plans/research.md § 1` + critique E1/X2 for
 * the rationale behind this module's shape and placement.
 */

export {
  asTenantContext,
  InvalidTenantSlugError,
  TENANT_SLUG_PATTERN,
  type TenantContext,
} from './domain/tenant-context';

export { getTenantTimezone } from './domain/tenant-timezone';

export {
  asIanaTimezone,
  unsafeIanaTimezone,
  type IanaTimezone,
  type IanaTimezoneError,
} from './domain/iana-timezone';
