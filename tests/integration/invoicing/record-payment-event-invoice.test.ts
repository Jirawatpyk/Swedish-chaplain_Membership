/**
 * 054-event-fee-invoices (final-review HIGH 2) — recordPayment for NON-member
 * EVENT-fee invoices (live Neon Singapore via .env.local).
 *
 * The ship-blocker this test closes: a non-member event invoice
 * (`invoice_subject='event'`, `member_id IS NULL`, buyer pinned in
 * `member_identity_snapshot`) could be drafted + issued but NEVER marked paid
 * via the admin manual-payment route (`POST /api/invoices/[id]/pay →
 * recordPayment`), because record-payment hard-rejected ALL `member_id IS NULL`
 * with `no_snapshot_on_invoice`. Spec §9 NF-B / Decision 7 promised the admin
 * record-payment path works for non-member event invoices (only F5 self-pay
 * stays members-only at the portal).
 *
 * Exercises the REAL `recordPayment` use-case via the real composition root
 * (`makeRecordPaymentDeps`) on live Neon. Drafts go through the REAL
 * `createEventInvoiceDraft` + `issueInvoice` so the non-member buyer snapshot
 * (pinned at DRAFT) flows end-to-end into the receipt render at payment time.
 *
 * Two non-member cases (matrix on §86/4 doc-type):
 *   1. Buyer WITH a 13-digit TIN → issued as kind 'invoice' (ใบกำกับภาษี); the
 *      payment-time receipt is the post-payment combined/separate receipt.
 *   2. Buyer WITHOUT a TIN → issued as kind 'receipt_separate' (ใบเสร็จรับเงิน);
 *      the payment-time receipt MUST be `receipt_separate` (a TIN-less buyer can
 *      NEVER receive a `receipt_combined` ใบกำกับภาษี label — the §86/4 gate).
 *
 * Asserts per case:
 *   - recordPayment returns ok + the invoice row flips to `status='paid'`.
 *   - the receipt PDF render is invoked with the PRE-PINNED non-member buyer
 *     snapshot as `member` (NOT a deref of a null member) + the correct §86/4
 *     `kind` + `vatInclusive: true` (Model B threaded through).
 *   - an `invoice_paid` audit row is committed via the NON-timeline branch:
 *     payload has NO `member_id` key but DOES carry `event_registration_id`.
 *
 * A regression guard re-runs the membership path (member_id present) and
 * confirms it still flips to paid + emits the TIMELINE audit branch (payload
 * HAS member_id) — the relaxed guard must not change membership behaviour.
 *
 * Lives in tests/integration/** → hits live Neon. Migrations 0200–0203 MUST be
 * applied first (`pnpm db:migrate`).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { createEventInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-event-invoice-draft';
import { makeCreateEventInvoiceDraftDeps } from '@/modules/invoicing/application/invoicing-deps';
import {
  issueInvoice,
  type IssueInvoiceDeps,
} from '@/modules/invoicing/application/use-cases/issue-invoice';
import {
  recordPayment,
  type RecordPaymentDeps,
} from '@/modules/invoicing/application/use-cases/record-payment';
import { makeRecordPaymentDeps } from '@/modules/invoicing/application/invoicing-deps';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { postgresSequenceAllocator } from '@/modules/invoicing/infrastructure/adapters/postgres-sequence-allocator';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { resendEmailOutboxAdapter } from '@/modules/invoicing/infrastructure/adapters/resend-email-outbox-adapter';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

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

const BUYER_WITH_TIN = {
  legal_name: 'Beta Imports Ltd',
  tax_id: '9876543210123',
  address: '50 Sukhumvit Road, Bangkok 10110',
  primary_contact_name: 'Jane Doe',
  primary_contact_email: 'jane-pay@beta.example',
} as const;

const BUYER_NO_TIN = {
  legal_name: 'Walk-in Guest',
  tax_id: null,
  address: '99 Charoen Krung Road, Bangkok 10500',
  primary_contact_name: 'Walk-in Guest',
  primary_contact_email: 'walkin-pay@example.com',
} as const;

/**
 * Mocked PDF/Blob deps for the ISSUE step (mirrors issue-event-invoice.test.ts).
 * Real repos + real audit + real sequence allocator; PDF render + Blob upload
 * mocked to stay fast.
 */
