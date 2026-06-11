/**
 * T127 — Credit-note PDF render-input golden test.
 *
 * Pins Review C-1 (2026-04-20): the CN PDF must render with a SINGLE
 * synthetic line whose unitPrice === total === creditAmount (excl VAT)
 * and whose bilingual description references the original invoice
 * number. Protects against a future refactor that re-introduces
 * `loaded.lines` on the CN render path (which would make line-sum ≠
 * totals block — visually inconsistent AND a Thai RD §86/4 interpretation
 * risk for partial credit notes).
 *
 * This is a render-INPUT golden, not a PDF-bytes golden — it captures
 * the structured arguments passed to `pdfRender.render` (which a
 * regression would mangle before any bytes are produced). Cheaper +
 * more precise than binary diffing the output.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { makeDrizzleCreditNoteRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-credit-note-repo';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
import { postgresSequenceAllocator } from '@/modules/invoicing/infrastructure/adapters/postgres-sequence-allocator';
import { memberIdentityAdapter } from '@/modules/invoicing/infrastructure/adapters/member-identity-adapter';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { issueCreditNote } from '@/modules/invoicing/application/use-cases/issue-credit-note';
import type { IssueCreditNoteDeps } from '@/modules/invoicing/application/use-cases/issue-credit-note';
import { createEventInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-event-invoice-draft';
import { makeCreateEventInvoiceDraftDeps } from '@/modules/invoicing/application/invoicing-deps';
import { issueEventInvoiceAsPaid } from '@/modules/invoicing/application/use-cases/issue-event-invoice-as-paid';
import type { IssueEventInvoiceAsPaidDeps } from '@/modules/invoicing/application/use-cases/issue-event-invoice-as-paid';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { creditNotes } from '@/modules/invoicing/infrastructure/db/schema-credit-notes';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { eventRegistrationLookupAdapter } from '@/modules/invoicing/infrastructure/adapters/event-registration-lookup-adapter';

const MATRIX: BenefitMatrix = {
  eblast_per_year: 1,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'regular',
  directory_listing_size: 'half_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: false,
  partnership: null,
};

const ORIGINAL_DOC_NUMBER = 'T127-2026-000001';
const INVOICE_SUBTOTAL = 100_000n; // 1,000 THB
const INVOICE_VAT = 7_000n; // 7%
const INVOICE_TOTAL = 107_000n;

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
// L-1 (055-member-number, doc-only): the absent `member_number` key here is
// intentional — it models a historical / pre-feature member-identity snapshot
// captured before the member-number feature shipped. The snapshot parser maps
// the missing key to `null` via `.default(null)`, so the PDF buyer block omits
// the Member No. line (matching the event-attendee + pre-feature golden cases).
const SNAP_MEMBER = {
  legal_name: 'T127 Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};

async function seedPaidInvoice(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
): Promise<{ invoiceId: string }> {
  const invoiceId = randomUUID();
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'T127 Co',
      country: 'TH',
      planId,
      planYear: 2026,
    });
    await tx.insert(invoices).values({
      tenantId: tenant.ctx.slug,
      invoiceId,
      memberId,
      planYear: 2026,
      planId,
      draftByUserId: user.userId,
      status: 'paid',
      pdfDocKind: 'invoice',
      receiptPdfStatus: 'rendered',
      fiscalYear: 2026,
      sequenceNumber: 1,
      documentNumber: ORIGINAL_DOC_NUMBER,
      issueDate: '2026-01-15',
      dueDate: '2026-02-14',
      subtotalSatang: INVOICE_SUBTOTAL,
      vatRateSnapshot: '0.0700',
      vatSatang: INVOICE_VAT,
      totalSatang: INVOICE_TOTAL,
      creditedTotalSatang: 0n,
      proRatePolicySnapshot: 'monthly',
      netDaysSnapshot: 30,
      tenantIdentitySnapshot: SNAP_TENANT,
      memberIdentitySnapshot: SNAP_MEMBER,
      pdfBlobKey: 'invoicing/t127/2026/seed.pdf',
      pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 1,
      paymentMethod: 'bank_transfer',
      paymentReference: 'seed-ref',
      paymentRecordedByUserId: user.userId,
      paymentDate: '2026-02-01',
      paidAt: new Date('2026-02-01T03:00:00Z'),
    });
    await tx.insert(invoiceLines).values({
      tenantId: tenant.ctx.slug,
      lineId: randomUUID(),
      invoiceId,
      kind: 'membership_fee',
      descriptionTh: 'ค่าสมาชิก ปี 2026',
      descriptionEn: 'Membership 2026',
      unitPriceSatang: INVOICE_SUBTOTAL,
      totalSatang: INVOICE_SUBTOTAL,
      position: 1,
    });
  });
  return { invoiceId };
}

function makeDepsWithRenderSpy(
  tenantId: string,
  captured: PdfRenderInput[],
): IssueCreditNoteDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    creditNoteRepo: makeDrizzleCreditNoteRepo(tenantId),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    sequenceAllocator: postgresSequenceAllocator,
    pdfRender: {
      render: vi.fn(async (input: PdfRenderInput) => {
        captured.push(input);
        return {
          bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
          sha256: Sha256Hex.ofUnsafe('b'.repeat(64)),
        };
      }),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }) => ({ key, url: `https://blob.test/${key}` })),
      uploadLogo: vi.fn(async ({ key }) => ({ key, url: `https://blob.test/${key}` })),
      signDownloadUrl: vi.fn(async () => 'https://blob.test/signed'),
      downloadBytes: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => [] as string[]),
    },
    audit: f4AuditAdapter,
    clock: { nowIso: () => '2026-04-18T10:00:00Z' },
    outbox: { enqueue: vi.fn(async () => {}) },
    currentTemplateVersion: 1,
  };
}

describe('T127 — credit-note PDF render-input golden (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 't127-plan';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-chamber');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'T127 Plan' },
        description: { en: 'Test description' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      });
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 0n,
        legalNameTh: 'ทดสอบ',
        legalNameEn: 'Test',
        taxId: '0000000000000',
        registeredAddressTh: 'Bangkok',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'T127',
        creditNoteNumberPrefix: 'T127C',
      });
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  beforeEach(async () => {
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.delete(creditNotes).where(eq(creditNotes.tenantId, tenant.ctx.slug));
      await tx.delete(invoiceLines).where(eq(invoiceLines.tenantId, tenant.ctx.slug));
      await tx.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug));
      await tx.delete(members).where(eq(members.tenantId, tenant.ctx.slug));
    });
  });

  it('partial CN (50%) renders exactly 1 synthetic line with unitPrice=total=creditAmount + bilingual original-doc ref', async () => {
    const { invoiceId } = await seedPaidInvoice(tenant, user, planId);
    const captured: PdfRenderInput[] = [];
    const deps = makeDepsWithRenderSpy(tenant.ctx.slug, captured);

    // 50% partial: credit_total 53_500 satang = 50_000 excl VAT + 3_500 VAT.
    const r = await issueCreditNote(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      creditTotalSatang: 53_500n,
      reason: 'T127 golden test',
    });
    expect(r.ok).toBe(true);

    // The FIRST render call is the CN render (kind='credit_note').
    // Partial CN also triggers a J2 re-annotation render (kind='invoice')
    // as the SECOND call — the golden pins the CN one specifically.
    const cnRender = captured.find((c) => c.kind === 'credit_note');
    expect(cnRender, 'expected a credit_note render call').toBeDefined();
    if (cnRender?.kind !== 'credit_note') throw new Error('unreachable');

    // (1) Exactly ONE synthetic line — catches a future refactor that
    // re-introduces loaded.lines on the CN path.
    expect(
      cnRender.lines,
      'CN render MUST pass a single synthetic line — see Review C-1',
    ).toHaveLength(1);
    const line = cnRender.lines[0]!;

    // (2) unitPrice === total === creditAmount (excl VAT, 50_000 satang).
    expect(line.unitPrice.satang).toBe(50_000n);
    expect(line.total.satang).toBe(50_000n);
    expect(line.unitPrice.satang).toBe(line.total.satang);

    // (3) Bilingual description references the original invoice number.
    //     Exact prefix format is enforced by the use-case; assert the
    //     number is present in both languages so a refactor that drops
    //     one language fails here.
    expect(line.descriptionTh).toContain(ORIGINAL_DOC_NUMBER);
    expect(line.descriptionEn).toContain(ORIGINAL_DOC_NUMBER);

    // (4) CN-level totals match the line-level numbers — subtotal ===
    // unitPrice === total; vat is the 7% split; total is subtotal + vat.
    expect(cnRender.subtotal.satang).toBe(50_000n);
    expect(cnRender.vat.satang).toBe(3_500n);
    expect(cnRender.total.satang).toBe(53_500n);

    // (5) creditNote context carries the original document number +
    //     issue date + free-text reason. Template reads these for the
    //     reference block — regression here would drop the Thai RD
    //     "§86/5 reference to original tax document" requirement.
    expect(cnRender.creditNote?.originalDocumentNumber).toBe(ORIGINAL_DOC_NUMBER);
    expect(cnRender.creditNote?.reason).toBe('T127 golden test');
  }, 60_000);
});

// -----------------------------------------------------------------------------
// 064 Task 12 — J2 annotation re-render preserves pdf_doc_kind (live Neon).
//
// An AS-PAID TIN event invoice's MAIN blob is the combined ใบกำกับภาษี/
// ใบเสร็จรับเงิน (kind='receipt_combined', pdf_doc_kind persisted by
// applyIssueAsPaid) — the ONLY §105ทวิ receipt evidence for that sale (10-year
// retention). The J2 credited-annotation re-render OVERWRITES that blob
// (allowOverwrite=true at the SAME key), so it MUST reproduce the original
// document kind. A hardcoded kind:'invoice' would re-title the combined
// receipt as a plain §86/4 ใบกำกับภาษี — destroying the receipt evidence.
//
// End-to-end through the REAL use-cases (mirrors issue-as-paid.test.ts /
// credit-note-event-invoice.test.ts): createEventInvoiceDraft →
// issueEventInvoiceAsPaid (TIN buyer → receipt_combined main PDF) →
// issueCreditNote (partial). Render-INPUT golden: PDF render + Blob are
// spied; DB + allocator + RLS + audit adapter are live.
// -----------------------------------------------------------------------------

// SIMULATED buyer — fake company + fake TIN (never real member PII).
const J2_BUYER = {
  legal_name: 'Sim As-Paid Gala Co., Ltd.',
  tax_id: '1234567890123',
  address: '99 Simulated Road, Bangkok 10110',
  primary_contact_name: 'Sim Contact',
  primary_contact_email: 'sim-aspaid-j2@example.com',
} as const;

const J2_PAYMENT_DATE = '2026-06-10';
const J2_TICKET_SATANG = 25_000; // 250 THB inclusive

function makeAsPaidDeps(tenantSlug: string): IssueEventInvoiceAsPaidDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantSlug),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    memberIdentity: memberIdentityAdapter,
    // 064 S1 — issuance-time refunded re-check (real adapter; only invoked for event subjects).
    eventRegistrationLookup: eventRegistrationLookupAdapter,
    sequenceAllocator: postgresSequenceAllocator,
    pdfRender: {
      render: vi.fn(async () => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sha256: Sha256Hex.ofUnsafe('a'.repeat(64)),
      })),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({ key, url: `https://blob.test/${key}` })),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => [] as string[]),
    } as unknown as IssueEventInvoiceAsPaidDeps['blob'],
    audit: f4AuditAdapter,
    clock: { nowIso: () => `${J2_PAYMENT_DATE}T10:00:00Z` },
    outbox: { enqueue: vi.fn(async () => {}) },
    currentTemplateVersion: 1,
  };
}

describe('064 Task 12 — J2 annotation preserves receipt_combined on an as-paid parent (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let invoiceId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    const eventId = randomUUID();
    const regId = randomUUID();

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 0n,
        legalNameTh: 'หอการค้าจำลอง',
        legalNameEn: 'Simulated Chamber',
        taxId: '0000000000000',
        registeredAddressTh: 'Bangkok',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'J2A',
        creditNoteNumberPrefix: 'J2AC',
      });
      await tx.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId: `evt-j2-aspaid-${regId.slice(0, 8)}`,
        name: 'J2 As-Paid Gala',
        startDate: new Date('2026-09-10T11:00:00Z'),
      } satisfies NewEventRow);
      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId: regId,
        eventId,
        externalId: `att-j2-aspaid-${regId.slice(0, 8)}`,
        attendeeEmail: J2_BUYER.primary_contact_email,
        attendeeName: 'Sim Attendee',
        attendeeCompany: J2_BUYER.legal_name,
        matchType: 'non_member',
        ticketType: 'Standard',
        ticketPriceThb: 250,
        paymentStatus: 'paid',
        registeredAt: new Date('2026-09-01T03:00:00Z'),
      } satisfies NewEventRegistrationRow);
    });

    // 1) Genuine event draft via the REAL use-case (buyer snapshot pinned).
    const draft = await createEventInvoiceDraft(
      makeCreateEventInvoiceDraftDeps(tenant.ctx.slug),
      {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `int-j2-draft-${regId}`,
        eventRegistrationId: regId,
        amountOverride: J2_TICKET_SATANG,
        buyer: J2_BUYER,
      },
    );
    if (!draft.ok) throw new Error(`draft failed: ${draft.error.code}`);
    invoiceId = draft.value.invoiceId;

    // 2) REAL as-paid issuance — TIN buyer → ONE combined receipt_combined
    // main PDF + pdf_doc_kind='receipt_combined' persisted.
    const paid = await issueEventInvoiceAsPaid(makeAsPaidDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-j2-aspaid-${invoiceId}`,
      invoiceId,
      paymentDate: J2_PAYMENT_DATE,
      paymentMethod: 'cash',
      paymentReference: 'SIM-DOOR-J2',
    });
    if (!paid.ok) throw new Error(`as-paid failed: ${JSON.stringify(paid)}`);
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('partial CN → annotated ORIGINAL re-render keeps kind=receipt_combined, overwrites the SAME blob key, sha updated, annotation present', async () => {
    // Pre-state: the as-paid main PDF is the combined receipt.
    const [before] = await db
      .select({
        sha: invoices.pdfSha256,
        blobKey: invoices.pdfBlobKey,
        docKind: invoices.pdfDocKind,
      })
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    expect(before!.docKind).toBe('receipt_combined');
    const originalSha = before!.sha;
    const originalBlobKey = before!.blobKey;

    const captured: PdfRenderInput[] = [];
    const uploads: Array<{ key: string; allowOverwrite: boolean | undefined }> = [];
    const deps = makeDepsWithRenderSpy(tenant.ctx.slug, captured);
    const originalUpload = deps.blob.uploadPdf;
    const depsWithBlobSpy: IssueCreditNoteDeps = {
      ...deps,
      blob: {
        ...deps.blob,
        uploadPdf: vi.fn(async (input: Parameters<typeof originalUpload>[0]) => {
          uploads.push({ key: input.key, allowOverwrite: input.allowOverwrite });
          return originalUpload(input);
        }),
      },
    };

    const r = await issueCreditNote(depsWithBlobSpy, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-j2-cn-${invoiceId}`,
      invoiceId,
      creditTotalSatang: 12_500n, // 50% partial — parent stays partially_credited
      reason: 'J2 doc-kind preservation test',
    });
    expect(r.ok, r.ok ? 'ok' : `cn err: ${JSON.stringify(r)}`).toBe(true);
    if (!r.ok) throw new Error('cn failed');

    // The J2 annotation re-render — the render call that is NOT the CN PDF.
    const annotation = captured.find((c) => c.kind !== 'credit_note');
    expect(annotation, 'expected a J2 annotation re-render call').toBeDefined();

    // CORE (Task 12): the re-render must reproduce what the main blob held —
    // the combined ใบกำกับภาษี/ใบเสร็จรับเงิน, NOT a plain ใบกำกับภาษี.
    expect(
      annotation!.kind,
      'J2 re-render must preserve the original pdf_doc_kind (receipt_combined)',
    ).toBe('receipt_combined');

    // Annotation payload present: partial → fullyCredited=false + the CN ref.
    expect(annotation!.creditedAnnotation).toBeTruthy();
    expect(annotation!.creditedAnnotation!.fullyCredited).toBe(false);
    expect(annotation!.creditedAnnotation!.references).toHaveLength(1);
    expect(annotation!.creditedAnnotation!.references[0]!.documentNumber).toBe(
      r.value.creditNote.documentNumber.raw,
    );

    // Overwrite at the SAME main blob key (CR-1 contract).
    const reRenderUpload = uploads.find((u) => u.key === originalBlobKey);
    expect(reRenderUpload, 'annotated re-render upload at the original key').toBeDefined();
    expect(reRenderUpload!.allowOverwrite).toBe(true);

    // Row: sha updated to the re-rendered bytes; doc kind + key unchanged.
    const [after] = await db
      .select({
        sha: invoices.pdfSha256,
        blobKey: invoices.pdfBlobKey,
        docKind: invoices.pdfDocKind,
        status: invoices.status,
      })
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    expect(after!.sha).toBe('b'.repeat(64)); // the CN-deps render-spy sha
    expect(after!.sha).not.toBe(originalSha);
    expect(after!.blobKey).toBe(originalBlobKey);
    expect(after!.docKind).toBe('receipt_combined');
    expect(after!.status).toBe('partially_credited');
  }, 90_000);
});
