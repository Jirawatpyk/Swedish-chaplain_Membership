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
    companyName: 'Acme Co',
    legalEntityType: null,
    country: 'TH',
    taxId: null,
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
    documentNumber: 'INV-2026-0001',
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

  it('includes the PDF bytes when the fetch succeeds', async () => {
    listInvoicesByMemberMock.mockResolvedValue({
      ok: true,
      value: { rows: [invoiceWithPdf()], total: 1 },
    });
    downloadBytesMock.mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46]));

    const data = await gdprArchiveSourceAdapter.gather(CTX, { subjectMemberId: MEMBER });
    expect(data!.invoices[0]!.pdf).not.toBeNull();
    // I3: filename disambiguated with invoiceId when a documentNumber is present
    // (collision-safe zip entry key).
    expect(data!.invoices[0]!.pdf!.filename).toBe('INV-2026-0001-inv-1.pdf');
    expect(Array.from(data!.invoices[0]!.pdf!.bytes)).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it('returns null when the subject member does not exist (→ member_not_found)', async () => {
    memberFindByIdMock.mockResolvedValue({ ok: false, error: { code: 'repo.not_found' } });
    const data = await gdprArchiveSourceAdapter.gather(CTX, { subjectMemberId: MEMBER });
    expect(data).toBeNull();
  });
});
