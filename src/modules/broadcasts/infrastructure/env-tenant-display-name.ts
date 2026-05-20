/**
 * Phase 5E (F7.1a US7) — `TenantDisplayNamePort` env-backed adapter.
 *
 * Single-tenant MVP impl: reads `process.env.NEXT_PUBLIC_TENANT_NAME`
 * (with 'SweCham' fallback). Mirrors the existing pattern at
 * `src/app/(staff)/admin/layout.tsx:53` and 8 auth-public pages which
 * already surface the chamber name in the UI chrome.
 *
 * Multi-tenant future (F10+): when the SaaS `tenants` table lands the
 * adapter swaps to query `tenants.display_name` keyed by the tenant
 * slug. Use-cases (e.g. T102 snapshotTemplateToDraft) consume only
 * the port interface so the swap is zero-impact above this file.
 *
 * Never throws (port contract) — empty/missing env var falls back to
 * 'SweCham' so the snapshot operation never fails on a missing tenant
 * lookup.
 */
import type { TenantDisplayNamePort } from '../application/ports/tenant-display-name-port';

const FALLBACK_TENANT_NAME = 'SweCham';

export const envTenantDisplayName: TenantDisplayNamePort = {
  resolve: async () => {
    const raw = process.env.NEXT_PUBLIC_TENANT_NAME;
    if (typeof raw === 'string' && raw.length > 0) return raw;
    return FALLBACK_TENANT_NAME;
  },
};
