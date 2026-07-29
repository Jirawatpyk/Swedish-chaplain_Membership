/**
 * 107-auto-invoice Task 7 — `autoDraftDueRenewals` integration test (live
 * Neon).
 *
 * Verifies the daily auto-draft cron worker body on real Postgres + RLS:
 *
 *   (a) an enrolled, due member with an ANCHORED `upcoming` cycle (the
 *       rolling-anchor shape every real auto-draft candidate has) → exactly
 *       1 `drafted`, `origin='auto_renewal'`, correct coverage window +
 *       frozen price + `autoEmailOnIssue=false` explicit, NO §87 number /
 *       PDF / outbox row, a `renewal_auto_drafted` audit row with the
 *       correct payload. The `membershipCoverage` window IS exercised here
 *       (T5's own bridge test omitted that path).
 *   (b) re-run over the SAME cycle → no second draft (idempotent — Task 6's
 *       own coarse member-wide dedup already excludes the cycle from the
 *       eligibility list once a draft exists, so `cyclesProcessed` drops to
 *       0 on the second call).
 *   (c) a member whose MOST-RECENT cycle (by `created_at`) is `lapsed` —
 *       even though an OLDER `upcoming` cycle would otherwise be eligible —
 *       resolves `terminated` via `deriveMembershipAccess` →
 *       `skippedTerminated`, no draft (the membership-access re-assert).
 *   (d) batch isolation — stub the bridge to reject for ONE member
 *       mid-batch → that member counts in `errors`, the other member still
 *       drafts successfully, and the invariant `drafted + skippedExisting +
 *       skippedRaceLost + skippedTerminated + errors === cyclesProcessed`
 *       holds.
 *   (e) Review M1 — a cycle whose status DRIFTED between the eligibility-
 *       list query and the per-cycle lock acquisition (stubbed
 *       `cyclesRepo.findByIdInTx`, simulating a concurrent
 *       `confirmRenewal` self-transition or admin cancel) → `skippedRaceLost`,
 *       `drafted: 0`, no invoice created.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { deriveFiscalYear } from '@/lib/fiscal-year';
import { addMonthsUtc } from '@/lib/dates';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { notificationsOutbox } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { autoDraftDueRenewals, makeRenewalsDeps } from '@/modules/renewals';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const NOW = new Date('2026-07-15T00:00:00.000Z');

async function enableAutoInvoice(
  t: TestTenant,
  opts?: {
    readonly leadDaysRolling?: number;
    readonly leadDaysCalendar?: number;
  },
): Promise<void> {
  await seedTenantFiscal({ tenant: t, invoiceNumberPrefix: 'SC', receiptNumberPrefix: 'RC' });
  await runInTenant(t.ctx, (tx) =>
    tx
      .update(tenantInvoiceSettings)
      .set({
        autoInvoiceEnabled: true,
        autoInvoiceLeadDaysRolling: opts?.leadDaysRolling ?? 30,
        autoInvoiceLeadDaysCalendar: opts?.leadDaysCalendar ?? 31,
        autoInvoicePageSize: 200,
      })
      .where(eq(tenantInvoiceSettings.tenantId, t.ctx.slug)),
  );
}

interface SeedMemberOpts {
  readonly t: TestTenant;
  readonly planId: string;
  readonly enrolled?: boolean;
}

async function seedMember(opts: SeedMemberOpts): Promise<string> {
  const memberId = randomUUID();
  await runInTenant(opts.t.ctx, (tx) =>
    tx.insert(members).values({
      tenantId: opts.t.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `Auto-Draft T7 Co ${memberId.slice(0, 6)}`,
      country: 'TH' as const,
      planId: opts.planId,
      // Matches the seeded membership_plans row's planYear (2025) — see
      // the plan-seed comment in `beforeAll` for why 2025, not 2026.
      planYear: 2025,
      billingCycle: 'rolling',
      autoInvoiceEnrolledAt:
        opts.enrolled === false ? null : new Date('2026-01-01T00:00:00Z'),
    }),
  );
  return memberId;
}

interface SeedEligibleCycleOpts {
  readonly t: TestTenant;
  readonly memberId: string;
  readonly planId: string;
  /** ISO 8601 UTC — cycle start. `periodTo`/`expiresAt` = +12 months. */
  readonly periodFrom: string;
  readonly frozenPlanPriceThb?: string;
  /** Defaults to `periodFrom` — the rolling-anchor shape (anchored=renewal, not first_payment). */
  readonly anchoredAt?: string;
  /**
   * A-2 defensive-gate coverage — when true, insert the cycle UN-anchored
   * (`anchored_at = NULL`) with no settled predecessor, so
   * `classifyMembershipPayment` resolves `'first_payment'`
   * (`settledCycleCount===0 && anchoredAt===null`). This is the shape an
   * imported active member has when the R4 backfill
   * (`scripts/backfill-cycle-anchors.ts`) skipped their row (unmatched /
   * ambiguous company name, no CSV row, future-dated payment). Wins over
   * `anchoredAt`.
   */
  readonly firstPayment?: boolean;
  /**
   * Explicit `created_at` override. Omitted → DB default (`now()` = real
   * wall-clock test-run time, which can be LATER than a fixture's other
   * explicit-dated rows) — pass this whenever a test needs deterministic
   * `created_at DESC` ordering against another cycle for the same member
   * (`findLatestCycleForMemberInTx`'s tiebreak key).
   */
  readonly createdAt?: string;
}

