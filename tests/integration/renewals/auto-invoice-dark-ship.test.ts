/**
 * 107-auto-invoice Task 17 — dark-ship verification sweep, advisory-lock
 * topology, and cross-tenant scoping (live Neon).
 *
 * This file exists to answer one question adversarially: **is the feature
 * actually dark, or does it merely look dark because nobody has clicked the
 * button yet?** Those are very different properties, and only the first one
 * is safe to merge. So the cases below try to BREAK the dark-ship claim
 * rather than demonstrate it — each of the three keys is exercised
 * INDEPENDENTLY, with the other two set to their permissive value, so a
 * single key that silently stopped gating cannot hide behind its neighbours.
 *
 * The three keys (design §5.7, all default-off):
 *   1. `FEATURE_AUTO_INVOICE`                        — env, route layer
 *   2. `tenant_invoice_settings.auto_invoice_enabled` — per tenant, USE-CASE layer
 *   3. `members.auto_invoice_enrolled_at IS NOT NULL` — per member, query layer
 *
 * **Key #1 is deliberately NOT re-tested here.** It is a route-layer gate on
 * an env flag, and it already has direct coverage for all four routes in
 * `tests/unit/api/cron/renewals/` — `auto-draft-route.test.ts` (worker AND
 * coordinator), `prune-auto-drafts-route.test.ts`,
 * `reconcile-issued-orphans-route.test.ts`, each asserting
 * `200 {skipped, reason:'feature_flag_disabled'}` with the use-case never
 * invoked. Duplicating that against live Neon would add runtime and no
 * signal. Keys #2 and #3 are what this file owns, because they are the ones
 * enforced in application/query code where a refactor can quietly drop them.
 *
 * § A — dark-ship sweep (keys #2 and #3, independently)
 * § B — advisory-lock topology (shared per-cycle key vs disjoint namespaces)
 * § C — cross-tenant scoping
 *
 * ---
 * **A note on § A5, the positive control.** A dark-ship suite is uniquely
 * prone to passing for the wrong reason: every assertion is "nothing
 * happened", and a fixture that COULD never draft (wrong dates, missing
 * plan row, unseeded settings) satisfies all of them while proving nothing.
 * A5 flips all three keys on over the same fixtures and asserts a draft IS
 * produced. If A5 ever goes red, every other case in § A is void — read A5
 * first when this file fails.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { autoDraftDueRenewals, makeRenewalsDeps } from '@/modules/renewals';
// `CycleId` is a branded type; the barrel exports `parseCycleId` but the
// established integration-test precedent for the unchecked cast is the
// domain-level `asCycleId` (see async-reject-refund-settle.test.ts:47).
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

/**
 * Fixed "now". `periodFrom` below is chosen so `period_to` (= +12 months)
 * lands ~17 days out — inside the 30-day rolling lead window, i.e. squarely
 * eligible. Eligibility is therefore never the reason a case sees 0 drafts;
 * the key under test is.
 */
const NOW = new Date('2026-07-15T00:00:00.000Z');
const PERIOD_FROM = '2025-08-01T00:00:00Z';

async function setAutoInvoiceEnabled(
  t: TestTenant,
  enabled: boolean,
): Promise<void> {
  await runInTenant(t.ctx, (tx) =>
    tx
      .update(tenantInvoiceSettings)
      .set({
        autoInvoiceEnabled: enabled,
        autoInvoiceLeadDaysRolling: 30,
        autoInvoiceLeadDaysCalendar: 31,
        autoInvoicePageSize: 200,
      })
      .where(eq(tenantInvoiceSettings.tenantId, t.ctx.slug)),
  );
}

async function seedMember(
  t: TestTenant,
  planId: string,
  enrolled: boolean,
): Promise<string> {
  const memberId = randomUUID();
  await runInTenant(t.ctx, (tx) =>
    tx.insert(members).values({
      tenantId: t.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `Dark-Ship T17 Co ${memberId.slice(0, 6)}`,
      country: 'TH' as const,
      planId,
      planYear: 2025,
      billingCycle: 'rolling',
      autoInvoiceEnrolledAt: enrolled ? new Date('2026-01-01T00:00:00Z') : null,
    }),
  );
  return memberId;
}

