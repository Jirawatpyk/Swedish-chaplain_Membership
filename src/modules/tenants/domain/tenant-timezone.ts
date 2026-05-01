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

const TENANT_TIMEZONES: Readonly<Record<string, string>> = Object.freeze({
  swecham: 'Asia/Bangkok',
});

/** Constitution § Hosting deviation places SweCham primary in Singapore;
 * member-facing display + quota math run in Asia/Bangkok per FR-006. */
const DEFAULT_TIMEZONE = 'Asia/Bangkok';

/**
 * Returns the IANA timezone identifier for the given tenant slug.
 *
 * Unknown slugs fall back to the project default rather than throwing —
 * this avoids regressing benefit-dashboard renders for tenants that get
 * onboarded ahead of an explicit map entry. Onboarding a new tenant
 * should still update this map so the future config-table migration
 * preserves the same timezone.
 */
export function getTenantTimezone(tenantSlug: string): string {
  return TENANT_TIMEZONES[tenantSlug] ?? DEFAULT_TIMEZONE;
}
