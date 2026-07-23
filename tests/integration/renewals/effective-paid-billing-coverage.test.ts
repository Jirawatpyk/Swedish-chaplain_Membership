/**
 * plan-change-ux task #24 (MONEY) — the billing/classification "effective-paid"
 * predicate. Sibling of the L1 display fix
 * (`pipeline-anchored-refund-void-coverage.test.ts`), but for the two functions
 * that drive BILLING rather than the pipeline read-model:
 *
 *   - `findMaxPaidThroughForMemberInTx`  → the paid-through FRONTIER that
 *     `restoreCycleForMember` (undelete) + `adminRenewLapsedMember` (comeback)
 *     anchor the re-created / comeback cycle at — and that the printed §86/4
 *     window is derived from.
 *   - `countSettledCyclesForMemberInTx`  → the `first_payment` vs `renewal`
 *     classifier (`classifyMembershipPayment` `settledCycleCountForMember`).
 *
 * Both previously counted a cycle's period as PAID coverage from the raw
 * `status = 'completed' OR anchored_at IS NOT NULL` discriminator ALONE,
 * WITHOUT checking the SETTLING invoice's status. So a cycle whose settling
 * invoice was later VOIDED or fully REFUNDED / credit-noted ('credited') still
 * counted → the frontier over-reached the refunded period → under-bill on
 * restore/comeback + wrong first_payment/renewal classification.
 *
 * The corrected EFFECTIVE-PAID rule (business-approved) retracts a cycle whose
 * settling invoice is 'void' or 'credited', keeps 'partially_credited' (partial
 * → period still paid-for) and 'paid', and — HARD GUARDRAIL — NEVER retracts a
 * cycle whose settling invoice id is NULL (R4 backfill / no in-system invoice),
 * via `IS DISTINCT FROM` NULL-tolerance.
 *
 * TWO ARMS, because a cycle's settling invoice lives in DIFFERENT columns
 * across its lifecycle:
 *   - a COMPLETED steady-state cycle (anchored_at may be NULL) → its settling
 *     invoice is stamped on `linked_invoice_id`;
 *   - an OPEN anchored cycle (upcoming/awaiting) → `anchor_invoice_id`.
 * Each arm is exercised below. (A completed cycle always has a non-null
 * linked_invoice_id per the DB CHECK, so the NULL-settling-id backfill guardrail
 * is exercised on the ANCHORED arm — the R4 cohort with anchor_invoice_id NULL.)
 *
 * RED-FIRST: the four *reversed* cases (completed/anchored × void/credited)
 * assert the CORRECTED expectation (frontier null, settled count 0) and FAIL
 * against the pre-fix raw predicate that still counts them.
 *
 * Live Neon (DEV branch). One tenant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { asSatang, type Satang } from '@/lib/money';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { makeRenewalsDeps } from '@/modules/renewals';
import { loadMemberRenewalContext } from '@/app/(staff)/admin/invoices/_lib/member-renewal-context';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// A single shared period end (future — a "paid-ahead" completed cycle is legal).
// Each member has exactly ONE cycle, so a covered member's frontier is exactly
// this value and a retracted member's frontier is null.
const PERIOD_TO = new Date(Date.now() + 20 * 86_400_000);
const PERIOD_FROM = new Date(Date.now() - 345 * 86_400_000);
const PAID_AT = new Date(Date.now() - 30 * 86_400_000);

type SettlingInvoiceStatus =
  | 'paid'
  | 'void'
  | 'credited'
  | 'partially_credited';

type Arm = 'completed' | 'anchored';

interface CoverageCase {
  readonly key: string;
  readonly arm: Arm;
  /** null → BACKFILL cohort (settling invoice id NULL, no in-system invoice). */
  readonly invoiceStatus: SettlingInvoiceStatus | null;
  readonly expectedCovered: boolean;
  memberId: string;
  cycleId: string;
  invoiceId: string | null;
}

const TOTAL_SATANG = asSatang(5_350_000n);

