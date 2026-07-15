/**
 * 065 L-2 / L-1 — `runListMemberVatRegistrantByIds` failure-path honesty.
 *
 * The B5 buyerIsVatRegistrant enrichment wrapper degrades to an EMPTY map on
 * infrastructure failure (the picker falls back to the legacy
 * matched⇒has-TIN guess; server-side issuance guards stay authoritative).
 * Pre-065 the degradation was a single warn with only `err.message` —
 * programming errors were indistinguishable from Neon blips, and ops had
 * no alertable signal. This file pins:
 *
 *   1. happy passthrough — the tenant-scoped read's map is returned as-is;
 *   2. infra throw → empty map + warn carrying `errName` + the
 *      `eventcreate_member_tin_enrichment_degraded_total` counter (L-1);
 *   3. malformed tenant slug → InvalidTenantSlugError PROPAGATES (caller
 *      bug — `asTenantContext` runs OUTSIDE the try, never degraded into
 *      the silent empty-map arm);
 *   4. empty memberIds → empty map without opening a tenant tx.
 *
 * `@/lib/db` is mocked at the seam (cron-orchestration unit-test pattern)
 * so no live Neon is needed.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { InvalidTenantSlugError } from '@/modules/tenants';
import { eventcreateMetrics } from '@/lib/metrics';
import { logger } from '@/lib/logger';

const runInTenantMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => ({
  runInTenant: runInTenantMock,
}));

vi.mock('@/lib/logger', async () => {
  const actual = await vi.importActual<typeof import('@/lib/logger')>('@/lib/logger');
  // Dynamic import (not a static top-level import) — sidesteps hoisting/
  // TDZ ordering entirely, so this is safe regardless of where `@/lib/logger`
  // first gets pulled in relative to this file's other static imports.
  const { createMockLogger } = await import('../../helpers/mock-logger');
  return {
    ...actual,
    logger: createMockLogger({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
  };
});

import { runListMemberVatRegistrantByIds } from '@/lib/events-admin-deps';

const MEMBER_IDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
];

describe('runListMemberVatRegistrantByIds — 065 L-2/L-1 failure-path honesty', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path — returns the tenant-scoped presence map unchanged', async () => {
    const presence = new Map([[MEMBER_IDS[0]!, true]]);
    runInTenantMock.mockResolvedValueOnce(presence);
    const out = await runListMemberVatRegistrantByIds('test-swecham', MEMBER_IDS);
    expect(out).toBe(presence);
    expect(runInTenantMock).toHaveBeenCalledTimes(1);
  });

  it('infra throw → EMPTY map + warn carries errName + degradation metric fires (L-1)', async () => {
    const degraded = vi.spyOn(eventcreateMetrics, 'tinEnrichmentDegraded');
    class NeonBlip extends Error {
      override readonly name = 'NeonBlip';
    }
    runInTenantMock.mockRejectedValueOnce(new NeonBlip('connection reset'));

    const out = await runListMemberVatRegistrantByIds('test-swecham', MEMBER_IDS);
    expect(out.size).toBe(0);
    // L-2 — errName distinguishes a future programming-error class
    // (TypeError etc.) from an infrastructure blip in the logs.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'f6_member_vat_registrant_lookup_failed',
        tenant_slug: 'test-swecham',
        member_id_count: 2,
        errName: 'NeonBlip',
      }),
      expect.stringContaining('buyerIsVatRegistrant enrichment lookup failed'),
    );
    // No member ids / PII in the warn payload — count only.
    const warnPayload = JSON.stringify(vi.mocked(logger.warn).mock.calls[0]?.[0]);
    expect(warnPayload).not.toContain(MEMBER_IDS[0]!);
    // L-1 — alertable degradation counter.
    expect(degraded).toHaveBeenCalledWith('test-swecham');
    degraded.mockRestore();
  });

  it('non-Error throw → errName falls back to "unknown" (still degraded, still counted)', async () => {
    const degraded = vi.spyOn(eventcreateMetrics, 'tinEnrichmentDegraded');
    runInTenantMock.mockRejectedValueOnce('string failure');
    const out = await runListMemberVatRegistrantByIds('test-swecham', MEMBER_IDS);
    expect(out.size).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errName: 'unknown', err: 'string failure' }),
      expect.any(String),
    );
    expect(degraded).toHaveBeenCalledWith('test-swecham');
    degraded.mockRestore();
  });

  it('malformed tenant slug → InvalidTenantSlugError PROPAGATES (caller bug, never the silent empty-map arm)', async () => {
    const degraded = vi.spyOn(eventcreateMetrics, 'tinEnrichmentDegraded');
    await expect(
      runListMemberVatRegistrantByIds('Bad Slug!', MEMBER_IDS),
    ).rejects.toThrow(InvalidTenantSlugError);
    expect(runInTenantMock).not.toHaveBeenCalled();
    expect(degraded).not.toHaveBeenCalled();
    degraded.mockRestore();
  });

  it('empty memberIds → empty map WITHOUT opening a tenant tx', async () => {
    const out = await runListMemberVatRegistrantByIds('test-swecham', []);
    expect(out.size).toBe(0);
    expect(runInTenantMock).not.toHaveBeenCalled();
  });
});