function makeIssueDepsWithMocks(tenantSlug: string): IssueInvoiceDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantSlug),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    memberIdentity: makeCreateEventInvoiceDraftDeps(tenantSlug).memberIdentity,
    sequenceAllocator: postgresSequenceAllocator,
    pdfRender: {
      render: vi.fn(async () => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sha256: Sha256Hex.ofUnsafe('b'.repeat(64)),
      })),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({
        key,
        url: `https://blob.test/${key}`,
      })),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    },
    audit: f4AuditAdapter,
    clock: { nowIso: () => '2026-04-18T10:00:00Z' },
    outbox: resendEmailOutboxAdapter,
    currentTemplateVersion: 1,
  };
}

/**
 * Real composition root for recordPayment, but with the PDF render + Blob
 * deps overridden by mocks that CAPTURE every render input so the test can
 * assert the §86/4 doc-type `kind` + the pre-pinned buyer snapshot threaded
 * as `member`. Everything else (real Drizzle invoice repo on the test tenant,
 * real §87 receipt allocator, real F4 audit adapter, real outbox) stays live.
 *
 * `asyncReceiptPdf: false` override (+ drop the enqueue port): the shared
 * `tests/integration-setup.ts` forces `FEATURE_F5_ASYNC_RECEIPT_PDF=true`,
 * which makes `recordPayment` SKIP the synchronous receipt render and enqueue
 * an async render task instead — there'd be no inline render to capture. The
 * SYNCHRONOUS render is the path the F4 admin manual mark-paid route uses in
 * production (env flag default false), so we pin it here to assert the receipt
 * render args (kind + buyer snapshot) directly. The async enqueue path's
 * rollback semantics are already covered by record-payment-rollback.test.ts.
 */
function makeRecordPaymentDepsWithCapture(
  tenantSlug: string,
  captured: PdfRenderInput[],
): RecordPaymentDeps {
  const real = makeRecordPaymentDeps(tenantSlug);
  const { receiptPdfRenderEnqueue: _omitEnqueue, ...rest } = real;
  void _omitEnqueue;
  return {
    ...rest,
    asyncReceiptPdf: false,
    pdfRender: {
      render: vi.fn(async (renderInput: PdfRenderInput) => {
        captured.push(renderInput);
        return {
          bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
          sha256: Sha256Hex.ofUnsafe('c'.repeat(64)),
        };
      }),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({
        key,
        url: `https://blob.test/${key}`,
      })),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    },
  };
}

