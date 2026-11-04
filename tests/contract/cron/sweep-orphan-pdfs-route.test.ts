/**
 * #729 — Contract test: GET/POST /api/cron/invoicing/sweep-orphan-pdfs.
 *
 * The composition wrapper is mocked (the orphan rule is pinned by
 * tests/unit/invoicing/sweep-orphan-pdfs.test.ts); this file owns the
 * route's auth, the write-freeze skip, the dry-run switch and the
 * outcome → HTTP mapping.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const CRON_SECRET = 'test-secret-32-bytes-long-aaaaaa';
const flagsMock = vi.hoisted(() => ({ readOnlyMode: false }));

vi.mock('@/lib/env', () => ({
  env: {
    cron: { secret: 'test-secret-32-bytes-long-aaaaaa' },
    flags: flagsMock,
    log: { level: 'silent' },
    isProduction: false,
    isDevelopment: false,
    isTest: true,
    nodeEnv: 'test' as const,
  },
}));
vi.mock('@/lib/metrics', () => ({
  renewalsMetrics: { cronBearerAuthRejected: vi.fn(), redisFallback: vi.fn() },
}));
const runSweepMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/invoicing-orphan-pdf-sweep-deps', () => ({
  runSweepOrphanPdfs: (...args: unknown[]) => runSweepMock(...args),
}));

import { GET, POST } from '@/app/api/cron/invoicing/sweep-orphan-pdfs/route';

function makeRequest(authorization: string | null, query = ''): NextRequest {
  const headers: Record<string, string> = {};
  if (authorization !== null) headers.authorization = authorization;
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    nextUrl: new URL(`https://x.test/api/cron/invoicing/sweep-orphan-pdfs${query}`),
  } as unknown as NextRequest;
}
const AUTH = `Bearer ${CRON_SECRET}`;
const OK = {
  kind: 'ok',
  dryRun: false,
  tenants: 1,
  scanned: 4,
  deleted: 1,
  wouldDelete: 0,
  kept: 2,
  skippedYoung: 1,
  skippedUnknown: 0,
  failed: 0,
  truncated: false,
};

describe('/api/cron/invoicing/sweep-orphan-pdfs — contract (#729)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('Vercel Cron calls GET: GET is POST', () => {
    expect(GET).toBe(POST);
  });

  it('401 without the bearer, and nothing runs', async () => {
    for (const auth of [null, 'Bearer wrong-secret-deadbeef-000000000000']) {
      const res = await POST(makeRequest(auth));
      expect(res.status).toBe(401);
    }
    expect(runSweepMock).not.toHaveBeenCalled();
  });

  it('READ_ONLY_MODE skips without sweeping', async () => {
    flagsMock.readOnlyMode = true;
    try {
      const res = await POST(makeRequest(AUTH));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, skipped: true, reason: 'read_only_mode' });
      expect(runSweepMock).not.toHaveBeenCalled();
    } finally {
      flagsMock.readOnlyMode = false;
    }
  });

  it('200 with the counts; a scheduled call is a real sweep', async () => {
    runSweepMock.mockResolvedValue(OK);
    const res = await POST(makeRequest(AUTH));
    expect(res.status).toBe(200);
    expect(runSweepMock).toHaveBeenCalledWith({ dryRun: false });
    expect(await res.json()).toMatchObject({
      ok: true,
      dryRun: false,
      tenants: 1,
      scanned: 4,
      deleted: 1,
      kept: 2,
      skippedYoung: 1,
      skippedUnknown: 0,
      failed: 0,
      truncated: false,
    });
  });

  it('?dryRun=1 asks for a dry run', async () => {
    runSweepMock.mockResolvedValue({ ...OK, dryRun: true, deleted: 0, wouldDelete: 1 });
    const res = await POST(makeRequest(AUTH, '?dryRun=1'));
    expect(runSweepMock).toHaveBeenCalledWith({ dryRun: true });
    expect(await res.json()).toMatchObject({ dryRun: true, wouldDelete: 1, deleted: 0 });
  });

  it('500 scan_failed when the tenant list fails or the sweep throws', async () => {
    runSweepMock.mockResolvedValueOnce({ kind: 'scan_failed' });
    expect((await POST(makeRequest(AUTH))).status).toBe(500);
    runSweepMock.mockRejectedValueOnce(new Error('boom'));
    const res = await POST(makeRequest(AUTH));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('scan_failed');
  });
});
