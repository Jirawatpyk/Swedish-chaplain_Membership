/**
 * Unit tests for `getCreditNotePdfSignedUrl` (T080 / G-1).
 *
 * Mirrors the harness of `get-invoice-pdf-signed-url.test.ts` (plain
 * vi.fn port stubs, blob spy pushing signed keys into `callsKeys`) with
 * the CN fixture from `resend-pdf.test.ts`. Pins:
 *
 *   - admin/manager sign the STORED `cn.pdf.blobKey` and the filename is
 *     the §86/10 document number — and (I-1 CLOSED) every successful
 *     download emits the R8-M1 access-trail audit BEFORE signing, failing
 *     the read if the emit fails. AUDIT NOTE: reuses
 *     `invoice_pdf_downloaded` (10y) per the get-zero-rate-cert precedent;
 *     the summary + payload carry the credit-note identity.
 *   - G-1 member ownership: a member may sign only a CN whose
 *     `originalInvoiceMemberId` matches their own id; every denial is the
 *     OPAQUE `credit_note_not_found` (never `forbidden` — do not leak
 *     existence) + a `credit_note_cross_tenant_probe` audit row.
 *   - IM-4 blob-miss mapping: BlobNotFoundError / "404" / non-Error
 *     "not found" throws → typed `blob_missing` with the stored key;
 *     transient errors rethrow.
 *
 * Constitution Principle II — the PDF-download use-case is a file ACL
 * gate (PII surface), so this file targets 100% line + branch.
 */
