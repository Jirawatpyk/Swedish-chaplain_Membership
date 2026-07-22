/**
 * Rolling-anchor refactor (design 2026-07-08, migration 0238) — Task 4
 * repo-surface integration test (live Neon).
 *
 * Exercises the 3 new `RenewalCycleRepo` methods that back the rolling
 * first-payment re-anchor design (spec rev 2 §2):
 *   - `countCyclesForMemberInTx`   — ALL cycle rows for a member, any status
 *   - `findOpenCycleForMemberInTx` — the member's open (non-terminal) cycle
 *   - `reanchorPeriodInTx`         — guarded re-anchor UPDATE + reminder-
 *                                    event reset, the Review-Gate-blocking
 *                                    surface (Constitution Principle I
 *                                    clause 3 — cross-tenant probe below)
 *
 * `renewal_reminder_events` rows CASCADE-delete when their owning
 * `renewal_cycles` row is deleted (`renewal_reminder_events_cycle_fk ON
 * DELETE CASCADE`), so `TestTenant.cleanup()` (which already deletes
 * `renewal_cycles`) needs no extra teardown step for this table.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { parseThbDecimal } from '@/lib/money';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { renewalReminderEvents } from '@/modules/renewals/infrastructure/schema-renewal-reminder-events';
import { makeRenewalsDeps } from '@/modules/renewals';
import { asCycleId, type CycleId } from '@/modules/renewals/domain/renewal-cycle';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

describe('F8 rolling-anchor repo surface — integration (Task 4)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let planIdA: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;
    planIdA = `f8-reanchor-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenantA.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId: planIdA,
        planName: { en: 'Reanchor Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  }, 120_000);

  async function seedMember(t: TestTenant): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(t.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: t.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Reanchor Co',
        country: 'TH',
        planId: planIdA,
        planYear: 2026,
      }),
    );
    return memberId;
  }

  /**
   * `renewal_cycles_anchor_invoice_fk` (migration 0238) requires
   * `anchor_invoice_id` to reference a real `invoices` row — seed a
   * minimum-CHECK-passing F4 draft invoice (`status='draft'` needs no
   * snapshots/PDF fields; the FK does not require a specific status —
   * same precedent as self-service-renewal-tx.test.ts seedTriplet).
   */
  async function seedDraftInvoice(t: TestTenant, memberId: string): Promise<string> {
    const invoiceId = randomUUID();
    await runInTenant(t.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: t.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId: planIdA,
        draftByUserId: user.userId,
        status: 'draft',
        currency: 'THB',
      }),
    );
    return invoiceId;
  }

  interface SeedCycleOpts {
    readonly cycleId: string;
    readonly memberId: string;
    readonly status: 'upcoming' | 'awaiting_payment' | 'cancelled';
    readonly anchoredAt?: Date | null;
    readonly anchorInvoiceId?: string | null;
  }

  async function seedCycle(t: TestTenant, opts: SeedCycleOpts): Promise<void> {
    await runInTenant(t.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: t.ctx.slug,
        cycleId: opts.cycleId,
        memberId: opts.memberId,
        status: opts.status,
        periodFrom: new Date('2026-06-01T00:00:00Z'),
        periodTo: new Date('2027-06-01T00:00:00Z'),
        expiresAt: new Date('2027-06-01T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planIdA,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        anchoredAt: opts.anchoredAt ?? null,
        anchorInvoiceId: opts.anchorInvoiceId ?? null,
        // Terminal-status CHECK (`renewal_cycles_closed_at_iff_terminal_check`)
        // requires closed_at/closed_reason for 'cancelled'; the two active
        // statuses used elsewhere in this file must NOT set them.
        ...(opts.status === 'cancelled'
          ? { closedAt: new Date(), closedReason: 'cancelled' as const }
          : {}),
      }),
    );
  }

  describe('countCyclesForMemberInTx', () => {
    it('counts ALL cycle rows for the member regardless of status', async () => {
      const memberId = await seedMember(tenantA);
      // Terminal + active can coexist (the partial-unique active-cycle
      // index only constrains NON-terminal rows).
      await seedCycle(tenantA, { cycleId: randomUUID(), memberId, status: 'cancelled' });
      await seedCycle(tenantA, { cycleId: randomUUID(), memberId, status: 'upcoming' });

      const deps = makeRenewalsDeps(tenantA.ctx.slug);
      const count = await runInTenant(tenantA.ctx, (tx) =>
        deps.cyclesRepo.countCyclesForMemberInTx(tx, tenantA.ctx.slug, memberId),
      );
      expect(count).toBe(2);
    });

    it('returns 0 for a member with no cycles', async () => {
      const memberId = await seedMember(tenantA);
      const deps = makeRenewalsDeps(tenantA.ctx.slug);
      const count = await runInTenant(tenantA.ctx, (tx) =>
        deps.cyclesRepo.countCyclesForMemberInTx(tx, tenantA.ctx.slug, memberId),
      );
      expect(count).toBe(0);
    });

    it('cross-tenant: tenant B sees zero for tenant A\'s member (RLS)', async () => {
      const memberId = await seedMember(tenantA);
      await seedCycle(tenantA, { cycleId: randomUUID(), memberId, status: 'upcoming' });

      const depsB = makeRenewalsDeps(tenantB.ctx.slug);
      const count = await runInTenant(tenantB.ctx, (tx) =>
        depsB.cyclesRepo.countCyclesForMemberInTx(tx, tenantB.ctx.slug, memberId),
      );
      expect(count).toBe(0);
    });
  });

  describe('findOpenCycleForMemberInTx', () => {
    it('returns the single open cycle among mixed terminal + active rows', async () => {
      const memberId = await seedMember(tenantA);
      const openCycleId = randomUUID();
      await seedCycle(tenantA, { cycleId: randomUUID(), memberId, status: 'cancelled' });
      await seedCycle(tenantA, { cycleId: openCycleId, memberId, status: 'awaiting_payment' });

      const deps = makeRenewalsDeps(tenantA.ctx.slug);
      const open = await runInTenant(tenantA.ctx, (tx) =>
        deps.cyclesRepo.findOpenCycleForMemberInTx(tx, tenantA.ctx.slug, memberId),
      );
      expect(open?.cycleId).toBe(openCycleId);
      expect(open?.status).toBe('awaiting_payment');
    });

    it('returns null when the member has only terminal cycles', async () => {
      const memberId = await seedMember(tenantA);
      await seedCycle(tenantA, { cycleId: randomUUID(), memberId, status: 'cancelled' });

      const deps = makeRenewalsDeps(tenantA.ctx.slug);
      const open = await runInTenant(tenantA.ctx, (tx) =>
        deps.cyclesRepo.findOpenCycleForMemberInTx(tx, tenantA.ctx.slug, memberId),
      );
      expect(open).toBeNull();
    });
  });

  describe('reanchorPeriodInTx', () => {
    const REANCHOR_ARGS = {
      periodFrom: '2026-08-01T00:00:00.000Z',
      periodTo: '2027-08-01T00:00:00.000Z',
      anchoredAt: '2026-08-01T00:00:00.000Z',
      frozenPlanPriceThb: parseThbDecimal('55000.00'),
      frozenPlanTermMonths: 12,
    };

    it('(a) re-anchors a fresh upcoming cycle: moves period, stamps anchor, syncs expires_at, 0 reminder events reset', async () => {
      const memberId = await seedMember(tenantA);
      const cycleId: CycleId = asCycleId(randomUUID());
      await seedCycle(tenantA, { cycleId, memberId, status: 'upcoming' });

      // Real F4 invoice — the anchor FK (`renewal_cycles_anchor_invoice_fk`)
      // must resolve; this case exercises the non-null forensic reference.
      const anchorInvoiceId = await seedDraftInvoice(tenantA, memberId);
      const deps = makeRenewalsDeps(tenantA.ctx.slug);
      const result = await runInTenant(tenantA.ctx, (tx) =>
        deps.cyclesRepo.reanchorPeriodInTx(tx, tenantA.ctx.slug, cycleId, {
          ...REANCHOR_ARGS,
          anchorInvoiceId,
        }),
      );

      expect(result).not.toBeNull();
      expect(result?.reminderEventsReset).toBe(0);
      expect(result?.cycle.status).toBe('upcoming');
      expect(result?.cycle.periodFrom).toBe(REANCHOR_ARGS.periodFrom);
      expect(result?.cycle.periodTo).toBe(REANCHOR_ARGS.periodTo);
      expect(result?.cycle.anchoredAt).toBe(REANCHOR_ARGS.anchoredAt);
      expect(result?.cycle.anchorInvoiceId).toBe(anchorInvoiceId);
      // expires_at trigger denormalises from period_to.
      expect(result?.cycle.expiresAt).toBe(REANCHOR_ARGS.periodTo);

      const rows = await runInTenant(tenantA.ctx, (tx) =>
        tx.select().from(renewalCycles).where(eq(renewalCycles.cycleId, cycleId)),
      );
      expect(rows[0]?.status).toBe('upcoming');
      expect(rows[0]?.anchoredAt).not.toBeNull();
      expect(rows[0]?.expiresAt.toISOString()).toBe(REANCHOR_ARGS.periodTo);
    });

    it('(c) a second re-anchor attempt on the now-anchored cycle returns null (anchored_at guard)', async () => {
      const memberId = await seedMember(tenantA);
      const cycleId: CycleId = asCycleId(randomUUID());
      await seedCycle(tenantA, { cycleId, memberId, status: 'upcoming' });

      const deps = makeRenewalsDeps(tenantA.ctx.slug);
      // `anchorInvoiceId: null` — the sanctioned R4-backfill arm (no
      // forensic invoice reference for pre-system payments).
      const first = await runInTenant(tenantA.ctx, (tx) =>
        deps.cyclesRepo.reanchorPeriodInTx(tx, tenantA.ctx.slug, cycleId, {
          ...REANCHOR_ARGS,
          anchorInvoiceId: null,
        }),
      );
      expect(first).not.toBeNull();
      expect(first?.cycle.anchorInvoiceId).toBeNull();

      const second = await runInTenant(tenantA.ctx, (tx) =>
        deps.cyclesRepo.reanchorPeriodInTx(tx, tenantA.ctx.slug, cycleId, {
          ...REANCHOR_ARGS,
          anchorInvoiceId: null,
        }),
      );
      expect(second).toBeNull();
    });

    it('(b) re-anchors an awaiting_payment unanchored cycle: status resets to upcoming', async () => {
      const memberId = await seedMember(tenantA);
      const cycleId: CycleId = asCycleId(randomUUID());
      await seedCycle(tenantA, { cycleId, memberId, status: 'awaiting_payment' });

      const deps = makeRenewalsDeps(tenantA.ctx.slug);
      const result = await runInTenant(tenantA.ctx, (tx) =>
        deps.cyclesRepo.reanchorPeriodInTx(tx, tenantA.ctx.slug, cycleId, {
          ...REANCHOR_ARGS,
          anchorInvoiceId: null,
        }),
      );

      expect(result).not.toBeNull();
      expect(result?.cycle.status).toBe('upcoming');
    });

    it("(d) fixed-anchor: does NOT delete the cycle's reminder events (period unchanged → reminders stay valid, reset=0)", async () => {
      const memberId = await seedMember(tenantA);
      const cycleId: CycleId = asCycleId(randomUUID());
      await seedCycle(tenantA, { cycleId, memberId, status: 'upcoming' });

      await runInTenant(tenantA.ctx, (tx) =>
        tx.insert(renewalReminderEvents).values([
          {
            tenantId: tenantA.ctx.slug,
            cycleId,
            stepId: 't-30',
            channel: 'email',
            templateId: 'renewal-t30-email',
            status: 'pending',
            yearInCycle: 1,
          },
          {
            tenantId: tenantA.ctx.slug,
            cycleId,
            stepId: 't-14',
            channel: 'email',
            templateId: 'renewal-t14-email',
            status: 'pending',
            yearInCycle: 1,
          },
        ]),
      );

      const deps = makeRenewalsDeps(tenantA.ctx.slug);
      const result = await runInTenant(tenantA.ctx, (tx) =>
        deps.cyclesRepo.reanchorPeriodInTx(tx, tenantA.ctx.slug, cycleId, {
          ...REANCHOR_ARGS,
          anchorInvoiceId: null,
        }),
      );

      expect(result?.reminderEventsReset).toBe(0);

      const remaining = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .select()
          .from(renewalReminderEvents)
          .where(eq(renewalReminderEvents.cycleId, cycleId)),
      );
      // Reminders are KEPT — the period did not move so they are still valid.
      expect(remaining).toHaveLength(2);
    });

    it("(e) cross-tenant: tenant B cannot re-anchor tenant A's cycle (RLS → null)", async () => {
      const memberId = await seedMember(tenantA);
      const cycleId: CycleId = asCycleId(randomUUID());
      await seedCycle(tenantA, { cycleId, memberId, status: 'upcoming' });

      const depsB = makeRenewalsDeps(tenantB.ctx.slug);
      const result = await runInTenant(tenantB.ctx, (tx) =>
        depsB.cyclesRepo.reanchorPeriodInTx(tx, tenantB.ctx.slug, cycleId, {
          ...REANCHOR_ARGS,
          anchorInvoiceId: randomUUID(),
        }),
      );
      expect(result).toBeNull();

      // Tenant A's cycle MUST stay untouched.
      const rows = await runInTenant(tenantA.ctx, (tx) =>
        tx.select().from(renewalCycles).where(eq(renewalCycles.cycleId, cycleId)),
      );
      expect(rows[0]?.status).toBe('upcoming');
      expect(rows[0]?.anchoredAt).toBeNull();
    });
  });
});
