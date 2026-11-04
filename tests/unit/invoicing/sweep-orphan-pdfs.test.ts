/**
 * #729 (task 63) — the orphan PDF sweeper.
 *
 * Record payment, issue, issue-as-paid and the credit-note issue upload a PDF
 * to a deterministic Blob key inside their transaction. The catch-path cleanup
 * covers a use case that fails by itself; these cases still leave bytes no row
 * references, which the daily sweep reclaims:
 *   (a) the function was killed after the upload, before the catch;
 *   (b) a caller-owned transaction rolled back after the use case returned ok;
 *   (c) the admin voided instead of retrying;
 *   (d) a template-version bump left the old `_v{n}` key behind.
 * The sweep never matches a key by pattern: it keeps a key iff the row it
 * names references exactly that key, re-checked under the invoice row lock.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const metricMock = vi.hoisted(() => ({ orphanBlobCleanupFailed: vi.fn() }));
vi.mock('@/lib/metrics', () => ({ invoicingMetrics: metricMock }));

import {
  ORPHAN_PDF_MIN_AGE_MS,
  parseOrphanPdfKey,
  sweepOrphanPdfs,
  type SweepOrphanPdfsDeps,
} from '@/modules/invoicing/application/use-cases/sweep-orphan-pdfs';
import { BlobChangedSinceUploadError } from '@/modules/invoicing/application/ports/blob-storage-port';

const T = 'test-swecham';
const NOW = new Date('2026-11-04T12:00:00.000Z');
const OLD = new Date(NOW.getTime() - ORPHAN_PDF_MIN_AGE_MS - 60_000);
const YOUNG = new Date(NOW.getTime() - 60_000);
const INV = '11111111-1111-4111-8111-111111111111';
const INV2 = '22222222-2222-4222-8222-222222222222';
const CN = '33333333-3333-4333-8333-333333333333';

const invoiceKey = (id: string, v = 13) => `invoicing/${T}/2026/${id}_v${v}.pdf`;
const receiptKey = (id: string, v = 13) => `invoicing/${T}/2026/${id}_receipt_v${v}.pdf`;
const cnKey = (id: string, v = 13) => `invoicing/${T}/2026/credit-note_${id}_v${v}.pdf`;

interface Item {
  key: string;
  uploadedAt: Date;
  etag: string;
}
interface Row {
  pdf: { blobKey: string } | null;
  receiptPdf: { blobKey: string } | null;
}

function makeDeps(opts: {
  items: Item[];
  rows?: Record<string, Row>;
  creditNotes?: Record<string, { pdf: { blobKey: string } }>;
  tenants?: string[];
  pageSize?: number;
  onLock?: (id: string, rows: Record<string, Row>) => void;
  deleteError?: (key: string) => unknown;
}) {
  const rows = opts.rows ?? {};
  const store = new Map(opts.items.map((i) => [i.key, i]));
  const listing = [...opts.items];
  const pageSize = opts.pageSize ?? 1000;
  const blob = {
    listPage: vi.fn(async (prefix: string, cursor: string | undefined, limit: number) => {
      // A snapshot of the listing: a delete does not shift a later page
      // (Blob cursors are opaque positions, not offsets into a live array).
      const all = listing.filter((i) => i.key.startsWith(prefix));
      const start = cursor ? Number(cursor) : 0;
      const n = Math.min(limit, pageSize);
      const items = all.slice(start, start + n);
      const next = start + n;
      return { items, cursor: next < all.length ? String(next) : undefined, hasMore: next < all.length };
    }),
    delete: vi.fn(async (key: string, options?: { ifMatch?: string }) => {
      const e = opts.deleteError?.(key);
      if (e) throw e;
      const it = store.get(key);
      if (it && options?.ifMatch !== undefined && options.ifMatch !== it.etag) {
        throw new BlobChangedSinceUploadError();
      }
      store.delete(key);
    }),
  };
  const invoiceRepo = {
    withTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(Symbol('tx'))),
    findByIdInTxForUpdate: vi.fn(async (_tx: unknown, id: string, tenantId: string) => {
      expect(tenantId).toBe(T);
      opts.onLock?.(id, rows);
      return rows[id] ?? null;
    }),
  };
  const creditNoteRepo = {
    findById: vi.fn(async (id: string, tenantId: string) => {
      expect(tenantId).toBe(T);
      return opts.creditNotes?.[id] ?? null;
    }),
  };
  const deps = {
    blob,
    clock: { nowIso: () => NOW.toISOString() },
    listTenantIds: vi.fn(async () => opts.tenants ?? [T]),
    reposFor: vi.fn(() => ({ invoiceRepo, creditNoteRepo })),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return { deps: deps as unknown as SweepOrphanPdfsDeps, blob, store, invoiceRepo, creditNoteRepo, raw: deps };
}

const item = (key: string, uploadedAt = OLD, etag = `etag-${key}`): Item => ({ key, uploadedAt, etag });

beforeEach(() => metricMock.orphanBlobCleanupFailed.mockClear());

describe('parseOrphanPdfKey', () => {
  it('reads the three PDF shapes and nothing else', () => {
    expect(parseOrphanPdfKey(invoiceKey(INV), T)).toEqual({ kind: 'invoice', id: INV });
    expect(parseOrphanPdfKey(receiptKey(INV), T)).toEqual({ kind: 'receipt', id: INV });
    expect(parseOrphanPdfKey(cnKey(CN), T)).toEqual({ kind: 'credit_note', id: CN });
    for (const k of [
      `invoicing/${T}/logos/logo.png`,
      `invoicing/${T}/zero-rate-certs/${INV}_1793700000000.pdf`,
      `invoicing/${T}/2026/${INV}.pdf`,
      `invoicing/${T}/2026/not-a-uuid_v13.pdf`,
      `invoicing/other-tenant/2026/${INV}_v13.pdf`,
      `invoicing/${T}/2026/${INV}_v13.pdf.bak`,
    ]) {
      expect(parseOrphanPdfKey(k, T)).toBeNull();
    }
  });
});

describe('sweepOrphanPdfs (#729)', () => {
  it('(a) a receipt nobody references (killed function) is deleted, conditional on its etag', async () => {
    const { deps, blob, store } = makeDeps({
      items: [item(receiptKey(INV))],
      rows: { [INV]: { pdf: { blobKey: invoiceKey(INV) }, receiptPdf: null } },
    });
    const r = await sweepOrphanPdfs({}, deps);
    expect(blob.delete).toHaveBeenCalledWith(receiptKey(INV), { ifMatch: `etag-${receiptKey(INV)}` });
    expect(store.has(receiptKey(INV))).toBe(false);
    expect(r).toMatchObject({ kind: 'ok', scanned: 1, deleted: 1, kept: 0 });
  });

  it('(b) a caller transaction rolled back: the row exists with no key → its invoice PDF is deleted', async () => {
    const { deps, store } = makeDeps({
      items: [item(invoiceKey(INV))],
      rows: { [INV]: { pdf: null, receiptPdf: null } },
    });
    const r = await sweepOrphanPdfs({}, deps);
    expect(store.has(invoiceKey(INV))).toBe(false);
    expect(r).toMatchObject({ deleted: 1 });
  });

  it('(c) voided instead of retried: the receipt key is unreferenced → deleted; the void PDF is kept', async () => {
    const { deps, store } = makeDeps({
      items: [item(invoiceKey(INV)), item(receiptKey(INV))],
      rows: { [INV]: { pdf: { blobKey: invoiceKey(INV) }, receiptPdf: null } },
    });
    const r = await sweepOrphanPdfs({}, deps);
    expect(store.has(receiptKey(INV))).toBe(false);
    expect(store.has(invoiceKey(INV))).toBe(true);
    expect(r).toMatchObject({ deleted: 1, kept: 1 });
  });

  it('(d) template bump: the row references _v12, so _v13 goes and _v12 stays', async () => {
    const { deps, store } = makeDeps({
      items: [item(receiptKey(INV, 12)), item(receiptKey(INV, 13))],
      rows: { [INV]: { pdf: { blobKey: invoiceKey(INV, 12) }, receiptPdf: { blobKey: receiptKey(INV, 12) } } },
    });
    await sweepOrphanPdfs({}, deps);
    expect(store.has(receiptKey(INV, 12))).toBe(true);
    expect(store.has(receiptKey(INV, 13))).toBe(false);
  });

  it('a referenced invoice, receipt or credit-note key is never deleted', async () => {
    const { deps, blob } = makeDeps({
      items: [item(invoiceKey(INV)), item(receiptKey(INV)), item(cnKey(CN))],
      rows: { [INV]: { pdf: { blobKey: invoiceKey(INV) }, receiptPdf: { blobKey: receiptKey(INV) } } },
      creditNotes: { [CN]: { pdf: { blobKey: cnKey(CN) } } },
    });
    const r = await sweepOrphanPdfs({}, deps);
    expect(blob.delete).not.toHaveBeenCalled();
    expect(r).toMatchObject({ scanned: 3, deleted: 0, kept: 3 });
  });

  it('race: a payment commits the key between the listing and the lock → kept', async () => {
    const { deps, blob } = makeDeps({
      items: [item(receiptKey(INV))],
      rows: { [INV]: { pdf: { blobKey: invoiceKey(INV) }, receiptPdf: null } },
      onLock: (id, rows) => {
        // The concurrent recordPayment held the row lock and committed first.
        rows[id] = { pdf: { blobKey: invoiceKey(INV) }, receiptPdf: { blobKey: receiptKey(INV) } };
      },
    });
    const r = await sweepOrphanPdfs({}, deps);
    expect(blob.delete).not.toHaveBeenCalled();
    expect(r).toMatchObject({ kept: 1, deleted: 0 });
  });

  it('bytes re-uploaded since the listing (etag changed) are kept', async () => {
    const { deps, store } = makeDeps({
      items: [item(receiptKey(INV))],
      rows: { [INV]: { pdf: null, receiptPdf: null } },
      // A retry overwrote the key after the listing, before the lock.
      onLock: () => store.set(receiptKey(INV), { ...store.get(receiptKey(INV))!, etag: 'etag-new' }),
    });
    const r = await sweepOrphanPdfs({}, deps);
    expect(store.has(receiptKey(INV))).toBe(true);
    expect(r).toMatchObject({ kept: 1, deleted: 0 });
  });

  it('a key younger than the minimum age is not even looked up', async () => {
    const { deps, invoiceRepo, blob } = makeDeps({ items: [item(receiptKey(INV), YOUNG)] });
    const r = await sweepOrphanPdfs({}, deps);
    expect(invoiceRepo.findByIdInTxForUpdate).not.toHaveBeenCalled();
    expect(blob.delete).not.toHaveBeenCalled();
    expect(r).toMatchObject({ skippedYoung: 1, deleted: 0 });
  });

  it('logos, zero-rate certs and unknown shapes under the prefix are never touched', async () => {
    const { deps, blob, invoiceRepo } = makeDeps({
      items: [
        item(`invoicing/${T}/logos/logo.png`),
        item(`invoicing/${T}/zero-rate-certs/${INV}_1793700000000.pdf`),
        item(`invoicing/${T}/2026/${INV}.pdf`),
      ],
    });
    const r = await sweepOrphanPdfs({}, deps);
    expect(blob.delete).not.toHaveBeenCalled();
    expect(invoiceRepo.findByIdInTxForUpdate).not.toHaveBeenCalled();
    expect(r).toMatchObject({ skippedUnknown: 3, scanned: 3 });
  });

  it('an orphan credit-note PDF (no row) is deleted with its etag; the lookup is tenant-scoped', async () => {
    const { deps, blob, creditNoteRepo } = makeDeps({ items: [item(cnKey(CN))] });
    const r = await sweepOrphanPdfs({}, deps);
    expect(creditNoteRepo.findById).toHaveBeenCalledWith(CN, T);
    expect(blob.delete).toHaveBeenCalledWith(cnKey(CN), { ifMatch: `etag-${cnKey(CN)}` });
    expect(r).toMatchObject({ deleted: 1 });
  });

  it('a missing invoice row (a deleted draft) makes its PDF an orphan', async () => {
    const { deps, store } = makeDeps({ items: [item(invoiceKey(INV2))] });
    await sweepOrphanPdfs({}, deps);
    expect(store.has(invoiceKey(INV2))).toBe(false);
  });

  it('lists only the tenant folder and pages through every cursor', async () => {
    const keys = [INV, INV2].map((id) => item(receiptKey(id)));
    const { deps, blob } = makeDeps({ items: keys, pageSize: 1 });
    const r = await sweepOrphanPdfs({}, deps);
    expect(blob.listPage).toHaveBeenNthCalledWith(1, `invoicing/${T}/`, undefined, expect.any(Number));
    expect(blob.listPage).toHaveBeenNthCalledWith(2, `invoicing/${T}/`, '1', expect.any(Number));
    expect(r).toMatchObject({ scanned: 2, deleted: 2, truncated: false });
  });

  it('dry run deletes nothing and reports what it would delete', async () => {
    const { deps, blob } = makeDeps({
      items: [item(receiptKey(INV))],
      rows: { [INV]: { pdf: null, receiptPdf: null } },
    });
    const r = await sweepOrphanPdfs({ dryRun: true }, deps);
    expect(blob.delete).not.toHaveBeenCalled();
    expect(r).toMatchObject({ kind: 'ok', dryRun: true, deleted: 0, wouldDelete: 1 });
  });

  it('stops at the deletion cap and says it was truncated', async () => {
    const { deps, store } = makeDeps({ items: [INV, INV2].map((id) => item(receiptKey(id))) });
    const r = await sweepOrphanPdfs({ maxDeletes: 1 }, deps);
    expect(store.size).toBe(1);
    expect(r).toMatchObject({ deleted: 1, truncated: true });
  });

  it('stops at the deadline and says it was truncated', async () => {
    const { deps, blob } = makeDeps({ items: [INV, INV2].map((id) => item(receiptKey(id))) });
    const r = await sweepOrphanPdfs({ deadlineMs: 0 }, deps);
    expect(blob.delete).not.toHaveBeenCalled();
    expect(r).toMatchObject({ truncated: true });
  });

  it('a failed delete is counted and metered, and the run goes on', async () => {
    const { deps, store } = makeDeps({
      items: [item(receiptKey(INV)), item(receiptKey(INV2))],
      deleteError: (key) => (key === receiptKey(INV) ? new Error('blob 503') : undefined),
    });
    const r = await sweepOrphanPdfs({}, deps);
    expect(store.has(receiptKey(INV2))).toBe(false);
    expect(metricMock.orphanBlobCleanupFailed).toHaveBeenCalledWith('sweeper');
    expect(r).toMatchObject({ failed: 1, deleted: 1 });
  });

  it('a failed locked read keeps the key (fail-safe) and counts it as failed', async () => {
    const { deps, invoiceRepo, blob } = makeDeps({ items: [item(receiptKey(INV))] });
    invoiceRepo.findByIdInTxForUpdate.mockRejectedValueOnce(new Error('db down'));
    const r = await sweepOrphanPdfs({}, deps);
    expect(blob.delete).not.toHaveBeenCalled();
    expect(r).toMatchObject({ failed: 1, deleted: 0 });
  });

  it('a tenant-list failure is scan_failed; a per-tenant listing failure skips only that tenant', async () => {
    const a = makeDeps({ items: [] });
    a.raw.listTenantIds.mockRejectedValueOnce(new Error('db'));
    expect(await sweepOrphanPdfs({}, a.deps)).toEqual({ kind: 'scan_failed' });

    const b = makeDeps({ items: [item(receiptKey(INV))], tenants: ['broken', T] });
    b.blob.listPage.mockImplementationOnce(async () => {
      throw new Error('list 500');
    });
    const r = await sweepOrphanPdfs({}, b.deps);
    expect(r).toMatchObject({ kind: 'ok', tenants: 2, deleted: 1 });
  });
});
