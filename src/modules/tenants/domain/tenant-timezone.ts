/**
 * Tenant timezone resolver — Domain helper (F7 US3 / T127).
 *
 * Returns the IANA timezone identifier for a given tenant slug. F7's
 * quota-year boundary, e-blast benefits dashboard, and reset-date
 * microcopy depend on tenant-local time even though storage is UTC
 * (Constitution § Conventions: ISO 8601 UTC for storage; tenant-tz
 * only at display + boundary-math edges).
 *
 * MVP scope: hard-coded constant map. SweCham is the only deployed
 * tenant per CLAUDE.md `Repository status` (single-tenant deployment
 * with multi-tenant-aware schema). When F12 white-label / multi-tenant
 * onboarding ships, this helper should be replaced by a per-tenant
 * config column read.
 *
 * F12-TODO: replace with `tenants.timezone` column lookup via a
 * read-only TenantConfigPort once F12 SaaS-multi-tenant lands.
 */

import { unsafeIanaTimezone, type IanaTimezone } from './iana-timezone';

/** Constitution § Hosting deviation places SweCham primary in Singapore;
 * member-facing display + quota math run in Asia/Bangkok per FR-006. */
const ASIA_BANGKOK: IanaTimezone = unsafeIanaTimezone('Asia/Bangkok');

const TENANT_TIMEZONES: Readonly<Record<string, IanaTimezone>> = Object.freeze({
  swecham: ASIA_BANGKOK,
});

const DEFAULT_TIMEZONE: IanaTimezone = ASIA_BANGKOK;

/**
 * Returns the IANA timezone identifier for the given tenant slug as a
 * branded `IanaTimezone`. Build-time-known mapping → no validation
 * overhead at call time.
 *
 * Unknown slugs fall back to the project default — avoids regressing
 * benefit-dashboard renders for tenants onboarded ahead of an explicit
 * map entry. **Hazard**: a future Stockholm/EU tenant onboarded BEFORE
 * its map entry lands silently gets `Asia/Bangkok` quota-year math —
 * quota windows would reset on Thai New Year, not the EU tenant's
 * local fiscal boundary. F12 multi-tenant config migration MUST run
 * before any non-SweCham tenant goes live. The Application-layer
 * caller in `compute-quota-counter.ts` logs a warn on the fallback
 * path so the misconfiguration is observable in prod logs.
 */
export function getTenantTimezone(tenantSlug: string): IanaTimezone {
  return TENANT_TIMEZONES[tenantSlug] ?? DEFAULT_TIMEZONE;
}

/** True iff the slug has an explicit map entry — Application-layer
 *  callers use this to gate fallback logging without coupling Domain
 *  to a logger import (Constitution Principle III). */
export function hasExplicitTenantTimezone(tenantSlug: string): boolean {
  return Object.prototype.hasOwnProperty.call(TENANT_TIMEZONES, tenantSlug);
}