/**
 * Seeds an `upcoming` cycle in the ANCHORED rolling-anchor shape every
 * real auto-draft candidate has (it exists BECAUSE a prior payment
 * anchored it) — `anchoredAt` non-null so `classifyMembershipPayment`
 * resolves `'renewal'` (not `'first_payment'`), exercising the
 * `membershipCoverage` window path. Pass `firstPayment: true` to instead
 * seed the UN-anchored first-payment shape (see `SeedEligibleCycleOpts`).
 */
async function seedEligibleCycle(
  opts: SeedEligibleCycleOpts,
): Promise<{ readonly cycleId: string; readonly periodTo: Date }> {
  const cycleId = randomUUID();
  const periodFrom = new Date(opts.periodFrom);
  const periodTo = new Date(periodFrom);
  periodTo.setUTCMonth(periodTo.getUTCMonth() + 12);
  await runInTenant(opts.t.ctx, (tx) =>
    tx.insert(renewalCycles).values({
      tenantId: opts.t.ctx.slug,
      cycleId,
      memberId: opts.memberId,
      status: 'upcoming',
      periodFrom,
      periodTo,
      expiresAt: periodTo,
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular',
      planIdAtCycleStart: opts.planId,
      frozenPlanPriceThb: opts.frozenPlanPriceThb ?? '50000.00',
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB',
      anchoredAt: opts.firstPayment
        ? null
        : new Date(opts.anchoredAt ?? opts.periodFrom),
      ...(opts.createdAt ? { createdAt: new Date(opts.createdAt) } : {}),
    }),
  );
  return { cycleId, periodTo };
}

async function outboxCountForInvoice(
  t: TestTenant,
  invoiceId: string,
): Promise<number> {
  const rows = await db
    .select()
    .from(notificationsOutbox)
    .where(
      and(
        eq(notificationsOutbox.tenantId, t.ctx.slug),
        eq(notificationsOutbox.notificationType, 'invoice_auto_email'),
      ),
    );
  return rows.filter(
    (r) => (r.contextData as Record<string, unknown>).invoice_id === invoiceId,
  ).length;
}

