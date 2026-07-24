/**
 * M1 (plan-change-ux, Option 1b) — end-to-end retains_coverage chain, live Neon.
 *
 * The `credit_notes.retains_coverage` signal is exercised in three places that
 * were, until now, tested in ISOLATION:
 *   - the DERIVATION (`issueCreditNote`, sourceRefundId-first) — unit-mock tested;
 *   - the PERSISTENCE (`credit_notes.retains_coverage`) — direct-insert tested;
 *   - the READ predicate (`findMaxPaidThroughForMemberInTx`'s effective-paid
 *     coverage EXISTS) — direct-insert tested
 *     (`effective-paid-billing-coverage.test.ts`).
 *
 * This test threads the REAL `issueCreditNote` use-case end-to-end so the whole
 * chain (derivation ORDER + persistence + predicate) is pinned in one place — a
 * regression that flips the sourceRefundId-first derivation, drops the column
 * write, or breaks the correlated EXISTS would be caught here even if each unit
 * seam stayed green in isolation.
 *
 * Both members own a COMPLETED renewal cycle whose settling (`linked_invoice_id`)
 * invoice is a `paid` FULL-membership invoice with `period_to` in the future, so
 * BEFORE the credit note the frontier = period_to. Issuing a FULL credit flips
 * the invoice to `credited`; whether the frontier is RETAINED or RETRACTED then
 * depends solely on the derived + persisted `retains_coverage`:
 *
 *   (a) F4-manual FULL membership `keep` (no sourceRefundId) → retains_coverage
 *       TRUE  → frontier stays COVERED (paperwork correction, member not refunded).
 *   (b) F5-bridge CN (sourceRefundId set, membershipEffect 'keep' as the bridge
 *       hard-codes it) → retains_coverage FALSE → frontier RETRACTS (money
 *       returned).
 *
 * PDF render + Blob upload + outbox are stubbed (deterministic) so the SUT is the
 * DB persistence + derivation + predicate, not the external PDF/Blob/email
 * round-trip (covered by F4's own suites). Live Neon (DEV branch).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { asSatang } from '@/lib/money';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { creditNotes } from '@/modules/invoicing/infrastructure/db/schema-credit-notes';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { payments, refunds } from '@/modules/payments/infrastructure/schema';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { makeDrizzleCreditNoteRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-credit-note-repo';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
import { postgresSequenceAllocator } from '@/modules/invoicing/infrastructure/adapters/postgres-sequence-allocator';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { issueCreditNote } from '@/modules/invoicing/application/use-cases/issue-credit-note';
import type { IssueCreditNoteDeps } from '@/modules/invoicing/application/use-cases/issue-credit-note';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { makeRenewalsDeps } from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const INVOICE_TOTAL = 107_000n; // 1,000 THB subtotal + 7% VAT
const INVOICE_SUBTOTAL = 100_000n;
const INVOICE_VAT = 7_000n;
// A future period end so a covered member's frontier is exactly this ISO value
// and a retracted member's frontier is null.
const PERIOD_TO = new Date(Date.now() + 20 * 86_400_000);
const PERIOD_FROM = new Date(Date.now() - 345 * 86_400_000);

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'M1 E2E Test Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};

/**
 * Seed a member + a COMPLETED renewal cycle whose settling `linked_invoice_id`
 * is a `paid` FULL-membership invoice (`period_to` in the future). BEFORE any
 * credit note the effective-paid frontier for this member = PERIOD_TO.
 * `sequenceNumber` is distinct per call (this file does not wipe between `it`
 * blocks) to avoid a same-fiscal-year direct-insert collision.
 */
