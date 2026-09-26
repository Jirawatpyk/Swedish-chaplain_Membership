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
// F114 T079 — the change-request history (FR-029-scoped for a linked requester)
const crListVisibleToUserMock = vi.fn();
const crListByMemberMock = vi.fn();

vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({
    memberRepo: { findById: (...a: unknown[]) => memberFindByIdMock(...a) },
    contactRepo: { listByMember: (...a: unknown[]) => contactListByMemberMock(...a) },
    changeRequestRepo: {
      listVisibleToUser: (...a: unknown[]) => crListVisibleToUserMock(...a),
      listByMember: (...a: unknown[]) => crListByMemberMock(...a),
    },
  }),
}));
vi.mock('@/modules/members', async () => {
  // the barrel pulls Drizzle infra (and the mocked events barrel); the REAL
  // projection is taken from its own module so the archive's FR-029 / FR-014
  // rule under test is the members module's, not a copy
  const actual = await vi.importActual<typeof import('@/modules/members/application/use-cases/change-requests/list-change-requests')>(
    '@/modules/members/application/use-cases/change-requests/list-change-requests',
  );
  return {
    asMemberId: (s: string) => s,
    asTenantId: (s: string) => s,
    projectChangeRequestForViewer: actual.projectChangeRequestForViewer,
  };
});
vi.mock('@/modules/invoicing', () => ({
  listInvoicesByMember: (...a: unknown[]) => listInvoicesByMemberMock(...a),
  makeListInvoicesByMemberDeps: () => ({}),
  vercelBlobAdapter: { downloadBytes: (...a: unknown[]) => downloadBytesMock(...a) },
  // Faithful reimplementation of domain/invoice.ts billFirstDocumentNumber
  // (barrel pulls in Drizzle infra; real helper is unit-tested in its own suite).
  billFirstDocumentNumber: (inv: {
    documentNumber?: { raw: string } | null;
    billDocumentNumberRaw?: string | null;
  }) => inv.billDocumentNumberRaw ?? inv.documentNumber?.raw ?? null,
}));
vi.mock('@/modules/events', () => ({
  getEventAttendeesByMember: () => Promise.resolve([]),
  drizzleEventAttendeesQueryStrict: {},
}));
// F119 R17 — the member's E-Blast images (already projected by the broadcasts use case)
const listMemberBroadcastImagesMock = vi.fn();
// F119 T083 — the member's E-Blast approval rounds (already projected by the broadcasts use case)
const listMemberBroadcastVersionsMock = vi.fn();
vi.mock('@/modules/broadcasts', () => ({
  listMemberBroadcasts: () => Promise.resolve({ rows: [], total: 0, totalPages: 0, page: 1 }),
  makeListMemberBroadcastsDeps: () => ({}),
  listMemberBroadcastImages: (...a: unknown[]) => listMemberBroadcastImagesMock(...a),
  makeListMemberBroadcastImagesDeps: () => ({ deps: 'images' }),
  listMemberBroadcastVersions: (...a: unknown[]) => listMemberBroadcastVersionsMock(...a),
  makeListMemberBroadcastVersionsDeps: () => ({ deps: 'versions' }),
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
    // 058 / PR-B — ทุนจดทะเบียน, a NEW field distinct from turnoverThb.
    registeredCapitalThb: 2_000_000,
    addressLine1: '99 Sukhumvit',
    addressLine2: 'Unit 5',
    // 058 / PR-B — แขวง/ตำบล.
    subDistrict: 'คลองตันเหนือ',
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
    crListVisibleToUserMock.mockResolvedValue({ ok: true, value: { items: [], nextCursor: null } });
    crListByMemberMock.mockResolvedValue({ ok: true, value: { items: [], nextCursor: null } });
    listMemberBroadcastImagesMock.mockResolvedValue([]);
    listMemberBroadcastVersionsMock.mockResolvedValue({ threads: [], truncated: false });
  });

  describe('broadcast versions (F119 T083)', () => {
    it('serialises each E-Blast round with ISO dates and the member projection, and discloses a capped list', async () => {
      listInvoicesByMemberMock.mockResolvedValue({ ok: true, value: { rows: [], total: 0 } });
      listMemberBroadcastVersionsMock.mockResolvedValue({
        threads: [
          {
            broadcastId: 'b-1',
            versions: [
              {
                id: 'v-0',
                broadcastId: 'b-1',
                versionNo: 0,
                authoredBy: 'member',
                subject: 'Original',
                bodyHtml: '<p>original</p>',
                noteToMember: null,
                sentToMemberAt: null,
                createdAt: new Date('2026-09-20T10:00:00Z'),
              },
            ],
            decisions: [
              {
                id: 'd-1',
                broadcastId: 'b-1',
                versionId: 'v-1',
                round: 1,
                decision: 'changes_requested',
                reason: 'Fix the date',
                decidedAt: new Date('2026-09-21T10:00:00Z'),
              },
            ],
          },
        ],
        truncated: true,
      });
      const data = await gdprArchiveSourceAdapter.gather(CTX, { subjectMemberId: MEMBER });
      expect(listMemberBroadcastVersionsMock).toHaveBeenCalledWith({ deps: 'versions' }, { memberId: MEMBER, limit: 1000 });
      expect(data!.broadcastVersions).toEqual([
        {
          broadcastId: 'b-1',
          versions: [
            {
              versionId: 'v-0',
              versionNo: 0,
              authoredBy: 'member',
              subject: 'Original',
              bodyHtml: '<p>original</p>',
              noteToMember: null,
              sentToMemberAt: null,
              createdAt: '2026-09-20T10:00:00.000Z',
            },
          ],
          decisions: [
            {
              decisionId: 'd-1',
              versionId: 'v-1',
              round: 1,
              decision: 'changes_requested',
              reason: 'Fix the date',
              decidedAt: '2026-09-21T10:00:00.000Z',
            },
          ],
        },
      ]);
      expect(data!.completeness!.truncatedCategories).toContain('broadcastVersions');
    });
  });

  describe('broadcast images (F119 R17)', () => {
    const image = (i: number, deleted: boolean) => ({
      imageId: `img-${i}`,
      broadcastId: 'b-1',
      contentHash: `hash-${i}`,
      mimeType: 'image/png',
      byteSize: 1024,
      createdAt: new Date('2026-09-20T10:00:00Z'),
      deletedAt: deleted ? new Date('2026-09-21T10:00:00Z') : null,
      ...(deleted ? {} : { blobUrl: `https://assets.example/${i}.png` }),
    });

    it('serialises each image with ISO dates, keeps the use case’s projection (no URL on a stamped row), and asks for one probe row past the cap', async () => {
      listInvoicesByMemberMock.mockResolvedValue({ ok: true, value: { rows: [], total: 0 } });
      listMemberBroadcastImagesMock.mockResolvedValue([image(1, false), image(2, true)]);
      const data = await gdprArchiveSourceAdapter.gather(CTX, { subjectMemberId: MEMBER });
      expect(listMemberBroadcastImagesMock).toHaveBeenCalledWith({ deps: 'images' }, { memberId: MEMBER, limit: 1001 });
      expect(data!.broadcastImages).toEqual([
        {
          imageId: 'img-1',
          broadcastId: 'b-1',
          contentHash: 'hash-1',
          mimeType: 'image/png',
          byteSize: 1024,
          createdAt: '2026-09-20T10:00:00.000Z',
          deletedAt: null,
          blobUrl: 'https://assets.example/1.png',
        },
        {
          imageId: 'img-2',
          broadcastId: 'b-1',
          contentHash: 'hash-2',
          mimeType: 'image/png',
          byteSize: 1024,
          createdAt: '2026-09-20T10:00:00.000Z',
          deletedAt: '2026-09-21T10:00:00.000Z',
        },
      ]);
      expect(data!.completeness!.truncatedCategories).not.toContain('broadcastImages');
    });

    it('caps at MAX_BROADCAST_IMAGES (1,000) and DISCLOSES the truncation only on a genuine overflow', async () => {
      listInvoicesByMemberMock.mockResolvedValue({ ok: true, value: { rows: [], total: 0 } });
      listMemberBroadcastImagesMock.mockResolvedValue(Array.from({ length: 1001 }, (_, i) => image(i, false)));
      const over = await gdprArchiveSourceAdapter.gather(CTX, { subjectMemberId: MEMBER });
      expect(over!.broadcastImages).toHaveLength(1000);
      expect(over!.completeness!.truncatedCategories).toContain('broadcastImages');

      listMemberBroadcastImagesMock.mockResolvedValue(Array.from({ length: 1000 }, (_, i) => image(i, false)));
      const exact = await gdprArchiveSourceAdapter.gather(CTX, { subjectMemberId: MEMBER });
      expect(exact!.broadcastImages).toHaveLength(1000);
      expect(exact!.completeness!.truncatedCategories).not.toContain('broadcastImages');
    });
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
      // 058 / PR-B — แขวง/ตำบล, part of Art. 20 portability completeness.
      subDistrict: 'คลองตันเหนือ',
      city: 'Bangkok',
      province: 'Bangkok',
      postalCode: '10110',
      // P2 Wave-0 — turnover is the member's own subject-provided data.
      turnoverThb: 5_000_000,
      // 058 / PR-B — ทุนจดทะเบียน, a NEW field distinct from turnoverThb;
      // subject-provided business data, part of Art. 20 portability.
      registeredCapitalThb: 2_000_000,
    });
  });

  it("profile includes member_number — the subject's own display id (GDPR Art.15/20 transparency)", async () => {
    listInvoicesByMemberMock.mockResolvedValue({ ok: true, value: { rows: [], total: 0 } });
    const data = await gdprArchiveSourceAdapter.gather(CTX, { subjectMemberId: MEMBER });
    expect(data).not.toBeNull();
    expect(data!.profile).toMatchObject({ member_number: 7 });
  });

  it("the requester's own contact includes dateOfBirth — material personal data (P2 Wave-0, GDPR Art.15/20)", async () => {
    listInvoicesByMemberMock.mockResolvedValue({ ok: true, value: { rows: [], total: 0 } });
    contactListByMemberMock.mockResolvedValue({
      ok: true,
      value: [
        {
          contactId: 'c-1',
          linkedUserId: 'u-dao',
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
    crListVisibleToUserMock.mockResolvedValue({ ok: true, value: { items: [], nextCursor: null } });
    const data = await gdprArchiveSourceAdapter.gather(CTX, { subjectMemberId: MEMBER, requestedByUserId: 'u-dao' });
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

  it('088 tax-at-payment invoice — record carries bill/receipt raw numbers + PDF stem uses SC (FR-030)', async () => {
    // A new-flow 088 invoice has NULL §87 `documentNumber`; the SC bill number
    // lives in `billDocumentNumberRaw` and (once paid) the §86/4 RC in
    // `receiptDocumentNumberRaw`. The archive record must carry BOTH (GDPR Art.20
    // completeness) and the zip PDF stem must use the SC (bill-first) + the
    // invoiceId uniqueness suffix — never a bare UUID.
    listInvoicesByMemberMock.mockResolvedValue({
      ok: true,
      value: {
        rows: [
          {
            ...invoiceWithPdf(),
            documentNumber: null,
            billDocumentNumberRaw: 'SC-2026-000123',
            receiptDocumentNumberRaw: 'RC-2026-000123',
          },
        ],
        total: 1,
      },
    });
    downloadBytesMock.mockResolvedValue(new Uint8Array([0x25]));
    const data = await gdprArchiveSourceAdapter.gather(CTX, { subjectMemberId: MEMBER });
    expect(data).not.toBeNull();
    expect(data!.invoices[0]!.record).toMatchObject({
      documentNumber: null,
      billDocumentNumberRaw: 'SC-2026-000123',
      receiptDocumentNumberRaw: 'RC-2026-000123',
    });
    // Bill-first stem + invoiceId suffix (collision-safe zip entry key).
    expect(data!.invoices[0]!.pdf!.filename).toBe('SC-2026-000123-inv-1.pdf');
  });

  it('returns null when the subject member does not exist (→ member_not_found)', async () => {
    memberFindByIdMock.mockResolvedValue({ ok: false, error: { code: 'repo.not_found' } });
    const data = await gdprArchiveSourceAdapter.gather(CTX, { subjectMemberId: MEMBER });
    expect(data).toBeNull();
  });

  // F114 T079 — FR-030: the change-request history joins the export, scoped
  // as FR-029 for a requester who is one of the member's linked contacts;
  // an admin on-behalf request (not a contact of the member) exports the
  // whole member's history. Reason AND note are included (FR-014); the
  // decider is the organisation, never a named reviewer.
  describe('change requests (F114 T079)', () => {
    const REQUESTER = 'u-portal-1';
    const row = {
      request: {
        id: 'cr-1',
        memberId: MEMBER,
        submittedByUserId: REQUESTER,
        submittedByContactId: 'c-1',
        submitterRoleAtSubmission: 'primary',
        scope: 'own_contact',
        state: 'decided',
        outcome: 'rejected',
        withdrawnReason: null,
        replacedByRequestId: null,
        submittedAt: new Date('2026-09-01T10:00:00Z'),
        staffNotifiedAt: new Date('2026-09-01T10:00:00Z'),
        decidedAt: new Date('2026-09-02T10:00:00Z'),
        decidedByUserId: 'staff-9',
        decisionReason: 'Use the registered phone',
        decisionNote: 'checked DBD',
        withdrawnAt: null,
        outcomeAcknowledgedAt: null,
        fields: [{ key: 'phone', target: 'contact', seen: '+66812345678', proposed: '+66899999999', affectsTaxDocuments: false, outcome: 'rejected', appliedAt: null }],
      },
      member: { companyName: 'Acme Co', memberNumber: 7, status: 'active', archived: false },
      submitter: { displayName: 'Som Chai' },
      decidedBy: { displayName: 'Reviewer Rae', deactivated: false },
    };

    it('a linked requester gets the FR-029-scoped list, serialised with reason + note and the organisation as decider — never the reviewer', async () => {
      listInvoicesByMemberMock.mockResolvedValue({ ok: true, value: { rows: [], total: 0 } });
      contactListByMemberMock.mockResolvedValue({
        ok: true,
        value: [{ contactId: 'c-1', linkedUserId: REQUESTER, firstName: 'Som', lastName: 'Chai', email: 'som@acme.example', phone: null, dateOfBirth: null, roleTitle: null, preferredLanguage: 'en', isPrimary: true, removedAt: null, createdAt: new Date('2026-01-01T00:00:00Z') }],
      });
      crListVisibleToUserMock.mockResolvedValue({ ok: true, value: { items: [row], nextCursor: null } });
      const data = await gdprArchiveSourceAdapter.gather(CTX, { subjectMemberId: MEMBER, requestedByUserId: REQUESTER });
      expect(crListVisibleToUserMock).toHaveBeenCalledWith(CTX, REQUESTER, MEMBER, expect.objectContaining({ cursor: null }));
      expect(crListByMemberMock).not.toHaveBeenCalled();
      expect(data!.changeRequests).toEqual([
        {
          id: 'cr-1',
          scope: 'own_contact',
          state: 'decided',
          outcome: 'rejected',
          withdrawnReason: null,
          submittedAt: '2026-09-01T10:00:00.000Z',
          submittedBy: { contactId: 'c-1', displayName: 'Som Chai' },
          decidedAt: '2026-09-02T10:00:00.000Z',
          decidedBy: 'organisation',
          decisionReason: 'Use the registered phone',
          decisionNote: 'checked DBD',
          fields: [{ key: 'phone', target: 'contact', seen: '+66812345678', proposed: '+66899999999', outcome: 'rejected', appliedAt: null, affectsTaxDocuments: false }],
        },
      ]);
      expect(JSON.stringify(data!.changeRequests)).not.toContain('Reviewer Rae');
      expect(JSON.stringify(data!.changeRequests)).not.toContain('staff-9');
    });

    it('an on-behalf requester who is not a contact of the member gets the COMPANY-LEVEL history only: own-contact requests dropped, a mixed row stripped, no reason / note (FR-029 fail-closed — the artefact may reach any contact)', async () => {
      listInvoicesByMemberMock.mockResolvedValue({ ok: true, value: { rows: [], total: 0 } });
      const company = { ...row, request: { ...row.request, id: 'cr-company', scope: 'company', fields: [{ key: 'company_name', target: 'member', seen: 'Acme', proposed: 'Acme Co', affectsTaxDocuments: true, outcome: 'rejected', appliedAt: null }] } };
      const mixed = { ...row, request: { ...row.request, id: 'cr-mixed', scope: 'mixed', fields: [...row.request.fields, { key: 'company_name', target: 'member', seen: 'Acme', proposed: 'Acme Co', affectsTaxDocuments: true, outcome: 'rejected', appliedAt: null }] } };
      crListByMemberMock.mockResolvedValue({ ok: true, value: { items: [row, company, mixed], nextCursor: null } });
      const data = await gdprArchiveSourceAdapter.gather(CTX, { subjectMemberId: MEMBER, requestedByUserId: 'admin-1' });
      expect(crListByMemberMock).toHaveBeenCalledWith(CTX, MEMBER, expect.objectContaining({ cursor: null }));
      expect(crListVisibleToUserMock).not.toHaveBeenCalled();
      expect(data!.changeRequests.map((r) => r.id)).toEqual(['cr-company', 'cr-mixed']);
      for (const r of data!.changeRequests) {
        expect(r.fields.every((f) => f.target === 'member')).toBe(true);
        expect(r.decisionReason).toBeNull();
        expect(r.decisionNote).toBeNull();
      }
      expect(JSON.stringify(data!.changeRequests)).not.toContain('+668');
      expect(JSON.stringify(data!.changeRequests)).not.toContain('checked DBD');
    });

    it("a linked requester sees a COLLEAGUE's mixed row with company fields only and without the reason / note; their own row in full", async () => {
      listInvoicesByMemberMock.mockResolvedValue({ ok: true, value: { rows: [], total: 0 } });
      contactListByMemberMock.mockResolvedValue({
        ok: true,
        value: [{ contactId: 'c-1', linkedUserId: REQUESTER, firstName: 'Som', lastName: 'Chai', email: 'som@acme.example', phone: null, dateOfBirth: null, roleTitle: null, preferredLanguage: 'en', isPrimary: false, removedAt: null, createdAt: new Date('2026-01-01T00:00:00Z') }],
      });
      const colleagueMixed = { ...row, request: { ...row.request, id: 'cr-colleague', submittedByUserId: 'u-primary', submittedByContactId: 'c-0', scope: 'mixed', fields: [...row.request.fields, { key: 'company_name', target: 'member', seen: 'Acme', proposed: 'Acme Co', affectsTaxDocuments: true, outcome: 'rejected', appliedAt: null }] } };
      crListVisibleToUserMock.mockResolvedValue({ ok: true, value: { items: [row, colleagueMixed], nextCursor: null } });
      const data = await gdprArchiveSourceAdapter.gather(CTX, { subjectMemberId: MEMBER, requestedByUserId: REQUESTER });
      const mine = data!.changeRequests.find((r) => r.id === 'cr-1')!;
      const theirs = data!.changeRequests.find((r) => r.id === 'cr-colleague')!;
      expect(mine.decisionReason).toBe('Use the registered phone');
      expect(mine.fields.map((f) => f.key)).toEqual(['phone']);
      expect(theirs.fields.map((f) => f.key)).toEqual(['company_name']);
      expect(theirs.decisionReason).toBeNull();
      expect(theirs.decisionNote).toBeNull();
      // Art. 15(4) — the colleague is named, never identified by contact id
      expect(theirs.submittedBy).toEqual({ contactId: null, displayName: row.submitter.displayName });
      expect(mine.submittedBy.contactId).toBe('c-1');
    });

    it('walks every page of the history (keyset cursor) so a long history is not silently cut', async () => {
      listInvoicesByMemberMock.mockResolvedValue({ ok: true, value: { rows: [], total: 0 } });
      // an on-behalf gather (no requester) — company-level rows, which survive the scope rule
      const companyRow = { ...row, request: { ...row.request, scope: 'company', fields: [{ key: 'company_name', target: 'member', seen: 'Acme', proposed: 'Acme Co', affectsTaxDocuments: true, outcome: 'rejected', appliedAt: null }] } };
      const second = { ...companyRow, request: { ...companyRow.request, id: 'cr-2' } };
      crListByMemberMock
        .mockResolvedValueOnce({ ok: true, value: { items: [companyRow], nextCursor: { submittedAt: row.request.submittedAt, id: 'cr-1' } } })
        .mockResolvedValueOnce({ ok: true, value: { items: [second], nextCursor: null } });
      const data = await gdprArchiveSourceAdapter.gather(CTX, { subjectMemberId: MEMBER });
      expect(data!.changeRequests.map((r) => r.id)).toEqual(['cr-1', 'cr-2']);
      expect(crListByMemberMock).toHaveBeenCalledTimes(2);
    });

    it('caps the history at MAX_CHANGE_REQUESTS (1,000), stops walking one row past the cap, and DISCLOSES the truncation', async () => {
      listInvoicesByMemberMock.mockResolvedValue({ ok: true, value: { rows: [], total: 0 } });
      const companyRow = (id: string) => ({
        ...row,
        request: {
          ...row.request,
          id,
          scope: 'company',
          fields: [{ key: 'company_name', target: 'member', seen: 'Acme', proposed: 'Acme Co', affectsTaxDocuments: true, outcome: 'rejected', appliedAt: null }],
        },
      });
      // The pool is deliberately LARGER than the cap + one page (1,200, not
      // 1,001): the 1,001st row is what trips the cap, and the rows beyond it
      // are what makes the `break` at gdpr-archive-source-adapter.ts:308-311
      // fail-able — without it the walk drains all 24 pages instead of 21.
      const POOL = 1_200;
      const PAGE = 50; // CHANGE_REQUEST_PAGE
      let served = 0;
      crListByMemberMock.mockImplementation(async () => {
        const items = Array.from({ length: Math.min(PAGE, POOL - served) }, (_, i) => companyRow(`cr-${served + i + 1}`));
        served += items.length;
        const last = items[items.length - 1];
        return {
          ok: true,
          value: { items, nextCursor: served < POOL && last ? { submittedAt: row.request.submittedAt, id: last.request.id } : null },
        };
      });
      const data = await gdprArchiveSourceAdapter.gather(CTX, { subjectMemberId: MEMBER });
      expect(data!.changeRequests).toHaveLength(1000);
      expect(data!.changeRequests[999]!.id).toBe('cr-1000'); // the NEWEST-first page order is kept, trimmed from the tail
      expect(data!.completeness!.truncatedCategories).toContain('changeRequests');
      expect(crListByMemberMock).toHaveBeenCalledTimes(21);
    });

    it('FAILS LOUD when the change-request read errors — never a hollow change-requests.json', async () => {
      listInvoicesByMemberMock.mockResolvedValue({ ok: true, value: { rows: [], total: 0 } });
      crListByMemberMock.mockResolvedValue({ ok: false, error: { code: 'repo.unexpected' } });
      await expect(gdprArchiveSourceAdapter.gather(CTX, { subjectMemberId: MEMBER })).rejects.toThrow(/change-request list failed/);
    });
  });

  // GDPR Art. 15(4) / 20(4) · PDPA §30 — any colleague may request the member
  // archive; it must not hand them another colleague's personal data.
  describe("colleagues' personal data (Art. 15(4))", () => {
    const REQUESTER = 'u-requester';
    const contact = (over: Record<string, unknown>) => ({
      firstName: 'X',
      lastName: 'Y',
      phone: '+66800000000',
      dateOfBirth: new Date('1990-07-15T00:00:00Z'),
      roleTitle: 'Staff',
      preferredLanguage: 'en',
      isPrimary: false,
      removedAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      linkedUserId: null,
      ...over,
    });
    const roster = [
      contact({ contactId: 'c-me', linkedUserId: REQUESTER, firstName: 'Som', lastName: 'Chai', email: 'som@acme.example' }),
      contact({ contactId: 'c-anna', linkedUserId: 'u-anna', firstName: 'Anna', lastName: 'Lindqvist', email: 'anna@acme.example', phone: '+66811111111', roleTitle: 'CEO', isPrimary: true }),
      contact({ contactId: 'c-gone', linkedUserId: 'u-gone', firstName: 'Gone', lastName: 'Person', email: 'gone@acme.example', removedAt: new Date('2026-03-01T00:00:00Z') }),
    ];

    beforeEach(() => {
      listInvoicesByMemberMock.mockResolvedValue({ ok: true, value: { rows: [], total: 0 } });
      contactListByMemberMock.mockResolvedValue({ ok: true, value: roster });
      crListVisibleToUserMock.mockResolvedValue({ ok: true, value: { items: [], nextCursor: null } });
    });

    it("the archive does not contain another contact's email, phone or date of birth", async () => {
      const data = await gdprArchiveSourceAdapter.gather(CTX, { subjectMemberId: MEMBER, requestedByUserId: REQUESTER });
      const json = JSON.stringify(data!.contacts);
      expect(json).not.toContain('anna@acme.example');
      expect(json).not.toContain('+66811111111');
      const anna = data!.contacts.find((c) => c.firstName === 'Anna')!;
      expect(anna).toEqual({ firstName: 'Anna', lastName: 'Lindqvist', roleTitle: 'CEO', isPrimary: true });
    });

    it("keeps the requester's own record in full and drops former colleagues", async () => {
      const data = await gdprArchiveSourceAdapter.gather(CTX, { subjectMemberId: MEMBER, requestedByUserId: REQUESTER });
      expect(data!.contacts.find((c) => c.contactId === 'c-me')).toMatchObject({ email: 'som@acme.example', phone: '+66800000000' });
      expect(JSON.stringify(data!.contacts)).not.toContain('Gone');
    });

    it("scopes the audit read to the requester's own account, not every colleague's", async () => {
      await gdprArchiveSourceAdapter.gather(CTX, { subjectMemberId: MEMBER, requestedByUserId: REQUESTER });
      expect(auditQueryMock).toHaveBeenCalledWith(CTX, expect.objectContaining({ memberUserIds: [REQUESTER] }));
    });

    it('a staff on-behalf export carries every active contact by name and role only', async () => {
      crListByMemberMock.mockResolvedValue({ ok: true, value: { items: [], nextCursor: null } });
      const data = await gdprArchiveSourceAdapter.gather(CTX, { subjectMemberId: MEMBER });
      expect(data!.contacts).toEqual([
        { firstName: 'Som', lastName: 'Chai', roleTitle: 'Staff', isPrimary: false },
        { firstName: 'Anna', lastName: 'Lindqvist', roleTitle: 'CEO', isPrimary: true },
      ]);
      expect(auditQueryMock).toHaveBeenCalledWith(CTX, expect.objectContaining({ memberUserIds: [] }));
    });
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
