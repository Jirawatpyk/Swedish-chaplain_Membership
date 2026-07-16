/**
 * F-2 (2026-07-08, renewal-rolling-anchor design Task 13) — credit-note
 * membership-effect cascade, end-to-end against live Neon.
 *
 * Pins the F4 → F8 cross-module contract the `/api/credit-notes` route
 * orchestrates: `issueCreditNote` commits FIRST (§86/10 numbering never
 * depends on F8), then — only when the credit was a FULL credit on a
 * membership invoice with `membershipEffect: 'cancel_membership'` — the
 * SAME sequence the route runs is exercised directly here (mirrors the
 * precedent in `f3-archival-cascade.test.ts`: "this test exercises the F8
 * use-case directly to keep the integration scope on the F8-side
 * invariants"; the route's own orchestration wiring — including failure
 * handling — is covered by the mocked contract test at
 * `tests/contract/credit-notes-route.test.ts`).
 *
 * Covers:
 *   1. `cancel_membership` on a full credit → the member's open renewal
 *      cycle transitions to `cancelled` (`closed_reason='cancelled'`) +
 *      a `renewal_cycle_cancelled` audit row with
 *      `payload.reason='credit_note_refund'` (F-2's dedicated cascade
 *      discriminator — distinct from the F3 archival cascade's default,
 *      since the member is NOT archived, only refunded) + `request_id`
 *      matching the `credit-note:{creditNoteId}` correlation format —
 *      AND the credit note itself is intact (status flips to `credited`).
 *   2. `keep` on an otherwise-identical full credit → the cycle is
 *      UNTOUCHED (still in its original non-terminal status); the
 *      credit note still commits normally.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { creditNotes } from '@/modules/invoicing/infrastructure/db/schema-credit-notes';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { makeDrizzleCreditNoteRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-credit-note-repo';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
import { postgresSequenceAllocator } from '@/modules/invoicing/infrastructure/adapters/postgres-sequence-allocator';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { issueCreditNote } from '@/modules/invoicing/application/use-cases/issue-credit-note';
import type { IssueCreditNoteDeps } from '@/modules/invoicing/application/use-cases/issue-credit-note';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { cancelInFlightCyclesForMember, makeRenewalsDeps } from '@/modules/renewals';
import { asMemberId } from '@/modules/members';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const INVOICE_TOTAL = 107_000n; // 1,000 THB subtotal + 7% VAT
const INVOICE_SUBTOTAL = 100_000n;
const INVOICE_VAT = 7_000n;
const EXPIRES_AT = new Date('2026-09-15T00:00:00.000Z');
const PERIOD_FROM = new Date('2025-09-15T00:00:00.000Z');

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'F-2 Cascade Test Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};

/** Seeds a member + an open renewal cycle + a paid membership invoice. */
async function seedMemberWithCycleAndPaidInvoice(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
  // Distinct per call within a test file that does NOT wipe between `it`
  // blocks (unlike `credit-note-partial-accumulation.test.ts`'s per-test
  // beforeEach wipe) — avoids any theoretical same-fiscal-year sequence
  // collision on a direct (non-allocator) insert.
  sequenceNumber: number,
): Promise<{ memberId: string; cycleId: string; invoiceId: string }> {
  const memberId = randomUUID();
  const cycleId = randomUUID();
  const invoiceId = randomUUID();

  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'F-2 Cascade Test Co',
      country: 'TH',
      planId,
      planYear: 2026,
    });

    await tx.insert(renewalCycles).values({
      tenantId: tenant.ctx.slug,
      cycleId,
      memberId,
      status: 'awaiting_payment',
      periodFrom: PERIOD_FROM,
      periodTo: EXPIRES_AT,
      expiresAt: EXPIRES_AT,
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular',
      planIdAtCycleStart: planId,
      frozenPlanPriceThb: '1070.00',
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB',
    });

    // Seed shape mirrors `credit-note-partial-accumulation.test.ts`'s
    // proven `seedInvoiceInStatus('paid')` verbatim (legacy combined-mode:
    // non-null invoice-stream documentNumber, no separate RC) — this test
    // is about the F4↔F8 cascade wiring, not the 088 document-number
    // resolution paths already covered elsewhere.
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
      documentNumber: `F2CN-2026-${String(sequenceNumber).padStart(6, '0')}`,
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
      pdfBlobKey: 'invoicing/x/2026/seed.pdf',
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
  });
  return { memberId, cycleId, invoiceId };
}