async function seedMemberCompletedCyclePaidInvoice(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
  sequenceNumber: number,
): Promise<{ memberId: string; invoiceId: string }> {
  const memberId = randomUUID();
  const cycleId = randomUUID();
  const invoiceId = randomUUID();

  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'M1 E2E Test Co',
      country: 'TH',
      planId,
      planYear: 2026,
    });

    // Settling invoice BEFORE the cycle so the composite FK
    // (tenant_id, linked_invoice_id) → invoices is satisfied. Legacy
    // combined-mode shape (non-null invoice-stream documentNumber, no separate
    // RC) — mirrors credit-note-membership-cascade.test.ts's proven paid seed.
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
      sequenceNumber,
      documentNumber: `M1E2E-2026-${String(sequenceNumber).padStart(6, '0')}`,
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
      pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
      pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 1,
      paymentMethod: 'bank_transfer',
      paymentReference: 'seed-ref',
      paymentNotes: null,
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

    // Completed steady-state cycle — settling invoice on linked_invoice_id, so
    // ONLY the completed arm of the effective-paid predicate matches it.
    await tx.insert(renewalCycles).values({
      tenantId: tenant.ctx.slug,
      cycleId,
      memberId,
      status: 'completed',
      periodFrom: PERIOD_FROM,
      periodTo: PERIOD_TO,
      expiresAt: PERIOD_TO,
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular',
      planIdAtCycleStart: planId,
      frozenPlanPriceThb: '1070.00',
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB',
      linkedInvoiceId: invoiceId,
      closedAt: PERIOD_TO,
      closedReason: 'paid',
    });
  });

  return { memberId, invoiceId };
}

/**
 * Seed a real Payment + Refund against `invoiceId` so an F5-bridge credit note's
 * `source_refund_id` FK (→ refunds.id, ON DELETE RESTRICT) resolves. Returns the
 * refund id the caller threads as `sourceRefundId`.
 */
async function seedRefundForInvoice(
  tenant: TestTenant,
  user: TestUser,
  memberId: string,
  invoiceId: string,
): Promise<{ refundId: string }> {
  const paymentId = `pay-${randomUUID()}`;
  const refundId = `rfnd-${randomUUID()}`;
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(payments).values({
      id: paymentId,
      tenantId: tenant.ctx.slug,
      invoiceId,
      memberId,
      method: 'card',
      status: 'succeeded',
      amountSatang: INVOICE_TOTAL,
      currency: 'THB',
      processorPaymentIntentId: `pi_test_${randomUUID()}`,
      processorChargeId: `ch_test_${randomUUID()}`,
      processorEnvironment: 'test',
      attemptSeq: 1,
      cardBrand: 'visa',
      cardLast4: '4242',
      cardExpMonth: 12,
      cardExpYear: 2030,
      initiatedAt: new Date('2026-02-01T03:00:00Z'),
      completedAt: new Date('2026-02-01T03:00:10Z'),
      actorUserId: user.userId,
      correlationId: 'test-corr-payment',
    });
    await tx.insert(refunds).values({
      id: refundId,
      tenantId: tenant.ctx.slug,
      paymentId,
      invoiceId,
      amountSatang: asSatang(INVOICE_TOTAL),
      reason: 'Customer requested refund',
      status: 'pending',
      initiatedAt: new Date('2026-02-03T03:00:00Z'),
      initiatorUserId: user.userId,
      correlationId: 'test-corr-refund',
    });
  });
  return { refundId };
}

/** Real DB repos + deterministic PDF/Blob/outbox stubs (mirror the cascade test). */
function makeCreditNoteDeps(tenantId: string): IssueCreditNoteDeps {
  return {
    pendingRefundGuard: { countPendingRefundsForInvoice: async () => 0 },
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    creditNoteRepo: makeDrizzleCreditNoteRepo(tenantId),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    sequenceAllocator: postgresSequenceAllocator,
    pdfRender: {
      render: vi.fn(async () => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sha256: Sha256Hex.ofUnsafe('b'.repeat(64)),
      })),
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
    recipientLocale: { getMemberEmailLocale: vi.fn(async () => null) },
    currentTemplateVersion: 1,
  };
}

