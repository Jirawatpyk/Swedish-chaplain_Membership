/**
 * V3 (088 US8 UX-B1 verify-followup) — unit coverage for the cert-VIEW
 * use-case `getZeroRateCertSignedUrl`. The UPLOAD + PRUNE use-cases had unit
 * tests; the VIEW path (signed-url retrieval of the 10y §80/1(5) zero-rate
 * certificate SCAN) did not. This pins every Result branch:
 *
 *   happy path            → ok({ url, filename }) + `invoice_pdf_downloaded` audit
 *   cert_not_attached      → no `zeroRateCertBlobKey` pinned (cert NUMBER-only)
 *   cert_not_attached      → key present but NOT under this tenant/invoice's cert
 *                            namespace (IDOR / mispinned-row defence-in-depth)
 *   blob_missing           → key present but the Blob is gone (BlobNotFoundError)
 *   cross-tenant probe     → RLS-hidden foreign invoice (repo → null): emits
 *                            `invoice_cross_tenant_probe` + returns invoice_not_found
 *                            (Constitution Principle I clause 4)
 *
 * Mirrors the sibling `get-invoice-pdf-signed-url` unit deps shape. The use-case
 * only reads `zeroRateCertBlobKey` + `documentNumber` + `billDocumentNumberRaw`,
 * so the fixture is minimal (cast at the boundary, like the sibling).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  getZeroRateCertSignedUrl,
  type GetZeroRateCertSignedUrlDeps,
} from '@/modules/invoicing/application/use-cases/get-zero-rate-cert-signed-url';
import { asInvoiceId, type Invoice } from '@/modules/invoicing/domain/invoice';

const TENANT = 't';
const INVOICE_ID = 'i';
/** A validly-namespaced cert key: `invoicing/{tenant}/zero-rate-certs/{invoiceId}_…`. */
const CERT_KEY = `invoicing/${TENANT}/zero-rate-certs/${INVOICE_ID}_1720000000000.pdf`;

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    invoiceId: asInvoiceId(INVOICE_ID),
    tenantId: TENANT,
    // 088 zero-rate membership bill: no §87 documentNumber; label falls back to
    // the SC bill number for the download filename.
    documentNumber: null,
    billDocumentNumberRaw: 'SC-2026-000012',
    zeroRateCertBlobKey: CERT_KEY,
    ...overrides,
  } as unknown as Invoice;
}

function makeDeps(invoice: Invoice | null, opts: { signThrows?: unknown } = {}) {
  const emit = vi.fn(async () => {});
  const signDownloadUrl = vi.fn(async (key: string) => {
    if ('signThrows' in opts) throw opts.signThrows;
    return `https://blob.example/${key}?token=stub`;
  });
  const deps = {
    invoiceRepo: {
      findById: vi.fn(async () => invoice),
    } as unknown as GetZeroRateCertSignedUrlDeps['invoiceRepo'],
    blob: { signDownloadUrl } as unknown as GetZeroRateCertSignedUrlDeps['blob'],
    audit: { emit } as unknown as GetZeroRateCertSignedUrlDeps['audit'],
  } satisfies GetZeroRateCertSignedUrlDeps;
  return { deps, emit, signDownloadUrl };
}

const baseInput = {
  tenantId: TENANT,
  actorUserId: 'admin-1',
  actorRole: 'admin' as const,
  invoiceId: INVOICE_ID,
};