function makeCreditNoteDeps(tenantId: string): IssueCreditNoteDeps {
  return {
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

describe('F-2 — credit-note membership-effect cascade (Task 13, live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'f2-cascade-plan';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-chamber');
    await seedRenewalPolicies(tenant.ctx);
    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'F-2 Cascade Plan' },
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
        invoiceNumberPrefix: 'F2IT',
        creditNoteNumberPrefix: 'F2CN',
      });
    });
  }, 60_000);

  afterAll(async () => {
    await db.delete(renewalCycles).where(eq(renewalCycles.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(creditNotes).where(eq(creditNotes.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(invoiceLines).where(eq(invoiceLines.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 60_000);

  it('cancel_membership + full credit → cycle cancelled + renewal_cycle_cancelled audit (reason=credit_note_refund) + credit note intact', async () => {
    const { memberId, cycleId, invoiceId } = await seedMemberWithCycleAndPaidInvoice(
      tenant,
      user,
      planId,
      1,
    );
    const deps = makeCreditNoteDeps(tenant.ctx.slug);

    const cn = await issueCreditNote(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `f2-cascade-req-${invoiceId}`,
      invoiceId,
      creditTotalSatang: INVOICE_TOTAL, // full
      reason: 'refund + membership withdrawal',
      membershipEffect: 'cancel_membership',
    });
    expect(cn.ok, cn.ok ? 'ok' : `err: ${JSON.stringify(cn)}`).toBe(true);
    if (!cn.ok) throw new Error('credit note failed');
    expect(cn.value.membershipCancellationRequested).toBe(true);

    // Credit note is intact — parent invoice flips to 'credited'.
    const [invoiceRow] = await db
      .select({ status: invoices.status })
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    expect(invoiceRow!.status).toBe('credited');

    // Orchestrate the SAME F8 call the route makes after commit.
    const correlationId = `credit-note:${cn.value.creditNote.creditNoteId}`;
    const cascade = await cancelInFlightCyclesForMember(makeRenewalsDeps(tenant.ctx.slug), {
      tenant: tenant.ctx,
      memberId: asMemberId(memberId),
      cascadeReason: 'credit_note_refund',
      initiatedByUserId: user.userId,
      requestId: null,
      correlationId,
    });
    expect(cascade.ok).toBe(true);
    if (!cascade.ok) throw new Error('cascade failed');
    expect(cascade.value.outcome).toBe('ok');
    expect(cascade.value.cancelledCount).toBe(1);

    // Cycle transitioned to cancelled.
    const [cycleRow] = await db
      .select({ status: renewalCycles.status, closedReason: renewalCycles.closedReason })
      .from(renewalCycles)
      .where(and(eq(renewalCycles.tenantId, tenant.ctx.slug), eq(renewalCycles.cycleId, cycleId)));
    expect(cycleRow!.status).toBe('cancelled');
    expect(cycleRow!.closedReason).toBe('cancelled');

    // F8 audit row carries the F-2 cascade discriminator + the credit-note
    // correlation id (forensic chain).
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'renewal_cycle_cancelled' as never),
          eq(auditLog.requestId, correlationId),
        ),
      );
    expect(auditRows).toHaveLength(1);
    const payload = auditRows[0]!.payload as { reason: string; cycle_id: string; member_id: string };
    expect(payload.reason).toBe('credit_note_refund');
    expect(payload.cycle_id).toBe(cycleId);
    expect(payload.member_id).toBe(memberId);
  }, 90_000);

  it('keep + full credit → cycle is UNTOUCHED (still awaiting_payment); credit note still commits normally', async () => {
    const { memberId, cycleId, invoiceId } = await seedMemberWithCycleAndPaidInvoice(
      tenant,
      user,
      planId,
      2,
    );
    const deps = makeCreditNoteDeps(tenant.ctx.slug);

    const cn = await issueCreditNote(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `f2-cascade-keep-req-${invoiceId}`,
      invoiceId,
      creditTotalSatang: INVOICE_TOTAL, // full
      reason: 'paperwork correction',
      membershipEffect: 'keep',
    });
    expect(cn.ok, cn.ok ? 'ok' : `err: ${JSON.stringify(cn)}`).toBe(true);
    if (!cn.ok) throw new Error('credit note failed');
    // 'keep' never requests the F8 cascade — the route would NOT call
    // cancelInFlightCyclesForMember at all for this outcome.
    expect(cn.value.membershipCancellationRequested).toBe(false);

    const [invoiceRow] = await db
      .select({ status: invoices.status })
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    expect(invoiceRow!.status).toBe('credited');

    // No cascade was ever invoked — the cycle stays exactly as seeded.
    const [cycleRow] = await db
      .select({ status: renewalCycles.status })
      .from(renewalCycles)
      .where(and(eq(renewalCycles.tenantId, tenant.ctx.slug), eq(renewalCycles.cycleId, cycleId)));
    expect(cycleRow!.status).toBe('awaiting_payment');
    void memberId; // seeded for parity with the sibling test; not asserted here directly.
  }, 90_000);
});
