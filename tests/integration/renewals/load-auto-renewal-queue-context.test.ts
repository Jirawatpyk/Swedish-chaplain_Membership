/**
 * 107-auto-invoice Task 13 — `loadAutoRenewalQueueContext` integration test
 * (live Neon). Verifies the per-row decision signals the admin review-queue
 * view needs, per the review round that found the first cut's bill-year
 * predicate discriminated nothing and its would-be-refused prediction
 * missed two of `issueAutoDraftedRenewal`'s three refusal reasons:
 *
 *   (a) priceChanged   — a cycle whose `frozenPlanPriceThb` differs from the
 *                        CURRENT active plan-catalogue price for (planId,
 *                        planYear) → `priceChanged:true, priceUnverifiable:
 *                        false` + both prices surfaced.
 *   (a2) unchanged      — frozen price matches the catalogue exactly →
 *                        `priceChanged:false, priceUnverifiable:false`.
 *   (b1) billYearStale=false — the COMMON case: planYear matches the fiscal
 *                        year that would print if issued "today" → proves
 *                        the redefined predicate does NOT fire on every row
 *                        (review A1's core complaint).
 *   (b2) billYearStale=true  — "today" (clock override) has rolled into a
 *                        later fiscal year than the stored planYear.
 *   (c1) refusalReason=duplicate_live_bill — a pre-existing LIVE (`issued`)
 *                        membership bill for the same plan_year; a SIBLING
 *                        `auto_renewal` DRAFT for the same (member,
 *                        planYear) must NOT trip it (mirrors the real
 *                        guard's discard-before-check sequence).
 *   (c2) refusalReason=plan_year_drift — the stamped cycle's `periodFrom`
 *                        was re-anchored after the draft was created, so
 *                        its derived fiscal year no longer matches the
 *                        invoice's stored `plan_year` (review A2).
 *   (c3) refusalReason=member_terminated — the member's CURRENT latest
 *                        cycle is `lapsed`, independent of this draft's own
 *                        (still-healthy) stamped cycle (review A2).
 *   (c4) refusalReason=member_erased — the member was GDPR/PDPA-erased.
 *                        NOT covered by (c3): erasure leaves `status` and the
 *                        cycle alone, so access still resolves `full`.
 *   (d) orphan          — a draft with no stamped cycle (Task 7's "orphaned
 *                        after commit" window) → `priceUnverifiable:true`,
 *                        `cycleId:null`, `refusalReason:null` (membership +
 *                        duplicate-bill checks still run — they don't need
 *                        THIS draft's own cycle), never a throw.
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
const PERIOD_TO_FY2026 = '2026-08-01T00:00:00Z';
const PLAN_YEAR = deriveFiscalYear(PERIOD_FROM_FY2025);

let tenant: TestTenant;
let user: TestUser;
let planId: string;

/** deps with a fixed "now" — overrides the default wallClock. */
function depsWithClock(nowIso: string) {
  return {
    ...makeAutoRenewalQueueContextDeps(tenant.ctx.slug),
    clock: { now: () => new Date(nowIso) },
  };
}

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
  readonly periodFrom?: string;
  readonly periodTo?: string;
  readonly status?: 'upcoming' | 'lapsed';
}): Promise<string> {
  const cycleId = randomUUID();
  const periodFrom = opts.periodFrom ?? PERIOD_FROM_FY2025;
  const periodTo = opts.periodTo ?? PERIOD_TO_FY2026;
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(renewalCycles).values({
      tenantId: tenant.ctx.slug,
      cycleId,
      memberId: opts.memberId,
      status: opts.status ?? 'upcoming',
      periodFrom: new Date(periodFrom),
      periodTo: new Date(periodTo),
      expiresAt: new Date(periodTo),
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular',
      planIdAtCycleStart: planId,
      frozenPlanPriceThb: opts.frozenPlanPriceThb,
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB',
      anchoredAt: new Date(periodFrom),
      ...(opts.status === 'lapsed' ? { closedAt: new Date(periodTo), closedReason: 'grace_expired' } : {}),
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
        // priceChanged scenario seeds a cycle frozen at 50,000.00 to diverge
        // from this; the unchanged scenario seeds a cycle frozen at exactly this.
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

  it('(a) frozen price ≠ current catalogue price → priceChanged:true, priceUnverifiable:false, both prices surfaced', async () => {
    const memberId = await seedMember();
    const cycleId = await seedCycle({ memberId, frozenPlanPriceThb: '50000.00' });
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
    expect(meta?.priceChanged).toBe(true);
    expect(meta?.priceUnverifiable).toBe(false);
    expect(meta?.frozenPriceThb).toBe('50000.00');
    expect(meta?.currentCataloguePriceThb).toBe('60000.00');
  }, 60_000);

  it('(a2) frozen price === current catalogue price → priceChanged:false, priceUnverifiable:false', async () => {
    const memberId = await seedMember();
    const cycleId = await seedCycle({ memberId, frozenPlanPriceThb: '60000.00' });
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
    expect(meta?.priceChanged).toBe(false);
    expect(meta?.priceUnverifiable).toBe(false);
    expect(meta?.currentCataloguePriceThb).toBe('60000.00');
  }, 60_000);

  it('(b1) planYear matches "today"\'s fiscal year (the common case) → billYearStale:false — proves the predicate does NOT fire on every row', async () => {
    const memberId = await seedMember();
    const cycleId = await seedCycle({ memberId, frozenPlanPriceThb: '60000.00' });
    const invoiceId = await seedAutoDraft({
      memberId,
      planYear: PLAN_YEAR,
      frozenPlanPriceThb: '60000.00',
      cycleId,
    });

    // "Today" is inside the SAME fiscal year the draft is for (PLAN_YEAR=2025).
    const result = await loadAutoRenewalQueueContext(depsWithClock('2025-09-01T00:00:00Z'), {
      tenantId: tenant.ctx.slug,
      rows: [{ invoiceId, memberId, planId, planYear: PLAN_YEAR }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const meta = result.value.get(invoiceId);
    expect(meta?.currentFiscalYear).toBe(PLAN_YEAR);
    expect(meta?.billYearStale).toBe(false);
  }, 60_000);

  it('(b2) "today" has rolled into a LATER fiscal year than planYear → billYearStale:true', async () => {
    const memberId = await seedMember();
    const cycleId = await seedCycle({ memberId, frozenPlanPriceThb: '60000.00' });
    const invoiceId = await seedAutoDraft({
      memberId,
      planYear: PLAN_YEAR,
      frozenPlanPriceThb: '60000.00',
      cycleId,
    });

    // "Today" is a full fiscal year later than the draft's stored planYear.
    const result = await loadAutoRenewalQueueContext(depsWithClock('2026-09-01T00:00:00Z'), {
      tenantId: tenant.ctx.slug,
      rows: [{ invoiceId, memberId, planId, planYear: PLAN_YEAR }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const meta = result.value.get(invoiceId);
    expect(meta?.currentFiscalYear).toBe(PLAN_YEAR + 1);
    expect(meta?.billYearStale).toBe(true);
  }, 60_000);

  it('(c1) a pre-existing LIVE membership bill for the same plan_year → refusalReason:duplicate_live_bill', async () => {
    const memberId = await seedMember();
    const cycleId = await seedCycle({ memberId, frozenPlanPriceThb: '60000.00' });
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
    expect(meta?.refusalReason).toEqual({
      kind: 'duplicate_live_bill',
      conflictingInvoiceId,
    });
  }, 60_000);

  it('(c1b) a SIBLING auto_renewal DRAFT for the same (member, planYear) does NOT trip refusalReason', async () => {
    const memberId = await seedMember();
    const cycleId = await seedCycle({ memberId, frozenPlanPriceThb: '60000.00' });
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

    expect(result.value.get(invoiceId)?.refusalReason).toBeNull();
    expect(result.value.get(siblingInvoiceId)?.refusalReason).toBeNull();
  }, 60_000);

  it('(c2) the stamped cycle was re-anchored after drafting → refusalReason:plan_year_drift', async () => {
    const memberId = await seedMember();
    const cycleId = await seedCycle({ memberId, frozenPlanPriceThb: '60000.00' });
    const invoiceId = await seedAutoDraft({
      memberId,
      planYear: PLAN_YEAR,
      frozenPlanPriceThb: '60000.00',
      cycleId,
    });

    // Simulate `reanchorPeriodInTx` shifting the cycle's periodFrom into a
    // DIFFERENT fiscal year after the draft was created — the invoice's
    // stored plan_year (PLAN_YEAR) no longer matches deriveFiscalYear of the
    // cycle's (now re-anchored) periodFrom. Must stay < periodTo
    // (PERIOD_TO_FY2026 = 2026-08-01) to satisfy the DB's period-order CHECK.
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(renewalCycles)
        .set({ periodFrom: new Date('2026-01-15T00:00:00Z') })
        .where(eq(renewalCycles.cycleId, cycleId)),
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

    expect(result.value.get(invoiceId)?.refusalReason).toEqual({
      kind: 'plan_year_drift',
    });
  }, 60_000);

  it('(c3) the member\'s CURRENT latest cycle is lapsed (independent of this draft\'s own cycle) → refusalReason:member_terminated', async () => {
    const memberId = await seedMember();
    const cycleId = await seedCycle({ memberId, frozenPlanPriceThb: '60000.00' });
    const invoiceId = await seedAutoDraft({
      memberId,
      planYear: PLAN_YEAR,
      frozenPlanPriceThb: '60000.00',
      cycleId,
    });
    // A NEWER `lapsed` cycle for the SAME member — mirrors the shape T9's
    // own `member_terminated` fixture uses (findLatestCycleForMember
    // resolves this one, not the draft's own still-`upcoming` cycle).
    await seedCycle({
      memberId,
      frozenPlanPriceThb: '60000.00',
      periodFrom: '2026-08-01T00:00:00Z',
      periodTo: '2027-08-01T00:00:00Z',
      status: 'lapsed',
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
    expect(meta?.refusalReason?.kind).toBe('member_terminated');
  }, 60_000);

  it("(c4) the member has been GDPR-erased → refusalReason:member_erased, even though access is still 'full'", async () => {
    const memberId = await seedMember();
    const cycleId = await seedCycle({ memberId, frozenPlanPriceThb: '60000.00' });
    const invoiceId = await seedAutoDraft({
      memberId,
      planYear: PLAN_YEAR,
      frozenPlanPriceThb: '60000.00',
      cycleId,
    });
    // Erasure stamps ONLY `erased_at` — `status` and the cycle are left
    // untouched, so the cycle stays `upcoming` with a future `expires_at` and
    // `deriveMembershipAccess` still resolves `full`. That is exactly why
    // (c3)'s `member_terminated` prediction does NOT cover this case, and why
    // the queue needs its own erasure signal rather than reusing that one.
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(members)
        .set({ erasedAt: new Date('2026-07-01T00:00:00Z'), companyName: '[erased]' })
        .where(eq(members.memberId, memberId)),
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
    // The row is still RETURNED (not filtered out) — the draft exists and
    // Discard is a per-row action, so hiding it would strand it.
    expect(meta).toBeDefined();
    expect(meta?.refusalReason?.kind).toBe('member_erased');
  }, 60_000);

  it('(d) orphan draft (no stamped cycle) → priceUnverifiable:true, priceChanged:false, cycleId:null, refusalReason:null, never throws', async () => {
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
    expect(meta?.priceUnverifiable).toBe(true);
    expect(meta?.priceChanged).toBe(false);
    expect(meta?.frozenPriceThb).toBeNull();
    expect(meta?.currentCataloguePriceThb).toBeNull();
    // member_terminated + duplicate_live_bill checks don't need THIS
    // draft's own cycle — a clean member with no other bills stays null.
    expect(meta?.refusalReason).toBeNull();
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
