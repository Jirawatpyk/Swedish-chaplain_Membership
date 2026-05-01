/**
 * Tenant timezone resolver — Domain helper (F7 US3).
 *
 * Returns the IANA timezone identifier for a given tenant slug. F7's
 * quota-year boundary, e-blast benefits dashboard, and reset-date
 * microcopy depend on tenant-local time even though storage is UTC
 * (Constitution § Conventions: ISO 8601 UTC for storage; tenant-tz
 * only at display + boundary-math edges).
 *
 * MTA+STD scope: each deployment serves ONE tenant, so the tz lives
 * on `env.tenant.timezone` (validated against the IANA registry at
 * boot — invalid id refuses to start the app rather than silently
 * rendering UTC). The slug parameter is retained for the future-F12
 * multi-tenant-per-deployment migration: when F12 lands, this helper
 * will be swapped for a `TenantConfigPort` repo read keyed on slug.
 *
 * F12-TODO: replace single-env read with `tenants.timezone` column
 * lookup via a read-only `TenantConfigPort` once F12 SaaS-multi-tenant
 * lands.
 */

import { env } from '@/lib/env';
import { unsafeIanaTimezone, type IanaTimezone } from './iana-timezone';

/**
 * Returns the IANA timezone identifier for the given tenant slug as a
 * branded `IanaTimezone`.
 *
 * Today the slug is informational only — a single-tenant deployment
 * reads `env.tenant.timezone` regardless of which slug was passed.
 * Domain callers continue to thread `tenant.slug` through so the
 * Application boundary doesn't change shape when F12 swaps in the
 * per-tenant config port.
 *
 * The env value is validated by `src/lib/env.ts` at boot via
 * `Intl.DateTimeFormat`, so the unsafe-cast here is sound — no
 * runtime IANA validation needed at the call site.
 */
export function getTenantTimezone(_tenantSlug: string): IanaTimezone {
  return unsafeIanaTimezone(env.tenant.timezone);
}
