/**
 * L1 hardening (renewals-coverage-window-hardening) — the OFFLINE mark-paid
 * path forwards the membership-coverage-exclude window (mig 0281) EXPLICITLY,
 * exactly like the ONLINE renewal bridge, so `invoices.coverage_from/to` is
 * stamped from `coverageWindow` (not the `coverageWindow → membershipCoverage`
 * fallback) on a renewal, and stays NULL on a first-payment. Live Neon.
 *
 * Asserts, against real Postgres:
 *   1. an offline RENEWAL bill's persisted `coverage_from/to` are NOT NULL and
 *      equal `[lockedCycle.periodTo, periodTo + frozenPlanTermMonths)`;
 *   2. that window is IDENTICAL to the one the ONLINE renewal bridge
 *      (`issueInvoiceForRenewal`) stamps for the SAME cycle inputs — no drift
 *      between the two rails;
 *   3. a genuine FIRST-PAYMENT bill (single unanchored cycle → re-anchor) stamps
 *      `coverage_from/to` = the cycle's CURRENT period `[periodFrom, periodTo)`
 *      (A-1 — unified with confirm-renewal L3 + admin-renew-lapsed-member:596),
 *      so it participates in the duplicate-coverage EXCLUDE as a 2nd dup-authority
 *      layer; and that current-period window is half-open ADJACENT to the next
 *      renewal window `[periodTo, periodTo + term)`, so it does NOT over-block a
 *      later renewal (asserted via `findOverlappingMembershipCoverageBill`).
 *
 * Test seam: drives the REAL `markPaidOffline` + the REAL online bridge
 * end-to-end (NO bridge mock — the coverage-window threading IS the unit under
 * test) with the F4 PDF render + Blob upload + email outbox mocked at module
 * level (mirrors `offline-frozen-price.test.ts`).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

// Stub render/blob/outbox so the bridge's internal makeIssueInvoiceDeps /
// makeIssueMembershipBillDeps + makeRecordPaymentDeps pick up mocked PDF/Blob —
// the system under test is the coverage-window threading, not the PDF/email
// round-trip. Same pattern as offline-frozen-price.test.ts.
vi.mock(
  '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter',
  async () => {
    const { Sha256Hex: S } = await import(
      '@/modules/invoicing/domain/value-objects/sha256-hex'
    );
    return {
      reactPdfRenderAdapter: {
        render: vi.fn(async () => ({
          bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
          sha256: S.ofUnsafe('c'.repeat(64)),
        })),
      },
    };
  },
);
vi.mock(
  '@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter',
  () => ({
    vercelBlobAdapter: {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({
        key,
        url: `https://blob.test/${key}`,
      })),
      getSignedReadUrl: vi.fn(async () => 'https://blob.test/signed'),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    },
  }),
);
vi.mock(
  '@/modules/invoicing/infrastructure/adapters/resend-email-outbox-adapter',
  () => ({
    resendEmailOutboxAdapter: {
      enqueue: vi.fn(async () => undefined),
    },
  }),
);

import { db, runInTenant } from '@/lib/db';
import { addMonthsUtc } from '@/lib/dates';
import type { ThbDecimal } from '@/lib/money';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { markPaidOffline, makeRenewalsDeps } from '@/modules/renewals';
import { f4InvoicingForRenewalBridge } from '@/modules/renewals/infrastructure/ports-adapters/f4-invoicing-for-renewal-bridge-drizzle';
import {
  findOverlappingMembershipCoverageBill,
  type MembershipBillCoverageRow,
} from '@/modules/renewals/domain/membership-bill-coverage';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const FROZEN_PRICE_THB = '50000.00';
// Cycle period + term used across the renewal + online-bridge cases. The
// renewal §86/4 coverage window is the NEXT period: [periodTo, periodTo + term).
const PERIOD_FROM_ISO = '2026-06-01T00:00:00.000Z';
const PERIOD_TO_ISO = '2027-06-01T00:00:00.000Z';
const TERM_MONTHS = 12;
// The window both rails must stamp for this cycle: [2027-06-01, 2028-06-01).
const EXPECTED_COVERAGE_FROM = PERIOD_TO_ISO; // '2027-06-01T00:00:00.000Z'
const EXPECTED_COVERAGE_TO = addMonthsUtc(PERIOD_TO_ISO, TERM_MONTHS); // '2028-06-01T00:00:00.000Z'
// A-1 — a genuine first-payment offline settlement now stamps the cycle's
// CURRENT period [periodFrom, periodTo) (mirroring confirm-renewal L3 + admin-
// renew-lapsed-member:596), NOT NULL and NOT the next-period renewal window. For
// this normal (non-comeback) cohort the fixed-anchor re-anchor KEEPS the period
// (periodTo is after the payment date), so the stamped window == pre-anchor.
const EXPECTED_FIRSTPAY_COVERAGE_FROM = PERIOD_FROM_ISO; // '2026-06-01T00:00:00.000Z'
const EXPECTED_FIRSTPAY_COVERAGE_TO = PERIOD_TO_ISO; // '2027-06-01T00:00:00.000Z'

// A-1 comeback-snap (expired-period first payment) — characterizes the
// adjudicated "inert-but-harmless" divergence. The §86/4 coverage window is
// stamped at ISSUE time from the cycle's OLD (pre-snap) period, BEFORE `onPaid`
// re-anchors the now-dead period to the payment month, so the invoice coverage
// (old, elapsed period) and the cycle period (new, snapped period) DIVERGE by
// design — mirroring the confirm-renewal rail's pre-anchor stamp.
//
// A SHORT past period (not a full 12-month term) is seeded deliberately: the
// payment date must stay in the PAST relative to the real test clock, and the
// bill's plan_year derives from the cycle's OLD periodFrom (invoices_plan_fk →
// membership_plans(tenant, plan, plan_year)), so periodFrom must sit in FY2026
// to match the single seeded plan-year row. Those two constraints together
// forbid a full 12-month period that is ALSO fully elapsed by a 2026 payment;
// the period length is immaterial to the behaviour under test (the coverage
// stamp is [periodFrom, periodTo) regardless of length).
const COMEBACK_OLD_PERIOD_FROM = '2026-02-01T00:00:00.000Z';
const COMEBACK_OLD_PERIOD_TO = '2026-05-01T00:00:00.000Z';
const COMEBACK_PAYMENT_DATE = '2026-06-05'; // after OLD_PERIOD_TO, still in the past
// The re-anchor snaps to the payment-MONTH start + frozenPlanTermMonths (12).
const COMEBACK_SNAPPED_PERIOD_FROM = '2026-06-01T00:00:00.000Z';
const COMEBACK_SNAPPED_PERIOD_TO = addMonthsUtc(
  COMEBACK_SNAPPED_PERIOD_FROM,
  TERM_MONTHS,
); // '2027-06-01T00:00:00.000Z'

describe('F8 offline mark-paid — coverage_from/to window threading (mig 0281, L1)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;
  let memberRenewalId: string;
  let cycleRenewalId: string;
  let memberFirstPayId: string;
  let cycleFirstPayId: string;
  let memberComebackId: string;
  let cycleComebackId: string;
  let memberOnlineId: string;

  async function readCoverage(
    invoiceId: string,
  ): Promise<{ from: Date | null; to: Date | null }> {
    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ from: invoices.coverageFrom, to: invoices.coverageTo })
        .from(invoices)
        .where(
          and(
            eq(invoices.tenantId, tenant.ctx.slug),
            eq(invoices.invoiceId, invoiceId),
          ),
        )
        .limit(1),
    );
    return { from: row?.from ?? null, to: row?.to ?? null };
  }

  async function seedMemberWithContact(
    memberId: string,
    companyName: string,
  ): Promise<void> {
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName,
        country: 'TH',
        planId,
        planYear: 2026,
        registrationFeePaid: true,
        registrationDate: '2020-01-01',
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Coverage',
        lastName: 'Window',
        email: `${memberId.slice(0, 8)}@example.com`,
        isPrimary: true,
      });
    });
  }

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    await seedTenantFiscal({ tenant, vatRate: '0.0700' });

    planId = `f8-covwin-${randomUUID().slice(0, 8)}`;
    memberRenewalId = randomUUID();
    cycleRenewalId = randomUUID();
    memberFirstPayId = randomUUID();
    cycleFirstPayId = randomUUID();
    memberComebackId = randomUUID();
    cycleComebackId = randomUUID();
    memberOnlineId = randomUUID();

    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Coverage Window Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
        annualFeeMinorUnits: 5_000_000,
      }),
    );

    await seedMemberWithContact(memberRenewalId, 'Renewal Coverage Co');
    await seedMemberWithContact(memberFirstPayId, 'First-Pay Coverage Co');
    await seedMemberWithContact(memberComebackId, 'Comeback Coverage Co');
    await seedMemberWithContact(memberOnlineId, 'Online Coverage Co');

    // RENEWAL member — a TERMINAL, ANCHORED predecessor (settled history) so the
    // classifier resolves `renewal` (not `first_payment`), plus the payable
    // cycle whose NEXT period this bill covers.
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: randomUUID(),
        memberId: memberRenewalId,
        status: 'cancelled',
        periodFrom: new Date('2024-06-01T00:00:00Z'),
        periodTo: new Date('2025-06-01T00:00:00Z'),
        expiresAt: new Date('2025-06-01T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: FROZEN_PRICE_THB,
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        anchoredAt: new Date('2024-06-01T00:00:00Z'),
        closedAt: new Date('2025-06-01T00:00:00Z'),
        closedReason: 'cancelled',
      }),
    );
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: cycleRenewalId,
        memberId: memberRenewalId,
        status: 'awaiting_payment',
        periodFrom: new Date(PERIOD_FROM_ISO),
        periodTo: new Date(PERIOD_TO_ISO),
        expiresAt: new Date(PERIOD_TO_ISO),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: FROZEN_PRICE_THB,
        frozenPlanTermMonths: TERM_MONTHS,
        frozenPlanCurrency: 'THB',
      }),
    );

    // FIRST-PAYMENT member — the member's ONLY-EVER cycle, never anchored
    // (`anchored_at` NULL), payable. periodTo is AFTER the payment date so the
    // fixed-anchor re-anchor KEEPS the period (the normal, non-comeback branch).
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: cycleFirstPayId,
        memberId: memberFirstPayId,
        status: 'awaiting_payment',
        periodFrom: new Date(PERIOD_FROM_ISO),
        periodTo: new Date(PERIOD_TO_ISO),
        expiresAt: new Date(PERIOD_TO_ISO),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: FROZEN_PRICE_THB,
        frozenPlanTermMonths: TERM_MONTHS,
        frozenPlanCurrency: 'THB',
      }),
    );

    // COMEBACK first-payment member — the member's ONLY-EVER cycle, never
    // anchored (`anchored_at` NULL), payable, BUT whose fixed period has ALREADY
    // fully elapsed by the payment date (period_to < paymentDate → the
    // `periodExpiredAtPayment` branch in reanchor-first-payment.ts:145-150).
    // First-payment classification (single unanchored cycle, no settled
    // predecessor), so `onPaid` re-anchors — and because the period is expired,
    // the re-anchor MOVES it to the payment month (grants a fresh period). That
    // is the divergence this test locks: coverage stamped at issue = old period,
    // cycle re-anchored to the new period.
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: cycleComebackId,
        memberId: memberComebackId,
        status: 'awaiting_payment',
        periodFrom: new Date(COMEBACK_OLD_PERIOD_FROM),
        periodTo: new Date(COMEBACK_OLD_PERIOD_TO),
        expiresAt: new Date(COMEBACK_OLD_PERIOD_TO),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: FROZEN_PRICE_THB,
        frozenPlanTermMonths: TERM_MONTHS,
        frozenPlanCurrency: 'THB',
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

  it('an offline RENEWAL bill stamps coverage_from/to = [periodTo, periodTo + frozenTerm) — NOT NULL', async () => {
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const r = await markPaidOffline(deps, {
      tenantId: tenant.ctx.slug,
      cycleId: cycleRenewalId,
      paymentMethod: 'bank_transfer',
      paymentReference: 'BT-COVWIN-RENEWAL',
      paymentDate: '2026-06-05',
      actorUserId: user.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    if (!r.ok) {
      throw new Error(`markPaidOffline failed: ${JSON.stringify(r.error)}`);
    }
    expect(r.value.outcome).toBe('completed');

    const cov = await readCoverage(r.value.invoiceId);
    expect(cov.from, 'renewal coverage_from must be stamped').not.toBeNull();
    expect(cov.to, 'renewal coverage_to must be stamped').not.toBeNull();
    expect(cov.from?.toISOString()).toBe(EXPECTED_COVERAGE_FROM);
    expect(cov.to?.toISOString()).toBe(EXPECTED_COVERAGE_TO);
  }, 120_000);

  it('the ONLINE renewal bridge stamps the SAME coverage window for the same cycle (no drift between rails)', async () => {
    // Drive the online rail directly with the SAME window inputs a renewal
    // confirm computes for this cycle: [periodTo, periodTo + term). A separate
    // member so the per-member EXCLUDE never fires against the offline bill.
    const online = await f4InvoicingForRenewalBridge.issueInvoiceForRenewal({
      tenantId: tenant.ctx.slug,
      memberId: memberOnlineId,
      planId,
      planYear: 2026,
      frozenPlanPriceThb: FROZEN_PRICE_THB as ThbDecimal,
      membershipCoverage: {
        kind: 'window',
        fromIso: EXPECTED_COVERAGE_FROM,
        toIso: EXPECTED_COVERAGE_TO,
      },
      coverageWindow: {
        fromIso: EXPECTED_COVERAGE_FROM,
        toIso: EXPECTED_COVERAGE_TO,
      },
      autoEmailOnIssue: false,
      actorUserId: user.userId,
      correlationId: randomUUID(),
      requestId: null,
    });
    if (online.status !== 'issued') {
      throw new Error(
        `online issueInvoiceForRenewal failed: ${JSON.stringify(online)}`,
      );
    }

    const onlineCov = await readCoverage(online.invoiceId);
    // Both rails persist the identical window — no drift.
    expect(onlineCov.from?.toISOString()).toBe(EXPECTED_COVERAGE_FROM);
    expect(onlineCov.to?.toISOString()).toBe(EXPECTED_COVERAGE_TO);
  }, 120_000);

  it('a genuine FIRST-PAYMENT bill stamps coverage_from/to = [periodFrom, periodTo) (current period) — participates in the EXCLUDE, no over-block', async () => {
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const r = await markPaidOffline(deps, {
      tenantId: tenant.ctx.slug,
      cycleId: cycleFirstPayId,
      paymentMethod: 'bank_transfer',
      paymentReference: 'BT-COVWIN-FIRSTPAY',
      paymentDate: '2026-06-05',
      actorUserId: user.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    if (!r.ok) {
      throw new Error(`markPaidOffline failed: ${JSON.stringify(r.error)}`);
    }
    // The member's only-ever, never-anchored cycle re-anchors (stays upcoming).
    expect(r.value.outcome).toBe('reanchored');

    // A-1 — the offline first-payment now stamps the cycle's CURRENT period
    // [periodFrom, periodTo) (unified with confirm-renewal L3 + admin-renew:596),
    // so the bill participates in the DB EXCLUDE as a 2nd dup-authority layer
    // alongside the plan_year guard (was NULL → single-layer). The re-anchor
    // (inside onPaid, AFTER the bridge consumes coverageWindow) keeps the period
    // for this normal cohort, so pre==post == [PERIOD_FROM_ISO, PERIOD_TO_ISO).
    const cov = await readCoverage(r.value.invoiceId);
    if (cov.from === null || cov.to === null) {
      throw new Error('first-payment coverage_from/to must be stamped (A-1)');
    }
    expect(cov.from.toISOString()).toBe(EXPECTED_FIRSTPAY_COVERAGE_FROM);
    expect(cov.to.toISOString()).toBe(EXPECTED_FIRSTPAY_COVERAGE_TO);

    // No over-block: the stamped current-period window is half-open ADJACENT to
    // the next renewal window [periodTo, periodTo + term), so a subsequent
    // legitimate renewal that bills the next period is NOT refused by the coverage
    // guard. Proven against the PERSISTED window via the domain twin of the DB
    // EXCLUDE (status 'paid' — a committed blocking bill, the strongest case).
    const stampedBill: MembershipBillCoverageRow = {
      invoiceId: r.value.invoiceId,
      status: 'paid',
      coverage: { from: cov.from.toISOString(), to: cov.to.toISOString() },
    };
    const overlap = findOverlappingMembershipCoverageBill([stampedBill], {
      from: EXPECTED_COVERAGE_FROM, // next renewal window from = periodTo
      to: EXPECTED_COVERAGE_TO, //     next renewal window to   = periodTo + term
    });
    expect(
      overlap,
      'stamped [periodFrom, periodTo) must NOT over-block the next renewal window [periodTo, periodTo + term)',
    ).toBeNull();
  }, 120_000);

  it('a COMEBACK first-payment (expired period) stamps the §86/4 with the OLD pre-snap period while the cycle re-anchors to the payment month — the accepted, inert divergence', async () => {
    // WHY the coverage is the OLD (elapsed) period, not the snapped one:
    // `coverageWindow` is stamped on the §86/4 at ISSUE time (inside the F4
    // bridge, from `[lockedCycle.periodFrom, lockedCycle.periodTo)`), which runs
    // BEFORE `onPaid` re-anchors the dead period to the payment month — the
    // IDENTICAL pre-anchor timing as the online confirm-renewal rail. The
    // adjudicated verdict (A-1 financial-integrity review) is inert-but-harmless:
    // the stamped old period is fully elapsed and overlaps no legitimate
    // future/concurrent bill, so it never over-blocks; the plan_year
    // `findLiveMembershipBillInTx` guard remains the effective duplicate
    // protection for this comeback edge (the coverage EXCLUDE is a 2nd layer only
    // for the normal, period-KEEPING first payment). This test LOCKS that
    // behaviour so a future change cannot silently "fix" the stamp to the snapped
    // period without a deliberate, reviewed decision. Characterization, not
    // TDD-red — it must PASS on current HEAD.
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const r = await markPaidOffline(deps, {
      tenantId: tenant.ctx.slug,
      cycleId: cycleComebackId,
      paymentMethod: 'bank_transfer',
      paymentReference: 'BT-COVWIN-COMEBACK',
      paymentDate: COMEBACK_PAYMENT_DATE,
      actorUserId: user.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    if (!r.ok) {
      throw new Error(`markPaidOffline failed: ${JSON.stringify(r.error)}`);
    }
    // Settlement SUCCEEDED and re-anchored (no over-block, no error).
    expect(r.value.outcome).toBe('reanchored');

    // (1) The issued §86/4 coverage is the OLD, pre-snap period [oldFrom, oldTo)
    // — stamped before the re-anchor moved the cycle.
    const cov = await readCoverage(r.value.invoiceId);
    if (cov.from === null || cov.to === null) {
      throw new Error('comeback coverage_from/to must be stamped (A-1)');
    }
    expect(cov.from.toISOString()).toBe(COMEBACK_OLD_PERIOD_FROM);
    expect(cov.to.toISOString()).toBe(COMEBACK_OLD_PERIOD_TO);

    // (2) The cycle DID snap: period moved to [paymentMonthStart, +frozenTerm)
    // and `anchored_at` is stamped (status re-activates to 'upcoming').
    const [cycleRow] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          periodFrom: renewalCycles.periodFrom,
          periodTo: renewalCycles.periodTo,
          anchoredAt: renewalCycles.anchoredAt,
          status: renewalCycles.status,
        })
        .from(renewalCycles)
        .where(
          and(
            eq(renewalCycles.tenantId, tenant.ctx.slug),
            eq(renewalCycles.cycleId, cycleComebackId),
          ),
        )
        .limit(1),
    );
    if (!cycleRow) {
      throw new Error('comeback cycle row not found after settlement');
    }
    expect(cycleRow.periodFrom.toISOString()).toBe(COMEBACK_SNAPPED_PERIOD_FROM);
    expect(cycleRow.periodTo.toISOString()).toBe(COMEBACK_SNAPPED_PERIOD_TO);
    expect(
      cycleRow.anchoredAt,
      'comeback re-anchor must stamp anchored_at',
    ).not.toBeNull();
    expect(cycleRow.status).toBe('upcoming');

    // The documented, ACCEPTED divergence: the §86/4 coverage (old dead period)
    // is NOT the re-anchored cycle period (new snapped period). If this ever
    // stops diverging, the pre-anchor stamp changed — investigate before editing.
    expect(cov.from.toISOString()).not.toBe(cycleRow.periodFrom.toISOString());
    expect(cov.to.toISOString()).not.toBe(cycleRow.periodTo.toISOString());

    // (3) Exactly ONE issued §86/4 for the comeback member — no duplicate mint.
    const memberBills = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ invoiceId: invoices.invoiceId })
        .from(invoices)
        .where(
          and(
            eq(invoices.tenantId, tenant.ctx.slug),
            eq(invoices.memberId, memberComebackId),
          ),
        ),
    );
    expect(memberBills).toHaveLength(1);
    expect(memberBills[0]?.invoiceId).toBe(r.value.invoiceId);
  }, 120_000);
});
