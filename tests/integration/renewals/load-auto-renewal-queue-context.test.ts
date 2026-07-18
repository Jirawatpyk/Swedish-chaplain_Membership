/**
 * 107-auto-invoice Task 13 — `loadAutoRenewalQueueContext` integration test
 * (live Neon). Verifies the three per-row decision signals the admin
 * review-queue view needs:
 *
 *   (a) drift    — a cycle whose `frozenPlanPriceThb` differs from the
 *                  CURRENT active plan-catalogue price for (planId,
 *                  planYear) → `driftFlagged: true` + the two prices surfaced.
 *   (a2) no drift — frozen price matches the catalogue exactly → `false`.
 *   (b) bill-year ≠ coverage-year — a cycle straddling a fiscal-year edge
 *                  (periodFrom FY2025, periodTo FY2026) → the note fires.
 *   (c) would-be-refused — a member with a pre-existing LIVE (`issued`)
 *                  membership bill for the same plan_year → `wouldBeRefused:
 *                  true` naming the conflicting invoice; a SIBLING
 *                  `auto_renewal` DRAFT for the same (member, planYear) must
 *                  NOT trip the same prediction (mirrors the real guard's
 *                  discard-before-check sequence).
 *   (d) orphan   — a draft with no stamped cycle (Task 7's "orphaned after
 *                  commit" window) → `driftFlagged: true`, `cycleId: null`,
 *                  never a throw.
 *
 * Lives in tests/integration/** → hits live Neon via runInTenant (RLS);
 * seeds with `tx` from runInTenant, never the global db singleton.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { deriveFiscalYear } from '@/lib/fiscal-year';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import {
  loadAutoRenewalQueueContext,
  makeAutoRenewalQueueContextDeps,
  makeRenewalsDeps,
} from '@/modules/renewals';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

/** `deriveFiscalYear` defaults to a Jan-start FY (matches this suite's tenant). */
const PERIOD_FROM_FY2025 = '2025-08-01T00:00:00Z';
const PLAN_YEAR = deriveFiscalYear(PERIOD_FROM_FY2025);

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
      companyName: `Queue Ctx Co ${memberId.slice(0, 6)}`,
      country: 'TH' as const,
      taxId: '9999999999999',
      addressLine1: '99 Rama IV Road',
      city: 'Sathon',
      province: 'Bangkok',
      postalCode: '10120',
      planId,
      planYear: PLAN_YEAR,
      billingCycle: 'rolling',
      autoInvoiceEnrolledAt: new Date('2026-01-01T00:00:00Z'),
    }),
  );
  return memberId;
}

/** Seeds a renewal_cycles row with the given frozen price + period window. */
async function seedCycle(opts: {
  readonly memberId: string;
  readonly frozenPlanPriceThb: string;
  readonly periodFrom: string;
  readonly periodTo: string;
}): Promise<string> {
  const cycleId = randomUUID();
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(renewalCycles).values({
      tenantId: tenant.ctx.slug,
      cycleId,
      memberId: opts.memberId,
      status: 'upcoming',
      periodFrom: new Date(opts.periodFrom),
      periodTo: new Date(opts.periodTo),
      expiresAt: new Date(opts.periodTo),
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular',
      planIdAtCycleStart: planId,
      frozenPlanPriceThb: opts.frozenPlanPriceThb,
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB',
      anchoredAt: new Date(opts.periodFrom),
    }),
  );
  return cycleId;
}

/** Creates a genuine `origin='auto_renewal'` draft via the T5 bridge and
 *  (optionally) stamps it onto a cycle — the exact shape Task 7's cron
 *  produces. */
async function seedAutoDraft(opts: {
  readonly memberId: string;
  readonly planYear: number;
  readonly frozenPlanPriceThb: string;
  readonly cycleId: string | null;
}): Promise<string> {
  const deps = makeRenewalsDeps(tenant.ctx.slug);
  const drafted = await deps.f4InvoicingBridge.draftInvoiceForRenewal({
    tenantId: tenant.ctx.slug,
    memberId: opts.memberId,
    planId,
    planYear: opts.planYear,
    frozenPlanPriceThb: opts.frozenPlanPriceThb as never,
    actorUserId: user.userId,
    requestId: null,
  });
  if (drafted.status !== 'drafted') {
    throw new Error(`fixture draft failed: ${JSON.stringify(drafted)}`);
  }
  if (opts.cycleId !== null) {
    const cycleId = opts.cycleId;
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(renewalCycles)
        .set({ autoDraftInvoiceId: drafted.invoiceId })
        .where(eq(renewalCycles.cycleId, cycleId)),
    );
  }
  return drafted.invoiceId;
}