describe('getZeroRateCertSignedUrl — cert-view Result branches (V3)', () => {
  it('happy path — cert attached → signed url + deterministic filename + invoice_pdf_downloaded audit', async () => {
    const { deps, emit, signDownloadUrl } = makeDeps(makeInvoice());

    const r = await getZeroRateCertSignedUrl(deps, baseInput);

    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(r)}`).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.url).toBe(`https://blob.example/${CERT_KEY}?token=stub`);
    // label = documentNumber ?? billDocumentNumberRaw ?? invoiceId; ext from key.
    expect(r.value.filename).toBe('zero-rate-cert-SC-2026-000012.pdf');
    // Signed the pinned cert key (never anything else).
    expect(signDownloadUrl).toHaveBeenCalledWith(CERT_KEY);

    // Forensic trail: `invoice_pdf_downloaded` with the cert discriminator +
    // NO member_id (staff-only evidence, never on the F3 timeline).
    expect(emit).toHaveBeenCalledTimes(1);
    const ev = (emit as ReturnType<typeof vi.fn>).mock.calls[0]![1] as {
      eventType: string;
      payload: Record<string, unknown>;
    };
    expect(ev.eventType).toBe('invoice_pdf_downloaded');
    expect(ev.payload.document).toBe('zero_rate_cert');
    expect(ev.payload.actor_role).toBe('admin');
    expect('member_id' in ev.payload).toBe(false);
    // Audit fires BEFORE signing (durable-trail-before-serve invariant).
    expect((emit as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!).toBeLessThan(
      (signDownloadUrl as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
    );
  });

  it('cert_not_attached — invoice exists but has no cert scan pinned (cert NUMBER-only issue)', async () => {
    const { deps, emit, signDownloadUrl } = makeDeps(
      makeInvoice({ zeroRateCertBlobKey: null } as Partial<Invoice>),
    );

    const r = await getZeroRateCertSignedUrl(deps, baseInput);

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected cert_not_attached, got ok');
    expect(r.error.code).toBe('cert_not_attached');
    // No sign, no audit — the not-attached leg returns before both.
    expect(signDownloadUrl).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('cert_not_attached — key pinned but OUTSIDE this tenant/invoice cert namespace (IDOR defence-in-depth)', async () => {
    // A legacy/mispinned row whose key belongs to a DIFFERENT tenant. The
    // use-case re-verifies the namespace before signing so this admin proxy can
    // never sign + stream an arbitrary or cross-tenant blob (Vercel Blob has no
    // RLS → this is the tenant-isolation boundary, Constitution I).
    const foreignKey = `invoicing/other-tenant/zero-rate-certs/${INVOICE_ID}_1.pdf`;
    const { deps, signDownloadUrl } = makeDeps(
      makeInvoice({ zeroRateCertBlobKey: foreignKey } as Partial<Invoice>),
    );

    const r = await getZeroRateCertSignedUrl(deps, baseInput);

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected cert_not_attached, got ok');
    expect(r.error.code).toBe('cert_not_attached');
    expect(signDownloadUrl).not.toHaveBeenCalled();
  });

  it('blob_missing — cert key pinned but the Blob is gone (BlobNotFoundError) → typed blob_missing with key', async () => {
    const { deps, signDownloadUrl } = makeDeps(makeInvoice(), {
      signThrows: new Error('BlobNotFoundError: 404 not found'),
    });

    const r = await getZeroRateCertSignedUrl(deps, baseInput);

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected blob_missing, got ok');
    expect(r.error.code).toBe('blob_missing');
    if (r.error.code === 'blob_missing') expect(r.error.key).toBe(CERT_KEY);
    // The sign WAS attempted (on the correct key) before the miss was mapped.
    expect(signDownloadUrl).toHaveBeenCalledWith(CERT_KEY);
  });

  it('cross-tenant probe — RLS-hidden foreign invoice (repo → null) → invoice_cross_tenant_probe audit + invoice_not_found', async () => {
    const { deps, emit, signDownloadUrl } = makeDeps(null);

    const r = await getZeroRateCertSignedUrl(deps, {
      ...baseInput,
      actorUserId: 'attacker-1',
      actorRole: 'manager',
      invoiceId: 'foreign',
    });

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected invoice_not_found, got ok');
    expect(r.error.code).toBe('invoice_not_found');
    // A single probe audit; never a signed URL for a row we cannot see.
    expect(emit).toHaveBeenCalledTimes(1);
    const ev = (emit as ReturnType<typeof vi.fn>).mock.calls[0]![1] as {
      eventType: string;
      payload: Record<string, unknown>;
    };
    expect(ev.eventType).toBe('invoice_cross_tenant_probe');
    expect(ev.payload.actor_role).toBe('manager');
    expect(signDownloadUrl).not.toHaveBeenCalled();
  });
});
