/**
 * F119 T035 — the image-sweep block in
 * `GET|POST /api/cron/broadcasts/prune-expired-drafts` (no new cron job:
 * 37 of 40 Pro slots are in use — plan § Summary).
 *
 * A SECOND, independently transacted block joins the daily draft prune:
 * its own try/catch, its own OK flag in the response body, a 500 only at
 * the end — so a fault in one half never drops the other. `GET = POST`
 * stays (native Vercel Cron invokes GET). The `CRON_SECRET` bearer check
 * guards both halves. T130 (PR-2) adds the reminder / expiry steps to the
 * same block.
 *
 * Wire contract, use cases mocked at the barrel; the last-reference rule
 * itself is pinned in `tests/unit/broadcasts/application/image-storage-port-delete.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { err, ok } from '@/lib/result';

const pruneMock = vi.fn();
const reclaimMock = vi.fn();
// T130 — the route's third block (the approval lifecycle); its own wire is
// pinned in `eblast-approval-lifecycle-cron.test.ts`. Here it just succeeds.
const lifecycleMock = vi.fn();

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-tenant', __brand: true }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/env', () => ({
  env: { cron: { secret: 'cron-secret-for-test' }, features: { f7Broadcasts: true }, flags: { readOnlyMode: false } },
}));
vi.mock('@/modules/broadcasts', () => ({
  pruneExpiredDrafts: (...args: unknown[]) => pruneMock(...args),
  makePruneExpiredDraftsDeps: () => ({}),
  reclaimOrphanedImages: (...args: unknown[]) => reclaimMock(...args),
  makeReclaimOrphanedImagesDeps: () => ({}),
  expireStaleMemberApprovals: (...args: unknown[]) => lifecycleMock(...args),
}));
vi.mock('@/lib/broadcast-approval-deps', () => ({ makeExpireStaleMemberApprovalsDeps: () => ({}) }));

function req(method: 'GET' | 'POST', auth = 'Bearer cron-secret-for-test'): NextRequest {
  return new NextRequest('http://localhost/api/cron/broadcasts/prune-expired-drafts', {
    method,
    headers: auth ? { authorization: auth } : {},
  });
}
const importRoute = () => import('@/app/api/cron/broadcasts/prune-expired-drafts/route');

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  pruneMock.mockResolvedValue(ok({ prunedCount: 2, cutoff: '2026-08-19T00:00:00.000Z' }));
  reclaimMock.mockResolvedValue(ok({ scanned: 3, blobsDeleted: 1, rowsRemoved: 3 }));
  lifecycleMock.mockResolvedValue(ok({ scanned: 0, remindersSent: 0, warningsSent: 0, expired: 0, rowsFailed: 0 }));
});
afterEach(() => vi.clearAllMocks());

describe('prune-expired-drafts — image sweep block (T035)', () => {
  it('runs BOTH blocks and reports each with its own OK flag; GET and POST are the same handler', async () => {
    const { GET, POST } = await importRoute();
    expect(GET).toBe(POST);
    const res = await GET(req('GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      tenantId: 'test-tenant',
      prunedCount: 2,
      imageSweep: { ok: true, scanned: 3, blobsDeleted: 1, rowsRemoved: 3 },
    });
    expect(pruneMock).toHaveBeenCalledTimes(1);
    expect(reclaimMock).toHaveBeenCalledTimes(1);
    const [, input] = reclaimMock.mock.calls[0]!;
    expect(input).toMatchObject({ tenantId: 'test-tenant' });
  });

  it('a fault in the image sweep does not drop the draft prune — both are reported, 500 only at the end', async () => {
    reclaimMock.mockRejectedValueOnce(new Error('blob store down'));
    const { POST } = await importRoute();
    const res = await POST(req('POST'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.prunedCount).toBe(2);
    expect(body.imageSweep).toMatchObject({ ok: false });
    expect(JSON.stringify(body)).not.toContain('blob store down');
  });

  it('a fault in the draft prune does not skip the image sweep', async () => {
    pruneMock.mockResolvedValueOnce(err({ kind: 'prune.server_error', message: 'db' }));
    const { POST } = await importRoute();
    const res = await POST(req('POST'));
    expect(res.status).toBe(500);
    expect(reclaimMock).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.imageSweep).toMatchObject({ ok: true, scanned: 3 });
  });

  /**
   * F7-1 — a per-row failure (e.g. an expired Blob token) used to leave only a
   * `warn` line inside the use case while the tick reported ok. It stays a 200
   * (a daily-cron 500 would hide the rows that DID succeed; the alert rides
   * the `broadcasts_image_sweep_row_failed_total` counter), but it is now in the
   * tick body and logged at `error` with its own errorId.
   */
  it('F7-1: rows that failed are reported and logged at error with an errorId — the tick stays 200', async () => {
    reclaimMock.mockResolvedValueOnce(
      ok({ scanned: 3, blobsDeleted: 0, rowsRemoved: 1, retained: 0, rowsFailed: 2 }),
    );
    const { POST } = await importRoute();
    const { logger } = await import('@/lib/logger');
    const res = await POST(req('POST'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.imageSweep).toMatchObject({ ok: true, rowsFailed: 2 });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ errorId: 'M119.cron.image_sweep.rows_failed', rowsFailed: 2 }),
      'cron.broadcasts.image_sweep.rows_failed',
    );
  });

  it('the CRON_SECRET bearer guards the whole handler — no block runs without it', async () => {
    const { POST } = await importRoute();
    const res = await POST(req('POST', 'Bearer wrong'));
    expect(res.status).toBe(401);
    expect(pruneMock).not.toHaveBeenCalled();
    expect(reclaimMock).not.toHaveBeenCalled();
    expect(lifecycleMock).not.toHaveBeenCalled();
  });
});
