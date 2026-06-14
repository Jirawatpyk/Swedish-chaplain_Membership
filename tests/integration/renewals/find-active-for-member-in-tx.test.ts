/**
 * F8-completion Slice 1 · Task 1.1 — `findActiveForMemberInTx` in-tx
 * idempotency guard. Live Neon.
 *
 * The on-paid next-cycle-creation callback (Task 1.4) runs INSIDE the F4
 * record-payment tx, AFTER callback[0] has flipped the prior cycle
 * →completed but BEFORE that tx commits. The idempotency guard
 * ("does this member already have an active cycle?") must see the
 * uncommitted completion so the prior cycle is correctly excluded and
 * the NEXT cycle is created on the FIRST (non-retry) delivery.
 *
 * `findActiveForMember` (connection-fresh — opens its OWN runInTenant)
 * CANNOT see an uncommitted flip under READ COMMITTED. `findActiveForMemberInTx`
 * threads the caller's tx so the read participates in the surrounding
 * transaction.
 *
 * This test proves the difference:
 *   1. In ONE tx: insert active `upcoming` cycle → `findActiveForMemberInTx`
 *      returns it.
 *   2. Transition it to `completed` IN THE SAME TX → `findActiveForMemberInTx`
 *      returns null (sees the uncommitted flip).
 *   3. Sibling assertion: BEFORE that tx commits, the connection-fresh
 *      `findActiveForMember` (separate connection) still sees the cycle
 *      as active — documenting why the in-tx variant is load-bearing.
 *
 * Constitution Principle VIII (state↔audit atomicity) + Principle I
 * (RLS via runInTenant).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { makeRenewalsDeps } from '@/modules/renewals';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import { asSatang } from '@/lib/money';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('findActiveForMemberInTx — integration (Slice 1 / Task 1.1)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;

  async function seedMember(): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `InTx Co ${memberId.slice(0, 6)}`,
        country: 'TH',
        planId,
        planYear: 2026,
      }),
    );
    return memberId;
  }

  async function seedCycle(
    tx: unknown,
    memberId: string,
    status: 'upcoming' | 'awaiting_payment',
  ): Promise<string> {
    const cycleId = randomUUID();
    const expiresAt = new Date(Date.now() + 60 * MS_PER_DAY);
    await (tx as typeof db).insert(renewalCycles).values({
      tenantId: tenant.ctx.slug,
      cycleId,
      memberId,
      status,
      periodFrom: new Date(expiresAt.getTime() - 365 * MS_PER_DAY),
      periodTo: expiresAt,
      expiresAt,
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular',
      planIdAtCycleStart: planId,
      frozenPlanPriceThb: '50000.00',
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB',
    });
    return cycleId;
  }

  /**
   * Seed an `issued` invoice for the member so a cycle's `→completed`
   * transition (which carries linked_invoice_id NOT NULL via the
   * completed-requires-invoice CHECK) resolves the FK. Mirrors
   * transition-status-enforcement.test.ts.
   */
  async function seedIssuedInvoice(memberId: string): Promise<string> {
    const invoiceId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
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
        issueDate: '2026-05-15',
        dueDate: '2026-06-14',
        currency: 'THB',
        subtotalSatang: asSatang(5_000_000n),
        vatRateSnapshot: '0.0700',
        vatSatang: asSatang(350_000n),
        totalSatang: asSatang(5_350_000n),
        proRatePolicySnapshot: 'whole_year',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: { legalNameEn: 'Test', taxId: '0' } as unknown,
        memberIdentitySnapshot: {
          companyName: 'InTx Co',
          country: 'TH',
          legal_name: 'InTx Co Ltd',
          address: '1 Test Road, Bangkok 10110',
          primary_contact_name: 'Test Contact',
          primary_contact_email: 'intx@example.com',
        } as unknown,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      }),
    );
    return invoiceId;
  }

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    planId = `f8-intx-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'InTx Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
  }, 180_000);

  afterAll(async () => {
    await db.delete(renewalCycles).where(eq(renewalCycles.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 60_000);

  it('returns the active cycle, then null after an in-tx →completed flip (sees the uncommitted completion)', async () => {
    const memberId = await seedMember();
    const invoiceId = await seedIssuedInvoice(memberId);
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    await runInTenant(tenant.ctx, async (tx) => {
      const cycleId = await seedCycle(tx, memberId, 'awaiting_payment');

      // (1) before the flip — the active cycle is visible in-tx.
      const before = await deps.cyclesRepo.findActiveForMemberInTx(
        tx,
        tenant.ctx.slug,
        memberId,
      );
      expect(before).not.toBeNull();
      expect(before?.cycleId).toBe(cycleId);

      // Flip it to completed IN THE SAME TX (uncommitted).
      await deps.cyclesRepo.transitionStatus(
        tx,
        tenant.ctx.slug,
        asCycleId(cycleId),
        {
          from: 'awaiting_payment',
          to: 'completed',
          closedAt: new Date().toISOString(),
          closedReason: 'paid',
          linkedInvoiceId: invoiceId,
        },
      );

      // (2) after the in-tx flip — the in-tx guard sees the uncommitted
      // completion → the member has NO active cycle.
      const after = await deps.cyclesRepo.findActiveForMemberInTx(
        tx,
        tenant.ctx.slug,
        memberId,
      );
      expect(after).toBeNull();
    });
  });

  it('connection-fresh findActiveForMember CANNOT see an uncommitted in-tx flip (documents why the in-tx variant exists)', async () => {
    const memberId = await seedMember();
    const invoiceId = await seedIssuedInvoice(memberId);
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    // Commit ONE active cycle in its own tx so the connection-fresh read
    // has a committed row to (fail to) see the flip of.
    let committedCycleId = '';
    await runInTenant(tenant.ctx, async (tx) => {
      committedCycleId = await seedCycle(tx, memberId, 'awaiting_payment');
    });

    await runInTenant(tenant.ctx, async (tx) => {
      // Flip the committed cycle →completed inside THIS uncommitted tx.
      await deps.cyclesRepo.transitionStatus(
        tx,
        tenant.ctx.slug,
        asCycleId(committedCycleId),
        {
          from: 'awaiting_payment',
          to: 'completed',
          closedAt: new Date().toISOString(),
          closedReason: 'paid',
          linkedInvoiceId: invoiceId,
        },
      );

      // The in-tx guard sees the uncommitted flip → null.
      const inTx = await deps.cyclesRepo.findActiveForMemberInTx(
        tx,
        tenant.ctx.slug,
        memberId,
      );
      expect(inTx).toBeNull();

      // The connection-fresh variant opens its OWN connection (READ
      // COMMITTED) → it CANNOT see this tx's uncommitted flip → it still
      // reports the cycle as active. This is exactly the trap Task 1.4
      // must avoid by threading the F4 tx.
      const fresh = await deps.cyclesRepo.findActiveForMember(
        tenant.ctx.slug,
        memberId,
      );
      expect(fresh).not.toBeNull();
      expect(fresh?.cycleId).toBe(committedCycleId);
    });
  });
});
