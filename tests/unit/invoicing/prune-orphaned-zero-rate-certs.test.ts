/**
 * 088 US8 UX-B2 (T061f) — unit coverage for `pruneOrphanedZeroRateCerts`,
 * the daily TTL sweep that prunes ABANDONED / SUPERSEDED §80/1(5) MFA
 * zero-rate cert-scan blobs (uploaded via the UX-B1 route but never pinned
 * onto an issued invoice). Mirrors the F6 `sweepExpiredErrorCsvBlobs` unit
 * suite (blob + repo + clock all mocked).
 *
 * The orphan rule under test:
 *   (a) PINNED cert (some invoice pins the exact key) → KEEP, even if very old
 *       (a pinned cert is 10y-retained legal evidence — NEVER swept).
 *   (b) UNPINNED + older than the 48h grace → DELETE.
 *   (c) UNPINNED + within the 48h grace → KEEP (protects a mid-issue upload).
 *   (d) MALFORMED key (no parseable uploaded-at ms) → skipped safely (NEVER
 *       deleted — we cannot compute its age, so we must not risk a pin).
 *   (e) Idempotent — a blob already gone (delete resolves as no-op, OR the
 *       adapter throws a not-found) counts as a successful sweep.
 *   (f) Counts (scanned / swept / skipped) are correct on a mixed run.
 *
 * Plus the DATA-LOSS-GUARD paths that must never delete:
 *   - the pinned-existence check THROWS → KEEP (fail-safe), never delete.
 *   - per-tenant blob.list THROWS → skip that tenant, continue the rest.
 *   - listCertTenantIds THROWS → `kind:'scan_failed'` (route → 500).
 *
 * Constitution Principle II — the failure/keep branches an integration suite
 * cannot cheaply induce are pinned here.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  pruneOrphanedZeroRateCerts,
  parseZeroRateCertKey,
  ORPHAN_CERT_GRACE_MS,
  type PruneOrphanedZeroRateCertsDeps,
} from '@/modules/invoicing/application/use-cases/prune-orphaned-zero-rate-certs';
import type { ClockPort } from '@/modules/invoicing/application/ports/clock-port';

const TENANT = 'swecham';
const NOW_ISO = '2026-07-02T00:00:00.000Z';
const NOW_MS = new Date(NOW_ISO).getTime();
const HOUR = 60 * 60 * 1000;

function certKey(msAgoHours: number, invoiceId = '11111111-1111-4111-8111-aaaaaaaaaaaa'): string {
  const ms = NOW_MS - msAgoHours * HOUR;
  return `invoicing/${TENANT}/zero-rate-certs/${invoiceId}_${ms}.pdf`;
}

const fixedClock: ClockPort = { nowIso: () => NOW_ISO };

function makeDeps(
  over: Partial<PruneOrphanedZeroRateCertsDeps> = {},
): PruneOrphanedZeroRateCertsDeps {
  return {
    blob: {
      list: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    clock: fixedClock,
    listCertTenantIds: vi.fn().mockResolvedValue([TENANT]),
    // Default: no invoice pins any key (everything is an orphan candidate).
    withTenantScope: vi.fn(async (_tenantId, fn) =>
      fn({ existsInvoiceWithCertBlobKey: vi.fn().mockResolvedValue(false) }),
    ),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  };
}

describe('parseZeroRateCertKey', () => {
  it('parses a well-formed cert key', () => {
    const key = 'invoicing/swecham/zero-rate-certs/11111111-1111-4111-8111-aaaaaaaaaaaa_1751414400000.pdf';
    const parsed = parseZeroRateCertKey(key);
    expect(parsed).toEqual({
      tenantId: 'swecham',
      invoiceId: '11111111-1111-4111-8111-aaaaaaaaaaaa',
      uploadedAtMs: 1751414400000,
    });
  });

  it('returns null for a key with no parseable ms suffix', () => {
    expect(parseZeroRateCertKey('invoicing/swecham/zero-rate-certs/no-timestamp.pdf')).toBeNull();
  });

  it('returns null for a non-cert key', () => {
    expect(parseZeroRateCertKey('invoicing/swecham/logos/abc.png')).toBeNull();
  });

  it('returns null for a zero / non-positive ms', () => {
    expect(
      parseZeroRateCertKey('invoicing/swecham/zero-rate-certs/id_0.pdf'),
    ).toBeNull();
  });
});

describe('pruneOrphanedZeroRateCerts', () => {
  it('(a) PINNED cert is KEPT even when very old', async () => {
    const deleteMock = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      blob: {
        list: vi.fn().mockResolvedValue([certKey(24 * 365 /* 1yr */)]),
        delete: deleteMock,
      },
      withTenantScope: vi.fn(async (_t, fn) =>
        fn({ existsInvoiceWithCertBlobKey: vi.fn().mockResolvedValue(true) }),
      ),
    });

    const out = await pruneOrphanedZeroRateCerts({}, deps);
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.scanned).toBe(1);
    expect(out.swept).toBe(0);
    expect(out.skipped).toBe(1);
    // A pinned cert must NEVER be deleted — the paramount data-loss guard.
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('(b) UNPINNED + older than the grace window is DELETED', async () => {
    const key = certKey(72); // 72h ago > 48h grace
    const deleteMock = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      blob: { list: vi.fn().mockResolvedValue([key]), delete: deleteMock },
    });

    const out = await pruneOrphanedZeroRateCerts({}, deps);
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.scanned).toBe(1);
    expect(out.swept).toBe(1);
    expect(out.skipped).toBe(0);
    expect(deleteMock).toHaveBeenCalledWith(key);
  });

  it('(c) UNPINNED but WITHIN the grace window is KEPT', async () => {
    const deleteMock = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      blob: { list: vi.fn().mockResolvedValue([certKey(1) /* 1h ago */]), delete: deleteMock },
    });

    const out = await pruneOrphanedZeroRateCerts({}, deps);
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.scanned).toBe(1);
    expect(out.swept).toBe(0);
    expect(out.skipped).toBe(1);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('(c-edge) exactly AT the grace boundary is KEPT (delete only when strictly older)', async () => {
    const key = `invoicing/${TENANT}/zero-rate-certs/id_${NOW_MS - ORPHAN_CERT_GRACE_MS}.pdf`;
    const deleteMock = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      blob: { list: vi.fn().mockResolvedValue([key]), delete: deleteMock },
    });
    const out = await pruneOrphanedZeroRateCerts({}, deps);
    if (out.kind !== 'ok') throw new Error('expected ok');
    expect(out.swept).toBe(0);
    expect(out.skipped).toBe(1);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('(d) MALFORMED key (no parseable ms) is skipped safely — NEVER deleted', async () => {
    const deleteMock = vi.fn().mockResolvedValue(undefined);
    const existsMock = vi.fn().mockResolvedValue(false);
    const deps = makeDeps({
      blob: {
        list: vi.fn().mockResolvedValue([
          `invoicing/${TENANT}/zero-rate-certs/no-timestamp.pdf`,
        ]),
        delete: deleteMock,
      },
      withTenantScope: vi.fn(async (_t, fn) =>
        fn({ existsInvoiceWithCertBlobKey: existsMock }),
      ),
    });

    const out = await pruneOrphanedZeroRateCerts({}, deps);
    if (out.kind !== 'ok') throw new Error('expected ok');
    expect(out.scanned).toBe(1);
    expect(out.swept).toBe(0);
    expect(out.skipped).toBe(1);
    expect(deleteMock).not.toHaveBeenCalled();
    // Malformed → we short-circuit BEFORE even asking whether it is pinned.
    expect(existsMock).not.toHaveBeenCalled();
  });

  it('(e) idempotent — delete resolving as a no-op (blob already gone) counts as swept', async () => {
    const deps = makeDeps({
      blob: {
        list: vi.fn().mockResolvedValue([certKey(72)]),
        delete: vi.fn().mockResolvedValue(undefined),
      },
    });
    const out = await pruneOrphanedZeroRateCerts({}, deps);
    if (out.kind !== 'ok') throw new Error('expected ok');
    expect(out.swept).toBe(1);
    expect(out.skipped).toBe(0);
  });

  it('(e) idempotent — delete THROWING a not-found error counts as swept', async () => {
    const deps = makeDeps({
      blob: {
        list: vi.fn().mockResolvedValue([certKey(72)]),
        delete: vi.fn().mockRejectedValue(new Error('Vercel Blob: blob not found (404)')),
      },
    });
    const out = await pruneOrphanedZeroRateCerts({}, deps);
    if (out.kind !== 'ok') throw new Error('expected ok');
    expect(out.swept).toBe(1);
    expect(out.skipped).toBe(0);
  });

  it('delete throwing a REAL (non-not-found) error → skipped + retried next tick', async () => {
    const deps = makeDeps({
      blob: {
        list: vi.fn().mockResolvedValue([certKey(72)]),
        delete: vi.fn().mockRejectedValue(new Error('Vercel Blob 503 service unavailable')),
      },
    });
    const out = await pruneOrphanedZeroRateCerts({}, deps);
    if (out.kind !== 'ok') throw new Error('expected ok');
    expect(out.swept).toBe(0);
    expect(out.skipped).toBe(1);
    expect(deps.logger?.warn).toHaveBeenCalled();
  });

  it('DATA-LOSS GUARD: pinned-existence check THROWS → KEEP (never delete)', async () => {
    const deleteMock = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      blob: { list: vi.fn().mockResolvedValue([certKey(72)]), delete: deleteMock },
      withTenantScope: vi.fn(async () => {
        throw new Error('runInTenant connection refused');
      }),
    });

    const out = await pruneOrphanedZeroRateCerts({}, deps);
    if (out.kind !== 'ok') throw new Error('expected ok');
    expect(out.swept).toBe(0);
    expect(out.skipped).toBe(1);
    // The blob must NOT be deleted when we cannot confirm it is unpinned.
    expect(deleteMock).not.toHaveBeenCalled();
    expect(deps.logger?.error).toHaveBeenCalled();
  });

  it('per-tenant blob.list THROWS → that tenant is skipped, others continue', async () => {
    const tenants = ['tenant-bad', 'tenant-ok'];
    const okDelete = vi.fn().mockResolvedValue(undefined);
    const listMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error('blob list 500');
      })
      .mockImplementationOnce(async () => [`invoicing/tenant-ok/zero-rate-certs/id_${NOW_MS - 72 * HOUR}.pdf`]);
    const deps = makeDeps({
      listCertTenantIds: vi.fn().mockResolvedValue(tenants),
      blob: { list: listMock, delete: okDelete },
    });

    const out = await pruneOrphanedZeroRateCerts({}, deps);
    if (out.kind !== 'ok') throw new Error('expected ok');
    // tenant-bad contributed nothing; tenant-ok swept its one orphan.
    expect(out.scanned).toBe(1);
    expect(out.swept).toBe(1);
    expect(okDelete).toHaveBeenCalledTimes(1);
    expect(deps.logger?.warn).toHaveBeenCalled();
  });

  it('scan_failed when the tenant-list step THROWS (route → 500)', async () => {
    const deps = makeDeps({
      listCertTenantIds: vi.fn().mockRejectedValue(new Error('tenant_invoice_settings query failed')),
    });
    const out = await pruneOrphanedZeroRateCerts({}, deps);
    expect(out.kind).toBe('scan_failed');
    expect(deps.logger?.error).toHaveBeenCalled();
  });

  it('(f) mixed run — counts correct across pinned / orphan / grace / malformed', async () => {
    const pinnedKey = certKey(999, '22222222-2222-4222-8222-bbbbbbbbbbbb'); // KEEP (pinned)
    const orphanKey = certKey(72, '33333333-3333-4333-8333-cccccccccccc'); // SWEEP
    const graceKey = certKey(2, '44444444-4444-4444-8444-dddddddddddd'); // KEEP (grace)
    const malformedKey = `invoicing/${TENANT}/zero-rate-certs/bad-key.pdf`; // KEEP (malformed)

    const existsMock = vi
      .fn()
      .mockImplementation(async (_t: string, key: string) => key === pinnedKey);
    const deleteMock = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      blob: {
        list: vi.fn().mockResolvedValue([pinnedKey, orphanKey, graceKey, malformedKey]),
        delete: deleteMock,
      },
      withTenantScope: vi.fn(async (_t, fn) =>
        fn({ existsInvoiceWithCertBlobKey: existsMock }),
      ),
    });

    const out = await pruneOrphanedZeroRateCerts({}, deps);
    if (out.kind !== 'ok') throw new Error('expected ok');
    expect(out.scanned).toBe(4);
    expect(out.swept).toBe(1);
    expect(out.skipped).toBe(3);
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(deleteMock).toHaveBeenCalledWith(orphanKey);
  });

  it('cutoff is derived from the injected clock (grace applied), NOT Date.now()', async () => {
    const deps = makeDeps();
    const out = await pruneOrphanedZeroRateCerts({}, deps);
    if (out.kind !== 'ok') throw new Error('expected ok');
    expect(out.cutoff.toISOString()).toBe(
      new Date(NOW_MS - ORPHAN_CERT_GRACE_MS).toISOString(),
    );
  });

  it('per-tenant list limit is clamped (input.limit > 1000 → 1000)', async () => {
    const listMock = vi.fn().mockResolvedValue([]);
    const deps = makeDeps({ blob: { list: listMock, delete: vi.fn() } });
    await pruneOrphanedZeroRateCerts({ limit: 999999 }, deps);
    expect(listMock).toHaveBeenCalledWith(
      `invoicing/${TENANT}/zero-rate-certs/`,
      1000,
    );
  });
});