describe('107-auto-invoice Task 13 — loadAutoRenewalQueueContext (live Neon)', () => {
  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test');
    planId = `f8-t13-plan-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planYear: PLAN_YEAR,
        planName: { en: 'Queue Ctx Plan' },
        // CURRENT catalogue price — 60,000.00 THB (6,000,000 satang). The
        // drift scenario seeds a cycle frozen at 50,000.00 to diverge from
        // this; the no-drift scenario seeds a cycle frozen at exactly this.
        annualFeeMinorUnits: 6_000_000,
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
    await seedTenantFiscal({
      tenant,
      invoiceNumberPrefix: 'SC',
      receiptNumberPrefix: 'RC',
    });
  }, 180_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  }, 60_000);

  it('(a) frozen price ≠ current catalogue price → driftFlagged:true, both prices surfaced', async () => {
    const memberId = await seedMember();
    const periodFrom = PERIOD_FROM_FY2025;
    const periodTo = '2026-08-01T00:00:00Z';
    const cycleId = await seedCycle({
      memberId,
      frozenPlanPriceThb: '50000.00',
      periodFrom,
      periodTo,
    });
    const invoiceId = await seedAutoDraft({
      memberId,
      planYear: PLAN_YEAR,
      frozenPlanPriceThb: '50000.00',
      cycleId,
    });

    const result = await loadAutoRenewalQueueContext(
      makeAutoRenewalQueueContextDeps(tenant.ctx.slug),
      {
        tenantId: tenant.ctx.slug,
        rows: [{ invoiceId, memberId, planId, planYear: PLAN_YEAR }],
      },
    );
    expect(result.ok, result.ok ? 'ok' : JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    const meta = result.value.get(invoiceId);
    expect(meta).toBeDefined();
    expect(meta?.cycleId).toBe(cycleId);
    expect(meta?.driftFlagged).toBe(true);
    expect(meta?.frozenPriceThb).toBe('50000.00');
    expect(meta?.currentCataloguePriceThb).toBe('60000.00');
  }, 60_000);

  it('(a2) frozen price === current catalogue price → driftFlagged:false', async () => {
    const memberId = await seedMember();
    const periodFrom = PERIOD_FROM_FY2025;
    const periodTo = '2026-08-01T00:00:00Z';
    const cycleId = await seedCycle({
      memberId,
      frozenPlanPriceThb: '60000.00',
      periodFrom,
      periodTo,
    });
    const invoiceId = await seedAutoDraft({
      memberId,
      planYear: PLAN_YEAR,
      frozenPlanPriceThb: '60000.00',
      cycleId,
    });

    const result = await loadAutoRenewalQueueContext(
      makeAutoRenewalQueueContextDeps(tenant.ctx.slug),
      {
        tenantId: tenant.ctx.slug,
        rows: [{ invoiceId, memberId, planId, planYear: PLAN_YEAR }],
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const meta = result.value.get(invoiceId);
    expect(meta?.driftFlagged).toBe(false);
    expect(meta?.currentCataloguePriceThb).toBe('60000.00');
  }, 60_000);

  it('(b) cycle straddling a fiscal-year edge → billYearCoverageYearMismatch:true', async () => {
    const memberId = await seedMember();
    // periodFrom → FY2025 (Jan-start default); periodTo (12mo later) → FY2026.
    // Coverage starts AT periodTo, so `coverageYear` (2026) diverges from
    // `planYear` (deriveFiscalYear(periodFrom) = 2025).
    const periodFrom = '2025-08-01T00:00:00Z';
    const periodTo = '2026-08-01T00:00:00Z';
    const cycleId = await seedCycle({
      memberId,
      frozenPlanPriceThb: '60000.00',
      periodFrom,
      periodTo,
    });
    const planYear = deriveFiscalYear(periodFrom);
    const coverageYear = deriveFiscalYear(periodTo);
    expect(coverageYear).not.toBe(planYear); // sanity: the fixture actually straddles the edge

    const invoiceId = await seedAutoDraft({
      memberId,
      planYear,
      frozenPlanPriceThb: '60000.00',
      cycleId,
    });

    const result = await loadAutoRenewalQueueContext(
      makeAutoRenewalQueueContextDeps(tenant.ctx.slug),
      {
        tenantId: tenant.ctx.slug,
        rows: [{ invoiceId, memberId, planId, planYear }],
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const meta = result.value.get(invoiceId);
    expect(meta?.billYearCoverageYearMismatch).toBe(true);
    expect(meta?.coverageYear).toBe(coverageYear);
  }, 60_000);

  it('(c) a pre-existing LIVE membership bill for the same plan_year → wouldBeRefused:true', async () => {
    const memberId = await seedMember();
    const periodFrom = PERIOD_FROM_FY2025;
    const periodTo = '2026-08-01T00:00:00Z';
    const cycleId = await seedCycle({
      memberId,
      frozenPlanPriceThb: '60000.00',
      periodFrom,
      periodTo,
    });
    const invoiceId = await seedAutoDraft({
      memberId,
      planYear: PLAN_YEAR,
      frozenPlanPriceThb: '60000.00',
      cycleId,
    });

    // A pre-existing LIVE (issued) membership invoice for the SAME
    // (member, planYear) — an orphan/manual bill, not linked to any cycle.
    const conflictingInvoiceId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId: conflictingInvoiceId,
        invoiceSubject: 'membership',
        memberId,
        planYear: PLAN_YEAR,
        planId,
        draftByUserId: user.userId,
        status: 'issued',
        pdfDocKind: 'invoice',
        fiscalYear: PLAN_YEAR,
        sequenceNumber: 1,
        documentNumber: `SC-${PLAN_YEAR}-000001`,
        issueDate: '2026-01-05',
        dueDate: '2026-02-05',
        subtotalSatang: 6_000_000n,
        vatRateSnapshot: '0.0700',
        vatSatang: 420_000n,
        totalSatang: 6_420_000n,
        creditedTotalSatang: 0n,
        proRatePolicySnapshot: 'monthly',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: {
          legal_name_th: 'ทดสอบ',
          legal_name_en: 'Test',
          tax_id: '0000000000000',
          address_th: 'Bangkok',
          address_en: 'Bangkok',
          logo_blob_key: null,
        },
        memberIdentitySnapshot: {
          legal_name: 'Queue Ctx Co',
          tax_id: '1234567890123',
          address: 'Bangkok',
          primary_contact_name: 'n',
          primary_contact_email: 'test@example.com',
        },
        pdfBlobKey: `invoicing/qc/${PLAN_YEAR}/1.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      }),
    );

    const result = await loadAutoRenewalQueueContext(
      makeAutoRenewalQueueContextDeps(tenant.ctx.slug),
      {
        tenantId: tenant.ctx.slug,
        rows: [{ invoiceId, memberId, planId, planYear: PLAN_YEAR }],
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const meta = result.value.get(invoiceId);
    expect(meta?.wouldBeRefused).toBe(true);
    expect(meta?.conflictingInvoiceId).toBe(conflictingInvoiceId);
  }, 60_000);

  it('(c2) a SIBLING auto_renewal DRAFT for the same (member, planYear) does NOT trip wouldBeRefused', async () => {
    const memberId = await seedMember();
    const periodFrom = PERIOD_FROM_FY2025;
    const periodTo = '2026-08-01T00:00:00Z';
    const cycleId = await seedCycle({
      memberId,
      frozenPlanPriceThb: '60000.00',
      periodFrom,
      periodTo,
    });
    const invoiceId = await seedAutoDraft({
      memberId,
      planYear: PLAN_YEAR,
      frozenPlanPriceThb: '60000.00',
      cycleId,
    });
    // A SIBLING auto-renewal draft for the SAME (member, planYear), not
    // stamped onto any cycle (the double-draft shape design §5.4 calls
    // harmless — Task 9's real guard discards it before its content check).
    const siblingInvoiceId = await seedAutoDraft({
      memberId,
      planYear: PLAN_YEAR,
      frozenPlanPriceThb: '60000.00',
      cycleId: null,
    });

    const result = await loadAutoRenewalQueueContext(
      makeAutoRenewalQueueContextDeps(tenant.ctx.slug),
      {
        tenantId: tenant.ctx.slug,
        rows: [
          { invoiceId, memberId, planId, planYear: PLAN_YEAR },
          { invoiceId: siblingInvoiceId, memberId, planId, planYear: PLAN_YEAR },
        ],
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.get(invoiceId)?.wouldBeRefused).toBe(false);
    expect(result.value.get(siblingInvoiceId)?.wouldBeRefused).toBe(false);
  }, 60_000);

  it('(d) orphan draft (no stamped cycle) → driftFlagged:true, cycleId:null, never throws', async () => {
    const memberId = await seedMember();
    const invoiceId = await seedAutoDraft({
      memberId,
      planYear: PLAN_YEAR,
      frozenPlanPriceThb: '60000.00',
      cycleId: null, // never stamped — simulates Task 7's orphan window
    });

    const result = await loadAutoRenewalQueueContext(
      makeAutoRenewalQueueContextDeps(tenant.ctx.slug),
      {
        tenantId: tenant.ctx.slug,
        rows: [{ invoiceId, memberId, planId, planYear: PLAN_YEAR }],
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const meta = result.value.get(invoiceId);
    expect(meta?.cycleId).toBeNull();
    expect(meta?.driftFlagged).toBe(true);
    expect(meta?.frozenPriceThb).toBeNull();
    expect(meta?.currentCataloguePriceThb).toBeNull();
    expect(meta?.wouldBeRefused).toBe(false);
  }, 60_000);

  it('empty rows → empty map, no queries', async () => {
    const result = await loadAutoRenewalQueueContext(
      makeAutoRenewalQueueContextDeps(tenant.ctx.slug),
      { tenantId: tenant.ctx.slug, rows: [] },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.size).toBe(0);
  });
});