describe('recordPayment — NON-member EVENT-fee invoices (admin manual mark-paid, spec §9 NF-B)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'event-pay-plan';

  let eventId: string;
  let regWithTinId: string; // non-member WITH tin → kind 'invoice' at issue
  let regNoTinId: string; // non-member WITHOUT tin → kind 'receipt_separate' at issue
  let regMatchedId: string; // matched member (regression: membership-style audit)
  let memberId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    eventId = randomUUID();
    regWithTinId = randomUUID();
    regNoTinId = randomUUID();
    regMatchedId = randomUUID();
    memberId = randomUUID();

    await runInTenant(tenant.ctx, async (tx) => {
      // Tenant invoice settings — standard 7% VAT, SEPARATE receipt numbering so
      // record-payment allocates its own receipt sequence (exercises the §87
      // receipt allocator on the event path).
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 0n,
        legalNameTh: 'หอการค้า',
        legalNameEn: 'Chamber',
        taxId: '0000000000000',
        registeredAddressTh: 'Bangkok',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'EVP',
        creditNoteNumberPrefix: 'EVPC',
        receiptNumberPrefix: 'EVPR',
        receiptNumberingMode: 'separate',
      });

      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'Event Pay Plan' },
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

      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        companyName: 'Gamma Pay Corp',
        country: 'TH',
        taxId: '1111111111111',
        addressLine1: '1 Wireless Road',
        city: 'Pathum Wan',
        province: 'Bangkok',
        postalCode: '10330',
        planId,
        planYear: 2026,
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Som',
        lastName: 'Pay',
        email: 'som.pay@gamma.example',
        isPrimary: true,
      });

      await tx.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId: 'evt_fee_pay_int',
        name: 'Pay Gala',
        startDate: new Date('2026-09-10T11:00:00Z'),
      } satisfies NewEventRow);

      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId: regWithTinId,
        eventId,
        externalId: 'pay_att_with_tin',
        attendeeEmail: 'jane-pay@beta.example',
        attendeeName: 'Jane Doe',
        attendeeCompany: 'Beta Imports Ltd',
        matchType: 'non_member',
        ticketType: 'VIP',
        ticketPriceThb: 5000,
        paymentStatus: 'paid',
        registeredAt: new Date('2026-09-01T03:00:00Z'),
      } satisfies NewEventRegistrationRow);

      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId: regNoTinId,
        eventId,
        externalId: 'pay_att_no_tin',
        attendeeEmail: 'walkin-pay@example.com',
        attendeeName: 'Walk-in Guest',
        attendeeCompany: null,
        matchType: 'non_member',
        ticketType: 'Standard',
        ticketPriceThb: 250,
        paymentStatus: 'paid',
        registeredAt: new Date('2026-09-01T03:00:00Z'),
      } satisfies NewEventRegistrationRow);

      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId: regMatchedId,
        eventId,
        externalId: 'pay_att_matched',
        attendeeEmail: 'som.pay@gamma.example',
        attendeeName: 'Som Pay',
        attendeeCompany: 'Gamma Pay Corp',
        matchType: 'member_domain',
        matchedMemberId: memberId,
        ticketType: 'Standard',
        ticketPriceThb: 2000,
        paymentStatus: 'paid',
        registeredAt: new Date('2026-09-01T03:00:00Z'),
      } satisfies NewEventRegistrationRow);
    });
  }, 90_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await tenant.cleanup().catch(() => {});
  });

  async function readInvoiceRow(invoiceId: string) {
    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    return row;
  }

  /** Draft + issue a non-member event invoice; returns its id. */
  async function draftAndIssueNonMember(
    eventRegistrationId: string,
    buyer: typeof BUYER_WITH_TIN | typeof BUYER_NO_TIN,
    tag: string,
  ): Promise<string> {
    const draftDeps = makeCreateEventInvoiceDraftDeps(tenant.ctx.slug);
    const draft = await createEventInvoiceDraft(draftDeps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-pay-draft-${tag}`,
      eventRegistrationId,
      amountOverride: 25000, // 250.00 THB inclusive
      buyer,
    });
    expect(draft.ok, draft.ok ? 'ok' : `draft err: ${draft.error.code}`).toBe(true);
    if (!draft.ok) throw new Error(`draft failed: ${draft.error.code}`);
    const invoiceId = draft.value.invoiceId;

    const issue = await issueInvoice(makeIssueDepsWithMocks(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-pay-issue-${tag}`,
      invoiceId,
    });
    expect(issue.ok, issue.ok ? 'ok' : `issue err: ${JSON.stringify(issue)}`).toBe(true);
    if (!issue.ok) throw new Error('issue failed');
    return invoiceId;
  }

  it('non-member WITH tin: recordPayment flips issued→paid, receipt render uses pre-pinned buyer snapshot, NON-timeline invoice_paid audit', async () => {
    const invoiceId = await draftAndIssueNonMember(regWithTinId, BUYER_WITH_TIN, `withtin-${regWithTinId}`);

    const captured: PdfRenderInput[] = [];
    const payReqId = `int-pay-record-withtin-${invoiceId}`;
    const result = await runInTenant(tenant.ctx, async () =>
      recordPayment(makeRecordPaymentDepsWithCapture(tenant.ctx.slug, captured), {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: payReqId,
        invoiceId,
        paymentMethod: 'bank_transfer',
        paymentReference: 'TRX-EVT-WITHTIN',
        paymentDate: '2026-05-01',
      }),
    );
    expect(result.ok, result.ok ? 'ok' : `pay err: ${JSON.stringify(result)}`).toBe(true);
    if (!result.ok) throw new Error(`pay failed: ${JSON.stringify(result)}`);

    // Invoice row flips to paid.
    const row = await readInvoiceRow(invoiceId);
    expect(row!.status).toBe('paid');
    expect(row!.paidAt).not.toBeNull();
    expect(row!.memberId).toBeNull(); // non-member event invoice.

    // Receipt render invoked with the PRE-PINNED non-member buyer snapshot
    // (NOT a deref of a null member) + Model-B vatInclusive threaded.
    const receiptRender = captured.find(
      (c) => c.kind === 'receipt_separate' || c.kind === 'receipt_combined',
    );
    expect(receiptRender, 'expected a receipt render for the paid event invoice').toBeDefined();
    expect(receiptRender!.member.legal_name).toBe('Beta Imports Ltd');
    expect(receiptRender!.member.tax_id).toBe('9876543210123');
    expect(receiptRender!.vatInclusive).toBe(true);

    // NON-timeline invoice_paid audit: no member_id, but has event_registration_id.
    const [auditRow] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'invoice_paid'),
          eq(auditLog.requestId, payReqId),
        ),
      );
    expect(auditRow, 'expected an invoice_paid audit row').toBeDefined();
    const payload = auditRow!.payload as Record<string, unknown>;
    expect('member_id' in payload).toBe(false);
    expect(payload.event_registration_id).toBe(regWithTinId);
    expect(payload.invoice_id).toBe(invoiceId);
  }, 90_000);

  it('non-member WITHOUT tin: recordPayment flips issued→paid, receipt render is receipt_separate (no ใบกำกับภาษี for a TIN-less buyer)', async () => {
    const invoiceId = await draftAndIssueNonMember(regNoTinId, BUYER_NO_TIN, `notin-${regNoTinId}`);

    const captured: PdfRenderInput[] = [];
    const payReqId = `int-pay-record-notin-${invoiceId}`;
    const result = await runInTenant(tenant.ctx, async () =>
      recordPayment(makeRecordPaymentDepsWithCapture(tenant.ctx.slug, captured), {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: payReqId,
        invoiceId,
        paymentMethod: 'cash',
        paymentDate: '2026-05-01',
      }),
    );
    expect(result.ok, result.ok ? 'ok' : `pay err: ${JSON.stringify(result)}`).toBe(true);
    if (!result.ok) throw new Error(`pay failed: ${JSON.stringify(result)}`);

    const row = await readInvoiceRow(invoiceId);
    expect(row!.status).toBe('paid');
    expect(row!.memberId).toBeNull();

    // §86/4: a TIN-less buyer must NEVER get a `receipt_combined` (ใบกำกับภาษี
    // label). The render kind MUST be `receipt_separate` (ใบเสร็จรับเงิน), even
    // though the tenant setting is `receiptNumberingMode='separate'` here anyway
    // — the buyerHasTin gate is the authoritative driver.
    const receiptRender = captured.find(
      (c) => c.kind === 'receipt_separate' || c.kind === 'receipt_combined',
    );
    expect(receiptRender, 'expected a receipt render').toBeDefined();
    expect(receiptRender!.kind).toBe('receipt_separate');
    expect(receiptRender!.member.tax_id).toBeNull();
    expect(receiptRender!.vatInclusive).toBe(true);

    // NON-timeline audit again.
    const [auditRow] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'invoice_paid'),
          eq(auditLog.requestId, payReqId),
        ),
      );
    const payload = auditRow!.payload as Record<string, unknown>;
    expect('member_id' in payload).toBe(false);
    expect(payload.event_registration_id).toBe(regNoTinId);
  }, 90_000);

  it('regression — matched-member event invoice still flips to paid + TIMELINE invoice_paid audit (payload HAS member_id)', async () => {
    // Matched member draft pins the buyer at ISSUE (member_id non-null on the row).
    const draftDeps = makeCreateEventInvoiceDraftDeps(tenant.ctx.slug);
    const draft = await createEventInvoiceDraft(draftDeps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-pay-draft-matched-${regMatchedId}`,
      eventRegistrationId: regMatchedId,
    });
    expect(draft.ok, draft.ok ? 'ok' : `draft err: ${draft.error.code}`).toBe(true);
    if (!draft.ok) throw new Error(`draft failed: ${draft.error.code}`);
    const invoiceId = draft.value.invoiceId;

    const issue = await issueInvoice(makeIssueDepsWithMocks(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-pay-issue-matched-${invoiceId}`,
      invoiceId,
    });
    expect(issue.ok, issue.ok ? 'ok' : `issue err: ${JSON.stringify(issue)}`).toBe(true);

    const captured: PdfRenderInput[] = [];
    const payReqId = `int-pay-record-matched-${invoiceId}`;
    const result = await runInTenant(tenant.ctx, async () =>
      recordPayment(makeRecordPaymentDepsWithCapture(tenant.ctx.slug, captured), {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: payReqId,
        invoiceId,
        paymentMethod: 'bank_transfer',
        paymentDate: '2026-05-01',
      }),
    );
    expect(result.ok, result.ok ? 'ok' : `pay err: ${JSON.stringify(result)}`).toBe(true);

    const row = await readInvoiceRow(invoiceId);
    expect(row!.status).toBe('paid');
    expect(row!.memberId).toBe(memberId);

    // TIMELINE branch: payload HAS member_id.
    const [auditRow] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'invoice_paid'),
          eq(auditLog.requestId, payReqId),
        ),
      );
    const payload = auditRow!.payload as Record<string, unknown>;
    expect(payload.member_id).toBe(memberId);
  }, 90_000);
});