async function seedEligibleCycle(
  t: TestTenant,
  memberId: string,
  planId: string,
): Promise<string> {
  const cycleId = randomUUID();
  const periodFrom = new Date(PERIOD_FROM);
  const periodTo = new Date(periodFrom);
  periodTo.setUTCMonth(periodTo.getUTCMonth() + 12);
  await runInTenant(t.ctx, (tx) =>
    tx.insert(renewalCycles).values({
      tenantId: t.ctx.slug,
      cycleId,
      memberId,
      status: 'upcoming',
      periodFrom,
      periodTo,
      expiresAt: periodTo,
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular',
      planIdAtCycleStart: planId,
      frozenPlanPriceThb: '50000.00',
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB',
      anchoredAt: periodFrom,
    }),
  );
  return cycleId;
}

/**
 * Invoice count for ONE member.
 *
 * The § A cases share a tenant, and each seeds its own member, so a
 * tenant-wide count is not a safe "nothing happened" assertion: A1 seeds an
 * enrolled member while the tenant key is off, and A2 then turns that key on,
 * at which point A1's leftover member legitimately becomes eligible and
 * drafts. (Observed: A2 initially failed with `drafted: 1` — that 1 was A1's
 * member, not A2's un-enrolled one.) Scoping the assertion to the member
 * under test makes each case independent of its neighbours' residue, which is
 * what the "each key independently" claim requires.
 */
async function countInvoicesForMember(
  t: TestTenant,
  memberId: string,
): Promise<number> {
  const rows = await runInTenant(t.ctx, (tx) =>
    tx
      .select()
      .from(invoices)
      .where(
        and(eq(invoices.tenantId, t.ctx.slug), eq(invoices.memberId, memberId)),
      ),
  );
  return rows.length;
}

async function countAutoRenewalInvoices(t: TestTenant): Promise<number> {
  const rows = await runInTenant(t.ctx, (tx) =>
    tx
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, t.ctx.slug),
          eq(invoices.origin, 'auto_renewal'),
        ),
      ),
  );
  return rows.length;
}

function fixedClockDeps(tenantSlug: string) {
  const deps = makeRenewalsDeps(tenantSlug);
  return { ...deps, clock: { now: () => NOW } };
}

async function runAutoDraft(tenantSlug: string) {
  return autoDraftDueRenewals(fixedClockDeps(tenantSlug), {
    tenantId: tenantSlug,
    correlationId: randomUUID(),
  });
}

