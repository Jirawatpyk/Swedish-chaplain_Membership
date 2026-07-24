/**
 * Production defect fix — `markPaidOffline` duplicate membership-bill guard.
 *
 * BEFORE this guard, `markPaidOffline` gated on renewal-cycle STATUS alone.
 * It never asked whether the member already had a live membership bill for
 * the plan year, then called `f4InvoiceBridge.issueAndMarkPaid(...)`, which
 * unconditionally creates + issues a FRESH invoice. So on the ordinary
 * post-`confirmRenewal` state (`awaiting_payment` + `linked_invoice_id` set,
 * i.e. a live §86/4 already exists), a treasurer clicking "Mark paid offline"
 * minted a SECOND numbered tax document for the same membership year.
 *
 * Neither `createInvoiceDraft` nor any DB constraint blocks this: the
 * `event` invoice subject got a partial unique index in migration 0201
 * (`invoices_event_registration_uniq`), but the `membership` subject never
 * got the analogous `(tenant_id, member_id, plan_year) WHERE
 * invoice_subject='membership' AND status <> 'void'`. The guard under test
 * is the application-layer stand-in for that missing invariant.
 *
 * Covers:
 *   - refusal when a live membership bill already exists for (member, plan
 *     year), INCLUDING the proof that the guard sits ABOVE the first write:
 *     the bridge is never invoked and the cycle is left untouched;
 *   - the legitimate path (no existing live bill) still completes;
 *   - a `void` bill does NOT block — an invoice voided for correction must
 *     stay re-issuable.
 *
 * Fixture note (deliberate, and the reason this lives in its own file):
 * the bridge mock INSERTS the invoice row at call time rather than
 * pre-seeding it in `beforeAll`. That mirrors production ordering — the real
 * bridge's `createInvoiceDraft` + `issueInvoice` commit in their OWN txs
 * before `onPaid` fires — so the guard, which runs before the bridge, sees
 * the same empty state it sees in production. A pre-seeded live bill would
 * instead reproduce the very state the guard is built to refuse.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { asSatang } from '@/lib/money';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { markPaidOffline, makeRenewalsDeps } from '@/modules/renewals';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

describe('F8 markPaidOffline — duplicate membership-bill guard', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;

  /**
   * §87 sequence numbers are unique per (tenant, fiscal_year), so every
   * seeded non-draft invoice needs its own. A module-level counter keeps
   * the tests independent of execution order.
   */
  let seq = 0;

  /**
   * Insert an F4 invoice row directly. `status` other than 'draft' trips the
   * `invoices_non_draft_has_snapshots` CHECK, so every snapshot column is
   * populated with the same minimum stubs the sibling F8 integration tests
   * use. `'void'` additionally trips `invoices_void_has_reason`, which
   * demands `voided_at` + `void_reason` + `voided_by_user_id` together.
   */
  async function seedInvoice(opts: {
    invoiceId: string;
    memberId: string;
    planYear: number;
    status: 'issued' | 'void';
  }): Promise<void> {
    seq += 1;
    const n = seq;
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId: opts.invoiceId,
        memberId: opts.memberId,
        planYear: opts.planYear,
        planId,
        status: opts.status,
        pdfDocKind: 'invoice',
        draftByUserId: user.userId,
        fiscalYear: 2026,
        sequenceNumber: n,
        documentNumber: `INV-2026-${String(n).padStart(6, '0')}`,
        issueDate: '2026-05-15',
        dueDate: '2026-06-14',
        currency: 'THB',
        subtotalSatang: asSatang(5_000_000n),
        vatRateSnapshot: '0.0700',
        vatSatang: asSatang(350_000n),
        totalSatang: asSatang(5_350_000n),
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: { legalNameEn: 'Test', taxId: '0' } as unknown,
        memberIdentitySnapshot: {
          companyName: 'Guard Co',
          country: 'TH',
          legal_name: 'Guard Co Ltd',
          address: '1 Guard Road, Bangkok 10110',
          primary_contact_name: 'Guard Contact',
          primary_contact_email: 'guard@example.com',
        } as unknown,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${opts.invoiceId}.pdf`,
        pdfSha256: 'c'.repeat(64),
        pdfTemplateVersion: 1,
        ...(opts.status === 'void'
          ? {
              voidedAt: new Date('2026-05-16T00:00:00Z'),
              voidReason: 'seeded void — corrected and re-issued',
              voidedByUserId: user.userId,
            }
          : {}),
      }),
    );
  }

  /**
   * A member plus an ANCHORED terminal predecessor cycle plus a payable
   * `awaiting_payment` cycle. The predecessor keeps the shared classifier off
   * its `first_payment` branch (which re-anchors instead of completing), so
   * these tests exercise the plain completion path.
   *
   * `periodFrom` 2026-06-01 → `deriveFiscalYear` 2026, which is the plan year
   * the guard queries on.
   */
  async function seedMemberWithPayableCycle(companyName: string): Promise<{
    memberId: string;
    cycleId: string;
  }> {
    const memberId = randomUUID();
    const cycleId = randomUUID();

    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName,
        country: 'TH',
        planId,
        planYear: 2026,
      }),
    );

    // Anchored terminal predecessor → member reads as "has settled history".
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: randomUUID(),
        memberId,
        status: 'cancelled',
        periodFrom: new Date('2025-06-01T00:00:00Z'),
        periodTo: new Date('2026-06-01T00:00:00Z'),
        expiresAt: new Date('2026-06-01T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: randomUUID(),
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        anchoredAt: new Date('2025-06-01T00:00:00Z'),
        closedAt: new Date(),
        closedReason: 'cancelled',
      }),
    );

    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'awaiting_payment',
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

    return { memberId, cycleId };
  }

  /**
   * Mock the F4 bridge the way the REAL bridge behaves: create + commit the
   * invoice in its own tx (steps 1+2 open their own `withTx`), then fire
   * `onPaid` on the caller's outer tx so the cycle flip rides the same atomic
   * boundary. Returns the spy plus the id it minted.
   */
  function mockBridgeCreatingInvoice(
    deps: ReturnType<typeof makeRenewalsDeps>,
    mintedInvoiceId: string,
  ) {
    const paidAt = new Date().toISOString();
    return vi
      .spyOn(deps.f4InvoiceBridge, 'issueAndMarkPaid')
      .mockImplementation(async (input) => {
        await seedInvoice({
          invoiceId: mintedInvoiceId,
          memberId: input.memberId,
          planYear: input.planYear,
          status: 'issued',
        });
        if (input.onPaid) {
          await input.onPaid({
            tenantId: input.tenantId,
            invoiceId: mintedInvoiceId,
            memberId: input.memberId,
            paidAt,
            amountSatang: asSatang(5_000_000n),
            vatSatang: asSatang(350_000n),
            currency: 'THB',
            paymentMethod: input.paymentMethod,
            triggeredBy: 'admin_offline_mark',
            invoiceSubject: 'membership',
            paymentDate: input.paymentDate,
          });
        }
        return {
          ok: true,
          value: {
            invoiceId: mintedInvoiceId,
            paidAt,
            emailDispatch: 'sent' as const,
          },
        };
      });
  }

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    planId = `f8-dup-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Duplicate-guard Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(invoices)
      .where(eq(invoices.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('refuses when a live membership bill already exists for (member, plan year) — and mints nothing', async () => {
    const { memberId, cycleId } = await seedMemberWithPayableCycle('Dup Co');
    // The ordinary post-`confirmRenewal` state: a live §86/4 for this plan
    // year already exists and the cycle points at it.
    const existingInvoiceId = randomUUID();
    await seedInvoice({
      invoiceId: existingInvoiceId,
      memberId,
      planYear: 2026,
      status: 'issued',
    });
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(renewalCycles)
        .set({ linkedInvoiceId: existingInvoiceId })
        .where(eq(renewalCycles.cycleId, cycleId)),
    );

    const deps = makeRenewalsDeps(tenant.ctx.slug);
    // Throwing stub, not a call-through: if the guard regresses, this fails
    // loudly instead of letting the REAL bridge mint a second §86/4 against
    // the dev database and corrupt the invoice-count assertion below.
    const bridgeSpy = vi
      .spyOn(deps.f4InvoiceBridge, 'issueAndMarkPaid')
      .mockImplementation(async () => {
        throw new Error(
          'f4InvoiceBridge.issueAndMarkPaid must NOT be reached — the duplicate-bill guard should have refused first',
        );
      });

    const r = await markPaidOffline(deps, {
      tenantId: tenant.ctx.slug,
      cycleId,
      paymentMethod: 'bank_transfer',
      paymentReference: 'BT-DUP-0001',
      paymentDate: '2026-05-15',
      actorUserId: user.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('membership_bill_already_exists');
      if (r.error.kind === 'membership_bill_already_exists') {
        expect(r.error.existingInvoiceId).toBe(existingInvoiceId);
        expect(r.error.existingStatus).toBe('issued');
      }
    }

    // The guard sits ABOVE the first write: the F4 chain is never entered,
    // so no second numbered document can exist.
    expect(bridgeSpy).not.toHaveBeenCalled();
    const allInvoices = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ invoiceId: invoices.invoiceId })
        .from(invoices)
        .where(
          and(
            eq(invoices.tenantId, tenant.ctx.slug),
            eq(invoices.memberId, memberId),
          ),
        ),
    );
    expect(allInvoices).toHaveLength(1);
    expect(allInvoices[0]?.invoiceId).toBe(existingInvoiceId);

    // `err(...)` inside `runInTenant` COMMITS the tx — assert the refusal
    // left no partial state behind.
    const cycleRows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(renewalCycles).where(eq(renewalCycles.cycleId, cycleId)),
    );
    expect(cycleRows[0]?.status).toBe('awaiting_payment');
    expect(cycleRows[0]?.closedReason).toBeNull();

    // …and emitted no completion audit.
    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'renewal_cycle_completed_offline' as never),
        ),
      );
    expect(audits).toHaveLength(0);

    bridgeSpy.mockRestore();
  }, 60_000);

  it('still completes when the member has NO existing live membership bill', async () => {
    const { memberId, cycleId } = await seedMemberWithPayableCycle('Clean Co');
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const mintedInvoiceId = randomUUID();
    const bridgeSpy = mockBridgeCreatingInvoice(deps, mintedInvoiceId);

    const r = await markPaidOffline(deps, {
      tenantId: tenant.ctx.slug,
      cycleId,
      paymentMethod: 'bank_transfer',
      paymentReference: 'BT-CLEAN-0001',
      paymentDate: '2026-05-15',
      actorUserId: user.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.outcome).toBe('completed');
    expect(r.value.invoiceId).toBe(mintedInvoiceId);
    expect(bridgeSpy).toHaveBeenCalledTimes(1);

    const cycleRows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(renewalCycles).where(eq(renewalCycles.cycleId, cycleId)),
    );
    expect(cycleRows[0]?.status).toBe('completed');
    expect(cycleRows[0]?.closedReason).toBe('completed_offline');
    expect(cycleRows[0]?.linkedInvoiceId).toBe(mintedInvoiceId);

    void memberId;
    bridgeSpy.mockRestore();
  }, 60_000);

  it('a VOID bill does NOT block — an invoice voided for correction stays re-issuable', async () => {
    const { memberId, cycleId } = await seedMemberWithPayableCycle('Void Co');
    // Voided for correction: must not fence the member out of re-issue.
    await seedInvoice({
      invoiceId: randomUUID(),
      memberId,
      planYear: 2026,
      status: 'void',
    });

    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const mintedInvoiceId = randomUUID();
    const bridgeSpy = mockBridgeCreatingInvoice(deps, mintedInvoiceId);

    const r = await markPaidOffline(deps, {
      tenantId: tenant.ctx.slug,
      cycleId,
      paymentMethod: 'cheque',
      paymentReference: 'CHQ-VOID-0001',
      paymentDate: '2026-05-15',
      actorUserId: user.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.invoiceId).toBe(mintedInvoiceId);
    expect(bridgeSpy).toHaveBeenCalledTimes(1);

    const cycleRows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(renewalCycles).where(eq(renewalCycles.cycleId, cycleId)),
    );
    expect(cycleRows[0]?.status).toBe('completed');

    bridgeSpy.mockRestore();
  }, 60_000);
});