function mkCase(
  key: string,
  arm: Arm,
  invoiceStatus: SettlingInvoiceStatus | null,
  expectedCovered: boolean,
): CoverageCase {
  return {
    key,
    arm,
    invoiceStatus,
    expectedCovered,
    memberId: randomUUID(),
    cycleId: randomUUID(),
    invoiceId: invoiceStatus === null ? null : randomUUID(),
  };
}

describe('effective-paid frontier + settled-count — refund/void coverage (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;
  const cases: CoverageCase[] = [];

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    planId = `f8-eff-paid-${randomUUID().slice(0, 8)}`;

    cases.push(
      // --- COMPLETED arm (settling invoice = linked_invoice_id) ---
      mkCase('completed-paid', 'completed', 'paid', true),
      mkCase('completed-credited', 'completed', 'credited', false),
      mkCase('completed-void', 'completed', 'void', false),
      mkCase('completed-partial', 'completed', 'partially_credited', true),
      // NO `completed-backfill` case (fin-review L1): the completed arm's
      // NULL-settling-invoice branch is STRUCTURALLY UNREACHABLE, so its absence
      // is a coverage NON-gap, not a hole. Two DB invariants make a completed
      // cycle's `linkedInv.status` never NULL: (1) CHECK
      // `renewal_cycles_completed_requires_invoice_check` (migration 0087) forbids
      // a `completed` cycle with NULL `linked_invoice_id`; (2) the composite FK
      // `(tenant_id, linked_invoice_id) → invoices` (NO ACTION on delete) forbids
      // a dangling id, so the completed arm's LEFT JOIN can never miss. The
      // `IS DISTINCT FROM NULL` NULL-tolerance of the SHARED
      // `effectivePaidCoverageSql` helper (identical operator on both arms) is
      // therefore exercised via the ANCHORED arm's `anchored-backfill` case below
      // (anchor_invoice_id NULL → join miss → status NULL → covered) — the only
      // lifecycle position where a cycle legitimately has a NULL settling-invoice
      // id (R4 pre-system-payment cohort).
      // --- ANCHORED-open arm (settling invoice = anchor_invoice_id) ---
      mkCase('anchored-paid', 'anchored', 'paid', true),
      mkCase('anchored-credited', 'anchored', 'credited', false),
      mkCase('anchored-void', 'anchored', 'void', false),
      mkCase('anchored-partial', 'anchored', 'partially_credited', true),
      // R4 backfill — anchored, NO in-system invoice → NULL-tolerant → covered.
      mkCase('anchored-backfill', 'anchored', null, true),
    );

    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Effective Paid Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });

      for (const c of cases) {
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId: c.memberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: `Eff ${c.key} Co`,
          country: 'TH',
          planId,
          planYear: 2026,
        });
        // Insert the settling invoice BEFORE the cycle so the composite FK
        // (tenant_id, linked/anchor_invoice_id) is satisfied.
        if (c.invoiceId !== null && c.invoiceStatus !== null) {
          await insertSettlingInvoice(tx, {
            tenantSlug: tenant.ctx.slug,
            userId: user.userId,
            invoiceId: c.invoiceId,
            memberId: c.memberId,
            planId,
            status: c.invoiceStatus,
          });
        }
        if (c.arm === 'completed') {
          await tx.insert(renewalCycles).values({
            tenantId: tenant.ctx.slug,
            cycleId: c.cycleId,
            memberId: c.memberId,
            status: 'completed',
            periodFrom: PERIOD_FROM,
            periodTo: PERIOD_TO,
            expiresAt: PERIOD_TO,
            cycleLengthMonths: 12,
            tierAtCycleStart: 'regular',
            planIdAtCycleStart: planId,
            frozenPlanPriceThb: '50000.00',
            frozenPlanTermMonths: 12,
            frozenPlanCurrency: 'THB',
            // Steady-state completed cycle — settling invoice on linked, NOT
            // anchored (anchored_at NULL) so ONLY the completed arm can match.
            linkedInvoiceId: c.invoiceId,
            closedAt: PERIOD_TO,
            closedReason: 'paid',
          });
        } else {
          await tx.insert(renewalCycles).values({
            tenantId: tenant.ctx.slug,
            cycleId: c.cycleId,
            memberId: c.memberId,
            status: 'upcoming',
            periodFrom: PERIOD_FROM,
            periodTo: PERIOD_TO,
            expiresAt: PERIOD_TO,
            cycleLengthMonths: 12,
            tierAtCycleStart: 'regular',
            planIdAtCycleStart: planId,
            frozenPlanPriceThb: '50000.00',
            frozenPlanTermMonths: 12,
            frozenPlanCurrency: 'THB',
            // Open anchored cycle — settling invoice on anchor_invoice_id.
            anchoredAt: new Date(),
            anchorInvoiceId: c.invoiceId,
          });
        }
      }
    });
  }, 180_000);

  afterAll(async () => {
    // renewal_cycles (composite FK → invoices) BEFORE invoices.
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
  }, 120_000);

  it('findMaxPaidThroughForMemberInTx retracts a void/fully-credited settling invoice; keeps paid/partial/backfill (both arms)', async () => {
    const repo = makeRenewalsDeps(tenant.ctx.slug).cyclesRepo;
    await runInTenant(tenant.ctx, async (tx) => {
      for (const c of cases) {
        const frontier = await repo.findMaxPaidThroughForMemberInTx(
          tx,
          tenant.ctx.slug,
          c.memberId,
        );
        if (c.expectedCovered) {
          expect(frontier, `frontier covered for ${c.key}`).toBe(
            PERIOD_TO.toISOString(),
          );
        } else {
          expect(frontier, `frontier retracted for ${c.key}`).toBeNull();
        }
      }
    });
  }, 120_000);

  it('countSettledCyclesForMemberInTx retracts a void/fully-credited settling invoice; keeps paid/partial/backfill (both arms)', async () => {
    const repo = makeRenewalsDeps(tenant.ctx.slug).cyclesRepo;
    await runInTenant(tenant.ctx, async (tx) => {
      for (const c of cases) {
        // excludeCycleId = a fresh UUID (never the cycle under test) so the
        // seeded cycle is always eligible to be counted.
        const count = await repo.countSettledCyclesForMemberInTx(
          tx,
          tenant.ctx.slug,
          c.memberId,
          randomUUID(),
        );
        expect(count, `settled count for ${c.key}`).toBe(
          c.expectedCovered ? 1 : 0,
        );
      }
    });
  }, 120_000);
});

