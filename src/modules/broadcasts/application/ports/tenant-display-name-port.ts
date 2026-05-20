/**
 * Phase 5 (F7.1a US7) — `TenantDisplayNamePort` Application port.
 *
 * Narrow port for tenant display-name resolution. The value flows into
 * `substituteChamberName` (Domain VO `template-snapshot.ts`) at template
 * snapshot time per contracts/broadcast-template.md § 5.1.
 *
 * Single-tenant MVP (F7.1a): the production adapter reads from
 * `process.env.NEXT_PUBLIC_TENANT_NAME` with a 'SweCham' fallback —
 * mirrors the existing pattern at `src/app/(staff)/admin/layout.tsx:53`
 * which already surfaces the chamber name in the sidebar header.
 *
 * Multi-tenant future (F10+): when the SaaS `tenants` table lands the
 * adapter swaps to query `tenants.display_name` keyed by the tenant
 * slug; the snapshot use-case is unaffected per Clean Architecture.
 *
 * Pure interface — no framework imports (Constitution Principle III
 * NON-NEGOTIABLE).
 */
import type { TenantSlug } from '@/modules/tenants';

export interface TenantDisplayNamePort {
  /**
   * Resolve the human-readable chamber name for the given tenant.
   *
   * MUST NEVER throw — adapters fall back to a stable default (e.g.
   * 'SweCham' for single-tenant MVP) so the snapshot operation never
   * fails on a missing tenant lookup. The caller HTML-escapes the
   * returned string before inserting it into draft body/subject.
   */
  resolve(tenantId: TenantSlug): Promise<string>;
}
