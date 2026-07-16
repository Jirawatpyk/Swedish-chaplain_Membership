/**
 * F8-completion Slice 1 · Task 1.6 — createMember onboarding listener,
 * end-to-end against live Neon.
 *
 * Wires the REAL `f8OnCreateMemberCallbacks` factory into `createMember`
 * (exactly as `api/members/route.ts` does when F8 is on) and asserts the
 * post-commit listener creates the new member's initial renewal cycle:
 *
 *   - exactly ONE `upcoming` cycle, anchored at the member's
 *     `registration_date`, frozen at the resolved plan price;
 *   - a `renewal_cycle_created` audit row exists for that cycle;
 *   - an idempotency replay (the same onboarding event fired again) does
 *     NOT create a 2nd cycle (`findActiveForMemberInTx` no-op).
 *
 * Mirrors `change-plan-post-commit-listeners.test.ts` (the F2→F8 twin) for
 * the seed harness. Constitution Principle I (RLS via runInTenant) +
 * Principle VIII (state↔audit atomicity).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db, runInTenant } from '@/lib/db';
import { asSatang } from '@/lib/money';
import { createMember } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import {
  deriveMembershipAccess,
  f8OnCreateMemberCallbacks,
  f8OnPaidCallbacks,
} from '@/modules/renewals';
import { makeDrizzleRenewalCycleRepo } from '@/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

describe('Integration — createMember onboarding listener creates the initial cycle (Task 1.6)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    planId = `f8-onboard-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Onboard Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
        // 5_000_000 minor units → 50000.00 THB frozen price (default).
      }),
    );
  }, 180_000);

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
      .delete(members)
      .where(eq(members.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 60_000);

  /** An `issued` MEMBERSHIP invoice for the created member (full snapshot to
   *  satisfy `invoices_non_draft_has_snapshots`), UNLINKED to any cycle — so
   *  paying it drives the §5.3 unlinked-payment reanchor heal path. */
  async function seedIssuedMembershipInvoice(memberId: string): Promise<string> {
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
        documentNumber: `INV-2026-${String(Math.floor(Math.random() * 900_000) + 100_000)}`,
        issueDate: '2026-07-01',
        dueDate: '2026-07-31',
        currency: 'THB',
        subtotalSatang: asSatang(5_000_000n),
        vatRateSnapshot: '0.0700',
        vatSatang: asSatang(350_000n),
        totalSatang: asSatang(5_350_000n),
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: { legalNameEn: 'Test', taxId: '0' } as unknown,
        memberIdentitySnapshot: {
          companyName: 'Heal Co',
          country: 'SE',
          legal_name: 'Heal Co Ltd',
          address: '1 Test Road, Bangkok 10110',
          primary_contact_name: 'Test Contact',
          primary_contact_email: 'heal@example.com',
        } as unknown,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      }),
    );
    return invoiceId;
  }

  /** Fire the REAL `f8OnPaidCallbacks` chain against one threaded tx —
   *  exactly F4 `recordPayment`'s callback loop for an OFFLINE payment. */
  async function fireOnPaidChainInTx(
    invoiceId: string,
    memberId: string,
    paymentDate: string,
  ): Promise<void> {
    const callbacks = f8OnPaidCallbacks(tenant.ctx.slug);
    await runInTenant(tenant.ctx, async (tx) => {
      const evt: F4InvoicePaidEvent = {
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        paidAt: '2026-07-20T09:00:00.000Z',
        amountSatang: asSatang(5_350_000n),
        vatSatang: asSatang(350_000n),
        currency: 'THB',
        paymentMethod: 'bank_transfer',
        triggeredBy: 'admin_manual',
        invoiceSubject: 'membership',
        paymentDate,
      };
      for (const cb of callbacks) {
        await cb(evt, tx);
      }
    });
  }

  it('creates exactly one awaiting_payment cycle (065 §5.3) anchored at registration_date, frozen at the plan price', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const seedSlug = randomUUID().slice(0, 8);
    const registrationDate = '2026-03-15'; // ISO date

    const created = await createMember(
      {
        company_name: `Onboard Co ${seedSlug}`,
        country: 'SE',
        plan_id: planId,
        plan_year: 2026,
        registration_date: registrationDate,
        primary_contact: {
          first_name: 'Olivia',
          last_name: 'Onboard',
          email: `${seedSlug}@onboard.test`,
          preferred_language: 'en' as const,
        },
      },
      { actorUserId: user.userId, requestId: `onboard-${seedSlug}` },
      { ...deps, onboardingListeners: f8OnCreateMemberCallbacks(tenant.ctx.slug) },
    );
    if (!created.ok)
      throw new Error(`create failed: ${JSON.stringify(created.error)}`);
    const memberId = created.value.memberId;

    // Exactly one cycle for this member.
    const cycles = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(renewalCycles)
        .where(
          and(
            eq(renewalCycles.tenantId, tenant.ctx.slug),
            eq(renewalCycles.memberId, memberId),
          ),
        ),
    );
    expect(cycles).toHaveLength(1);
    const cycle = cycles[0]!;
    // 065 §5.3 — a new member is born 'awaiting_payment' (no benefit until the
    // first invoice is paid), not 'upcoming'. deriveMembershipAccess maps this
    // to suspended; first payment reanchors to 'upcoming' + anchored → full.
    expect(cycle.status).toBe('awaiting_payment');
    // Anchored at registration_date (UTC midnight of the ISO date).
    expect(cycle.periodFrom.toISOString()).toBe('2026-03-15T00:00:00.000Z');
    // period_to = period_from + 12 months (gapless).
    expect(cycle.periodTo.toISOString()).toBe('2027-03-15T00:00:00.000Z');
    // Frozen at the resolved plan price (50000.00 from the default seed).
    expect(cycle.frozenPlanPriceThb).toBe('50000.00');
    expect(cycle.tierAtCycleStart).toBe('regular');
    expect(cycle.planIdAtCycleStart).toBe(planId);

    // A renewal_cycle_created audit row exists for this member's cycle.
    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          // `renewal_cycle_created` is in the DB enum (migration 0109) but not
          // yet in the auth audit_log Drizzle pgEnum TS union — cast as the
          // precedent (create-next-cycle-on-paid.test.ts:250).
          eq(auditLog.eventType, 'renewal_cycle_created' as never),
        ),
      );
    const forMember = audit.filter(
      (a) => (a.payload as { member_id?: string }).member_id === memberId,
    );
    expect(forMember).toHaveLength(1);
    expect(
      (forMember[0]!.payload as { cycle_id?: string }).cycle_id,
    ).toBe(cycle.cycleId);
  }, 60_000);

  it('065 §5.3 — a new member has SUSPENDED benefit access until first payment (end-to-end)', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const seedSlug = randomUUID().slice(0, 8);
    const created = await createMember(
      {
        company_name: `Gated Co ${seedSlug}`,
        country: 'SE',
        plan_id: planId,
        plan_year: 2026,
        registration_date: '2026-05-10',
        primary_contact: {
          first_name: 'Gita',
          last_name: 'Gated',
          email: `${seedSlug}@gated.test`,
          preferred_language: 'en' as const,
        },
      },
      { actorUserId: user.userId, requestId: `gated-${seedSlug}` },
      { ...deps, onboardingListeners: f8OnCreateMemberCallbacks(tenant.ctx.slug) },
    );
    if (!created.ok)
      throw new Error(`create failed: ${JSON.stringify(created.error)}`);
    const memberId = created.value.memberId;

    // The end-to-end access decision the portal + use-case gates read: a
    // never-paid new member is SUSPENDED (no benefit until the first invoice is
    // paid). Read the latest cycle through the same repo `loadLatestCycleForMember`
    // wraps (the wrapper is React-`cache()`-scoped to RSC — not usable here).
    // The heal to `full` on first payment is covered by the reanchor-first-payment
    // tests; the import + renewal paths stay `upcoming` (= full) — covered by
    // import-members-cycles + create-next-cycle-on-paid — proving the gate fires
    // ONLY on new-member enrolment.
    const latest = await makeDrizzleRenewalCycleRepo(
      tenant.ctx,
    ).findLatestCycleForMember(tenant.ctx.slug, memberId);
    expect(latest?.status).toBe('awaiting_payment');
    const decision = deriveMembershipAccess(latest, new Date());
    expect(decision.access).toBe('suspended');
    expect(decision.reason).toBe('unpaid');
  }, 60_000);

  it('065 §5.3 — the first OFFLINE payment HEALS a born-awaiting member to FULL (reanchor)', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const seedSlug = randomUUID().slice(0, 8);
    const created = await createMember(
      {
        company_name: `Heal Co ${seedSlug}`,
        country: 'SE',
        plan_id: planId,
        plan_year: 2026,
        registration_date: '2026-05-10',
        primary_contact: {
          first_name: 'Hana',
          last_name: 'Heal',
          email: `${seedSlug}@heal.test`,
          preferred_language: 'en' as const,
        },
      },
      { actorUserId: user.userId, requestId: `heal-${seedSlug}` },
      { ...deps, onboardingListeners: f8OnCreateMemberCallbacks(tenant.ctx.slug) },
    );
    if (!created.ok)
      throw new Error(`create failed: ${JSON.stringify(created.error)}`);
    const memberId = created.value.memberId;
    const repo = makeDrizzleRenewalCycleRepo(tenant.ctx);

    // Born awaiting_payment → suspended (no benefit until first payment).
    const born = await repo.findLatestCycleForMember(tenant.ctx.slug, memberId);
    expect(born?.status).toBe('awaiting_payment');
    expect(deriveMembershipAccess(born, new Date()).access).toBe('suspended');

    // Admin records the first payment OFFLINE — F4's recordPayment fires the
    // F8 onPaid callback chain, which classifies `first_payment` on the
    // never-anchored initial cycle and REANCHORS it to the payment month
    // (upcoming + anchoredAt), the §5.3 heal path.
    const invoiceId = await seedIssuedMembershipInvoice(memberId);
    await fireOnPaidChainInTx(invoiceId, memberId, '2026-07-20');

    // The reanchor heals the member to FULL: the initial cycle is now an
    // anchored `upcoming` cycle whose period covers `now`.
    const healed = await repo.findLatestCycleForMember(tenant.ctx.slug, memberId);
    expect(healed?.status).toBe('upcoming');
    expect(healed?.anchoredAt).not.toBeNull();
    expect(deriveMembershipAccess(healed, new Date()).access).toBe('full');
  }, 120_000);

  it('068 R2-1 — a BACKDATED registration_date is anchored to the CURRENT period (cycle expires in the FUTURE, not immediately lapse-eligible)', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const seedSlug = randomUUID().slice(0, 8);
    // Onboarding a long-standing/historical member: registered 2 years ago.
    // WITHOUT current-period anchoring the cycle's period_to would be ~1 year
    // in the PAST → the enter-awaiting + lapse crons would flip the brand-new
    // member to `lapsed` at creation. With the R2-1 anchor it advances to the
    // current period so expires_at is in the FUTURE.
    const now = new Date();
    const twoYearsAgo = new Date(
      Date.UTC(now.getUTCFullYear() - 2, now.getUTCMonth(), 15),
    );
    const registrationDate = twoYearsAgo.toISOString().slice(0, 10); // YYYY-MM-DD

    const created = await createMember(
      {
        company_name: `Backdated Co ${seedSlug}`,
        country: 'SE',
        plan_id: planId,
        plan_year: 2026,
        registration_date: registrationDate,
        primary_contact: {
          first_name: 'Bram',
          last_name: 'Backdated',
          email: `${seedSlug}@backdated.test`,
          preferred_language: 'en' as const,
        },
      },
      { actorUserId: user.userId, requestId: `backdated-${seedSlug}` },
      { ...deps, onboardingListeners: f8OnCreateMemberCallbacks(tenant.ctx.slug) },
    );
    if (!created.ok)
      throw new Error(`create failed: ${JSON.stringify(created.error)}`);
    const memberId = created.value.memberId;

    const cycles = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(renewalCycles)
        .where(
          and(
            eq(renewalCycles.tenantId, tenant.ctx.slug),
            eq(renewalCycles.memberId, memberId),
          ),
        ),
    );
    expect(cycles).toHaveLength(1);
    const cycle = cycles[0]!;
    // The cycle window covers `now` → expires_at strictly in the future.
    expect(cycle.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(cycle.periodTo.getTime()).toBeGreaterThan(Date.now());
    // period_from must NOT be the raw 2-years-ago registration date — it was
    // advanced forward by whole 12-month terms (anniversary day preserved).
    expect(cycle.periodFrom.getTime()).toBeGreaterThan(twoYearsAgo.getTime());
    expect(cycle.periodFrom.getUTCDate()).toBe(15); // anniversary day kept
    // The member did not silently lapse: an active (awaiting_payment) cycle,
    // NOT lapsed (065 §5.3 — born awaiting_payment = suspended, not terminated).
    expect(cycle.status).toBe('awaiting_payment');
  }, 60_000);

  it('an idempotency replay (same onboarding event re-fired) does NOT create a 2nd cycle', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const seedSlug = randomUUID().slice(0, 8);

    const created = await createMember(
      {
        company_name: `Replay Co ${seedSlug}`,
        country: 'SE',
        plan_id: planId,
        plan_year: 2026,
        registration_date: '2026-04-01',
        primary_contact: {
          first_name: 'Rudy',
          last_name: 'Replay',
          email: `${seedSlug}@replay.test`,
          preferred_language: 'en' as const,
        },
      },
      { actorUserId: user.userId, requestId: `replay-${seedSlug}` },
      { ...deps, onboardingListeners: f8OnCreateMemberCallbacks(tenant.ctx.slug) },
    );
    if (!created.ok)
      throw new Error(`create failed: ${JSON.stringify(created.error)}`);
    const memberId = created.value.memberId;

    // Re-fire the onboarding listener directly (simulating a replay).
    const [listener] = f8OnCreateMemberCallbacks(tenant.ctx.slug);
    await listener!({
      tenantId: tenant.ctx.slug,
      memberId,
      registrationDate: '2026-04-01T00:00:00.000Z',
      planId,
      correlationId: `replay-2-${seedSlug}`,
    });

    // Still exactly one cycle — the in-tx idempotency guard no-ops.
    const cycles = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ id: renewalCycles.cycleId })
        .from(renewalCycles)
        .where(
          and(
            eq(renewalCycles.tenantId, tenant.ctx.slug),
            eq(renewalCycles.memberId, memberId),
          ),
        ),
    );
    expect(cycles).toHaveLength(1);
  }, 60_000);

  // Principle-I (068 speckit-review tests I-2) — tenant-isolation probe on
  // the onboarding-listener path. The `f8OnCreateMemberCallbacks` factory is
  // scoped to tenant A's slug (`makeRenewalsDeps(A)` → its listener opens its
  // OWN `runInTenant(A)` tx), so RLS structurally prevents the onboarding
  // cycle from landing in tenant B. This makes that guarantee an explicit
  // regression net: a repo method that reached for the pool-global `db`
  // instead of the threaded `tx` would write across tenants and this probe
  // would catch it.
  it('cross-tenant: onboarding a member in tenant A does not create a cycle visible in tenant B (Principle I)', async () => {
    const tenantB = await createTestTenant();
    try {
      // Tenant B starts with ZERO renewal cycles. It must still have zero
      // after tenant A onboards a member through its own listener.
      const beforeB = await runInTenant(tenantB.ctx, (tx) =>
        tx
          .select({ id: renewalCycles.cycleId })
          .from(renewalCycles)
          .where(eq(renewalCycles.tenantId, tenantB.ctx.slug)),
      );
      expect(beforeB).toHaveLength(0);

      const deps = buildMembersDeps(tenant.ctx);
      const seedSlug = randomUUID().slice(0, 8);
      const created = await createMember(
        {
          company_name: `Isolation Co ${seedSlug}`,
          country: 'SE',
          plan_id: planId,
          plan_year: 2026,
          registration_date: '2026-05-01',
          primary_contact: {
            first_name: 'Ingrid',
            last_name: 'Isolation',
            email: `${seedSlug}@isolation.test`,
            preferred_language: 'en' as const,
          },
        },
        { actorUserId: user.userId, requestId: `isolation-${seedSlug}` },
        { ...deps, onboardingListeners: f8OnCreateMemberCallbacks(tenant.ctx.slug) },
      );
      if (!created.ok)
        throw new Error(`create failed: ${JSON.stringify(created.error)}`);
      const memberId = created.value.memberId;

      // Tenant A got its onboarding cycle...
      const cyclesA = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select({ id: renewalCycles.cycleId })
          .from(renewalCycles)
          .where(
            and(
              eq(renewalCycles.tenantId, tenant.ctx.slug),
              eq(renewalCycles.memberId, memberId),
            ),
          ),
      );
      expect(cyclesA).toHaveLength(1);

      // ...but tenant B still has ZERO cycles (nothing crossed the boundary).
      const afterB = await runInTenant(tenantB.ctx, (tx) =>
        tx
          .select({ id: renewalCycles.cycleId })
          .from(renewalCycles)
          .where(eq(renewalCycles.tenantId, tenantB.ctx.slug)),
      );
      expect(afterB).toHaveLength(0);
    } finally {
      await db
        .delete(renewalCycles)
        .where(eq(renewalCycles.tenantId, tenantB.ctx.slug))
        .catch(() => {});
      await db
        .delete(members)
        .where(eq(members.tenantId, tenantB.ctx.slug))
        .catch(() => {});
      await tenantB.cleanup().catch(() => {});
    }
  }, 180_000);
});