describe('classifyMembershipPayment via loadMemberRenewalContext — refund retraction (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;

  // Two members, each with a COMPLETED predecessor + an OPEN un-anchored cycle.
  // The predecessor's settling invoice status decides whether the member has
  // "settled history" → renewal vs first_payment.
  const refundedMemberId = randomUUID();
  const paidMemberId = randomUUID();

  async function seedMember(
    tx: Parameters<Parameters<typeof runInTenant>[1]>[0],
    memberId: string,
    predecessorInvoiceStatus: SettlingInvoiceStatus,
  ): Promise<void> {
    const invoiceId = randomUUID();
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `Classify ${predecessorInvoiceStatus} Co`,
      country: 'TH',
      planId,
      planYear: 2026,
    });
    await insertSettlingInvoice(tx, {
      tenantSlug: tenant.ctx.slug,
      userId: user.userId,
      invoiceId,
      memberId,
      planId,
      status: predecessorInvoiceStatus,
    });
    // Completed predecessor whose settling invoice may be refunded.
    await tx.insert(renewalCycles).values({
      tenantId: tenant.ctx.slug,
      cycleId: randomUUID(),
      memberId,
      status: 'completed',
      periodFrom: PERIOD_FROM,
      periodTo: new Date(Date.now() - 5 * 86_400_000),
      expiresAt: new Date(Date.now() - 5 * 86_400_000),
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular',
      planIdAtCycleStart: planId,
      frozenPlanPriceThb: '50000.00',
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB',
      linkedInvoiceId: invoiceId,
      closedAt: new Date(Date.now() - 5 * 86_400_000),
      closedReason: 'paid',
    });
    // The OPEN cycle to be classified — un-anchored (anchoredAt NULL) so the
    // first_payment branch is reachable (classify requires openCycle.anchoredAt
    // === null AND settledCount === 0).
    await tx.insert(renewalCycles).values({
      tenantId: tenant.ctx.slug,
      cycleId: randomUUID(),
      memberId,
      status: 'upcoming',
      periodFrom: PERIOD_FROM,
      periodTo: PERIOD_TO,
      expiresAt: PERIOD_TO,
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular',
      planIdAtCycleStart: planId,
      frozenPlanPriceThb: '50000.00',
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB',
    });
  }

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    planId = `f8-classify-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Classify Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });
      await seedMember(tx, refundedMemberId, 'credited');
      await seedMember(tx, paidMemberId, 'paid');
    });
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
  }, 120_000);

  it('a refunded-only-history member classifies first_payment (the fully-credited predecessor no longer counts as settled)', async () => {
    const ctxOut = await loadMemberRenewalContext(
      tenant.ctx.slug,
      refundedMemberId,
    );
    expect(ctxOut.classification.kind).toBe('first_payment');
  });

  it('control: a genuinely-paid-history member still classifies renewal', async () => {
    const ctxOut = await loadMemberRenewalContext(tenant.ctx.slug, paidMemberId);
    expect(ctxOut.classification.kind).toBe('renewal');
  });
});

async function insertSettlingInvoice(
  tx: Parameters<Parameters<typeof runInTenant>[1]>[0],
  args: {
    readonly tenantSlug: string;
    readonly userId: string;
    readonly invoiceId: string;
    readonly memberId: string;
    readonly planId: string;
    readonly status: SettlingInvoiceStatus;
  },
): Promise<void> {
  const creditedTotal: Satang =
    args.status === 'credited'
      ? TOTAL_SATANG
      : args.status === 'partially_credited'
        ? asSatang(1_000_000n)
        : asSatang(0n);
  await tx.insert(invoices).values({
    tenantId: args.tenantSlug,
    invoiceId: args.invoiceId,
    memberId: args.memberId,
    planYear: 2026,
    planId: args.planId,
    status: args.status,
    pdfDocKind: 'invoice',
    receiptPdfStatus: 'rendered',
    draftByUserId: args.userId,
    fiscalYear: 2026,
    sequenceNumber: Math.floor(Math.random() * 1_000_000) + 1,
    documentNumber: `INV-2026-${String(Math.floor(Math.random() * 900000) + 100000)}`,
    issueDate: '2026-01-01',
    dueDate: '2026-01-31',
    currency: 'THB',
    subtotalSatang: asSatang(5_000_000n),
    vatRateSnapshot: '0.0700',
    vatSatang: asSatang(350_000n),
    totalSatang: TOTAL_SATANG,
    creditedTotalSatang: creditedTotal,
    proRatePolicySnapshot: 'none',
    netDaysSnapshot: 30,
    tenantIdentitySnapshot: { legalNameEn: 'Test', taxId: '0' } as unknown,
    memberIdentitySnapshot: {
      companyName: 'Eff Co',
      country: 'TH',
      legal_name: 'Eff Co Ltd',
      address: '1 Test Road, Bangkok 10110',
      primary_contact_name: 'Test Contact',
      primary_contact_email: 'eff@example.com',
    } as unknown,
    pdfBlobKey: `invoicing/${args.tenantSlug}/2026/${args.invoiceId}.pdf`,
    pdfSha256: 'a'.repeat(64),
    pdfTemplateVersion: 1,
    paymentMethod: 'bank_transfer',
    paymentReference: 'EFF-TEST-PAY',
    paymentRecordedByUserId: args.userId,
    paymentDate: PAID_AT.toISOString().slice(0, 10),
    paidAt: PAID_AT,
    ...(args.status === 'void'
      ? {
          voidedAt: new Date(),
          voidReason: 'test fixture void',
          voidedByUserId: args.userId,
        }
      : {}),
  });
}