describe('107-auto-invoice Task 17 — dark-ship sweep + lock topology (live Neon)', () => {
  let tenant: TestTenant;
  let peer: TestTenant;
  let user: TestUser;
  let planId: string;
  let peerPlanId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test');
    peer = await createTestTenant('test');

    planId = `f8-t17-plan-${randomUUID().slice(0, 8)}`;
    peerPlanId = `f8-t17-peer-plan-${randomUUID().slice(0, 8)}`;

    // planYear=2025 matches `deriveFiscalYear(periodFrom)` — the
    // `(plan_id, plan_year)` composite FK on the draft requires a real
    // `membership_plans` row at THAT year (see auto-draft-due-renewals.ts's
    // KEY tax-consistency note).
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planYear: 2025,
        planName: { en: 'Dark-Ship T17 Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
    await runInTenant(peer.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: peer.ctx.slug,
        planId: peerPlanId,
        planYear: 2025,
        planName: { en: 'Dark-Ship T17 Peer Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );

    await seedTenantFiscal({
      tenant,
      invoiceNumberPrefix: 'SC',
      receiptNumberPrefix: 'RC',
    });
    await seedTenantFiscal({
      tenant: peer,
      invoiceNumberPrefix: 'PC',
      receiptNumberPrefix: 'PR',
    });
  }, 180_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await peer.cleanup().catch(() => {});
  }, 60_000);

  // =========================================================================
  // § A — dark-ship sweep
  // =========================================================================
  describe('§ A — dark-ship sweep (each key independently)', () => {
    it('A1: key #2 OFF alone holds the line — enrolled member, due cycle, settings disabled → 0 drafts', async () => {
      // Every OTHER condition is permissive: the member IS enrolled (key #3
      // satisfied) and the cycle IS inside the lead window. Only
      // `auto_invoice_enabled=false` stands between this member and a bill.
      await setAutoInvoiceEnabled(tenant, false);
      const memberId = await seedMember(tenant, planId, true);
      await seedEligibleCycle(tenant, memberId, planId);

      const result = await runAutoDraft(tenant.ctx.slug);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Key #2 short-circuits before the eligibility query, so the pass
        // sees zero cycles tenant-wide — not merely zero drafts.
        expect(result.value.drafted).toBe(0);
        expect(result.value.cyclesProcessed).toBe(0);
      }
      expect(await countInvoicesForMember(tenant, memberId)).toBe(0);
    }, 120_000);

    it('A2: key #3 OFF alone holds the line — settings enabled, member NOT enrolled → 0 drafts', async () => {
      // Mirror image of A1: the tenant key is ON, so if enrolment stopped
      // being part of the eligibility predicate this member would be billed.
      await setAutoInvoiceEnabled(tenant, true);
      const memberId = await seedMember(tenant, planId, false);
      await seedEligibleCycle(tenant, memberId, planId);

      const result = await runAutoDraft(tenant.ctx.slug);

      expect(result.ok).toBe(true);
      // NOTE: `result.value.drafted` is deliberately NOT asserted to be 0
      // here. The tenant key is ON in this case, so OTHER members left by
      // neighbouring cases are legitimately draftable and the tenant-wide
      // counter is expected to be non-zero. The claim under test is narrower
      // and stronger: THIS un-enrolled member was not billed.
      expect(await countInvoicesForMember(tenant, memberId)).toBe(0);
    }, 120_000);

    it('A3: the gate is at the USE-CASE layer — key #2 off short-circuits BEFORE the eligibility query', async () => {
      // The adversarial point. A route-only gate would leave the use-case
      // billing happily for anyone who called it directly (a script, a
      // future admin action, a test). Prove the refusal lives in the
      // use-case by making the eligibility query EXPLODE if it is reached:
      // a use-case that short-circuits first never touches it.
      await setAutoInvoiceEnabled(tenant, false);
      const memberId = await seedMember(tenant, planId, true);
      await seedEligibleCycle(tenant, memberId, planId);

      const deps = fixedClockDeps(tenant.ctx.slug);
      const listSpy = vi
        .fn()
        .mockRejectedValue(
          new Error('eligibility query reached despite auto_invoice_enabled=false'),
        );
      const spiedDeps = {
        ...deps,
        cyclesRepo: { ...deps.cyclesRepo, listCyclesEligibleForAutoDraft: listSpy },
      };

      const result = await autoDraftDueRenewals(spiedDeps, {
        tenantId: tenant.ctx.slug,
        correlationId: randomUUID(),
      });

      expect(result.ok).toBe(true);
      // The load-bearing assertion: not merely "0 drafted" (which a thrown
      // error could also produce) but "the query was never called at all".
      expect(listSpy).not.toHaveBeenCalled();
    }, 120_000);

    it('A4: a tenant with NO settings row at all drafts nothing (absent ≠ enabled)', async () => {
      // `getAutoInvoiceSettings` returns null for a tenant that has never
      // been configured. Fail-closed is the only safe reading: a fresh
      // tenant onboarded mid-release must not start billing because a row
      // was missing rather than false.
      const fresh = await createTestTenant('test');
      try {
        const freshPlanId = `f8-t17-fresh-${randomUUID().slice(0, 8)}`;
        await runInTenant(fresh.ctx, (tx) =>
          seedF8MembershipPlan(tx, {
            tenantSlug: fresh.ctx.slug,
            planId: freshPlanId,
            planYear: 2025,
            planName: { en: 'Dark-Ship T17 Fresh Plan' },
            benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
            createdBy: user.userId,
          }),
        );
        // NOTE: no `seedTenantFiscal` → no `tenant_invoice_settings` row.
        const memberId = await seedMember(fresh, freshPlanId, true);
        await seedEligibleCycle(fresh, memberId, freshPlanId);

        const result = await runAutoDraft(fresh.ctx.slug);

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.drafted).toBe(0);
        expect(await countAutoRenewalInvoices(fresh)).toBe(0);
      } finally {
        await fresh.cleanup().catch(() => {});
      }
    }, 180_000);

    it('A5: POSITIVE CONTROL — all keys on over the same fixture shape DOES draft', async () => {
      // Without this, every assertion above could be passing because the
      // fixture is incapable of drafting at all. See the file header.
      await setAutoInvoiceEnabled(tenant, true);
      const memberId = await seedMember(tenant, planId, true);
      await seedEligibleCycle(tenant, memberId, planId);

      const result = await runAutoDraft(tenant.ctx.slug);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.drafted).toBeGreaterThanOrEqual(1);
      }
      // And what it produced really is a draft: no §87 number, still `draft`.
      const drafted = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select()
          .from(invoices)
          .where(
            and(
              eq(invoices.tenantId, tenant.ctx.slug),
              eq(invoices.memberId, memberId),
              eq(invoices.origin, 'auto_renewal'),
            ),
          ),
      );
      expect(drafted).toHaveLength(1);
      expect(drafted[0]!.status).toBe('draft');
      // `document_number` is the §87 sequential number — NULL until a human
      // issues it. Its absence is the whole "a draft bills nobody" claim.
      expect(drafted[0]!.documentNumber).toBeNull();
    }, 120_000);
  });

  // =========================================================================
  // § B — advisory-lock topology
  // =========================================================================
  //
  // READ THIS BEFORE "FIXING" ANYTHING HERE.
  //
  // The auto-draft path does NOT get its own advisory-lock namespace. It
  // takes `renewals:{tenantId}:{cycleId}` — the SAME per-cycle key used by
  // the other 12 cycle-mutating use-cases (13 in total call
  // `acquireCycleLockInTx`, including `confirmRenewal`,
  // `enterAwaitingPaymentOnExpiry`, `markPaidOffline` and
  // `issueAutoDraftedRenewal`).
  //
  // **That sharing is the safety property, not a contention bug.** The cron
  // and a member clicking "renew" in the portal mutate the SAME cycle row and
  // must serialise: if auto-draft were given a private namespace so it could
  // run "without contention", the cron could draft a renewal invoice at the
  // same moment `confirmRenewal` bills that member directly, and the member
  // gets two bills for one renewal. Anyone optimising this apparent
  // contention away would be introducing a double-billing race.
  //
  // (Task 17's brief asked for the opposite assertion — that a
  // `renewals:autodraft:*` namespace is disjoint from the per-cycle key. No
  // such namespace exists, and asserting its disjointness would have
  // mandated exactly the defect described above. The assertions below are
  // the inverted, correct form.)
  describe('§ B — advisory-lock topology', () => {
    const cycleKey = (tenantId: string, cycleId: string) =>
      `renewals:${tenantId}:${cycleId}`;

    async function tryLockFromAnotherSession(key: string): Promise<boolean> {
      // Runs on a DIFFERENT pooled connection from any open `runInTenant`
      // transaction, so a held xact-scoped lock shows up as contention.
      const rows = (await db.execute(
        sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS acquired`,
      )) as unknown as ReadonlyArray<{ acquired: boolean }>;
      return rows[0]!.acquired;
    }

    it('B1: auto-draft SHARES the per-cycle lock — a concurrent session is genuinely blocked', async () => {
      const memberId = await seedMember(tenant, planId, true);
      const cycleId = await seedEligibleCycle(tenant, memberId, planId);
      const deps = fixedClockDeps(tenant.ctx.slug);

      let contendedWhileHeld: boolean | undefined;

      await runInTenant(tenant.ctx, async (tx) => {
        // Acquire exactly the way the auto-draft use-case does — through the
        // repo method, not a hand-rolled key, so a change to the key
        // construction is caught here rather than silently diverging.
        await deps.cyclesRepo.acquireCycleLockInTx(
          tx,
          tenant.ctx.slug,
          asCycleId(cycleId),
        );
        contendedWhileHeld = !(await tryLockFromAnotherSession(
          cycleKey(tenant.ctx.slug, cycleId),
        ));
      });

      // Transaction-scoped: committing must release it.
      const freeAfterRelease = await tryLockFromAnotherSession(
        cycleKey(tenant.ctx.slug, cycleId),
      );

      expect(contendedWhileHeld).toBe(true);
      expect(freeAfterRelease).toBe(true);
    }, 120_000);

    it('B2: the per-cycle key is disjoint from coordinator-level and cross-module namespaces', async () => {
      const memberId = await seedMember(tenant, planId, true);
      const cycleId = await seedEligibleCycle(tenant, memberId, planId);
      const deps = fixedClockDeps(tenant.ctx.slug);

      // Namespaces that must NOT be blocked while a per-cycle lock is held:
      // the F8 coordinator-level locks and the other modules' locks. If any
      // of these contended, one member's renewal would stall an unrelated
      // whole-tenant cron pass or an F4/F5/F7 operation.
      const foreignKeys = [
        `renewals:dispatch:${tenant.ctx.slug}`,
        `renewals:enter-awaiting:${tenant.ctx.slug}`,
        `renewals:lapse:${tenant.ctx.slug}`,
        `renewals:reconcile:${tenant.ctx.slug}`,
        `renewals:at-risk:${tenant.ctx.slug}`,
        `renewals:tierupgrade:${tenant.ctx.slug}`,
        `invoicing:${tenant.ctx.slug}:membership:2026`,
        `payments:${tenant.ctx.slug}:${randomUUID()}`,
        `broadcasts:${tenant.ctx.slug}:${randomUUID()}`,
      ];

      const acquiredWhileCycleLockHeld: Record<string, boolean> = {};
      await runInTenant(tenant.ctx, async (tx) => {
        await deps.cyclesRepo.acquireCycleLockInTx(
          tx,
          tenant.ctx.slug,
          asCycleId(cycleId),
        );
        for (const key of foreignKeys) {
          acquiredWhileCycleLockHeld[key] = await tryLockFromAnotherSession(key);
        }
      });

      for (const key of foreignKeys) {
        expect(acquiredWhileCycleLockHeld[key]).toBe(true);
      }
    }, 120_000);

    it('B3: STRUCTURAL COLLISION — a tenant slug of literally `dispatch` aliases onto the dispatch coordinator key', async () => {
      // Assert-by-construction, no DB needed. Both keys are built by string
      // concatenation into the same `renewals:` namespace with no escaping:
      //
      //   per-cycle : `renewals:{tenantId}:{cycleId}`
      //   dispatch  : `renewals:dispatch:{tenantId}`
      //
      // so a tenant whose slug is `dispatch` produces per-cycle keys that
      // are indistinguishable from the dispatch-coordinator key of the
      // tenant named by that cycleId. The consequence is a spurious
      // cross-tenant stall (one tenant's cycle lock blocking another
      // tenant's whole dispatch pass), not data corruption — but it would
      // present as an unreproducible cron hang, which is about the worst
      // shape a bug can have.
      //
      // Remote today: slugs are chamber names and cycleIds are UUIDs, so
      // the alias needs a tenant literally named `dispatch` AND another
      // tenant whose slug is a UUID matching a cycle. Asserting it costs
      // nothing and documents the constraint that keeps it remote — if
      // tenant slugs ever become user-chosen, this is the test that says
      // why `dispatch` (and `lapse`, `reconcile`, `at-risk`, …) must be
      // reserved.
      const COLLIDING_CYCLE_ID = 'acme-chamber';
      const perCycleKeyForDispatchTenant = cycleKey('dispatch', COLLIDING_CYCLE_ID);
      const dispatchCoordinatorKeyForAcme = `renewals:dispatch:${COLLIDING_CYCLE_ID}`;

      expect(perCycleKeyForDispatchTenant).toBe(dispatchCoordinatorKeyForAcme);

      // ...and the same construction is collision-FREE for ordinary slugs,
      // which is why this is a latent constraint rather than a live bug.
      expect(cycleKey('acme-chamber', randomUUID())).not.toBe(
        `renewals:dispatch:acme-chamber`,
      );
    });
  });

  // =========================================================================
  // § C — cross-tenant scoping
  // =========================================================================
  describe('§ C — cross-tenant scoping', () => {
    it('C1: a peer tenant’s enrolled, due member is never drafted by this tenant’s pass', async () => {
      // Both tenants fully enabled — so the ONLY thing keeping the peer's
      // member out of this pass is tenant scoping, not a disabled key.
      await setAutoInvoiceEnabled(tenant, true);
      await setAutoInvoiceEnabled(peer, true);

      const peerMemberId = await seedMember(peer, peerPlanId, true);
      await seedEligibleCycle(peer, peerMemberId, peerPlanId);

      const peerBefore = await countAutoRenewalInvoices(peer);
      await runAutoDraft(tenant.ctx.slug);

      // The peer's invoice count is untouched by this tenant's pass...
      expect(await countAutoRenewalInvoices(peer)).toBe(peerBefore);
      // ...and specifically, no invoice exists for the peer's member.
      const peerMemberInvoices = await runInTenant(peer.ctx, (tx) =>
        tx
          .select()
          .from(invoices)
          .where(
            and(
              eq(invoices.tenantId, peer.ctx.slug),
              eq(invoices.memberId, peerMemberId),
            ),
          ),
      );
      expect(peerMemberInvoices).toHaveLength(0);
    }, 180_000);

    it('C2: the peer’s OWN pass still drafts it — C1 passed for the right reason', async () => {
      // C1 alone would also pass if the peer fixture were simply
      // undraftable. Run the peer's own pass and require a draft, which
      // proves C1's zero came from tenant scoping.
      await setAutoInvoiceEnabled(peer, true);
      const result = await runAutoDraft(peer.ctx.slug);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.drafted).toBeGreaterThanOrEqual(1);
      expect(await countAutoRenewalInvoices(peer)).toBeGreaterThanOrEqual(1);
    }, 180_000);
  });
});