describe('M1 — retains_coverage derivation → persist → read (end-to-end, live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'm1-e2e-plan';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-chamber');
    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'M1 E2E Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
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
        invoiceNumberPrefix: 'M1IT',
        creditNoteNumberPrefix: 'M1CN',
      });
    });
  }, 60_000);

  afterAll(async () => {
    await db.delete(renewalCycles).where(eq(renewalCycles.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(creditNotes).where(eq(creditNotes.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(refunds).where(eq(refunds.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(payments).where(eq(payments.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(invoiceLines).where(eq(invoiceLines.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 60_000);

  it('(a) F4-manual FULL membership keep → retains_coverage TRUE persisted → frontier stays COVERED', async () => {
    const { memberId, invoiceId } = await seedMemberCompletedCyclePaidInvoice(
      tenant,
      user,
      planId,
      1,
    );
    const deps = makeCreditNoteDeps(tenant.ctx.slug);

    const cn = await issueCreditNote(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `m1-e2e-keep-${invoiceId}`,
      invoiceId,
      creditTotalSatang: INVOICE_TOTAL, // full
      reason: 'paperwork correction — member not refunded',
      membershipEffect: 'keep',
      // No sourceRefundId → F4-manual → retention arm of the derivation.
    });
    expect(cn.ok, cn.ok ? 'ok' : `err: ${JSON.stringify(cn)}`).toBe(true);
    if (!cn.ok) throw new Error('credit note failed');

    // Persistence: the DERIVED retains_coverage lands TRUE on the row.
    const [cnRow] = await db
      .select({ retains: creditNotes.retainsCoverage })
      .from(creditNotes)
      .where(
        and(
          eq(creditNotes.tenantId, tenant.ctx.slug),
          eq(creditNotes.creditNoteId, cn.value.creditNote.creditNoteId),
        ),
      );
    expect(cnRow!.retains).toBe(true);

    // Parent invoice flipped to 'credited' by the full credit.
    const [invRow] = await db
      .select({ status: invoices.status })
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    expect(invRow!.status).toBe('credited');

    // Read predicate: the coverage-retaining CN keeps the period COVERED even
    // though the settling invoice is 'credited' (frontier NOT retracted).
    const frontier = await runInTenant(tenant.ctx, (tx) =>
      makeRenewalsDeps(tenant.ctx.slug).cyclesRepo.findMaxPaidThroughForMemberInTx(
        tx,
        tenant.ctx.slug,
        memberId,
      ),
    );
    expect(frontier).toBe(PERIOD_TO.toISOString());
  }, 90_000);

  it('(b) F5-bridge CN (sourceRefundId set) → retains_coverage FALSE persisted → frontier RETRACTS', async () => {
    const { memberId, invoiceId } = await seedMemberCompletedCyclePaidInvoice(
      tenant,
      user,
      planId,
      2,
    );
    const { refundId } = await seedRefundForInvoice(tenant, user, memberId, invoiceId);
    const deps = makeCreditNoteDeps(tenant.ctx.slug);

    const cn = await issueCreditNote(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `m1-e2e-refund-${invoiceId}`,
      invoiceId,
      creditTotalSatang: INVOICE_TOTAL, // full
      reason: 'refund — money returned',
      // The F5 bridge hard-codes membershipEffect 'keep' while GENUINELY
      // returning money, so sourceRefundId — NOT membershipEffect — is the
      // retract signal (derivation checks sourceRefundId FIRST).
      membershipEffect: 'keep',
      sourceRefundId: refundId,
    });
    expect(cn.ok, cn.ok ? 'ok' : `err: ${JSON.stringify(cn)}`).toBe(true);
    if (!cn.ok) throw new Error('credit note failed');

    // Persistence: sourceRefundId-first derivation lands retains_coverage FALSE
    // despite membershipEffect 'keep'.
    const [cnRow] = await db
      .select({ retains: creditNotes.retainsCoverage, srcRefund: creditNotes.sourceRefundId })
      .from(creditNotes)
      .where(
        and(
          eq(creditNotes.tenantId, tenant.ctx.slug),
          eq(creditNotes.creditNoteId, cn.value.creditNote.creditNoteId),
        ),
      );
    expect(cnRow!.retains).toBe(false);
    expect(cnRow!.srcRefund).toBe(refundId);

    const [invRow] = await db
      .select({ status: invoices.status })
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    expect(invRow!.status).toBe('credited');

    // Read predicate: a real refund → money returned → the 'credited' settling
    // invoice RETRACTS the period (no retention CN) → frontier null.
    const frontier = await runInTenant(tenant.ctx, (tx) =>
      makeRenewalsDeps(tenant.ctx.slug).cyclesRepo.findMaxPaidThroughForMemberInTx(
        tx,
        tenant.ctx.slug,
        memberId,
      ),
    );
    expect(frontier).toBeNull();
  }, 90_000);
});
