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
import { logger } from '@/lib/logger';
import type { TenantDisplayNamePort } from '../application/ports/tenant-display-name-port';

const FALLBACK_TENANT_NAME = 'SweCham';

// R4-S6 silent-L2 — log the fallback path ONCE per process so dev/
// staging observability picks up deployments where the env var is
// missing or empty. Subsequent calls don't re-log so the
// log volume stays bounded.
//
// R3.5 M-12 / R6.6 M-4 — test contamination caveat: this flag is
// module-scoped, so within a single Vitest worker (file-isolation,
// not test-isolation) the second test that hits the fallback won't
// see a repeat log. Test fixtures asserting on the warn fire MUST
// call `vi.resetModules()` before importing this module to clear the
// flag. (R4.3 M-14 added a `__resetForTestsOnly` export specifically
// for tests that preferred not to use `vi.resetModules` — R6.6
// removed it as dead code; no test in the repo ever called it.)
let warnedAboutFallback = false;

export const envTenantDisplayName: TenantDisplayNamePort = {
  resolve: async () => {
    const raw = process.env.NEXT_PUBLIC_TENANT_NAME;
    if (typeof raw === 'string' && raw.length > 0) return raw;
    if (!warnedAboutFallback) {
      warnedAboutFallback = true;
      logger.warn(
        { fallbackName: FALLBACK_TENANT_NAME },
        'broadcasts.tenant_display_name.env_fallback',
      );
    }
    return FALLBACK_TENANT_NAME;
  },
};

