/**
 * Phase 2 Step 2.4 — void-invoice clears `renewal_cycles.linked_invoice_id`.
 *
 * A voided membership §86/4 no longer validly links the cycle. Before this
 * step, `void-invoice.ts` did NOT clear `renewal_cycles.linked_invoice_id`
 * (that column is renewals-owned), so the cycle kept pointing at the voided
 * invoice and any REISSUE with a NEW invoice id hit `InvoiceLinkConflictError`
 * from `linkInvoice`'s guard (`WHERE linked_invoice_id IS NULL OR = $new`).
 * This blocked the "void the §86/4 and reissue so the new plan applies now"
 * workflow.
 *
 * The fix wires an OPTIONAL renewals seam (`onMembershipInvoiceVoidedInTx`)
 * into the void's Phase-1 tx: for a MEMBERSHIP void it resolves the cycle by
 * the voided invoice id and clears `linked_invoice_id` (guarded on the OPEN
 * cycle statuses + a CAS on the expected invoice id), ATOMICALLY with the void
 * + the `invoice_voided` audit, on the SAME tx (no nested `runInTenant`, no
 * second pooled connection while the void holds the member-row lock).
 *
 * Live Neon Singapore via `.env.local`. RED (pre-implementation):
 * `makeVoidInvoiceCycleUnlink` is not exported yet and the cycle repo has no
 * `clearLinkedInvoiceForVoidInTx` method — the file fails to import until the
 * seam ships.
 *
 * PDF/Blob/outbox are stubbed (fast); DB + RLS + audit are real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { voidInvoice } from '@/modules/invoicing/application/use-cases/void-invoice';
import type { VoidInvoiceDeps } from '@/modules/invoicing/application/use-cases/void-invoice';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { makeDrizzleRenewalCycleRepo } from '@/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import { InvoiceLinkConflictError } from '@/modules/renewals/application/ports/renewal-cycle-repo';
// RED: not exported until Step 2.4 ships the renewals seam.
import { makeVoidInvoiceCycleUnlink } from '@/modules/renewals';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

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

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'Unlink Test Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};
const RERENDERED_SHA = 'b'.repeat(64);
const PLAN_ID = 'unlink-plan';

async function seedPlan(tenant: TestTenant, user: TestUser): Promise<void> {
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId: PLAN_ID,
      planYear: 2026,
      planName: { en: 'Unlink Plan' },
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
      invoiceNumberPrefix: 'ULK',
      creditNoteNumberPrefix: 'CN',
    });
  });
}

async function seedMember(tenant: TestTenant): Promise<string> {
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'Unlink Test Co',
      country: 'TH',
      planId: PLAN_ID,
      planYear: 2026,
    });
  });
  return memberId;
}

async function seedMembershipInvoice(
  tenant: TestTenant,
  user: TestUser,
  memberId: string,
  status: 'issued' | 'paid',
  sequenceNumber: number,
): Promise<string> {
  const invoiceId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(invoices).values({
      tenantId: tenant.ctx.slug,
      invoiceId,
      memberId,
      planYear: 2026,
      planId: PLAN_ID,
      invoiceSubject: 'membership',
      draftByUserId: user.userId,
      status,
      pdfDocKind: 'invoice',
      fiscalYear: 2026,
      sequenceNumber,
      documentNumber: `ULK-2026-${String(sequenceNumber).padStart(6, '0')}`,
      issueDate: '2026-01-15',
      dueDate: '2026-02-14',
      subtotalSatang: 100_000n,
      vatRateSnapshot: '0.0700',
      vatSatang: 7_000n,
      totalSatang: 107_000n,
      creditedTotalSatang: 0n,
      proRatePolicySnapshot: 'monthly',
      netDaysSnapshot: 30,
      tenantIdentitySnapshot: SNAP_TENANT,
      memberIdentitySnapshot: SNAP_MEMBER,
      autoEmailOnIssue: false,
      pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
      pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 1,
      paymentMethod: status === 'paid' ? 'bank_transfer' : null,
      paymentReference: status === 'paid' ? 'seed-ref' : null,
      paymentRecordedByUserId: status === 'paid' ? user.userId : null,
      paymentDate: status === 'paid' ? '2026-02-01' : null,
      paidAt: status === 'paid' ? new Date('2026-02-01T03:00:00Z') : null,
      receiptPdfStatus: status === 'paid' ? 'rendered' : null,
    });
    await tx.insert(invoiceLines).values({
      tenantId: tenant.ctx.slug,
      lineId: randomUUID(),
      invoiceId,
      kind: 'membership_fee',
      descriptionTh: 'ค่าสมาชิก ปี 2026',
      descriptionEn: 'Membership 2026',
      unitPriceSatang: 100_000n,
      totalSatang: 100_000n,
      position: 1,
    });
  });
  return invoiceId;
}

async function seedCycle(
  tenant: TestTenant,
  memberId: string,
  linkedInvoiceId: string | null,
  status: 'awaiting_payment' | 'completed',
): Promise<string> {
  const cycleId = randomUUID();
  const isCompleted = status === 'completed';
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(renewalCycles).values({
      tenantId: tenant.ctx.slug,
      cycleId,
      memberId,
      status,
      periodFrom: new Date('2026-01-01T00:00:00.000Z'),
      periodTo: new Date('2027-01-01T00:00:00.000Z'),
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular',
      planIdAtCycleStart: PLAN_ID,
      frozenPlanPriceThb: '50000.00',
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB',
      linkedInvoiceId,
      // completed is terminal → closed_at + closed_reason required by CHECK.
      closedAt: isCompleted ? new Date('2026-02-01T03:00:00Z') : null,
      closedReason: isCompleted ? 'paid' : null,
    });
  });
  return cycleId;
}

function makeDeps(
  tenantId: string,
  opts: { wireUnlink: boolean } = { wireUnlink: true },
): VoidInvoiceDeps {
  const base: VoidInvoiceDeps = {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    pdfRender: {
      render: vi.fn(async () => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x56]),
        sha256: Sha256Hex.ofUnsafe(RERENDERED_SHA),
      })),
    },
    blob: {
      uploadPdf: vi.fn(async (input) => ({
        key: input.key,
        url: `https://blob.test/${input.key}`,
      })),
      uploadLogo: vi.fn(async ({ key }) => ({ key, url: `https://blob.test/${key}` })),
      signDownloadUrl: vi.fn(async () => 'https://blob.test/signed'),
      downloadBytes: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => [] as string[]),
    },
    audit: f4AuditAdapter,
    clock: { nowIso: () => '2026-03-15T10:00:00Z' },
    outbox: { enqueue: vi.fn(async () => {}) },
    recipientLocale: { getMemberEmailLocale: vi.fn(async () => null) },
    // 8A (merge) — non-locking pending-refund guard; this suite never seeds a
    // refund, so a constant 0 keeps the void unblocked.
    pendingRefundGuard: { countPendingRefundsForInvoice: async () => 0 },
  };
  return opts.wireUnlink
    ? { ...base, onMembershipInvoiceVoidedInTx: makeVoidInvoiceCycleUnlink(tenantId) }
    : base;
}

async function readCycle(cycleId: string) {
  const rows = await db
    .select()
    .from(renewalCycles)
    .where(eq(renewalCycles.cycleId, cycleId))
    .limit(1);
  return rows[0]!;
}

describe('Step 2.4 — void-invoice clears renewal_cycles.linked_invoice_id', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
    tenantB = await createTestTenant('test-chamber');
    await seedPlan(tenantA, user);
    await seedPlan(tenantB, user);
  }, 120_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      for (const q of [
        db.delete(auditLog).where(eq(auditLog.tenantId, t.ctx.slug)),
        db.delete(renewalCycles).where(eq(renewalCycles.tenantId, t.ctx.slug)),
        db.delete(invoiceLines).where(eq(invoiceLines.tenantId, t.ctx.slug)),
        db.delete(invoices).where(eq(invoices.tenantId, t.ctx.slug)),
        db.delete(members).where(eq(members.tenantId, t.ctx.slug)),
        db.delete(membershipPlans).where(eq(membershipPlans.tenantId, t.ctx.slug)),
      ]) {
        await q.catch(() => {});
      }
      await t.cleanup().catch(() => {});
    }
  }, 120_000);

  beforeEach(async () => {
    for (const t of [tenantA, tenantB]) {
      for (const q of [
        db.delete(auditLog).where(eq(auditLog.tenantId, t.ctx.slug)),
        db.delete(renewalCycles).where(eq(renewalCycles.tenantId, t.ctx.slug)),
        db.delete(invoiceLines).where(eq(invoiceLines.tenantId, t.ctx.slug)),
        db.delete(invoices).where(eq(invoices.tenantId, t.ctx.slug)),
        db.delete(members).where(eq(members.tenantId, t.ctx.slug)),
      ]) {
        await q.catch(() => {});
      }
    }
  });

  it('voiding an issued membership §86/4 clears the cycle link AND a reissue re-links a fresh invoice (no deadlock)', async () => {
    const memberId = await seedMember(tenantA);
    const invoiceId = await seedMembershipInvoice(tenantA, user, memberId, 'issued', 1);
    const cycleId = await seedCycle(tenantA, memberId, invoiceId, 'awaiting_payment');

    // The cycle points at the §86/4 that is about to be voided.
    expect((await readCycle(cycleId)).linkedInvoiceId).toBe(invoiceId);

    const start = Date.now();
    const r = await voidInvoice(makeDeps(tenantA.ctx.slug), {
      tenantId: tenantA.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      voidReason: 'Wrong plan — void to reissue under the new plan',
    });
    const elapsed = Date.now() - start;

    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(!r.ok && r.error)}`).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('void');

    // The clear committed ATOMICALLY with the void (same Phase-1 tx).
    expect((await readCycle(cycleId)).linkedInvoiceId).toBeNull();

    // No-deadlock: the clear runs on the void's own tx (no second connection
    // while the member-row lock is held). It must finish in a couple seconds.
    expect(
      elapsed,
      `void + cycle-unlink must complete promptly (took ${elapsed}ms)`,
    ).toBeLessThan(8_000);

    // REISSUE: a fresh §86/4 can now re-link the cycle (guard sees NULL, not the
    // voided id) — the workflow the pre-existing bug blocked.
    const reissuedInvoiceId = await seedMembershipInvoice(
      tenantA,
      user,
      memberId,
      'issued',
      2,
    );
    const cyclesRepo = makeDrizzleRenewalCycleRepo(tenantA.ctx);
    await expect(
      runInTenant(tenantA.ctx, (tx) =>
        cyclesRepo.linkInvoice(tx, tenantA.ctx.slug, asCycleId(cycleId), reissuedInvoiceId),
      ),
    ).resolves.toBeDefined();
    expect((await readCycle(cycleId)).linkedInvoiceId).toBe(reissuedInvoiceId);
  }, 60_000);

  it('UNWIRED caller (no seam) leaves the cycle link untouched — reissue still conflicts (documents the bug the seam fixes)', async () => {
    const memberId = await seedMember(tenantA);
    const invoiceId = await seedMembershipInvoice(tenantA, user, memberId, 'issued', 3);
    const cycleId = await seedCycle(tenantA, memberId, invoiceId, 'awaiting_payment');

    const r = await voidInvoice(makeDeps(tenantA.ctx.slug, { wireUnlink: false }), {
      tenantId: tenantA.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      voidReason: 'Void without the renewals seam',
    });
    expect(r.ok).toBe(true);

    // Unwired: the link is NOT cleared — behaves exactly as before Step 2.4.
    expect((await readCycle(cycleId)).linkedInvoiceId).toBe(invoiceId);

    // And a reissue with a NEW id conflicts (the guard sees the stale voided id).
    const reissuedInvoiceId = await seedMembershipInvoice(
      tenantA,
      user,
      memberId,
      'issued',
      4,
    );
    const cyclesRepo = makeDrizzleRenewalCycleRepo(tenantA.ctx);
    await expect(
      runInTenant(tenantA.ctx, (tx) =>
        cyclesRepo.linkInvoice(tx, tenantA.ctx.slug, asCycleId(cycleId), reissuedInvoiceId),
      ),
    ).rejects.toBeInstanceOf(InvoiceLinkConflictError);
  }, 60_000);

  it('voiding a PAID membership whose cycle is COMPLETED does NOT clear the link (CHECK-safe) and the void still succeeds', async () => {
    // 088 § F.3 edge path: voiding a PAID membership. Its cycle is `completed`,
    // and the completed-requires-invoice CHECK forbids a NULL linked_invoice_id.
    // The clear is guarded on the OPEN cycle statuses, so a completed cycle is a
    // no-op — the void must NOT roll back on a CHECK violation.
    const memberId = await seedMember(tenantA);
    const invoiceId = await seedMembershipInvoice(tenantA, user, memberId, 'paid', 5);
    const cycleId = await seedCycle(tenantA, memberId, invoiceId, 'completed');

    const r = await voidInvoice(makeDeps(tenantA.ctx.slug), {
      tenantId: tenantA.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      voidReason: 'Duplicate payment recorded',
    });

    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(!r.ok && r.error)}`).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('void');

    // Completed cycle keeps its link (clear was a no-op — status guard).
    const row = await readCycle(cycleId);
    expect(row.status).toBe('completed');
    expect(row.linkedInvoiceId).toBe(invoiceId);
  }, 60_000);

  it('clearLinkedInvoiceForVoidInTx: CAS on the expected invoice id — a wrong id clears nothing', async () => {
    const memberId = await seedMember(tenantA);
    const invoiceId = await seedMembershipInvoice(tenantA, user, memberId, 'issued', 6);
    const cycleId = await seedCycle(tenantA, memberId, invoiceId, 'awaiting_payment');

    const cyclesRepo = makeDrizzleRenewalCycleRepo(tenantA.ctx);
    const cleared = await runInTenant(tenantA.ctx, (tx) =>
      cyclesRepo.clearLinkedInvoiceForVoidInTx(
        tx,
        tenantA.ctx.slug,
        asCycleId(cycleId),
        randomUUID(), // a DIFFERENT invoice id than the linked one
      ),
    );
    expect(cleared).toBe(false);
    expect((await readCycle(cycleId)).linkedInvoiceId).toBe(invoiceId);
  }, 60_000);

  it('cross-tenant: tenant A cannot clear tenant B’s cycle link (RLS + explicit tenant predicate)', async () => {
    const memberB = await seedMember(tenantB);
    const invoiceB = await seedMembershipInvoice(tenantB, user, memberB, 'issued', 7);
    const cycleB = await seedCycle(tenantB, memberB, invoiceB, 'awaiting_payment');

    // Tenant A's repo, inside tenant A's runInTenant tx, tries to clear tenant
    // B's cycle. RLS (app.current_tenant=A) + the explicit tenant_id predicate
    // both refuse → 0 rows → false; tenant B's cycle is untouched.
    const repoA = makeDrizzleRenewalCycleRepo(tenantA.ctx);
    const cleared = await runInTenant(tenantA.ctx, (tx) =>
      repoA.clearLinkedInvoiceForVoidInTx(
        tx,
        tenantA.ctx.slug,
        asCycleId(cycleB),
        invoiceB,
      ),
    );
    expect(cleared).toBe(false);
    expect((await readCycle(cycleB)).linkedInvoiceId).toBe(invoiceB);
  }, 60_000);
});
