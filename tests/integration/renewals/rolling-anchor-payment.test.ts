/**
 * Rolling-anchor refactor (design 2026-07-08 rev 3, migration 0238) — Task 5
 * end-to-end resolution-hook integration test (live Neon).
 *
 * Drives the REAL `f8OnPaidCallbacks` array sequentially against a real
 * tenant tx, exactly mirroring F4's `recordPayment` callback loop
 * (`for (const cb of callbacks) await cb(evt, tx)`) — the same harness
 * precedent as `create-next-cycle-on-paid.test.ts`. Because the invoices
 * here are UNLINKED (no cycle's `linked_invoice_id` points at them),
 * callback[0]'s `no_cycle_for_invoice` branch delegates to
 * `resolveUnlinkedMembershipPaymentInTx` — the surface under test.
 *
 * Scenarios (per Task-5 brief step 4):
 *   1. First unlinked payment → provisional cycle RE-ANCHORED to the
 *      payment month (paymentDate wins) + `renewal_cycle_reanchored`
 *      audit row + NO next cycle (callback[2] interplay).
 *   2. Second unlinked payment → anchored cycle COMPLETED + gapless next
 *      cycle at periodTo (+ callback[2] no-op interplay).
 *   3. Re-fire of the same event → idempotent no-op (cycle count stable).
 *   4. Zero-cycle member → self-HEALED fresh anchored cycle.
 *   5. Cross-tenant probe (Constitution Principle I clause 3 —
 *      Review-Gate blocker).
 *
 * FK note (Task 4 discovery): `renewal_cycles_anchor_invoice_fk` requires
 * `anchor_invoice_id` to reference a REAL invoices row — every scenario
 * anchors to the actually-seeded issued invoice, as the production flows
 * do naturally via recordPayment.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { asSatang } from '@/lib/money';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { f8OnPaidCallbacks } from '@/modules/renewals';
import { makeRenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

describe('rolling-anchor unlinked-payment resolution — integration (Task 5)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let planIdA: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;
    planIdA = `f8-rollanchor-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenantA.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId: planIdA,
        planName: { en: 'Rolling Anchor Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
  }, 180_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      await db.delete(renewalCycles).where(eq(renewalCycles.tenantId, t.ctx.slug)).catch(() => {});
      await db.delete(invoices).where(eq(invoices.tenantId, t.ctx.slug)).catch(() => {});
      await db.delete(members).where(eq(members.tenantId, t.ctx.slug)).catch(() => {});
      await db.delete(auditLog).where(eq(auditLog.tenantId, t.ctx.slug)).catch(() => {});
      await t.cleanup().catch(() => {});
    }
  }, 120_000);

  async function seedMember(t: TestTenant, planId: string): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(t.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: t.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `RollAnchor Co ${memberId.slice(0, 6)}`,
        country: 'TH',
        planId,
        planYear: 2026,
      }),
    );
    return memberId;
  }

  async function seedIssuedInvoice(
    t: TestTenant,
    memberId: string,
    planId: string,
  ): Promise<string> {
    const invoiceId = randomUUID();
    await runInTenant(t.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: t.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId,
        status: 'issued',
        pdfDocKind: 'invoice',
        draftByUserId: user.userId,
        fiscalYear: 2026,
        sequenceNumber: Math.floor(Math.random() * 1_000_000) + 1,
        documentNumber: `INV-2026-${String(Math.floor(Math.random() * 900000) + 100000)}`,
        issueDate: '2026-08-01',
        dueDate: '2026-08-31',
        currency: 'THB',
        subtotalSatang: asSatang(5_000_000n),
        vatRateSnapshot: '0.0700',
        vatSatang: asSatang(350_000n),
        totalSatang: asSatang(5_350_000n),
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: { legalNameEn: 'Test', taxId: '0' } as unknown,
        memberIdentitySnapshot: {
          companyName: 'RollAnchor Co',
          country: 'TH',
          legal_name: 'RollAnchor Co Ltd',
          address: '1 Test Road, Bangkok 10110',
          primary_contact_name: 'Test Contact',
          primary_contact_email: 'rollanchor@example.com',
        } as unknown,
        pdfBlobKey: `invoicing/${t.ctx.slug}/2026/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      }),
    );
    return invoiceId;
  }

  /**
   * R2 residual (Task 5) — an already-PAID unlinked invoice, seeded
   * directly rather than driven through F4's real `recordPayment` (which
   * would need a full tenant-invoice-settings + sequence-allocator fixture
   * chain — the file-level docstring's precedent for this whole suite is
   * to fire the REAL `f8OnPaidCallbacks` array against a pre-committed
   * payment state, mirroring exactly what `recordPayment` leaves behind
   * in the DB by the time it invokes those same callbacks in its own tx).
   * Satisfies `invoices_paid_has_receipt_status` (paid ⇒ receipt_pdf_status
   * NOT NULL) + the paid⇒paid_at/payment_method CHECK.
   */
  async function seedPaidInvoice(
    t: TestTenant,
    memberId: string,
    planId: string,
  ): Promise<string> {
    const invoiceId = randomUUID();
    await runInTenant(t.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: t.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId,
        status: 'paid',
        pdfDocKind: 'invoice',
        receiptPdfStatus: 'rendered',
        draftByUserId: user.userId,
        fiscalYear: 2026,
        sequenceNumber: Math.floor(Math.random() * 1_000_000) + 1,
        documentNumber: `INV-2026-${String(Math.floor(Math.random() * 900000) + 100000)}`,
        issueDate: '2026-08-01',
        dueDate: '2026-08-31',
        currency: 'THB',
        subtotalSatang: asSatang(5_000_000n),
        vatRateSnapshot: '0.0700',
        vatSatang: asSatang(350_000n),
        totalSatang: asSatang(5_350_000n),
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: { legalNameEn: 'Test', taxId: '0' } as unknown,
        memberIdentitySnapshot: {
          companyName: 'RollAnchor Co',
          country: 'TH',
          legal_name: 'RollAnchor Co Ltd',
          address: '1 Test Road, Bangkok 10110',
          primary_contact_name: 'Test Contact',
          primary_contact_email: 'rollanchor@example.com',
        } as unknown,
        pdfBlobKey: `invoicing/${t.ctx.slug}/2026/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
        paymentMethod: 'bank_transfer',
        paymentReference: 'R2-TEST-PAY',
        paymentRecordedByUserId: user.userId,
        paymentDate: '2026-08-16',
        paidAt: new Date('2026-08-16T09:00:00.000Z'),
      }),
    );
    return invoiceId;
  }

  /**
   * Provisional un-anchored cycle — the shape onboarding creates at the
   * member's registration date (linked to NO invoice, anchoredAt NULL).
   */
  async function seedProvisionalCycle(
    t: TestTenant,
    memberId: string,
    planId: string,
  ): Promise<string> {
    const cycleId = randomUUID();
    await runInTenant(t.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: t.ctx.slug,
        cycleId,
        memberId,
        status: 'upcoming',
        periodFrom: new Date('2026-06-01T00:00:00Z'),
        periodTo: new Date('2027-06-01T00:00:00Z'),
        expiresAt: new Date('2027-06-01T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      }),
    );
    return cycleId;
  }

  /**
   * FIXED-ANCHOR comeback (2026-07-22) — a provisional first-payment cycle
   * whose period has ALREADY fully elapsed (2024-06 → 2025-06) by the time
   * the August-2026 payment lands. Still `upcoming` + never anchored, so it
   * classifies as `first_payment`, but keeping the dead 2024 period would
   * leave the payer paid-but-suspended. The comeback exception must re-anchor
   * it to the payment month instead (distinct from `seedProvisionalCycle`'s
   * still-live June-2026 period).
   */
  async function seedExpiredProvisionalCycle(
    t: TestTenant,
    memberId: string,
    planId: string,
  ): Promise<string> {
    const cycleId = randomUUID();
    await runInTenant(t.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: t.ctx.slug,
        cycleId,
        memberId,
        status: 'upcoming',
        periodFrom: new Date('2024-06-01T00:00:00Z'),
        periodTo: new Date('2025-06-01T00:00:00Z'),
        expiresAt: new Date('2025-06-01T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        anchoredAt: null,
      }),
    );
    return cycleId;
  }

  /**
   * F2 fix (final-review, 2026-07-09) — a TERMINATED cycle that was
   * cancelled WITHOUT ever being anchored to a real payment (the
   * genuinely-never-paid shape). Distinct from `seedProvisionalCycle`'s
   * still-open row — this one is already `cancelled` + `closed_at` set
   * (the `renewal_cycles_closed_at_iff_terminal_check` CHECK requires
   * `closed_at` for any terminal status).
   */
  async function seedCancelledCycle(
    t: TestTenant,
    memberId: string,
    planId: string,
  ): Promise<string> {
    const cycleId = randomUUID();
    await runInTenant(t.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: t.ctx.slug,
        cycleId,
        memberId,
        status: 'cancelled',
        periodFrom: new Date('2025-06-01T00:00:00Z'),
        periodTo: new Date('2026-06-01T00:00:00Z'),
        expiresAt: new Date('2026-06-01T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        anchoredAt: null,
        closedAt: new Date('2025-07-01T00:00:00Z'),
        closedReason: 'cancelled',
      }),
    );
    return cycleId;
  }

  function buildEvent(
    invoiceId: string,
    memberId: string,
    tenantSlug: string,
    paymentDate: string | null,
  ): F4InvoicePaidEvent {
    return {
      tenantId: tenantSlug,
      invoiceId,
      memberId,
      paidAt: '2026-08-16T09:00:00.000Z',
      amountSatang: asSatang(5_350_000n),
      vatSatang: asSatang(350_000n),
      currency: 'THB',
      paymentMethod: 'bank_transfer',
      triggeredBy: 'admin_manual',
      invoiceSubject: 'membership',
      paymentDate,
    };
  }

  /**
   * Replicate F4's record-payment callback loop verbatim: fire ALL
   * registered F8 callbacks sequentially against ONE threaded tx.
   */
  async function fireOnPaidChainInTx(
    t: TestTenant,
    invoiceId: string,
    memberId: string,
    paymentDate: string | null,
  ): Promise<void> {
    const callbacks = f8OnPaidCallbacks(t.ctx.slug);
    await runInTenant(t.ctx, async (tx) => {
      const evt = buildEvent(invoiceId, memberId, t.ctx.slug, paymentDate);
      for (const cb of callbacks) {
        await cb(evt, tx);
      }
    });
  }

  async function loadCycles(t: TestTenant, memberId: string) {
    return runInTenant(t.ctx, (tx) =>
      tx
        .select({
          cycleId: renewalCycles.cycleId,
          status: renewalCycles.status,
          periodFrom: renewalCycles.periodFrom,
          periodTo: renewalCycles.periodTo,
          anchoredAt: renewalCycles.anchoredAt,
          anchorInvoiceId: renewalCycles.anchorInvoiceId,
          linkedInvoiceId: renewalCycles.linkedInvoiceId,
          closedReason: renewalCycles.closedReason,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.memberId, memberId)),
    );
  }

  async function countAuditRows(t: TestTenant, eventType: string): Promise<number> {
    const rows = await runInTenant(t.ctx, (tx) =>
      tx
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, t.ctx.slug),
            // F8 event types trail the F1 pgEnum TS union (values added at DB
            // level via migrations) — established `as never` cast.
            eq(auditLog.eventType, eventType as never),
          ),
        ),
    );
    return rows.length;
  }

  /** R2 residual (Task 5) — locate a specific cycle's audit row payload by
   * `cycle_id`, so a scenario can assert on payload FIELDS (e.g.
   * `held_for_admin_review`) rather than just a row count. */
  async function findAuditPayloadForCycle(
    t: TestTenant,
    eventType: string,
    cycleId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const rows = await runInTenant(t.ctx, (tx) =>
      tx
        .select({ payload: auditLog.payload })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, t.ctx.slug),
            eq(auditLog.eventType, eventType as never),
          ),
        ),
    );
    return rows
      .map((r) => r.payload as Record<string, unknown>)
      .find((p) => p.cycle_id === cycleId);
  }

  it('full lifecycle: first unlinked payment RE-ANCHORS; second unlinked payment RENEWS (complete + gapless next); re-fire is a no-op', async () => {
    const memberId = await seedMember(tenantA, planIdA);
    const provisionalCycleId = await seedProvisionalCycle(tenantA, memberId, planIdA);
    const invoice1 = await seedIssuedInvoice(tenantA, memberId, planIdA);

    // ---- Scenario 1: first unlinked payment (paymentDate 2026-08-16 →
    // month-start anchor 2026-08-01, overriding paidAt).
    const reanchoredBefore = await countAuditRows(tenantA, 'renewal_cycle_reanchored');
    await fireOnPaidChainInTx(tenantA, invoice1, memberId, '2026-08-16');

    let cycles = await loadCycles(tenantA, memberId);
    // Exactly ONE cycle — re-anchored in place; callback[2] created no next
    // cycle (the interplay guard: invoice1 is anchor-referenced, not linked).
    expect(cycles).toHaveLength(1);
    const anchored = cycles[0]!;
    expect(anchored.cycleId).toBe(provisionalCycleId);
    expect(anchored.status).toBe('upcoming');
    // FIXED-ANCHOR (2026-07-22): period STAYS at the provisional registration
    // anchor (June) — it is NOT moved to the August payment month. Only
    // anchored_at (the "when activated" stamp) reflects the payment month.
    expect(anchored.periodFrom.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(anchored.periodTo.toISOString()).toBe('2027-06-01T00:00:00.000Z');
    expect(anchored.anchoredAt?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(anchored.anchorInvoiceId).toBe(invoice1);
    // linked_invoice_id stays free for the future renewal invoice.
    expect(anchored.linkedInvoiceId).toBeNull();

    // Audit row landed atomically in the same tx.
    const reanchoredAfter = await countAuditRows(tenantA, 'renewal_cycle_reanchored');
    expect(reanchoredAfter).toBe(reanchoredBefore + 1);

    // ---- Scenario 2: second unlinked payment → renewal (complete + next).
    const invoice2 = await seedIssuedInvoice(tenantA, memberId, planIdA);
    const completedBefore = await countAuditRows(tenantA, 'renewal_completed');
    await fireOnPaidChainInTx(tenantA, invoice2, memberId, '2027-08-05');

    cycles = await loadCycles(tenantA, memberId);
    expect(cycles).toHaveLength(2);
    const completed = cycles.find((c) => c.cycleId === provisionalCycleId)!;
    const next = cycles.find((c) => c.cycleId !== provisionalCycleId)!;
    expect(completed.status).toBe('completed');
    expect(completed.closedReason).toBe('paid');
    expect(completed.linkedInvoiceId).toBe(invoice2);
    // Gapless: next cycle anchors at the completed cycle's (unchanged, June-
    // anchored) periodTo — NOT the second payment's date (paying within grace
    // backdates; and fixed-anchor means the completed period never moved).
    expect(next.status).toBe('upcoming');
    expect(next.periodFrom.toISOString()).toBe('2027-06-01T00:00:00.000Z');
    expect(next.periodTo.toISOString()).toBe('2028-06-01T00:00:00.000Z');

    const completedAfter = await countAuditRows(tenantA, 'renewal_completed');
    expect(completedAfter).toBe(completedBefore + 1);

    // ---- Scenario 3: re-fire the SAME event (admin double-click / webhook
    // retry). Invoice2 is now linked → callback[0] resolves the completed
    // cycle → cycle_not_payable idempotent skip. No new cycles, no state move.
    await expect(
      fireOnPaidChainInTx(tenantA, invoice2, memberId, '2027-08-05'),
    ).resolves.toBeUndefined();
    cycles = await loadCycles(tenantA, memberId);
    expect(cycles).toHaveLength(2);
    expect(cycles.filter((c) => c.status === 'completed')).toHaveLength(1);
    expect(cycles.filter((c) => c.status === 'upcoming')).toHaveLength(1);
  }, 120_000);

  it('C1 regression (Task 6, LINKED path): confirm-renewal-style linked payment on a never-paid member RE-ANCHORS (not completes); a LATER linked renewal payment links + completes cleanly', async () => {
    const memberId = await seedMember(tenantA, planIdA);
    const cycleId = await seedProvisionalCycle(tenantA, memberId, planIdA); // upcoming, unanchored
    const invoice1 = await seedIssuedInvoice(tenantA, memberId, planIdA);

    // Mirror confirm-renewal's real pre-payment shape: the cycle
    // self-transitions upcoming→awaiting_payment, THEN the F4 invoice is
    // linked via `cyclesRepo.linkInvoice` (the T122 confirm-renewal call).
    await runInTenant(tenantA.ctx, (tx) =>
      tx
        .update(renewalCycles)
        .set({ status: 'awaiting_payment' })
        .where(eq(renewalCycles.cycleId, cycleId)),
    );
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    await runInTenant(tenantA.ctx, (tx) =>
      deps.cyclesRepo.linkInvoice(tx, tenantA.ctx.slug, asCycleId(cycleId), invoice1),
    );

    let cycles = await loadCycles(tenantA, memberId);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.status).toBe('awaiting_payment');
    expect(cycles[0]!.linkedInvoiceId).toBe(invoice1);
    expect(cycles[0]!.anchoredAt).toBeNull();

    const reanchoredBefore = await countAuditRows(tenantA, 'renewal_cycle_reanchored');
    const completedBefore = await countAuditRows(tenantA, 'renewal_completed');

    // Pay invoice1 via the REAL onPaid callback chain. This IS the LINKED
    // path — callback[0]'s `findByInvoiceIdInTx` finds the cycle directly
    // (the unlinked hook never fires).
    await fireOnPaidChainInTx(tenantA, invoice1, memberId, '2026-08-16');

    cycles = await loadCycles(tenantA, memberId);
    // Still exactly ONE cycle — re-anchored in place, NOT completed, and no
    // next cycle created (callback[2]'s `findByInvoiceIdInTx(invoice1)`
    // finds nothing once the reanchor clears `linked_invoice_id`).
    expect(cycles).toHaveLength(1);
    const reanchored = cycles[0]!;
    expect(reanchored.cycleId).toBe(cycleId);
    expect(reanchored.status).toBe('upcoming');
    // FIXED-ANCHOR: period stays June (registration), not the Aug payment month.
    expect(reanchored.periodFrom.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(reanchored.periodTo.toISOString()).toBe('2027-06-01T00:00:00.000Z');
    expect(reanchored.anchoredAt?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(reanchored.anchorInvoiceId).toBe(invoice1);
    // linked_invoice_id CLEARED by the guarded UPDATE — frees the slot so
    // the NEXT renewal invoice can link cleanly (spec §2 reanchorPeriodInTx).
    expect(reanchored.linkedInvoiceId).toBeNull();

    const reanchoredAfter = await countAuditRows(tenantA, 'renewal_cycle_reanchored');
    expect(reanchoredAfter).toBe(reanchoredBefore + 1);
    const completedAfterFirst = await countAuditRows(tenantA, 'renewal_completed');
    expect(completedAfterFirst).toBe(completedBefore);

    // ---- SECOND linked renewal payment (a year later, renewal season):
    // confirm-renewal links a NEW invoice to the SAME (now re-anchored,
    // still-open) cycle, then it gets paid → completes cleanly + gapless
    // next cycle. Proves the reanchor's cleared `linked_invoice_id` does
    // not leave the cycle unable to link again.
    const invoice2 = await seedIssuedInvoice(tenantA, memberId, planIdA);
    await runInTenant(tenantA.ctx, (tx) =>
      tx
        .update(renewalCycles)
        .set({ status: 'awaiting_payment' })
        .where(eq(renewalCycles.cycleId, cycleId)),
    );
    await runInTenant(tenantA.ctx, (tx) =>
      deps.cyclesRepo.linkInvoice(tx, tenantA.ctx.slug, asCycleId(cycleId), invoice2),
    );

    await fireOnPaidChainInTx(tenantA, invoice2, memberId, '2027-08-05');

    cycles = await loadCycles(tenantA, memberId);
    expect(cycles).toHaveLength(2);
    const completed = cycles.find((c) => c.cycleId === cycleId)!;
    const next = cycles.find((c) => c.cycleId !== cycleId)!;
    expect(completed.status).toBe('completed');
    expect(completed.closedReason).toBe('paid');
    expect(completed.linkedInvoiceId).toBe(invoice2);
    // Gapless from the activated cycle's (unchanged, June-anchored) periodTo —
    // fixed-anchor: the first payment did not move it to the Aug payment month.
    expect(next.status).toBe('upcoming');
    expect(next.periodFrom.toISOString()).toBe('2027-06-01T00:00:00.000Z');
    expect(next.periodTo.toISOString()).toBe('2028-06-01T00:00:00.000Z');

    const completedAfterSecond = await countAuditRows(tenantA, 'renewal_completed');
    expect(completedAfterSecond).toBe(completedBefore + 1);
    // No SECOND reanchor audit fired for the renewal payment.
    expect(await countAuditRows(tenantA, 'renewal_cycle_reanchored')).toBe(reanchoredAfter);
  }, 120_000);

  it('paidAt fallback: no paymentDate (Stripe rail) → anchor derives from paidAt converted to Bangkok month', async () => {
    const memberId = await seedMember(tenantA, planIdA);
    await seedProvisionalCycle(tenantA, memberId, planIdA);
    const invoiceId = await seedIssuedInvoice(tenantA, memberId, planIdA);

    // paidAt 2026-08-16T09:00Z (Bangkok 16:00 same day) → anchor 2026-08-01.
    await fireOnPaidChainInTx(tenantA, invoiceId, memberId, null);

    const cycles = await loadCycles(tenantA, memberId);
    expect(cycles).toHaveLength(1);
    // Fixed-anchor: period stays at the provisional June anchor. The paidAt
    // fallback governs only `anchored_at` (the activation stamp), which derives
    // from paidAt (2026-08-16 → Bangkok month-start 2026-08-01).
    expect(cycles[0]!.periodFrom.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(cycles[0]!.anchoredAt?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(cycles[0]!.anchorInvoiceId).toBe(invoiceId);
  }, 120_000);

  it('zero-cycle member: unlinked membership payment self-HEALS a fresh anchored cycle', async () => {
    const memberId = await seedMember(tenantA, planIdA);
    const invoiceId = await seedIssuedInvoice(tenantA, memberId, planIdA);

    const reanchoredBefore = await countAuditRows(tenantA, 'renewal_cycle_reanchored');
    await fireOnPaidChainInTx(tenantA, invoiceId, memberId, '2026-08-16');

    const cycles = await loadCycles(tenantA, memberId);
    expect(cycles).toHaveLength(1);
    const healed = cycles[0]!;
    expect(healed.status).toBe('upcoming');
    expect(healed.periodFrom.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(healed.periodTo.toISOString()).toBe('2027-08-01T00:00:00.000Z');
    expect(healed.anchoredAt?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(healed.anchorInvoiceId).toBe(invoiceId);
    expect(healed.linkedInvoiceId).toBeNull();

    // heal emits `renewal_cycle_reanchored` (old_period_* null) — plus the
    // shared createCycleInTx emits its own `renewal_cycle_created`.
    const reanchoredAfter = await countAuditRows(tenantA, 'renewal_cycle_reanchored');
    expect(reanchoredAfter).toBe(reanchoredBefore + 1);
  }, 120_000);

  // F2 fix (final-review, 2026-07-09) — closes a bug where a member whose
  // ONLY prior cycle was cancelled without ever anchoring (genuinely never
  // paid) had their comeback payment misclassified `renewal`: the raw
  // `countCyclesForMemberInTx` (which counts the cancelled row) was the
  // sole discriminator, so the payment COMPLETED the fresh provisional
  // cycle at its stale provisional period instead of re-anchoring to the
  // real payment month. `countSettledCyclesForMemberInTx` (completed OR
  // ever-anchored, excluding the open cycle) now correctly reports ZERO
  // settled history for this member, so the payment still RE-ANCHORS.
  it('cancelled-only-history member: predecessor cycle was cancelled WITHOUT ever anchoring → payment still RE-ANCHORS (not completes)', async () => {
    const memberId = await seedMember(tenantA, planIdA);
    await seedCancelledCycle(tenantA, memberId, planIdA);
    const provisionalCycleId = await seedProvisionalCycle(tenantA, memberId, planIdA);
    const invoiceId = await seedIssuedInvoice(tenantA, memberId, planIdA);

    await fireOnPaidChainInTx(tenantA, invoiceId, memberId, '2026-08-16');

    const cycles = await loadCycles(tenantA, memberId);
    // The cancelled predecessor + the re-anchored provisional cycle —
    // NOT a third (gapless-next) cycle, since a re-anchor never completes.
    expect(cycles).toHaveLength(2);
    const reanchored = cycles.find((c) => c.cycleId === provisionalCycleId)!;
    expect(reanchored.status).toBe('upcoming');
    // Fixed-anchor: period stays at the provisional June anchor, not payment month.
    expect(reanchored.periodFrom.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(reanchored.anchoredAt?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(reanchored.anchorInvoiceId).toBe(invoiceId);
    expect(reanchored.closedReason).toBeNull(); // never completed
  }, 120_000);

  it('FIXED-ANCHOR comeback: first payment on an EXPIRED provisional period RE-ANCHORS to the payment month (not the dead period)', async () => {
    const memberId = await seedMember(tenantA, planIdA);
    const expiredCycleId = await seedExpiredProvisionalCycle(tenantA, memberId, planIdA);
    const invoiceId = await seedIssuedInvoice(tenantA, memberId, planIdA);

    // Period 2024-06 → 2025-06 is fully elapsed by the August-2026 payment
    // (paymentDate 2026-08-16 → month-start anchor 2026-08-01). Keeping the
    // dead period would resolve to `suspended`; the comeback exception must
    // grant a FRESH 2026-08 → 2027-08 period instead. This is the ONE
    // legitimate payment-time anchor move on the first-payment path.
    await fireOnPaidChainInTx(tenantA, invoiceId, memberId, '2026-08-16');

    const cycles = await loadCycles(tenantA, memberId);
    expect(cycles).toHaveLength(1);
    const reanchored = cycles[0]!;
    expect(reanchored.cycleId).toBe(expiredCycleId);
    expect(reanchored.status).toBe('upcoming');
    // The dead 2024 period is REPLACED by a fresh payment-month period —
    // NOT kept (which fixed-anchor does for a still-LIVE period).
    expect(reanchored.periodFrom.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(reanchored.periodTo.toISOString()).toBe('2027-08-01T00:00:00.000Z');
    expect(reanchored.anchoredAt?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(reanchored.anchorInvoiceId).toBe(invoiceId);
    expect(reanchored.closedReason).toBeNull(); // never completed
  }, 120_000);

  it('R2(a) catalogue-gap heal skip: zero-cycle member on an inactive-only plan → PlanNotResolvableError caught, payment stands (paid), no cycle, no reanchor audit', async () => {
    // A plan with exactly ONE row, is_active=false — a "soft-deleted"
    // catalogue gap. `members_plan_tenant_year_fk` still requires the
    // member's OWN (plan_id, plan_year) to reference a real row, so the
    // member is seeded against this exact (inactive) row for plan_year
    // 2026 — the FK is satisfied. The gap is exposed by PAYING in a
    // DIFFERENT fiscal year: `loadPlanFrozenFields` (mode 'freeze') finds
    // no exact-year row for 2027, and its fallback "most-recent ACTIVE
    // row" query also comes up empty (the only row is is_active=false) →
    // `status: 'plan_inactive'` → `PlanNotResolvableError`.
    const gapPlanId = `f8-rollanchor-gap-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenantA.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId: gapPlanId,
        planName: { en: 'Catalogue Gap Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
        isActive: false,
      }),
    );
    const memberId = await seedMember(tenantA, gapPlanId); // zero cycles
    const invoiceId = await seedPaidInvoice(tenantA, memberId, gapPlanId);

    const reanchoredBefore = await countAuditRows(tenantA, 'renewal_cycle_reanchored');

    // `healNoCycle` catches `PlanNotResolvableError` and returns
    // skipped:plan_unresolvable — the chain must NOT throw (the payment
    // already stands independent of any specific plan resolution).
    await expect(
      fireOnPaidChainInTx(tenantA, invoiceId, memberId, '2027-08-16'),
    ).resolves.toBeUndefined();

    const cycles = await loadCycles(tenantA, memberId);
    expect(cycles).toHaveLength(0);

    const reanchoredAfter = await countAuditRows(tenantA, 'renewal_cycle_reanchored');
    expect(reanchoredAfter).toBe(reanchoredBefore);

    const invRows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({ status: invoices.status })
        .from(invoices)
        .where(eq(invoices.invoiceId, invoiceId)),
    );
    expect(invRows[0]?.status).toBe('paid');
  }, 120_000);

  it('R2(b) blocked-member hold: renewal-classified unlinked payment routes to pending_admin_reactivation, no auto-complete, no next cycle, payment stands', async () => {
    const memberId = await seedMember(tenantA, planIdA);
    await runInTenant(tenantA.ctx, (tx) =>
      tx
        .update(members)
        .set({
          blockedFromAutoReactivation: true,
          blockedFromAutoReactivationAt: new Date(),
          blockedFromAutoReactivationSetByUserId: user.userId,
          blockedFromAutoReactivationReason: 'integration-test-r2-blocked-hold',
        })
        .where(eq(members.memberId, memberId)),
    );

    // Completed predecessor cycle — cycleCountForMember=2, so the
    // classifier resolves 'renewal' (never 'first_payment', regardless of
    // the open cycle's anchoredAt — see classifyMembershipPayment).
    // `renewal_cycles_completed_requires_invoice_check` (+ composite FK
    // (tenant_id, linked_invoice_id) → invoices) means a completed cycle
    // MUST link a real prior invoice — seed a throwaway one for it.
    const predecessorInvoiceId = await seedPaidInvoice(tenantA, memberId, planIdA);
    const predecessorId = randomUUID();
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenantA.ctx.slug,
        cycleId: predecessorId,
        memberId,
        status: 'completed',
        periodFrom: new Date('2025-06-01T00:00:00Z'),
        periodTo: new Date('2026-06-01T00:00:00Z'),
        expiresAt: new Date('2026-06-01T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planIdA,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        anchoredAt: new Date('2025-06-01T00:00:00Z'),
        closedAt: new Date('2026-06-01T00:00:00Z'),
        closedReason: 'paid',
        linkedInvoiceId: predecessorInvoiceId,
      }),
    );
    // The open cycle this payment resolves — anchored + awaiting_payment
    // (the single-transition heldForAdminReview path).
    const openCycleId = randomUUID();
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenantA.ctx.slug,
        cycleId: openCycleId,
        memberId,
        status: 'awaiting_payment',
        periodFrom: new Date('2026-06-01T00:00:00Z'),
        periodTo: new Date('2027-06-01T00:00:00Z'),
        expiresAt: new Date('2027-06-01T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planIdA,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        anchoredAt: new Date('2025-06-01T00:00:00Z'),
      }),
    );

    const invoiceId = await seedPaidInvoice(tenantA, memberId, planIdA);
    const heldBefore = await countAuditRows(tenantA, 'renewal_completed_post_lapse');

    await expect(
      fireOnPaidChainInTx(tenantA, invoiceId, memberId, '2026-08-16'),
    ).resolves.toBeUndefined();

    const cycles = await loadCycles(tenantA, memberId);
    // Predecessor + the SAME open cycle — NO next cycle created (the
    // admin, not the auto-pipeline, decides what happens next).
    expect(cycles).toHaveLength(2);
    const held = cycles.find((c) => c.cycleId === openCycleId)!;
    expect(held.status).toBe('pending_admin_reactivation');
    expect(held.linkedInvoiceId).toBe(invoiceId);

    const heldAfter = await countAuditRows(tenantA, 'renewal_completed_post_lapse');
    expect(heldAfter).toBe(heldBefore + 1);
    const heldPayload = await findAuditPayloadForCycle(
      tenantA,
      'renewal_completed_post_lapse',
      openCycleId,
    );
    expect(heldPayload?.held_for_admin_review).toBe(true);
    expect(heldPayload?.invoice_id).toBe(invoiceId);

    const invRows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({ status: invoices.status })
        .from(invoices)
        .where(eq(invoices.invoiceId, invoiceId)),
    );
    expect(invRows[0]?.status).toBe('paid');
  }, 120_000);

  it('event-fee invoice: hook skips without touching renewal state', async () => {
    const memberId = await seedMember(tenantA, planIdA);
    const cycleId = await seedProvisionalCycle(tenantA, memberId, planIdA);
    const invoiceId = await seedIssuedInvoice(tenantA, memberId, planIdA);

    const callbacks = f8OnPaidCallbacks(tenantA.ctx.slug);
    await runInTenant(tenantA.ctx, async (tx) => {
      const evt: F4InvoicePaidEvent = {
        ...buildEvent(invoiceId, memberId, tenantA.ctx.slug, '2026-08-16'),
        invoiceSubject: 'event',
      };
      for (const cb of callbacks) {
        await cb(evt, tx);
      }
    });

    const cycles = await loadCycles(tenantA, memberId);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.cycleId).toBe(cycleId);
    expect(cycles[0]!.anchoredAt).toBeNull();
    expect(cycles[0]!.periodFrom.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  }, 120_000);

  it("cross-tenant probe: tenant A's unlinked-payment flow never anchors, completes, or creates a cycle in tenant B (Principle I)", async () => {
    // Tenant B: its own plan + member + untouched provisional cycle.
    const planIdB = `f8-rollanchor-b-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenantB.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenantB.ctx.slug,
        planId: planIdB,
        planName: { en: 'Tenant B Rolling Anchor Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
    const memberB = await seedMember(tenantB, planIdB);
    const cycleB = await seedProvisionalCycle(tenantB, memberB, planIdB);

    // Tenant A drives its full unlinked-payment flow.
    const memberA = await seedMember(tenantA, planIdA);
    await seedProvisionalCycle(tenantA, memberA, planIdA);
    const invoiceA = await seedIssuedInvoice(tenantA, memberA, planIdA);
    await fireOnPaidChainInTx(tenantA, invoiceA, memberA, '2026-08-16');

    // Tenant B's cycle set is byte-identical to what was seeded: still one
    // cycle, still un-anchored, period untouched.
    const cyclesB = await runInTenant(tenantB.ctx, (tx) =>
      tx
        .select({
          cycleId: renewalCycles.cycleId,
          status: renewalCycles.status,
          anchoredAt: renewalCycles.anchoredAt,
          periodFrom: renewalCycles.periodFrom,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.tenantId, tenantB.ctx.slug)),
    );
    expect(cyclesB).toHaveLength(1);
    expect(cyclesB[0]!.cycleId).toBe(cycleB);
    expect(cyclesB[0]!.status).toBe('upcoming');
    expect(cyclesB[0]!.anchoredAt).toBeNull();
    expect(cyclesB[0]!.periodFrom.toISOString()).toBe('2026-06-01T00:00:00.000Z');

    // And no `renewal_cycle_reanchored` audit row leaked into tenant B.
    expect(await countAuditRows(tenantB, 'renewal_cycle_reanchored')).toBe(0);
  }, 180_000);
});
