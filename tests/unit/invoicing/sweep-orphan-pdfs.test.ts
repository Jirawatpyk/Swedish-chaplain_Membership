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
 * names references exactly that key. One lock-free batch read per page keeps
 * every referenced key; only the rest are re-checked under the invoice row
 * lock (or, for a credit note, deleted on the etag).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const metricMock = vi.hoisted(() => ({ orphanBlobCleanupFailed: vi.fn() }));
vi.mock('@/lib/metrics', () => ({ invoicingMetrics: metricMock }));

import {
  ORPHAN_PDF_LIST_TIMEOUT_MS,
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
  status?: string;
  receiptPdfStatus?: 'pending' | 'rendered' | 'failed' | null;
}

function makeDeps(opts: {
  items: Item[];
  rows?: Record<string, Row>;
  creditNotes?: Record<string, string>;
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
    listPage: vi.fn(async (prefix: string, cursor: string | undefined, limit: number, _o?: { signal?: AbortSignal }) => {
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
  // The lock-free batch read: every key the named rows reference.
  const referencedKeys = vi.fn(
    async (tenantId: string, ids: { invoiceIds: readonly string[]; creditNoteIds: readonly string[] }) => {
      expect(tenantId).toBe(T);
      const keys = new Set<string>();
      for (const id of ids.invoiceIds) {
        const r = rows[id];
        if (r?.pdf) keys.add(r.pdf.blobKey);
        if (r?.receiptPdf) keys.add(r.receiptPdf.blobKey);
      }
      for (const id of ids.creditNoteIds) {
        const k = opts.creditNotes?.[id];
        if (k) keys.add(k);
      }
      return keys;
    },
  );
  const deps = {
    blob,
    clock: { nowIso: () => NOW.toISOString() },
    listTenantIds: vi.fn(async () => opts.tenants ?? [T]),
    referencedKeys,
    reposFor: vi.fn(() => ({ invoiceRepo })),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return { deps: deps as unknown as SweepOrphanPdfsDeps, blob, store, invoiceRepo, referencedKeys, raw: deps };
}

const item = (key: string, uploadedAt = OLD, etag = `etag-${key}`): Item => ({ key, uploadedAt, etag });

beforeEach(() => metricMock.orphanBlobCleanupFailed.mockClear());

describe('parseOrphanPdfKey', () => {
  it('reads the three PDF shapes and nothing else', () => {
    expect(parseOrphanPdfKey(invoiceKey(INV), T)).toEqual({ kind: 'invoice', id: INV, fy: '2026', templateVersion: 13 });
    expect(parseOrphanPdfKey(receiptKey(INV, 12), T)).toEqual({ kind: 'receipt', id: INV, fy: '2026', templateVersion: 12 });
    expect(parseOrphanPdfKey(cnKey(CN), T)).toEqual({ kind: 'credit_note', id: CN, fy: '2026', templateVersion: 13 });
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
    const { deps, blob, invoiceRepo } = makeDeps({
      items: [item(invoiceKey(INV)), item(receiptKey(INV)), item(cnKey(CN))],
      rows: { [INV]: { pdf: { blobKey: invoiceKey(INV) }, receiptPdf: { blobKey: receiptKey(INV) } } },
      creditNotes: { [CN]: cnKey(CN) },
    });
    const r = await sweepOrphanPdfs({}, deps);
    expect(blob.delete).not.toHaveBeenCalled();
    // Kept by the lock-free batch read: no row lock is taken for them.
    expect(invoiceRepo.findByIdInTxForUpdate).not.toHaveBeenCalled();
    expect(r).toMatchObject({ scanned: 3, deleted: 0, kept: 3 });
  });

  it('one lock-free batch read per page names every parsed id; young and unknown keys are left out', async () => {
    const { deps, referencedKeys } = makeDeps({
      items: [item(invoiceKey(INV)), item(receiptKey(INV)), item(cnKey(CN)), item(receiptKey(INV2), YOUNG), item(`invoicing/${T}/logos/l.png`)],
      rows: { [INV]: { pdf: { blobKey: invoiceKey(INV) }, receiptPdf: { blobKey: receiptKey(INV) } } },
      creditNotes: { [CN]: cnKey(CN) },
    });
    await sweepOrphanPdfs({}, deps);
    expect(referencedKeys).toHaveBeenCalledTimes(1);
    expect(referencedKeys).toHaveBeenCalledWith(T, { invoiceIds: [INV], creditNoteIds: [CN] });
  });

  it('a failed batch read keeps the whole page (fail-safe), counted as failed and metered', async () => {
    const { deps, referencedKeys, blob, invoiceRepo } = makeDeps({ items: [item(receiptKey(INV)), item(cnKey(CN))] });
    referencedKeys.mockRejectedValueOnce(new Error('db down'));
    const r = await sweepOrphanPdfs({}, deps);
    expect(blob.delete).not.toHaveBeenCalled();
    expect(invoiceRepo.findByIdInTxForUpdate).not.toHaveBeenCalled();
    expect(metricMock.orphanBlobCleanupFailed).toHaveBeenCalledWith('sweeper');
    expect(r).toMatchObject({ failed: 2, deleted: 0 });
  });

  it.each(['pending', 'failed'] as const)(
    'a paid invoice whose async receipt is %s keeps its receipt key, even on an unchanged etag (financial H-1)',
    async (receiptPdfStatus) => {
      // The async worker uploads before it locks the row; its re-render is
      // byte-identical, so the etag check alone cannot tell its bytes apart.
      const { deps, blob } = makeDeps({
        items: [item(receiptKey(INV))],
        rows: { [INV]: { pdf: { blobKey: invoiceKey(INV) }, receiptPdf: null, status: 'paid', receiptPdfStatus } },
      });
      const r = await sweepOrphanPdfs({}, deps);
      expect(blob.delete).not.toHaveBeenCalled();
      expect(r).toMatchObject({ kept: 1, deleted: 0 });
    },
  );

  it('a paid invoice with a rendered receipt at another version: the stray receipt key is deleted', async () => {
    const { deps, store } = makeDeps({
      items: [item(receiptKey(INV, 13))],
      rows: {
        [INV]: { pdf: { blobKey: invoiceKey(INV, 12) }, receiptPdf: { blobKey: receiptKey(INV, 12) }, status: 'paid', receiptPdfStatus: 'rendered' },
      },
    });
    await sweepOrphanPdfs({}, deps);
    expect(store.has(receiptKey(INV, 13))).toBe(false);
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

  it('an orphan credit-note PDF (no row) is deleted with its etag, read straight from credit_notes', async () => {
    const { deps, blob, referencedKeys, invoiceRepo } = makeDeps({ items: [item(cnKey(CN))] });
    const r = await sweepOrphanPdfs({}, deps);
    expect(referencedKeys).toHaveBeenCalledWith(T, { invoiceIds: [], creditNoteIds: [CN] });
    expect(invoiceRepo.findByIdInTxForUpdate).not.toHaveBeenCalled();
    expect(blob.delete).toHaveBeenCalledWith(cnKey(CN), { ifMatch: `etag-${cnKey(CN)}` });
    expect(r).toMatchObject({ deleted: 1 });
  });

  it('a credit-note dry run deletes nothing', async () => {
    const { deps, blob } = makeDeps({ items: [item(cnKey(CN))] });
    const r = await sweepOrphanPdfs({ dryRun: true }, deps);
    expect(blob.delete).not.toHaveBeenCalled();
    expect(r).toMatchObject({ wouldDelete: 1, deleted: 0 });
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
    expect(blob.listPage).toHaveBeenNthCalledWith(1, `invoicing/${T}/`, undefined, expect.any(Number), {
      signal: expect.any(AbortSignal),
    });
    expect(blob.listPage).toHaveBeenNthCalledWith(2, `invoicing/${T}/`, '1', expect.any(Number), {
      signal: expect.any(AbortSignal),
    });
    expect(r).toMatchObject({ scanned: 2, deleted: 2, truncated: false, tenantsCompleted: 1 });
  });

  it('each listing is bounded: a hung page is aborted and that tenant is skipped (reliability H2)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { deps, blob } = makeDeps({ items: [] });
      blob.listPage.mockImplementationOnce(
        (_p: string, _c: string | undefined, _l: number, o?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            o?.signal?.addEventListener('abort', () => reject(o.signal!.reason));
          }),
      );
      const run = sweepOrphanPdfs({}, deps);
      await vi.advanceTimersByTimeAsync(ORPHAN_PDF_LIST_TIMEOUT_MS + 1);
      const r = await run;
      expect(r).toEqual({ kind: 'scan_failed' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs name the document, never its public Blob key (reliability L2)', async () => {
    const { deps, raw } = makeDeps({ items: [item(receiptKey(INV, 12))] });
    await sweepOrphanPdfs({}, deps);
    const deleted = raw.logger.info.mock.calls.find((c) => c[0].event === 'orphan_pdf_sweep_deleted');
    expect(deleted?.[0]).toMatchObject({ tenantId: T, docKind: 'receipt', documentId: INV, fy: '2026', templateVersion: 12 });
    for (const fn of [raw.logger.info, raw.logger.warn, raw.logger.error]) {
      for (const c of fn.mock.calls) expect(JSON.stringify(c)).not.toContain(receiptKey(INV, 12));
    }
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
    const { deps, store, raw } = makeDeps({ items: [INV, INV2].map((id) => item(receiptKey(id))) });
    const r = await sweepOrphanPdfs({ maxDeletes: 1 }, deps);
    expect(store.size).toBe(1);
    expect(r).toMatchObject({ deleted: 1, truncated: true, tenantsCompleted: 0 });
    expect(raw.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'orphan_pdf_sweep_truncated' }), expect.any(String));
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
    expect(r).toMatchObject({ kind: 'ok', tenants: 2, tenantsCompleted: 1, listFailed: 1, deleted: 1 });
    // A listing failure is metered, not only logged (reliability M1).
    expect(metricMock.orphanBlobCleanupFailed).toHaveBeenCalledWith('sweeper');
  });

  it('every tenant listing failing is scan_failed, so a dead Blob token cannot report green', async () => {
    const c = makeDeps({ items: [], tenants: ['a', 'b'] });
    c.blob.listPage.mockRejectedValue(new Error('403'));
    expect(await sweepOrphanPdfs({}, c.deps)).toEqual({ kind: 'scan_failed' });
  });

  it('no tenants is ok, with a warning', async () => {
    const d = makeDeps({ items: [], tenants: [] });
    expect(await sweepOrphanPdfs({}, d.deps)).toMatchObject({ kind: 'ok', tenants: 0 });
    expect(d.raw.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'orphan_pdf_sweep_no_tenants' }), expect.any(String));
  });
});