import { describe, expect, it, vi } from 'vitest';
import { getCreditNotePdfSignedUrl } from '@/modules/invoicing/application/use-cases/get-credit-note-pdf-signed-url';
import type { CreditNoteRepo } from '@/modules/invoicing/application/ports/credit-note-repo';
import { asInvoiceId } from '@/modules/invoicing/domain/invoice';
import { asCreditNoteId, type CreditNote } from '@/modules/invoicing/domain/credit-note';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { asFiscalYearUnsafe } from '@/modules/invoicing/domain/value-objects/fiscal-year';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { makeMemberIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';
import { makeTenantIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/tenant-identity-snapshot';

const TENANT = 'test-tenant';
const INVOICE_UUID = '11111111-2222-4333-8444-555555555555';
const CN_UUID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const STORED_CN_BLOB_KEY = 'blob:cn-key';

function sha(): Sha256Hex {
  const parsed = Sha256Hex.parse('a'.repeat(64));
  if (!parsed.ok) throw new Error('bad fixture hash');
  return parsed.value;
}

function docNum(): DocumentNumber {
  const parsed = DocumentNumber.parse('INV-2026-000001');
  if (!parsed.ok) throw new Error('bad fixture doc number');
  return parsed.value;
}

function memberSnap() {
  return makeMemberIdentitySnapshot({
    legal_name: 'Test Co',
    tax_id: '0105537000000',
    address: '1 Test Rd',
    primary_contact_name: 'Somchai',
    primary_contact_email: 'member@example.com',
  });
}

function tenantSnap() {
  return makeTenantIdentitySnapshot({
    legal_name_th: 'หอการค้า',
    legal_name_en: 'Chamber Co',
    tax_id: '0105500000000',
    address_th: '1 ถนนทดสอบ',
    address_en: '1 Chamber Rd',
    logo_blob_key: null,
  });
}

function creditNoteFixture(overrides: Partial<CreditNote> = {}): CreditNote {
  return {
    tenantId: TENANT,
    creditNoteId: asCreditNoteId(CN_UUID),
    originalInvoiceId: asInvoiceId(INVOICE_UUID),
    originalInvoiceMemberId: 'member-m1',
    fiscalYear: asFiscalYearUnsafe(2026),
    sequenceNumber: 1,
    documentNumber: docNum(),
    issueDate: '2026-04-21',
    issuedByUserId: 'u-admin',
    reason: 'Partial refund',
    creditAmount: Money.fromSatangUnsafe(50_00n),
    vat: Money.fromSatangUnsafe(3_50n),
    total: Money.fromSatangUnsafe(53_50n),
    tenantIdentitySnapshot: tenantSnap(),
    memberIdentitySnapshot: memberSnap(),
    pdf: { blobKey: STORED_CN_BLOB_KEY, sha256: sha(), templateVersion: 1 },
    sourceRefundId: null,
    createdAt: '2026-04-21T00:00:00Z',
    updatedAt: '2026-04-21T00:00:00Z',
    ...overrides,
  };
}

function makeDeps(cn: CreditNote | null) {
  const callsKeys: string[] = [];
  const audit = vi.fn(async (_tx: unknown, _ev: unknown) => {});
  const creditNoteRepo = {
    insertCreditNote: vi.fn(),
    findById: vi.fn(async () => cn),
    findByOriginalInvoice: vi.fn(),
    findByOriginalInvoiceInTx: vi.fn(),
    listPaged: vi.fn(),
  } as unknown as CreditNoteRepo;
  const deps = {
    creditNoteRepo,
    blob: {
      signDownloadUrl: async (key: string) => {
        callsKeys.push(key);
        return `https://blob.example/${key}?token=stub`;
      },
    } as unknown as Parameters<typeof getCreditNotePdfSignedUrl>[0]['blob'],
    audit: { emit: audit },
  };
  return { deps, callsKeys, audit };
}

describe('getCreditNotePdfSignedUrl — staff happy paths (I-1: download audit CLOSED)', () => {
  it('admin success → signs cn.pdf.blobKey, filename is the §86/10 document number, download audit emitted', async () => {
    const cn = creditNoteFixture();
    const { deps, callsKeys, audit } = makeDeps(cn);

    const result = await getCreditNotePdfSignedUrl(deps, {
      tenantId: TENANT,
      actorUserId: 'u-admin',
      actorRole: 'admin',
      requestId: 'req-dl-1',
      creditNoteId: CN_UUID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.filename).toBe('INV-2026-000001.pdf');
      expect(result.value.url).toContain(STORED_CN_BLOB_KEY);
    }
    expect(callsKeys).toEqual([STORED_CN_BLOB_KEY]);
    // I-1 closed: the CN download now has the same reconstructable access
    // trail as the invoice/receipt siblings. AUDIT NOTE — deliberately
    // reuses `invoice_pdf_downloaded` (10y) like get-zero-rate-cert; the
    // summary + payload carry the credit-note identity.
    expect(audit).toHaveBeenCalledTimes(1);
    const call = audit.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(call.eventType).toBe('invoice_pdf_downloaded');
    expect(call.requestId).toBe('req-dl-1');
    expect(call.summary).toBe('Credit note PDF downloaded — INV-2026-000001');
    const payload = call.payload as Record<string, unknown>;
    expect(payload.credit_note_id).toBe(CN_UUID);
    expect(payload.actor_role).toBe('admin');
    expect(payload.actor_member_id).toBeNull();
    expect(payload.route).toBe('get-credit-note-pdf-signed-url');
  });

  it('manager success → signs the same stored blob key, download audit emitted', async () => {
    const cn = creditNoteFixture();
    const { deps, callsKeys, audit } = makeDeps(cn);

    const result = await getCreditNotePdfSignedUrl(deps, {
      tenantId: TENANT,
      actorUserId: 'u-manager',
      actorRole: 'manager',
      creditNoteId: CN_UUID,
    });

    expect(result.ok).toBe(true);
    expect(callsKeys).toEqual([STORED_CN_BLOB_KEY]);
    expect(audit).toHaveBeenCalledTimes(1);
    expect((audit.mock.calls[0]?.[1] as Record<string, unknown>).eventType).toBe(
      'invoice_pdf_downloaded',
    );
  });

  it('member with matching originalInvoiceMemberId → success, blobKey byte-identical to the admin path, audit carries the member id', async () => {
    const cn = creditNoteFixture();
    const adminCall = makeDeps(cn);
    const memberCall = makeDeps(cn);

    const adminResult = await getCreditNotePdfSignedUrl(adminCall.deps, {
      tenantId: TENANT,
      actorUserId: 'u-admin',
      actorRole: 'admin',
      creditNoteId: CN_UUID,
    });
    const memberResult = await getCreditNotePdfSignedUrl(memberCall.deps, {
      tenantId: TENANT,
      actorUserId: 'u-member',
      actorRole: 'member',
      actorMemberId: 'member-m1',
      creditNoteId: CN_UUID,
    });

    expect(adminResult.ok).toBe(true);
    expect(memberResult.ok).toBe(true);
    // Transitive byte-identical guarantee (FR-016 pattern): both roles
    // signed the SAME stored key → Vercel Blob streams the same object.
    expect(memberCall.callsKeys).toEqual([STORED_CN_BLOB_KEY]);
    expect(memberCall.callsKeys).toEqual(adminCall.callsKeys);
    if (adminResult.ok && memberResult.ok) {
      expect(memberResult.value.filename).toBe(adminResult.value.filename);
    }
    // The member-download twin of the staff audit (I-1).
    expect(memberCall.audit).toHaveBeenCalledTimes(1);
    const memberAudit = memberCall.audit.mock.calls[0]?.[1] as Record<string, unknown>;
    expect((memberAudit.payload as Record<string, unknown>).actor_member_id).toBe('member-m1');
  });

  it('R8-M1 ordering: an audit-emit throw FAILS the read — no URL is signed for an unrecorded download', async () => {
    const cn = creditNoteFixture();
    const { deps, callsKeys, audit } = makeDeps(cn);
    audit.mockRejectedValueOnce(new Error('audit_log unavailable'));

    await expect(
      getCreditNotePdfSignedUrl(deps, {
        tenantId: TENANT,
        actorUserId: 'u-admin',
        actorRole: 'admin',
        creditNoteId: CN_UUID,
      }),
    ).rejects.toThrow('audit_log unavailable');
    expect(callsKeys, 'the blob must never be signed when the trail cannot be written').toEqual([]);
  });
});

describe('getCreditNotePdfSignedUrl — G-1 member ownership denials (opaque + probe)', () => {
  it('member with MISMATCHED actorMemberId → opaque credit_note_not_found (NOT forbidden) + probe audit', async () => {
    const cn = creditNoteFixture();
    const { deps, callsKeys, audit } = makeDeps(cn);

    const result = await getCreditNotePdfSignedUrl(deps, {
      tenantId: TENANT,
      actorUserId: 'u-attacker',
      actorRole: 'member',
      actorMemberId: 'm-other',
      creditNoteId: CN_UUID,
    });

    expect(result.ok).toBe(false);
    // Opaque denial — existence must not leak to a non-owner member.
    if (!result.ok) expect(result.error.code).toBe('credit_note_not_found');
    expect(callsKeys, 'must NOT sign a URL when ownership fails').toEqual([]);
    expect(audit).toHaveBeenCalledTimes(1);
    const auditCall = audit.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(auditCall.eventType).toBe('credit_note_cross_tenant_probe');
    const payload = auditCall.payload as Record<string, unknown>;
    expect(payload.attempted_credit_note_id).toBe(CN_UUID);
    expect(payload.attempted_member_id).toBe('m-other');
    expect(payload.actor_role).toBe('member');
    expect(payload.route).toBe('get-credit-note-pdf-signed-url');
  });

  it('member with actorMemberId OMITTED → same opaque denial, probe records attempted_member_id null', async () => {
    const cn = creditNoteFixture();
    const { deps, callsKeys, audit } = makeDeps(cn);

    const result = await getCreditNotePdfSignedUrl(deps, {
      tenantId: TENANT,
      actorUserId: 'u-member',
      actorRole: 'member',
      // actorMemberId deliberately omitted — G-1 requires it for members.
      creditNoteId: CN_UUID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('credit_note_not_found');
    expect(callsKeys).toEqual([]);
    expect(audit).toHaveBeenCalledTimes(1);
    const auditCall = audit.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(auditCall.eventType).toBe('credit_note_cross_tenant_probe');
    expect((auditCall.payload as Record<string, unknown>).attempted_member_id).toBeNull();
    // requestId omitted on this call → probe row records null.
    expect(auditCall.requestId).toBeNull();
  });

  it('CN with originalInvoiceMemberId NULL + member actor → denied (no member can ever own it)', async () => {
    // A CN whose original invoice had no member (e.g. a non-member event
    // buyer) can never match ANY actorMemberId — the member arm must
    // fail closed rather than treat null===undefined as a match.
    const cn = creditNoteFixture({ originalInvoiceMemberId: null });
    const { deps, callsKeys, audit } = makeDeps(cn);

    const result = await getCreditNotePdfSignedUrl(deps, {
      tenantId: TENANT,
      actorUserId: 'u-member',
      actorRole: 'member',
      actorMemberId: 'member-m1',
      requestId: 'req-cn-6',
      creditNoteId: CN_UUID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('credit_note_not_found');
    expect(callsKeys).toEqual([]);
    expect(audit).toHaveBeenCalledTimes(1);
    const auditCall = audit.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(auditCall.eventType).toBe('credit_note_cross_tenant_probe');
    // requestId supplied → echoed onto the ownership-probe row.
    expect(auditCall.requestId).toBe('req-cn-6');
  });
});

describe('getCreditNotePdfSignedUrl — not-found probe', () => {
  it('repo returns null → credit_note_not_found + probe with attempted_credit_note_id and the requestId echoed', async () => {
    const { deps, callsKeys, audit } = makeDeps(null);

    const result = await getCreditNotePdfSignedUrl(deps, {
      tenantId: TENANT,
      actorUserId: 'u-admin',
      actorRole: 'admin',
      requestId: 'req-cn-7',
      creditNoteId: CN_UUID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('credit_note_not_found');
    expect(callsKeys).toEqual([]);
    expect(audit).toHaveBeenCalledTimes(1);
    const auditCall = audit.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(auditCall.eventType).toBe('credit_note_cross_tenant_probe');
    expect(auditCall.requestId).toBe('req-cn-7');
    const payload = auditCall.payload as Record<string, unknown>;
    expect(payload.attempted_credit_note_id).toBe(CN_UUID);
    expect(payload.actor_role).toBe('admin');
    expect(payload.route).toBe('get-credit-note-pdf-signed-url');
  });

  it('repo returns null + requestId OMITTED → probe row records requestId null', async () => {
    const { deps, audit } = makeDeps(null);

    const result = await getCreditNotePdfSignedUrl(deps, {
      tenantId: TENANT,
      actorUserId: 'u-admin',
      actorRole: 'admin',
      creditNoteId: CN_UUID,
    });

    expect(result.ok).toBe(false);
    expect(audit).toHaveBeenCalledTimes(1);
    const auditCall = audit.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(auditCall.requestId).toBeNull();
  });
});

// IM-4 — blob-miss handling parity with the invoice/receipt siblings.
describe('getCreditNotePdfSignedUrl — blob_missing handling (IM-4)', () => {
  function makeBlobThrowingDeps(cn: CreditNote, err: unknown) {
    const { deps } = makeDeps(cn);
    const throwingBlob = {
      signDownloadUrl: async () => {
        throw err;
      },
    } as unknown as Parameters<typeof getCreditNotePdfSignedUrl>[0]['blob'];
    return { ...deps, blob: throwingBlob };
  }

  it('BlobNotFoundError → returns blob_missing with the stored key', async () => {
    const cn = creditNoteFixture();
    const deps = makeBlobThrowingDeps(cn, new Error('BlobNotFoundError: blob not found'));
    const result = await getCreditNotePdfSignedUrl(deps, {
      tenantId: TENANT,
      actorUserId: 'u-admin',
      actorRole: 'admin',
      creditNoteId: CN_UUID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('blob_missing');
      if (result.error.code === 'blob_missing') {
        expect(result.error.key).toBe(STORED_CN_BLOB_KEY);
      }
    }
  });

  it('Error message containing "404" → returns blob_missing', async () => {
    const cn = creditNoteFixture();
    const deps = makeBlobThrowingDeps(cn, new Error('Upstream 404 Not Found'));
    const result = await getCreditNotePdfSignedUrl(deps, {
      tenantId: TENANT,
      actorUserId: 'u-admin',
      actorRole: 'admin',
      creditNoteId: CN_UUID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('blob_missing');
  });

  it('Generic Error (network) → rethrows (transient, not a miss)', async () => {
    const cn = creditNoteFixture();
    const deps = makeBlobThrowingDeps(cn, new Error('Connection refused'));
    await expect(
      getCreditNotePdfSignedUrl(deps, {
        tenantId: TENANT,
        actorUserId: 'u-admin',
        actorRole: 'admin',
        creditNoteId: CN_UUID,
      }),
    ).rejects.toThrow(/Connection refused/);
  });

  it('Non-Error throw (string) → still resolves blob_missing via the String(e) arm', async () => {
    const cn = creditNoteFixture();
    const deps = makeBlobThrowingDeps(cn, 'string-style not found error');
    const result = await getCreditNotePdfSignedUrl(deps, {
      tenantId: TENANT,
      actorUserId: 'u-admin',
      actorRole: 'admin',
      creditNoteId: CN_UUID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('blob_missing');
  });
});
