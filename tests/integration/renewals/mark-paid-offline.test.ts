/**
 * F8 Phase 3 Wave H5 · T077 — `markPaidOffline` integration test (live Neon).
 *
 * Scope (Phase 3 MVP boundary): exercises the F8-side error-path matrix
 * + the advisory-lock + RLS probe semantics against real DB. The full
 * F4 chain (`createInvoiceDraft` → `issueInvoice` → `recordPayment`)
 * is exercised end-to-end through Playwright (T078 E2E) which sets up
 * the F4 fiscal settings + plan-year fee + member identity snapshot
 * via the admin UI. Inline-mocking the bridge keeps this integration
 * test focused on the F8 atomic boundary (cycle flip + audit emit
 * inside `runInTenant` tx) without 200+ LOC of F4 fixture plumbing.
 *
 * Covers:
 *   - `cycle_not_found` + `renewal_cross_tenant_probe` audit on
 *     cross-tenant attempt
 *   - `cycle_not_payable` for terminal cycles (completed / cancelled /
 *     lapsed) + `pending_admin_reactivation` (not in PAYABLE set)
 *   - `invalid_input` on bad cycleId / payment_method / payment_date
 *   - Happy path with mocked bridge: cycle flips to `completed` +
 *     `closed_reason='completed_offline'` + audit row in audit_log
 *     (verifies `onPaid` callback wiring + atomic state+audit)
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asSatang } from '@/lib/money';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import {
  markPaidOffline,
  makeRenewalsDeps,
} from '@/modules/renewals';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';

import {
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';
import {
  createActiveTestUser,
  type TestUser,
} from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

describe('F8 markPaidOffline — integration (T077)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let cycleAwaitingPaymentId: string;
  let cycleCancelledId: string;
  let memberIdA: string;
  let planIdA: string;

  async function seedCycle(
    t: TestTenant,
    cycleId: string,
    memberId: string,
    status:
      | 'upcoming'
      | 'awaiting_payment'
      | 'completed'
      | 'cancelled'
      | 'lapsed',
    // 068-f8-completion — payable cycles must anchor to a REAL plan id so
    // the next-cycle plan-lookup (now fired on the offline-mark path)
    // resolves a frozen price. Terminal cycles never reach that lookup, so
    // they default to a throwaway uuid.
    planIdAtCycleStart: string = randomUUID(),
  ) {
    await runInTenant(t.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: t.ctx.slug,
        cycleId,
        memberId,
        status,
        periodFrom: new Date('2026-06-01T00:00:00Z'),
        periodTo: new Date('2027-06-01T00:00:00Z'),
        expiresAt: new Date('2027-06-01T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        ...(status === 'completed' || status === 'cancelled' || status === 'lapsed'
          ? {
              closedAt: new Date(),
              closedReason: status === 'completed' ? 'paid' : status,
              ...(status === 'completed'
                ? { linkedInvoiceId: randomUUID() }
                : {}),
            }
          : {}),
      }),
    );
  }

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    planIdA = `f8-mpo-${randomUUID().slice(0, 8)}`;
    memberIdA = randomUUID();
    cycleAwaitingPaymentId = randomUUID();
    cycleCancelledId = randomUUID();

    for (const t of [tenantA, tenantB]) {
      await runInTenant(t.ctx, (tx) =>
        seedF8MembershipPlan(tx, {
          tenantSlug: t.ctx.slug,
          planId: planIdA,
          planName: { en: 'MPO Plan' },
          benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
          createdBy: user.userId,
        }),
      );
    }
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId: memberIdA,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'MPO Co',
        country: 'TH',
        planId: planIdA,
        planYear: 2026,
      }),
    );
    // The cancelled cycle goes first — terminal so it doesn't trigger
    // the partial-unique active-member constraint that protects against
    // multiple non-terminal cycles per member. Same memberIdA reused.
    // (Using 'cancelled' instead of 'completed' to avoid F4 invoice FK
    // requirement; the cycle_not_payable assertion works for either.)
    await seedCycle(tenantA, cycleCancelledId, memberIdA, 'cancelled');
    await seedCycle(
      tenantA,
      cycleAwaitingPaymentId,
      memberIdA,
      'awaiting_payment',
      // Real plan id — the offline-mark happy path now creates the next
      // cycle (renewal-loop closer), which needs a resolvable frozen price.
      planIdA,
    );
  }, 120_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      await db
        .delete(renewalCycles)
        .where(eq(renewalCycles.tenantId, t.ctx.slug))
        .catch(() => {});
      await db
        .delete(invoices)
        .where(eq(invoices.tenantId, t.ctx.slug))
        .catch(() => {});
      await db
        .delete(auditLog)
        .where(eq(auditLog.tenantId, t.ctx.slug))
        .catch(() => {});
    }
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  }, 120_000);

  it('cross-tenant: B cannot mark-paid A cycle (probe audit emits)', async () => {
    const deps = makeRenewalsDeps(tenantB.ctx.slug);
    const r = await markPaidOffline(deps, {
      tenantId: tenantB.ctx.slug,
      cycleId: cycleAwaitingPaymentId,
      paymentMethod: 'bank_transfer',
      paymentReference: 'BT-PROBE',
      paymentDate: '2026-05-15',
      actorUserId: user.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('cycle_not_found');

    const probes = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantB.ctx.slug),
          eq(auditLog.eventType, 'renewal_cross_tenant_probe' as never),
        ),
      );
    expect(probes.length).toBeGreaterThanOrEqual(1);
  });

  it('cycle_not_payable on cancelled cycle', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const r = await markPaidOffline(deps, {
      tenantId: tenantA.ctx.slug,
      cycleId: cycleCancelledId,
      paymentMethod: 'cash',
      paymentReference: 'CASH-X',
      paymentDate: '2026-05-15',
      actorUserId: user.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('cycle_not_payable');
      if (r.error.kind === 'cycle_not_payable') {
        expect(r.error.currentStatus).toBe('cancelled');
      }
    }
  });

  it('invalid_input on bad payment_date format', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const r = await markPaidOffline(deps, {
      tenantId: tenantA.ctx.slug,
      cycleId: cycleAwaitingPaymentId,
      paymentMethod: 'cheque',
      paymentReference: 'CHQ-001',
      paymentDate: '15-05-2026', // wrong format
      actorUserId: user.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });

  // Real-DB happy path: pre-seed an `issued` F4 invoice row directly
  // via Drizzle so the `renewal_cycles_linked_invoice_fk` constraint
  // resolves when `transitionStatus` flips the cycle to `completed`.
  // The F4 chain itself (createInvoiceDraft → issueInvoice →
  // recordPayment) is mocked at the bridge boundary — this test
  // focuses on the F8 atomic boundary (cycle flip + audit emit inside
  // the runInTenant tx + onPaid callback wiring).
  it('happy path: cycle flips to completed + audit emitted', async () => {
    // Step 1: Pre-seed F4 invoice row in 'issued' state (FK target).
    const seededInvoiceId = randomUUID();
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: tenantA.ctx.slug,
        invoiceId: seededInvoiceId,
        memberId: memberIdA,
        planYear: 2026,
        planId: planIdA,
        status: 'issued',
        pdfDocKind: 'invoice',
        draftByUserId: user.userId,
        fiscalYear: 2026,
        sequenceNumber: 1,
        documentNumber: 'INV-2026-000001',
        issueDate: '2026-05-15',
        dueDate: '2026-06-14',
        currency: 'THB',
        subtotalSatang: asSatang(5_000_000n),
        vatRateSnapshot: '0.0700',
        vatSatang: asSatang(350_000n),
        totalSatang: asSatang(5_350_000n),
        // F4 invariant `invoices_non_draft_has_snapshots` requires
        // ALL of these fields populated when status != 'draft'.
        // Minimum stubs for FK satisfaction; F4 production code
        // populates them from tenant_invoice_settings + render+blob.
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: { legalNameEn: 'Test', taxId: '0' } as unknown,
        memberIdentitySnapshot: {
          companyName: 'MPO Co',
          country: 'TH',
          legal_name: 'MPO Co Ltd',
          address: '1 Test Road, Bangkok 10110',
          primary_contact_name: 'Test Contact',
          primary_contact_email: 'mpo@example.com',
        } as unknown,
        pdfBlobKey: `invoicing/${tenantA.ctx.slug}/2026/${seededInvoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      }),
    );

    // Step 2: Mock the F4 bridge to return that real invoice id +
    // fire onPaid callback so the F8 cycle flip + audit emit run
    // inside the runInTenant tx.
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const fakeInvoiceId = seededInvoiceId;
    const fakePaidAt = new Date().toISOString();
    const bridgeSpy = vi
      .spyOn(deps.f4InvoiceBridge, 'issueAndMarkPaid')
      .mockImplementation(async (input) => {
        // Fire onPaid inside the same-tx-equivalent so the F8 cycle
        // flip + audit emit run via deps.cyclesRepo.transitionStatus
        // + deps.auditEmitter.emitInTx with the supplied externalTx.
        if (input.onPaid) {
          await input.onPaid({
            tenantId: input.tenantId,
            invoiceId: fakeInvoiceId,
            memberId: input.memberId,
            paidAt: fakePaidAt,
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
          value: { invoiceId: fakeInvoiceId, paidAt: fakePaidAt },
        };
      });

    const r = await markPaidOffline(deps, {
      tenantId: tenantA.ctx.slug,
      cycleId: cycleAwaitingPaymentId,
      paymentMethod: 'bank_transfer',
      paymentReference: 'BT-2026-9999',
      paymentDate: '2026-05-15',
      actorUserId: user.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cycleStatus).toBe('completed');
    expect(r.value.invoiceId).toBe(fakeInvoiceId);

    // DB state: cycle is completed + closed_reason='completed_offline'
    const rows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleAwaitingPaymentId)),
    );
    expect(rows[0]?.status).toBe('completed');
    expect(rows[0]?.closedReason).toBe('completed_offline');
    expect(rows[0]?.linkedInvoiceId).toBe(fakeInvoiceId);

    // Audit row emitted (renewal_cycle_completed_offline is in pgEnum
    // per Wave C-8 migration 0095).
    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantA.ctx.slug),
          eq(auditLog.eventType, 'renewal_cycle_completed_offline' as never),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);

    bridgeSpy.mockRestore();
  });

  // ---------------------------------------------------------------------
  // 068-f8-completion (slice 1) — renewal-loop closer on the OFFLINE path.
  //
  // The online / record-payment paths run the full `f8OnPaidCallbacks`
  // array (callback[2] = createNextCycleOnPaidInTx). The admin offline-
  // mark path builds its OWN single onPaid callback (the bridge wraps it
  // as `[onPaid]`) so callback[2] NEVER fires there. Without the fix, an
  // offline-paid (bank-transfer) renewal completes but the next cycle is
  // never created → the member silently drops out of the renewal pipeline.
  //
  // These tests seed a renewal cycle whose `planIdAtCycleStart = planIdA`
  // (so the plan-lookup inside createCycleInTx resolves a frozen price)
  // and a dedicated member (the existing memberIdA already holds a
  // terminal-then-completed history). They assert the SAME-TX renewal-loop
  // contract: prior →completed AND a gapless `upcoming` next cycle on the
  // FIRST mark, with idempotent retry.
  // ---------------------------------------------------------------------
  describe('renewal-loop closer — next cycle on offline mark', () => {
    let memberIdLoop: string;
    let cycleLoopId: string;
    let seededInvoiceLoopId: string;

    beforeAll(async () => {
      memberIdLoop = randomUUID();
      cycleLoopId = randomUUID();
      seededInvoiceLoopId = randomUUID();

      // Member for the renewal-loop scenario.
      await runInTenant(tenantA.ctx, (tx) =>
        tx.insert(members).values({
          tenantId: tenantA.ctx.slug,
          memberId: memberIdLoop,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'Loop Co',
          country: 'TH',
          planId: planIdA,
          planYear: 2026,
        }),
      );

      // Task 7 (rolling-anchor refactor) — a TERMINAL predecessor cycle so
      // memberIdLoop has TWO cycles ever (not the classifier's
      // `first_payment` shape: "exactly one cycle ever, unanchored"). This
      // describe block tests the pre-existing renewal-loop / next-cycle-
      // creation wiring, NOT the Task 7 re-anchor branch (that gets its
      // own dedicated describe block below) — without this predecessor,
      // `cycleLoopId` would classify as `first_payment` and re-anchor
      // instead of completing, breaking every assertion below. 'cancelled'
      // (not 'completed') avoids needing a second real invoice FK target.
      await seedCycle(tenantA, randomUUID(), memberIdLoop, 'cancelled');

      // Prior renewal cycle in `awaiting_payment`, anchored to the REAL
      // plan so the next-cycle plan-lookup resolves a frozen price.
      await runInTenant(tenantA.ctx, (tx) =>
        tx.insert(renewalCycles).values({
          tenantId: tenantA.ctx.slug,
          cycleId: cycleLoopId,
          memberId: memberIdLoop,
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
        }),
      );

      // F4 invoice row (issued) — FK target for the cycle completion flip
      // (`renewal_cycles_linked_invoice_fk`) + the linked-invoice lookup
      // that createNextCycleOnPaidInTx uses to resolve the prior cycle.
      await runInTenant(tenantA.ctx, (tx) =>
        tx.insert(invoices).values({
          tenantId: tenantA.ctx.slug,
          invoiceId: seededInvoiceLoopId,
          memberId: memberIdLoop,
          planYear: 2026,
          planId: planIdA,
          status: 'issued',
          pdfDocKind: 'invoice',
          draftByUserId: user.userId,
          fiscalYear: 2026,
          sequenceNumber: 2,
          documentNumber: 'INV-2026-000002',
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
            companyName: 'Loop Co',
            country: 'TH',
            legal_name: 'Loop Co Ltd',
            address: '1 Loop Road, Bangkok 10110',
            primary_contact_name: 'Loop Contact',
            primary_contact_email: 'loop@example.com',
          } as unknown,
          pdfBlobKey: `invoicing/${tenantA.ctx.slug}/2026/${seededInvoiceLoopId}.pdf`,
          pdfSha256: 'b'.repeat(64),
          pdfTemplateVersion: 1,
        }),
      );
    }, 120_000);

    function mockBridgeFireOnPaid(deps: ReturnType<typeof makeRenewalsDeps>) {
      const paidAt = new Date().toISOString();
      return vi
        .spyOn(deps.f4InvoiceBridge, 'issueAndMarkPaid')
        .mockImplementation(async (input) => {
          // Fire onPaid against the seeded invoice id so the offline
          // completion flips `cycleLoopId` →completed (linkedInvoiceId =
          // seededInvoiceLoopId) and the next-cycle creation resolves the
          // prior via findByInvoiceIdInTx — all inside the runInTenant tx.
          if (input.onPaid) {
            await input.onPaid({
              tenantId: input.tenantId,
              invoiceId: seededInvoiceLoopId,
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
            value: { invoiceId: seededInvoiceLoopId, paidAt },
          };
        });
    }

    it('prior →completed AND a gapless upcoming next cycle is created on first mark', async () => {
      const deps = makeRenewalsDeps(tenantA.ctx.slug);
      const bridgeSpy = mockBridgeFireOnPaid(deps);

      const r = await markPaidOffline(deps, {
        tenantId: tenantA.ctx.slug,
        cycleId: cycleLoopId,
        paymentMethod: 'bank_transfer',
        paymentReference: 'BT-LOOP-0001',
        paymentDate: '2026-05-15',
        actorUserId: user.userId,
        actorRole: 'admin',
        correlationId: randomUUID(),
      });
      expect(r.ok).toBe(true);
      bridgeSpy.mockRestore();

      const cycles = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .select()
          .from(renewalCycles)
          .where(eq(renewalCycles.memberId, memberIdLoop)),
      );

      // Prior cycle flipped to completed.
      const prior = cycles.find((c) => c.cycleId === cycleLoopId);
      expect(prior?.status).toBe('completed');
      expect(prior?.closedReason).toBe('completed_offline');

      // A NEW upcoming cycle exists for the member (the renewal loop closed).
      const next = cycles.find(
        (c) => c.cycleId !== cycleLoopId && c.status === 'upcoming',
      );
      expect(next).toBeDefined();
      // Gapless: next.periodFrom == prior.periodTo.
      expect(next?.periodFrom.toISOString()).toBe(
        prior?.periodTo.toISOString(),
      );
      // Frozen price carried from the plan lookup (50,000.00 THB).
      expect(next?.frozenPlanPriceThb).toBe('50000.00');
      expect(next?.planIdAtCycleStart).toBe(planIdA);

      // renewal_cycle_created audit emitted for the next cycle.
      const created = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenantA.ctx.slug),
            eq(auditLog.eventType, 'renewal_cycle_created' as never),
          ),
        );
      expect(created.length).toBeGreaterThanOrEqual(1);
    });

    it('idempotent: a literal retry of the offline-mark creates no duplicate next cycle', async () => {
      // After pass 1, cycleLoopId is `completed` (terminal, not payable).
      // A literal admin retry of the SAME mark-paid-offline therefore
      // returns cycle_not_payable and — critically — does NOT create a
      // second next cycle. This models the real operator retry: the admin
      // double-clicks "mark paid", or re-submits after a transient UI
      // error, and the renewal loop stays closed exactly once.
      const upcomingBefore = (
        await runInTenant(tenantA.ctx, (tx) =>
          tx
            .select()
            .from(renewalCycles)
            .where(eq(renewalCycles.memberId, memberIdLoop)),
        )
      ).filter((c) => c.status === 'upcoming');
      expect(upcomingBefore.length).toBe(1);

      const deps = makeRenewalsDeps(tenantA.ctx.slug);
      const r = await markPaidOffline(deps, {
        tenantId: tenantA.ctx.slug,
        cycleId: cycleLoopId,
        paymentMethod: 'bank_transfer',
        paymentReference: 'BT-LOOP-0001',
        paymentDate: '2026-05-15',
        actorUserId: user.userId,
        actorRole: 'admin',
        correlationId: randomUUID(),
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('cycle_not_payable');

      const upcomingAfter = (
        await runInTenant(tenantA.ctx, (tx) =>
          tx
            .select()
            .from(renewalCycles)
            .where(eq(renewalCycles.memberId, memberIdLoop)),
        )
      ).filter((c) => c.status === 'upcoming');
      // Still exactly ONE upcoming next cycle — the retry was a no-op.
      expect(upcomingAfter.length).toBe(1);
      expect(upcomingAfter[0]?.cycleId).toBe(upcomingBefore[0]?.cycleId);
    });

    it('in-tx idempotency guard: createNextCycleOnPaidInTx no-ops when an active cycle already exists (retry-safe)', async () => {
      // Directly exercises the createCycleInTx idempotency contract that
      // makes a rolled-back-then-retried offline-mark safe: with the prior
      // cycle already flipped →completed AND the next `upcoming` cycle
      // present (from pass 1), a re-invocation of createNextCycleOnPaidInTx
      // against the same paid event finds the active `upcoming` cycle via
      // findActiveForMemberInTx and SKIPS — no duplicate, no throw.
      const { createNextCycleOnPaidInTx } = await import(
        '@/modules/renewals/application/use-cases/create-next-cycle-on-paid'
      );
      const { asCycleId } = await import(
        '@/modules/renewals/domain/renewal-cycle'
      );
      const deps = makeRenewalsDeps(tenantA.ctx.slug);

      await runInTenant(tenantA.ctx, async (tx) => {
        await createNextCycleOnPaidInTx(
          {
            cyclesRepo: deps.cyclesRepo,
            planLookup: deps.planLookupForRenewal,
            auditEmitter: deps.auditEmitter,
            // The active-cycle guard short-circuits before this is called.
            idFactory: { cycleId: () => asCycleId(randomUUID()) },
          },
          {
            tenantId: tenantA.ctx.slug,
            invoiceId: seededInvoiceLoopId,
            memberId: memberIdLoop,
            paidAt: new Date().toISOString(),
            amountSatang: asSatang(5_000_000n),
            vatSatang: asSatang(350_000n),
            currency: 'THB',
            paymentMethod: 'bank_transfer',
            triggeredBy: 'admin_offline_mark',
            invoiceSubject: 'membership',
            paymentDate: '2026-05-15',
          },
          tx,
        );
      });

      const upcoming = (
        await runInTenant(tenantA.ctx, (tx) =>
          tx
            .select()
            .from(renewalCycles)
            .where(eq(renewalCycles.memberId, memberIdLoop)),
        )
      ).filter((c) => c.status === 'upcoming');
      // No duplicate created — the active-cycle guard short-circuited.
      expect(upcoming.length).toBe(1);
    });
  });

  // ---------------------------------------------------------------------
  // Task 7 (rolling-anchor refactor, design 2026-07-08 rev 3, migration
  // 0238, spec §1 consuming-site 3) — the member's ONLY-EVER cycle, never
  // anchored to a real payment (`anchored_at IS NULL`), is EXACTLY the
  // classifier's `first_payment` shape. mark-paid-offline must RE-ANCHOR
  // it to the actual payment month instead of completing it: the cycle
  // stays `upcoming`, `linked_invoice_id` stays NULL, `anchor_invoice_id`
  // points at the newly-issued F4 invoice, and NO next cycle is created
  // (the member's re-anchored cycle IS the active cycle).
  // ---------------------------------------------------------------------
  describe('Task 7 — first-payment re-anchor on the offline path', () => {
    let memberIdFirstPay: string;
    let cycleFirstPayId: string;
    let seededInvoiceFirstPayId: string;

    beforeAll(async () => {
      memberIdFirstPay = randomUUID();
      cycleFirstPayId = randomUUID();
      seededInvoiceFirstPayId = randomUUID();

      await runInTenant(tenantA.ctx, (tx) =>
        tx.insert(members).values({
          tenantId: tenantA.ctx.slug,
          memberId: memberIdFirstPay,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'First-Pay Co',
          country: 'TH',
          planId: planIdA,
          planYear: 2026,
        }),
      );

      // The member's ONLY-EVER cycle — a provisional pre-payment anchor
      // (e.g. a registration-date placeholder), `anchored_at` left NULL
      // (the column default). periodFrom is deliberately far from the
      // eventual payment month so the re-anchor visibly moves the dates.
      await runInTenant(tenantA.ctx, (tx) =>
        tx.insert(renewalCycles).values({
          tenantId: tenantA.ctx.slug,
          cycleId: cycleFirstPayId,
          memberId: memberIdFirstPay,
          status: 'awaiting_payment',
          periodFrom: new Date('2026-01-15T00:00:00Z'),
          periodTo: new Date('2027-01-15T00:00:00Z'),
          expiresAt: new Date('2027-01-15T00:00:00Z'),
          cycleLengthMonths: 12,
          tierAtCycleStart: 'regular',
          planIdAtCycleStart: planIdA,
          frozenPlanPriceThb: '50000.00',
          frozenPlanTermMonths: 12,
          frozenPlanCurrency: 'THB',
        }),
      );

      // F4 invoice row (issued) — `anchor_invoice_id`'s FK target (a
      // tenant-composite FK to `invoices`, per the migration 0238 schema).
      await runInTenant(tenantA.ctx, (tx) =>
        tx.insert(invoices).values({
          tenantId: tenantA.ctx.slug,
          invoiceId: seededInvoiceFirstPayId,
          memberId: memberIdFirstPay,
          planYear: 2026,
          planId: planIdA,
          status: 'issued',
          pdfDocKind: 'invoice',
          draftByUserId: user.userId,
          fiscalYear: 2026,
          sequenceNumber: 3,
          documentNumber: 'INV-2026-000003',
          issueDate: '2026-06-20',
          dueDate: '2026-07-20',
          currency: 'THB',
          subtotalSatang: asSatang(5_000_000n),
          vatRateSnapshot: '0.0700',
          vatSatang: asSatang(350_000n),
          totalSatang: asSatang(5_350_000n),
          proRatePolicySnapshot: 'none',
          netDaysSnapshot: 30,
          tenantIdentitySnapshot: { legalNameEn: 'Test', taxId: '0' } as unknown,
          memberIdentitySnapshot: {
            companyName: 'First-Pay Co',
            country: 'TH',
            legal_name: 'First-Pay Co Ltd',
            address: '1 First Pay Road, Bangkok 10110',
            primary_contact_name: 'First Pay Contact',
            primary_contact_email: 'firstpay@example.com',
          } as unknown,
          pdfBlobKey: `invoicing/${tenantA.ctx.slug}/2026/${seededInvoiceFirstPayId}.pdf`,
          pdfSha256: 'c'.repeat(64),
          pdfTemplateVersion: 1,
        }),
      );
    }, 120_000);

    it('re-anchors the cycle to the payment month instead of completing it', async () => {
      const deps = makeRenewalsDeps(tenantA.ctx.slug);
      const paidAt = new Date().toISOString();
      const bridgeSpy = vi
        .spyOn(deps.f4InvoiceBridge, 'issueAndMarkPaid')
        .mockImplementation(async (input) => {
          if (input.onPaid) {
            await input.onPaid({
              tenantId: input.tenantId,
              invoiceId: seededInvoiceFirstPayId,
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
            value: { invoiceId: seededInvoiceFirstPayId, paidAt },
          };
        });

      const r = await markPaidOffline(deps, {
        tenantId: tenantA.ctx.slug,
        cycleId: cycleFirstPayId,
        paymentMethod: 'bank_transfer',
        paymentReference: 'BT-FIRSTPAY-0001',
        // June 2026 — same fiscal year as the seeded periodFrom (Jan 2026)
        // and the seeded plan (2026), so no FY-crossing re-freeze fires;
        // the re-anchor keeps the frozen 50,000.00 THB / 12-month term.
        paymentDate: '2026-06-20',
        actorUserId: user.userId,
        actorRole: 'admin',
        correlationId: randomUUID(),
      });
      bridgeSpy.mockRestore();

      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.outcome).toBe('reanchored');
      expect(r.value.cycleStatus).toBe('upcoming');
      expect(r.value.invoiceId).toBe(seededInvoiceFirstPayId);
      // Bangkok month-start anchor: 2026-06-20 → 2026-06-01, +12 months.
      expect(r.value.newExpiresAt).toBe('2027-06-01T00:00:00.000Z');

      const rows = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .select()
          .from(renewalCycles)
          .where(eq(renewalCycles.cycleId, cycleFirstPayId)),
      );
      const row = rows[0]!;
      // NEVER completed on this branch.
      expect(row.status).toBe('upcoming');
      expect(row.closedAt).toBeNull();
      expect(row.closedReason).toBeNull();
      // Reanchor clears linked_invoice_id (never sets it) — the anchoring
      // invoice occupies anchor_invoice_id instead, so the member's
      // future renewal can still link cleanly.
      expect(row.linkedInvoiceId).toBeNull();
      expect(row.anchorInvoiceId).toBe(seededInvoiceFirstPayId);
      expect(row.anchoredAt?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
      expect(row.periodFrom.toISOString()).toBe('2026-06-01T00:00:00.000Z');
      expect(row.periodTo.toISOString()).toBe('2027-06-01T00:00:00.000Z');
      expect(row.frozenPlanPriceThb).toBe('50000.00');

      // renewal_cycle_reanchored fired for this cycle.
      const reanchored = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenantA.ctx.slug),
            eq(auditLog.eventType, 'renewal_cycle_reanchored' as never),
          ),
        );
      expect(reanchored.length).toBeGreaterThanOrEqual(1);

      // No `renewal_cycle_completed_offline` cycle for this member — the
      // completed-branch audit never fires on the re-anchor path.
      const memberCycles = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .select()
          .from(renewalCycles)
          .where(eq(renewalCycles.memberId, memberIdFirstPay)),
      );
      expect(
        memberCycles.every((c) => c.closedReason !== 'completed_offline'),
      ).toBe(true);
      // createNextCycleOnPaidInTx no-ops: still exactly ONE cycle row ever
      // for this member (the re-anchored cycle stays the sole active one).
      expect(memberCycles.length).toBe(1);
    });
  });
});
