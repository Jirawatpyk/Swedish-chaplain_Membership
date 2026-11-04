/**
 * #729 — Contract test: GET/POST /api/cron/invoicing/sweep-orphan-blobs.
 *
 * One scheduled route reclaims both kinds of invoicing Blob orphans (the Pro
 * plan holds 40 crons and this keeps the count there): the zero-rate cert
 * prune first, then the orphan PDF sweep. The composition wrappers are mocked
 * (their rules are pinned by the unit suites); this file owns the route's
 * auth, the write-freeze skip, the delete gate, the dry-run switch and the
 * outcome → HTTP mapping.
 *
 * The delete gate (thai-tax HIGH-1, MEDIUM-2): the PDF sweep deletes only on
 * a production deployment with `FEATURE_ORPHAN_PDF_SWEEP_DELETE` on. Anywhere
 * else — a preview whose Neon branch lags the Blob store, a dev machine
 * holding the prod token, or prod before the first dry run was read — it
 * runs as a dry run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const CRON_SECRET = 'test-secret-32-bytes-long-aaaaaa';
const flagsMock = vi.hoisted(() => ({ readOnlyMode: false }));
const envMock = vi.hoisted(() => ({
  vercelEnv: 'production' as string | undefined,
  features: { orphanPdfSweepDelete: true },
}));

vi.mock('@/lib/env', () => ({
  env: {
    cron: { secret: 'test-secret-32-bytes-long-aaaaaa' },
    flags: flagsMock,
    log: { level: 'silent' },
    isProduction: false,
    isDevelopment: false,
    isTest: true,
    nodeEnv: 'test' as const,
    get vercelEnv() {
      return envMock.vercelEnv;
    },
    features: envMock.features,
  },
}));
vi.mock('@/lib/metrics', () => ({
  renewalsMetrics: { cronBearerAuthRejected: vi.fn(), redisFallback: vi.fn() },
}));
const runSweepMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/invoicing-orphan-pdf-sweep-deps', () => ({
  runSweepOrphanPdfs: (...args: unknown[]) => runSweepMock(...args),
}));
const runPruneMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/invoicing-cert-prune-deps', () => ({
  runPruneOrphanedZeroRateCerts: (...args: unknown[]) => runPruneMock(...args),
}));

import { GET, POST } from '@/app/api/cron/invoicing/sweep-orphan-blobs/route';

function makeRequest(authorization: string | null, query = ''): NextRequest {
  const headers: Record<string, string> = {};
  if (authorization !== null) headers.authorization = authorization;
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    nextUrl: new URL(`https://x.test/api/cron/invoicing/sweep-orphan-blobs${query}`),
  } as unknown as NextRequest;
}
const AUTH = `Bearer ${CRON_SECRET}`;
const PDFS_OK = {
  kind: 'ok',
  dryRun: false,
  tenants: 1,
  tenantsCompleted: 1,
  scanned: 4,
  deleted: 1,
  wouldDelete: 0,
  kept: 2,
  skippedYoung: 1,
  skippedUnknown: 0,
  failed: 0,
  listFailed: 0,
  truncated: false,
  breakdown: [{ docKind: 'receipt', fy: '2025', templateVersion: 12, wouldDelete: 0, deleted: 1, kept: 2, alreadyGone: 0, failed: 0 }],
  otherGroups: 0,
};
const CERTS_OK = { kind: 'ok', scanned: 3, swept: 1, skipped: 2, cutoff: new Date('2026-11-02T21:00:00.000Z') };

describe('/api/cron/invoicing/sweep-orphan-blobs — contract (#729)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.vercelEnv = 'production';
    envMock.features.orphanPdfSweepDelete = true;
    runSweepMock.mockResolvedValue(PDFS_OK);
    runPruneMock.mockResolvedValue(CERTS_OK);
  });

  it('Vercel Cron calls GET: GET is POST', () => {
    expect(GET).toBe(POST);
  });

  it('401 without the bearer, and nothing runs', async () => {
    for (const auth of [null, 'Bearer wrong-secret-deadbeef-000000000000']) {
      const res = await POST(makeRequest(auth));
      expect(res.status).toBe(401);
    }
    expect(runSweepMock).not.toHaveBeenCalled();
    expect(runPruneMock).not.toHaveBeenCalled();
  });

  it('READ_ONLY_MODE skips both without sweeping', async () => {
    flagsMock.readOnlyMode = true;
    try {
      const res = await POST(makeRequest(AUTH));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, skipped: true, reason: 'read_only_mode' });
      expect(runSweepMock).not.toHaveBeenCalled();
      expect(runPruneMock).not.toHaveBeenCalled();
    } finally {
      flagsMock.readOnlyMode = false;
    }
  });

  it('a scheduled call on production with the flag on runs the cert prune, then a real PDF sweep', async () => {
    const res = await POST(makeRequest(AUTH));
    expect(res.status).toBe(200);
    expect(runPruneMock).toHaveBeenCalledWith({});
    expect(runSweepMock).toHaveBeenCalledWith({ dryRun: false, deadlineMs: expect.any(Number) });
    expect(runPruneMock.mock.invocationCallOrder[0]!).toBeLessThan(runSweepMock.mock.invocationCallOrder[0]!);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      deletesEnabled: true,
      certs: { scanned: 3, swept: 1, skipped: 2, cutoff: '2026-11-02T21:00:00.000Z' },
      pdfs: { dryRun: false, tenants: 1, deleted: 1, kept: 2, truncated: false },
    });
    // #72 — the breakdown reaches the response, so a `?dryRun=1` call answers
    // the rollout question without reading logs.
    expect(body.pdfs.breakdown).toEqual(PDFS_OK.breakdown);
    expect(body.pdfs.otherGroups).toBe(0);
    expect(body.pdfs.kind).toBeUndefined();
  });

  it('the PDF sweep gets what is left of the 240 s budget after the cert prune', async () => {
    await POST(makeRequest(AUTH));
    const { deadlineMs } = runSweepMock.mock.calls[0]![0] as { deadlineMs: number };
    expect(deadlineMs).toBeGreaterThan(200_000);
    expect(deadlineMs).toBeLessThanOrEqual(240_000);
  });

  it.each([
    ['the flag is off on production', 'production', false],
    ['a preview deployment, flag on', 'preview', true],
    ['a development deployment, flag on', 'development', true],
    ['no VERCEL_ENV (a local machine), flag on', undefined, true],
  ] as const)('%s → the PDF sweep is a dry run (thai-tax HIGH-1)', async (_label, vercelEnv, flag) => {
    envMock.vercelEnv = vercelEnv;
    envMock.features.orphanPdfSweepDelete = flag;
    runSweepMock.mockResolvedValue({ ...PDFS_OK, dryRun: true, deleted: 0, wouldDelete: 1 });
    const res = await POST(makeRequest(AUTH));
    expect(res.status).toBe(200);
    expect(runSweepMock).toHaveBeenCalledWith({ dryRun: true, deadlineMs: expect.any(Number) });
    expect(await res.json()).toMatchObject({ deletesEnabled: false, pdfs: { dryRun: true, wouldDelete: 1 } });
    // The cert prune has no dry run: it runs on production only (R126 F2).
    if (vercelEnv === 'production') expect(runPruneMock).toHaveBeenCalledWith({});
    else expect(runPruneMock).not.toHaveBeenCalled();
  });

  it('off production the cert prune is skipped and says so (R126 F2)', async () => {
    envMock.vercelEnv = 'preview';
    const res = await POST(makeRequest(AUTH));
    expect(res.status).toBe(200);
    expect(runPruneMock).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ certs: { skipped: 'not_production' } });
  });

  it('?dryRun=1 is a PDF dry run and skips the cert prune (which has no dry run)', async () => {
    runSweepMock.mockResolvedValue({ ...PDFS_OK, dryRun: true, deleted: 0, wouldDelete: 1 });
    const res = await POST(makeRequest(AUTH, '?dryRun=1'));
    expect(runSweepMock).toHaveBeenCalledWith({ dryRun: true, deadlineMs: expect.any(Number) });
    expect(runPruneMock).not.toHaveBeenCalled();
    // The gate is open here, but this run deletes nothing: say so (code review #6).
    expect(await res.json()).toMatchObject({
      deletesEnabled: false,
      certs: { skipped: 'dry_run' },
      pdfs: { dryRun: true, wouldDelete: 1 },
    });
  });

  it('500 when either half fails, and the other half still runs', async () => {
    runPruneMock.mockResolvedValueOnce({ kind: 'scan_failed', cutoff: new Date() });
    let res = await POST(makeRequest(AUTH));
    expect(res.status).toBe(500);
    expect(runSweepMock).toHaveBeenCalledTimes(1);
    expect(await res.json()).toMatchObject({ error: { code: 'scan_failed' }, certs: { scanFailed: true }, pdfs: { deleted: 1 } });

    runPruneMock.mockRejectedValueOnce(new Error('boom'));
    res = await POST(makeRequest(AUTH));
    expect(res.status).toBe(500);
    expect(runSweepMock).toHaveBeenCalledTimes(2);

    runSweepMock.mockResolvedValueOnce({ kind: 'scan_failed' });
    res = await POST(makeRequest(AUTH));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: 'scan_failed' }, pdfs: { scanFailed: true }, certs: { swept: 1 } });

    runSweepMock.mockRejectedValueOnce(new Error('boom'));
    res = await POST(makeRequest(AUTH));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('scan_failed');
  });
});
