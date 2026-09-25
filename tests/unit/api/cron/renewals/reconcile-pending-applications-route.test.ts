/**
 * #408 — the weekly F8 reconcile-pending-applications cron honours
 * READ_ONLY_MODE.
 *
 * The route takes an advisory lock and dismisses orphaned tier-upgrade
 * suggestions (UPDATE + audit). Vercel Cron invokes it with GET, which
 * `src/proxy.ts` never freezes, so the route must skip by itself — after the
 * Bearer check, before the lock.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const CRON_SECRET = 'test-secret-32-bytes-long-aaaaaa';

const envMock = vi.hoisted(() => ({
  cron: { secret: 'test-secret-32-bytes-long-aaaaaa' },
  features: { f8Renewals: true },
  flags: { readOnlyMode: false },
  tenant: { slug: 'tenanta' },
  log: { level: 'silent' },
}));
vi.mock('@/lib/env', () => ({ env: envMock }));

const runInTenantMock = vi.hoisted(() =>
  vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({ execute: async () => [] })),
);
vi.mock('@/lib/db', () => ({ runInTenant: runInTenantMock }));

const reconcileMock = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    value: { orphansDetected: 0, orphansDismissed: 0, orphansSkippedBenign: 0 },
  })),
);
vi.mock('@/modules/renewals', () => ({
  reconcilePendingApplications: reconcileMock,
  makeRenewalsDeps: () => ({}),
}));
vi.mock('@/modules/tenants', () => ({ asTenantContext: (slug: string) => ({ slug }) }));

const skippedReadOnlyMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/metrics', () => ({
  renewalsMetrics: { coordinatorSkippedReadOnly: skippedReadOnlyMock },
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { GET, POST } from '@/app/api/cron/renewals/reconcile-pending-applications/route';

function makeRequest(auth?: string): NextRequest {
  return {
    headers: { get: (k: string) => (k.toLowerCase() === 'authorization' ? auth ?? null : null) },
  } as unknown as NextRequest;
}

describe('cron renewals reconcile-pending-applications — READ_ONLY_MODE (#408)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.flags.readOnlyMode = false;
  });

  it('freeze on → 200 skipped; no lock taken, nothing dismissed, metered', async () => {
    envMock.flags.readOnlyMode = true;
    expect(GET).toBe(POST);
    const res = await GET(makeRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: true, reason: 'read_only_mode' });
    expect(runInTenantMock).not.toHaveBeenCalled();
    expect(reconcileMock).not.toHaveBeenCalled();
    expect(skippedReadOnlyMock).toHaveBeenCalledWith('reconcile_pending_applications');
  });

  it('freeze on + wrong Bearer → still 401', async () => {
    envMock.flags.readOnlyMode = true;
    const res = await GET(makeRequest('Bearer wrong'));
    expect(res.status).toBe(401);
    expect(runInTenantMock).not.toHaveBeenCalled();
  });

  it('freeze off → the reconcile runs as before', async () => {
    const res = await GET(makeRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: false, tenant_id: 'tenanta', orphans_detected: 0 });
    expect(reconcileMock).toHaveBeenCalledTimes(1);
  });
});
