/**
 * F9 US6 (W1 — staff-review remediation) — gather adapter PDF-fetch resilience.
 *
 * The GDPR gather fetches each documented invoice's PDF bytes from F4's Blob.
 * A single PDF-fetch failure MUST NOT abort the whole archive (FR-037 applies to
 * the export job, but one missing media file is a soft failure): the invoice is
 * still recorded in `invoices.json` (record present), only its `pdf` is dropped
 * (logged). This pins that fail-soft contract by mocking the source barrels.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { TenantContext } from '@/modules/tenants';

const listInvoicesByMemberMock = vi.fn();
const downloadBytesMock = vi.fn();
const memberFindByIdMock = vi.fn();
const contactListByMemberMock = vi.fn();
const auditQueryMock = vi.fn();

vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({
    memberRepo: { findById: (...a: unknown[]) => memberFindByIdMock(...a) },
    contactRepo: { listByMember: (...a: unknown[]) => contactListByMemberMock(...a) },
  }),
}));
vi.mock('@/modules/members', () => ({
  asMemberId: (s: string) => s,
  asTenantId: (s: string) => s,
}));
vi.mock('@/modules/invoicing', () => ({
  listInvoicesByMember: (...a: unknown[]) => listInvoicesByMemberMock(...a),
  makeListInvoicesByMemberDeps: () => ({}),
  vercelBlobAdapter: { downloadBytes: (...a: unknown[]) => downloadBytesMock(...a) },
}));
vi.mock('@/modules/events', () => ({
  getEventAttendeesByMember: () => Promise.resolve([]),
  drizzleEventAttendeesQueryStrict: {},
}));
vi.mock('@/modules/broadcasts', () => ({
  listMemberBroadcasts: () => Promise.resolve({ rows: [], total: 0, totalPages: 0, page: 1 }),
  makeListMemberBroadcastsDeps: () => ({}),
}));
vi.mock('@/modules/auth', () => ({
  gdprAuditSubsetReadAdapter: { query: (...a: unknown[]) => auditQueryMock(...a) },
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/log-id', () => ({ errKind: () => 'MockError' }));

import { gdprArchiveSourceAdapter } from '@/modules/insights/infrastructure/sources/gdpr-archive-source-adapter';

const CTX = { slug: 'test-tenant' } as unknown as TenantContext;
const MEMBER = '22222222-2222-2222-2222-222222222222';

function baseMember() {
  return {
    memberId: MEMBER,
    memberNumber: 7,
    companyName: 'Acme Co',
    legalEntityType: null,
    country: 'TH',
    taxId: null,
    turnoverThb: 5_000_000,
    addressLine1: '99 Sukhumvit',
    addressLine2: 'Unit 5',
    city: 'Bangkok',
    province: 'Bangkok',
    postalCode: '10110',
    website: null,
    description: null,
    foundedYear: null,
    planId: 'plan-1',
    planYear: 2026,
    status: 'active',
    registrationDate: new Date('2026-01-01T00:00:00Z'),
    registrationFeePaid: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

function invoiceWithPdf() {
  return {
    invoiceId: 'inv-1',
    // DocumentNumber is a class with a `.raw` string (NOT a plain string) — mock
    // it faithfully so the `.raw` access path is exercised (F9-US6-03 guard).
    documentNumber: { raw: 'INV-2026-0001' },
    status: 'issued',
    fiscalYear: 2026,
    issueDate: '2026-02-01',
    dueDate: '2026-03-01',
    paidAt: null,
    currency: 'THB',
    subtotal: { satang: 100000n },
    vat: { satang: 7000n },
    total: { satang: 107000n },
    pdf: { blobKey: 'tenant/inv-1.pdf', sha256: 'abc', templateVersion: 1 },
  };
}

describe('gdprArchiveSourceAdapter.gather — PDF-fetch resilience (W1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memberFindByIdMock.mockResolvedValue({ ok: true, value: baseMember() });
    contactListByMemberMock.mockResolvedValue({ ok: true, value: [] });
    auditQueryMock.mockResolvedValue([]);
  });

  it('records the invoice without bytes when the PDF fetch throws (fail-soft)', async () => {
    listInvoicesByMemberMock.mockResolvedValue({
      ok: true,
      value: { rows: [invoiceWithPdf()], total: 1 },
    });
    downloadBytesMock.mockRejectedValue(new Error('blob 404'));

    const data = await gdprArchiveSourceAdapter.gather(CTX, { subjectMemberId: MEMBER });

    expect(data).not.toBeNull();
    expect(data!.invoices).toHaveLength(1);
    // Record is present (member still gets the invoice metadata) …
    expect(data!.invoices[0]!.record).toMatchObject({ documentNumber: 'INV-2026-0001' });
    // … but the PDF is dropped (not aborted), not a throw.
    expect(data!.invoices[0]!.pdf).toBeNull();
  });

  it('profile includes the member postal address (S1-P1-12 / GDPR Art.20 portability)', async () => {
    listInvoicesByMemberMock.mockResolvedValue({
      ok: true,
      value: { rows: [], total: 0 },
    });
    const data = await gdprArchiveSourceAdapter.gather(CTX, { subjectMemberId: MEMBER });
    expect(data).not.toBeNull();
    expect(data!.profile).toMatchObject({
      addressLine1: '99 Sukhumvit',
      addressLine2: 'Unit 5',
      city: 'Bangkok',
      province: 'Bangkok',
      postalCode: '10110',
      // P2 Wave-0 — turnover is the member's own subject-provided data.
      turnoverThb: 5_000_000,
    });
  });

  it("profile includes member_number — the subject's own display id (GDPR Art.15/20 transparency)", async () => {
    listInvoicesByMemberMock.mockResolvedValue({ ok: true, value: { rows: [], total: 0 } });
    const data = await gdprArchiveSourceAdapter.gather(CTX, { subjectMemberId: MEMBER });
    expect(data).not.toBeNull();
    expect(data!.profile).toMatchObject({ member_number: 7 });
  });

  it('contacts include dateOfBirth — material personal data (P2 Wave-0, GDPR Art.15/20)', async () => {
    listInvoicesByMemberMock.mockResolvedValue({ ok: true, value: { rows: [], total: 0 } });
    contactListByMemberMock.mockResolvedValue({
      ok: true,
      value: [
        {
          contactId: 'c-1',
          firstName: 'Dao',
          lastName: 'Srisai',
          email: 'dao@example.com',
          phone: null,
          dateOfBirth: new Date('1990-07-15T00:00:00Z'),
          roleTitle: null,
          preferredLanguage: 'th',
          isPrimary: true,
          removedAt: null,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
    });
    const data = await gdprArchiveSourceAdapter.gather(CTX, { subjectMemberId: MEMBER });
    expect(data).not.toBeNull();
    expect(data!.contacts[0]).toMatchObject({
      contactId: 'c-1',
      dateOfBirth: '1990-07-15T00:00:00.000Z',
    });
  });

  it('includes the PDF bytes when the fetch succeeds', async () => {
    listInvoicesByMemberMock.mockResolvedValue({
      ok: true,
      value: { rows: [invoiceWithPdf()], total: 1 },
    });
    downloadBytesMock.mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46]));

    const data = await gdprArchiveSourceAdapter.gather(CTX, { subjectMemberId: MEMBER });
    expect(data!.invoices[0]!.pdf).not.toBeNull();
    // I3: filename disambiguated with invoiceId when a documentNumber is present
    // (collision-safe zip entry key). F9-US6-03: uses documentNumber.raw, NOT the
    // DocumentNumber object (would be "[object Object]-inv-1.pdf").
    expect(data!.invoices[0]!.pdf!.filename).toBe('INV-2026-0001-inv-1.pdf');
    expect(Array.from(data!.invoices[0]!.pdf!.bytes)).toEqual([0x25, 0x50, 0x44, 0x46]);
    // invoices.json record serialises documentNumber via .raw (not [object Object]).
    expect(data!.invoices[0]!.record.documentNumber).toBe('INV-2026-0001');
  });

  it('returns null when the subject member does not exist (→ member_not_found)', async () => {
    memberFindByIdMock.mockResolvedValue({ ok: false, error: { code: 'repo.not_found' } });
    const data = await gdprArchiveSourceAdapter.gather(CTX, { subjectMemberId: MEMBER });
    expect(data).toBeNull();
  });

  it('FAILS LOUD when the contacts read errors — never degrades to an empty archive (C2)', async () => {
    // The headline C2 fix: a contacts DB error must throw (→ worker marks the job
    // failed), NOT silently ship a hollow contacts.json + under-scoped audit subset.
    listInvoicesByMemberMock.mockResolvedValue({ ok: true, value: { rows: [], total: 0 } });
    contactListByMemberMock.mockResolvedValue({ ok: false, error: { code: 'repo.unexpected' } });
    await expect(
      gdprArchiveSourceAdapter.gather(CTX, { subjectMemberId: MEMBER }),
    ).rejects.toThrow(/contacts list failed/);
  });

  it('names a draft invoice PDF by invoiceId alone when it has no documentNumber (I3)', async () => {
    listInvoicesByMemberMock.mockResolvedValue({
      ok: true,
      value: { rows: [{ ...invoiceWithPdf(), documentNumber: null }], total: 1 },
    });
    downloadBytesMock.mockResolvedValue(new Uint8Array([1]));
    const data = await gdprArchiveSourceAdapter.gather(CTX, { subjectMemberId: MEMBER });
    // No leading dash / no documentNumber → just the unique invoiceId.
    expect(data!.invoices[0]!.pdf!.filename).toBe('inv-1.pdf');
  });

  it('collapses path separators in a hostile documentNumber stem (zip-slip defence)', async () => {
    // documentNumber.raw is §87-allocator-generated today, but the zip entry key
    // `invoices/<filename>` must never be able to carry a path separator. A `/`
    // is collapsed to `_` so the entry can never escape the `invoices/` prefix.
    listInvoicesByMemberMock.mockResolvedValue({
      ok: true,
      value: {
        rows: [{ ...invoiceWithPdf(), documentNumber: { raw: '../../etc/passwd' } }],
        total: 1,
      },
    });
    downloadBytesMock.mockResolvedValue(new Uint8Array([1]));
    const data = await gdprArchiveSourceAdapter.gather(CTX, { subjectMemberId: MEMBER });
    const filename = data!.invoices[0]!.pdf!.filename;
    // Every `/` → `_`; dots/dashes are allowed (a `..` with no separator is inert).
    expect(filename).toBe('.._.._etc_passwd-inv-1.pdf');
    // The load-bearing invariant: no path separator survives.
    expect(filename).not.toContain('/');
  });

  it('collapses spaces and special chars in a documentNumber stem (zip-slip defence)', async () => {
    listInvoicesByMemberMock.mockResolvedValue({
      ok: true,
      value: {
        rows: [{ ...invoiceWithPdf(), documentNumber: { raw: 'INV 2026-001 (copy).txt' } }],
        total: 1,
      },
    });
    downloadBytesMock.mockResolvedValue(new Uint8Array([1]));
    const data = await gdprArchiveSourceAdapter.gather(CTX, { subjectMemberId: MEMBER });
    // space/parens → `_`; the allowed `.` `-` are preserved.
    expect(data!.invoices[0]!.pdf!.filename).toBe('INV_2026-001__copy_.txt-inv-1.pdf');
    // Symmetry with the path-traversal case: no separator survives.
    expect(data!.invoices[0]!.pdf!.filename).not.toContain('/');
    expect(data!.invoices[0]!.pdf!.filename).not.toContain('\\');
  });
});