describe('107-auto-invoice Task 7 — autoDraftDueRenewals (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test');
    planId = `f8-t7-plan-${randomUUID().slice(0, 8)}`;
    // KEY: planYear=2025 — every seeded cycle's `periodFrom` (2025-08-01)
    // derives `deriveFiscalYear(periodFrom)=2025` (Jan-start fiscal year,
    // default `fiscalYearStartMonth`), and `createInvoiceDraft`'s
    // `(plan_id, plan_year)` composite FK requires a real
    // `membership_plans` row at THAT year, not the cycle's periodTo
    // calendar year (2026) — see the module docstring's KEY constraint.
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planYear: 2025,
        planName: { en: 'Auto-Draft T7 Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
    await enableAutoInvoice(tenant);
  }, 180_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  }, 60_000);

  // Shared across (a) + (b) — (b) re-runs against the SAME cycle (a) drafted.
  let memberA: string;
  let cycleA: string;
  let periodToA: Date;
  let invoiceIdA: string;

  it('(a) enrolled due member → exactly 1 draft, correct window + price, no number/PDF/outbox, audit row', async () => {
    memberA = await seedMember({ t: tenant, planId });
    const seeded = await seedEligibleCycle({
      t: tenant,
      memberId: memberA,
      planId,
      periodFrom: '2025-08-01T00:00:00Z', // period_to = 2026-08-01, ~17d from NOW → within 30d rolling lead window
    });
    cycleA = seeded.cycleId;
    periodToA = seeded.periodTo;

    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const fixedDeps = { ...deps, clock: { now: () => NOW } };

    const result = await autoDraftDueRenewals(fixedDeps, {
      tenantId: tenant.ctx.slug,
      correlationId: randomUUID(),
    });

    expect(result.ok, result.ok ? 'ok' : `err: ${JSON.stringify(result)}`).toBe(true);
    if (!result.ok) return;
    expect(result.value.cyclesProcessed).toBe(1);
    expect(result.value.drafted).toBe(1);
    expect(result.value.skippedExisting).toBe(0);
    expect(result.value.skippedRaceLost).toBe(0);
    expect(result.value.skippedTerminated).toBe(0);
    expect(result.value.errors).toBe(0);

    // --- invoice row -------------------------------------------------
    const [invRow] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          invoiceId: invoices.invoiceId,
          status: invoices.status,
          origin: invoices.origin,
          autoEmailOnIssue: invoices.autoEmailOnIssue,
          planYear: invoices.planYear,
          billDocumentNumberRaw: invoices.billDocumentNumberRaw,
          documentNumber: invoices.documentNumber,
          pdfBlobKey: invoices.pdfBlobKey,
        })
        .from(invoices)
        .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.memberId, memberA))),
    );
    expect(invRow).toBeDefined();
    if (!invRow) return;
    invoiceIdA = invRow.invoiceId;
    expect(invRow.status).toBe('draft');
    expect(invRow.origin).toBe('auto_renewal');
    expect(invRow.autoEmailOnIssue).toBe(false);
    expect(invRow.billDocumentNumberRaw).toBeNull();
    expect(invRow.documentNumber).toBeNull();
    expect(invRow.pdfBlobKey).toBeNull();
    // KEY constraint — planYear derived from periodFrom (deriveFiscalYear),
    // matching confirm-renewal.ts EXACTLY (not the design doc's periodTo
    // wording — see task report).
    expect(invRow.planYear).toBe(deriveFiscalYear('2025-08-01T00:00:00Z'));
    // `subtotalSatang` is NOT populated at DRAFT time (`createInvoiceDraft`
    // never writes it — only `issueInvoice` finalises totals); the frozen
    // price is instead proven via the `renewal_auto_drafted` audit
    // payload's `frozen_price_thb` below.

    // --- cycle stamped with the draft invoice id ----------------------
    const [cycleRow] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ autoDraftInvoiceId: renewalCycles.autoDraftInvoiceId })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleA)),
    );
    expect(cycleRow?.autoDraftInvoiceId).toBe(invoiceIdA);

    // --- audit row: renewal_auto_drafted, correct window --------------
    const expectedCoverageFrom = periodToA.toISOString().slice(0, 10);
    const expectedCoverageTo = addMonthsUtc(periodToA.toISOString(), 12).slice(0, 10);
    const auditRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ eventType: auditLog.eventType, payload: auditLog.payload })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'renewal_auto_drafted' as never),
          ),
        ),
    );
    expect(auditRows.length).toBe(1);
    expect(auditRows[0]?.payload).toMatchObject({
      cycle_id: cycleA,
      member_id: memberA,
      plan_year: deriveFiscalYear('2025-08-01T00:00:00Z'),
      frozen_price_thb: '50000.00',
      coverage_from: expectedCoverageFrom,
      coverage_to: expectedCoverageTo,
    });

    // --- A-2 renewal regression: dup-guard window on invoices.coverage_from/to --
    // A renewal-classified (ANCHORED) cycle stamps the NEXT-period window
    // [periodTo, periodTo+term) — the period this renewal charges. This is the
    // branch the A-2 gate leaves UNCHANGED (byte-identical before/after the fix);
    // asserting it here guards against the gate accidentally regressing renewals.
    const [covRowA] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          coverageFrom: invoices.coverageFrom,
          coverageTo: invoices.coverageTo,
        })
        .from(invoices)
        .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.memberId, memberA))),
    );
    expect(covRowA?.coverageFrom?.toISOString()).toBe(periodToA.toISOString());
    expect(covRowA?.coverageTo?.toISOString()).toBe(
      addMonthsUtc(periodToA.toISOString(), 12),
    );

    // --- no email --------------------------------------------------
    expect(await outboxCountForInvoice(tenant, invoiceIdA)).toBe(0);
  }, 60_000);

  it('(b) re-run over the same cycle → no second draft (dedup)', async () => {
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const fixedDeps = { ...deps, clock: { now: () => NOW } };

    const result = await autoDraftDueRenewals(fixedDeps, {
      tenantId: tenant.ctx.slug,
      correlationId: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The cycle is no longer even LISTED (Task 6's coarse member-wide
    // dedup already excludes a member with a live draft/issued
    // membership invoice) — the strongest possible proof of "no second
    // draft": the cron does not even attempt this member again.
    expect(result.value.cyclesProcessed).toBe(0);
    expect(result.value.drafted).toBe(0);

    const invRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ invoiceId: invoices.invoiceId })
        .from(invoices)
        .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.memberId, memberA))),
    );
    expect(invRows.length).toBe(1);
    expect(invRows[0]?.invoiceId).toBe(invoiceIdA);
  }, 60_000);

  it('(c) member whose MOST-RECENT cycle is lapsed → skippedTerminated, no draft', async () => {
    const memberC = await seedMember({ t: tenant, planId });
    // Older (by created_at), otherwise-eligible `upcoming` cycle. Explicit
    // EARLY `createdAt` — the DB default (`now()`, real wall-clock test
    // time) would otherwise be LATER than the lapsed cycle's explicit
    // `createdAt` below, inverting the intended `created_at DESC` order.
    await seedEligibleCycle({
      t: tenant,
      memberId: memberC,
      planId,
      periodFrom: '2025-08-01T00:00:00Z',
      createdAt: '2020-01-01T00:00:00Z',
    });
    // A NEWER (by created_at) `lapsed` cycle for the SAME member — the
    // member's true current membership-access state per
    // `findLatestCycleForMemberInTx` (created_at DESC). Mirrors the
    // exact seed shape `find-latest-cycle-for-member.test.ts` uses to
    // prove the same predicate.
    const lapsedCycleId = randomUUID();
    const lapsedPeriodFrom = new Date('2026-01-01T00:00:00Z');
    const lapsedPeriodTo = new Date('2027-01-01T00:00:00Z');
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: lapsedCycleId,
        memberId: memberC,
        status: 'lapsed',
        periodFrom: lapsedPeriodFrom,
        periodTo: lapsedPeriodTo,
        expiresAt: lapsedPeriodTo,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        createdAt: new Date('2020-06-01T00:00:00Z'), // after the upcoming cycle's explicit 2020-01-01 createdAt above
        closedAt: new Date('2020-06-01T00:00:00Z'),
        closedReason: 'grace_expired',
      }),
    );

    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const fixedDeps = { ...deps, clock: { now: () => NOW } };

    const result = await autoDraftDueRenewals(fixedDeps, {
      tenantId: tenant.ctx.slug,
      correlationId: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cyclesProcessed).toBe(1);
    expect(result.value.drafted).toBe(0);
    expect(result.value.skippedTerminated).toBe(1);
    expect(result.value.errors).toBe(0);

    const invRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ invoiceId: invoices.invoiceId })
        .from(invoices)
        .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.memberId, memberC))),
    );
    expect(invRows.length).toBe(0);
  }, 60_000);

  it('(d) batch isolation — bridge rejects for one member, others still draft', async () => {
    const batchTenant = await createTestTenant('test-chamber');
    try {
      const batchPlanId = `f8-t7-batch-${randomUUID().slice(0, 8)}`;
      await runInTenant(batchTenant.ctx, (tx) =>
        seedF8MembershipPlan(tx, {
          tenantSlug: batchTenant.ctx.slug,
          planId: batchPlanId,
          planYear: 2025,
          planName: { en: 'Auto-Draft T7 Batch Plan' },
          benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
          createdBy: user.userId,
        }),
      );
      await enableAutoInvoice(batchTenant);

      const memberGood = await seedMember({ t: batchTenant, planId: batchPlanId });
      const memberBad = await seedMember({ t: batchTenant, planId: batchPlanId });
      await seedEligibleCycle({
        t: batchTenant,
        memberId: memberGood,
        planId: batchPlanId,
        periodFrom: '2025-08-01T00:00:00Z',
      });
      await seedEligibleCycle({
        t: batchTenant,
        memberId: memberBad,
        planId: batchPlanId,
        periodFrom: '2025-08-01T00:00:00Z',
      });

      const realDeps = makeRenewalsDeps(batchTenant.ctx.slug);
      const wrappedBridge: typeof realDeps.f4InvoicingBridge = {
        ...realDeps.f4InvoicingBridge,
        draftInvoiceForRenewal: async (input) => {
          if (input.memberId === memberBad) {
            throw new Error('simulated bridge failure — batch isolation test');
          }
          return realDeps.f4InvoicingBridge.draftInvoiceForRenewal(input);
        },
      };
      const deps = {
        ...realDeps,
        f4InvoicingBridge: wrappedBridge,
        clock: { now: () => NOW },
      };

      const result = await autoDraftDueRenewals(deps, {
        tenantId: batchTenant.ctx.slug,
        correlationId: randomUUID(),
      });
      expect(result.ok, result.ok ? 'ok' : `err: ${JSON.stringify(result)}`).toBe(true);
      if (!result.ok) return;
      expect(result.value.cyclesProcessed).toBe(2);
      expect(result.value.drafted).toBe(1);
      expect(result.value.errors).toBe(1);
      // Invariant.
      expect(
        result.value.drafted +
          result.value.skippedExisting +
          result.value.skippedRaceLost +
          result.value.skippedTerminated +
          result.value.errors,
      ).toBe(result.value.cyclesProcessed);

      const goodInv = await runInTenant(batchTenant.ctx, (tx) =>
        tx
          .select({ invoiceId: invoices.invoiceId })
          .from(invoices)
          .where(
            and(eq(invoices.tenantId, batchTenant.ctx.slug), eq(invoices.memberId, memberGood)),
          ),
      );
      expect(goodInv.length).toBe(1);

      const badInv = await runInTenant(batchTenant.ctx, (tx) =>
        tx
          .select({ invoiceId: invoices.invoiceId })
          .from(invoices)
          .where(
            and(eq(invoices.tenantId, batchTenant.ctx.slug), eq(invoices.memberId, memberBad)),
          ),
      );
      expect(badInv.length).toBe(0);
    } finally {
      await batchTenant.cleanup().catch(() => {});
    }
  }, 60_000);

  it('(e) cycle status drifts between the list query and lock acquisition → skippedRaceLost, no draft (Review M1)', async () => {
    // Dedicated, fresh tenant (mirrors test (d)'s isolation strategy) — the
    // shared `tenant` above has accumulated an un-drafted eligible cycle
    // from test (c) (memberC's cycle stays `upcoming`/eligible forever
    // since it never drafts), which would otherwise inflate this test's
    // exact `cyclesProcessed` count.
    const raceTenant = await createTestTenant('test-chamber');
    try {
      const racePlanId = `f8-t7-race-${randomUUID().slice(0, 8)}`;
      await runInTenant(raceTenant.ctx, (tx) =>
        seedF8MembershipPlan(tx, {
          tenantSlug: raceTenant.ctx.slug,
          planId: racePlanId,
          planYear: 2025,
          planName: { en: 'Auto-Draft T7 Race Plan' },
          benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
          createdBy: user.userId,
        }),
      );
      await enableAutoInvoice(raceTenant);

      const memberE = await seedMember({ t: raceTenant, planId: racePlanId });
      const { cycleId: cycleE } = await seedEligibleCycle({
        t: raceTenant,
        memberId: memberE,
        planId: racePlanId,
        periodFrom: '2025-08-01T00:00:00Z',
      });

      const realDeps = makeRenewalsDeps(raceTenant.ctx.slug);
      // Simulates the exact real-world trigger for this branch: a
      // concurrent `confirmRenewal` self-transition (or admin cancel)
      // flips the cycle's status in the window between the eligibility-
      // list query and this cycle's per-cycle lock acquisition.
      // `findByIdInTx` is the tx-bound re-read `processOne` calls
      // immediately after acquiring the lock — stubbing it to report a
      // drifted status for THIS cycle id only deterministically exercises
      // the race-lost branch without needing real concurrency.
      const wrappedCyclesRepo: typeof realDeps.cyclesRepo = {
        ...realDeps.cyclesRepo,
        findByIdInTx: async (tx, tid, cid) => {
          const real = await realDeps.cyclesRepo.findByIdInTx(tx, tid, cid);
          if (real && cid === cycleE) {
            return {
              ...real,
              status: 'cancelled' as const,
              enteredPendingAt: null,
              closedAt: new Date().toISOString(),
              closedReason: 'cancelled' as const,
            };
          }
          return real;
        },
      };
      const deps = {
        ...realDeps,
        cyclesRepo: wrappedCyclesRepo,
        clock: { now: () => NOW },
      };

      const result = await autoDraftDueRenewals(deps, {
        tenantId: raceTenant.ctx.slug,
        correlationId: randomUUID(),
      });
      expect(result.ok, result.ok ? 'ok' : `err: ${JSON.stringify(result)}`).toBe(true);
      if (!result.ok) return;
      expect(result.value.cyclesProcessed).toBe(1);
      expect(result.value.drafted).toBe(0);
      expect(result.value.skippedRaceLost).toBe(1);
      expect(result.value.skippedExisting).toBe(0);
      expect(result.value.skippedTerminated).toBe(0);
      expect(result.value.errors).toBe(0);

      const invRows = await runInTenant(raceTenant.ctx, (tx) =>
        tx
          .select({ invoiceId: invoices.invoiceId })
          .from(invoices)
          .where(
            and(eq(invoices.tenantId, raceTenant.ctx.slug), eq(invoices.memberId, memberE)),
          ),
      );
      expect(invRows.length).toBe(0);
    } finally {
      await raceTenant.cleanup().catch(() => {});
    }
  }, 60_000);

  it('(f) A-2 — first-payment upcoming cycle (imported member not re-anchored) → dup-guard window is the CURRENT period [periodFrom, periodTo), NOT next-period', async () => {
    // A brand-new member created via the admin "New member" form is born
    // `awaiting_payment` (design §5.3) and can NEVER be auto-drafted while
    // first-payment. But an IMPORTED active member (scripts/import-members.ts)
    // is born `upcoming` with `anchored_at NULL`; if the one-off R4 backfill
    // (scripts/backfill-cycle-anchors.ts) skipped their row — unmatched /
    // ambiguous company name, missing CSV row, future-dated payment — the cycle
    // STAYS un-anchored and `classifyMembershipPayment` resolves `first_payment`
    // while the cycle is `upcoming`. That real production path reaches the
    // auto-draft cron, exercising the A-2 defensive gate directly.
    const fpTenant = await createTestTenant('test-chamber');
    try {
      const fpPlanId = `f8-t7-fp-${randomUUID().slice(0, 8)}`;
      await runInTenant(fpTenant.ctx, (tx) =>
        seedF8MembershipPlan(tx, {
          tenantSlug: fpTenant.ctx.slug,
          planId: fpPlanId,
          planYear: 2025,
          planName: { en: 'Auto-Draft T7 First-Payment Plan' },
          benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
          createdBy: user.userId,
        }),
      );
      await enableAutoInvoice(fpTenant);

      const memberF = await seedMember({ t: fpTenant, planId: fpPlanId });
      const periodFromF = '2025-08-01T00:00:00Z'; // period_to = 2026-08-01, ~17d from NOW → within 30d rolling lead window
      const seededF = await seedEligibleCycle({
        t: fpTenant,
        memberId: memberF,
        planId: fpPlanId,
        periodFrom: periodFromF,
        firstPayment: true, // anchored_at NULL, no predecessor → classifies first_payment
      });

      const realDeps = makeRenewalsDeps(fpTenant.ctx.slug);
      const deps = { ...realDeps, clock: { now: () => NOW } };

      const result = await autoDraftDueRenewals(deps, {
        tenantId: fpTenant.ctx.slug,
        correlationId: randomUUID(),
      });
      expect(result.ok, result.ok ? 'ok' : `err: ${JSON.stringify(result)}`).toBe(true);
      if (!result.ok) return;
      // full-access upcoming cycle → drafts (the defensive gate does not skip it,
      // it only changes WHICH coverage window is stamped).
      expect(result.value.cyclesProcessed).toBe(1);
      expect(result.value.drafted).toBe(1);
      expect(result.value.skippedTerminated).toBe(0);
      expect(result.value.errors).toBe(0);

      const [covRow] = await runInTenant(fpTenant.ctx, (tx) =>
        tx
          .select({
            status: invoices.status,
            origin: invoices.origin,
            coverageFrom: invoices.coverageFrom,
            coverageTo: invoices.coverageTo,
          })
          .from(invoices)
          .where(and(eq(invoices.tenantId, fpTenant.ctx.slug), eq(invoices.memberId, memberF))),
      );
      expect(covRow).toBeDefined();
      if (!covRow) return;
      expect(covRow.status).toBe('draft');
      expect(covRow.origin).toBe('auto_renewal');
      // A-2 — the dup-guard window is the cycle's OWN current period
      // [periodFrom, periodTo), MIRRORING confirm-renewal L3 /
      // admin-renew-lapsed-member:596 / offline A-1 — NOT the next-period
      // [periodTo, periodTo+term) window (which, once this draft is ISSUED,
      // would false-refuse the member's genuine first renewal at the DB EXCLUDE:
      // the L2/L3 over-block). Half-open [periodFrom, periodTo) is adjacent to
      // the next renewal window, so it never over-blocks.
      expect(covRow.coverageFrom?.toISOString()).toBe(new Date(periodFromF).toISOString());
      expect(covRow.coverageTo?.toISOString()).toBe(seededF.periodTo.toISOString());
    } finally {
      await fpTenant.cleanup().catch(() => {});
    }
  }, 60_000);
});
