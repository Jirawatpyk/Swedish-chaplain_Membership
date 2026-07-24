/**
 * plan-change-ux L1 (F-1 + Phase-2 review follow-up) — the pipeline
 * "Covered" read-model (`anchored`) must reflect the ANCHOR INVOICE's
 * effective-paid state, not the raw `anchored_at IS NOT NULL` discriminator.
 *
 * `anchored_at` is set-once (rolling-anchor re-anchor + R4 backfill) and is
 * NOT cleared when the anchor invoice is later VOIDED (F4) or fully
 * REFUNDED / credit-noted (F5 → §86/10). The `loadPipelinePage` projection
 * originally mapped `anchored = anchoredAt != null`, so a member whose
 * anchoring payment was reversed still rendered a green "Covered" cell —
 * misleading an admin reviewing the renewals pipeline.
 *
 * Effective-paid coverage (this test pins the read-model semantics):
 *   - VOID anchor invoice (status='void')             → NOT covered
 *   - FULL credit note / refund (status='credited')   → NOT covered
 *   - PARTIAL credit (status='partially_credited')    → STILL covered
 *   - happy-path paid anchor (status='paid')          → covered
 *   - BACKFILL cohort (anchor_invoice_id IS NULL, no  → covered
 *     in-system invoice to refund)
 *
 * Second `it` is a CHARACTERIZATION guard: the dispatcher's Gate 7.5
 * reconciliation guard (`listMemberIdsWithUnreconciledPaidMembershipInvoice`)
 * is STRUCTURALLY IMMUNE to the stale-anchor problem — it already filters
 * `status IN ('paid','partially_credited')`, so a void / fully-credited
 * anchor invoice is not even a candidate, and a partially-credited anchor
 * is still reconciled by the cycle. None of the five members below is falsely
 * flagged as "unreconciled" (which would SUPPRESS their reminder + raise a
 * loud staff alarm). This test documents that the guard needs no change.
 *
 * Live Neon (DEV branch). One tenant, five members, four anchor invoices.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { asSatang, type Satang } from '@/lib/money';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { creditNotes } from '@/modules/invoicing/infrastructure/db/schema-credit-notes';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { loadPipeline, makeRenewalsDeps } from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// 20 days out → t-30 urgency bucket, inside the 90-day pipeline window.
const EXPIRES_AT = new Date(Date.now() + 20 * 86_400_000);
const PERIOD_FROM = new Date(Date.now() - 345 * 86_400_000);
// Anchor payment 30 days ago — inside the guard's own `paid_at > NOW()-12mo`
// window (the guard uses the real wall-clock, not an injected test-clock).
const PAID_AT = new Date(Date.now() - 30 * 86_400_000);

type AnchorInvoiceStatus = 'paid' | 'void' | 'credited' | 'partially_credited';

interface Scenario {
  readonly key: string;
  readonly memberId: string;
  readonly cycleId: string;
  /** null → BACKFILL cohort (anchor_invoice_id IS NULL, no in-system invoice). */
  readonly invoiceId: string | null;
  readonly invoiceStatus: AnchorInvoiceStatus | null;
  readonly expectedAnchored: boolean;
  /**
   * M1 (plan-change-ux, Option 1b) — when non-null, seed a `credit_notes` row
   * against the anchor invoice with `retains_coverage = <this>`. TRUE simulates
   * an F4-manual FULL membership 'keep' (member NOT refunded → coverage
   * retained → still "Covered"); FALSE simulates an F5 refund CN. null = no
   * credit_notes row (the pre-existing defaulted / no-CN 'credited' cohort).
   */
  readonly creditNoteRetains: boolean | null;
}

const TOTAL_SATANG = asSatang(5_350_000n);

describe('loadPipeline `anchored` — anchor invoice void/refund coverage (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;
  const scenarios: Scenario[] = [];
  // M1 — monotone per-(tenant, fiscal_year) credit-note sequence number.
  let cnSeqCounter = 0;

  function mkScenario(
    key: string,
    invoiceStatus: AnchorInvoiceStatus | null,
    expectedAnchored: boolean,
    creditNoteRetains: boolean | null = null,
  ): Scenario {
    return {
      key,
      memberId: randomUUID(),
      cycleId: randomUUID(),
      invoiceId: invoiceStatus === null ? null : randomUUID(),
      invoiceStatus,
      expectedAnchored,
      creditNoteRetains,
    };
  }

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    planId = `f8-anchor-cov-${randomUUID().slice(0, 8)}`;

    scenarios.push(
      // A voided anchor invoice no longer covers the period.
      mkScenario('void', 'void', false),
      // A fully credit-noted / refunded anchor no longer covers the period.
      mkScenario('credited', 'credited', false),
      // A partial credit still leaves the period paid-for → still covered.
      mkScenario('partial', 'partially_credited', true),
      // Happy path — a live paid anchor covers the period.
      mkScenario('paid', 'paid', true),
      // M1 (Option 1b) — a fully-credited anchor with an F4-manual 'keep'
      // retention CN (retains_coverage=TRUE) still renders "Covered"; an
      // F5-refund CN (retains_coverage=FALSE) does not. The `credited` scenario
      // above (no CN row) is the pre-existing defaulted / no-CN cohort.
      mkScenario('credited-retains', 'credited', true, true),
      mkScenario('credited-refund', 'credited', false, false),
      // R4 backfill — no in-system invoice to refund; anchored_at stands alone.
      mkScenario('backfill', null, true),
    );

    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Anchor Coverage Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });

      for (const s of scenarios) {
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId: s.memberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: `Anchor ${s.key} Co`,
          country: 'TH',
          planId,
          planYear: 2026,
        });
        // Insert the anchor invoice BEFORE the cycle so the composite FK
        // `renewal_cycles_anchor_invoice_fk` (tenant_id, anchor_invoice_id) is
        // satisfied.
        if (s.invoiceId !== null && s.invoiceStatus !== null) {
          await insertAnchorInvoice(tx, {
            tenantSlug: tenant.ctx.slug,
            userId: user.userId,
            invoiceId: s.invoiceId,
            memberId: s.memberId,
            planId,
            status: s.invoiceStatus,
          });
          // M1 — seed the coverage-retention CN against the anchor invoice
          // (FK requires the invoice to exist first).
          if (s.creditNoteRetains !== null) {
            cnSeqCounter += 1;
            await insertRetentionCreditNote(tx, {
              tenantSlug: tenant.ctx.slug,
              userId: user.userId,
              invoiceId: s.invoiceId,
              sequenceNumber: cnSeqCounter,
              retainsCoverage: s.creditNoteRetains,
            });
          }
        }
        await tx.insert(renewalCycles).values({
          tenantId: tenant.ctx.slug,
          cycleId: s.cycleId,
          memberId: s.memberId,
          status: 'upcoming',
          periodFrom: PERIOD_FROM,
          periodTo: EXPIRES_AT,
          expiresAt: EXPIRES_AT,
          cycleLengthMonths: 12,
          tierAtCycleStart: 'regular',
          planIdAtCycleStart: planId,
          frozenPlanPriceThb: '50000.00',
          frozenPlanTermMonths: 12,
          frozenPlanCurrency: 'THB',
          // Rolling-anchor discriminator stamped (real payment / R4 backfill).
          // linked_invoice_id deliberately NULL so the "Covered" branch (not
          // the "View invoice" link) is what the pipeline cell would render.
          anchoredAt: new Date(),
          anchorInvoiceId: s.invoiceId,
        });
      }
    });
  }, 180_000);

  afterAll(async () => {
    // credit_notes + renewal_cycles (both composite FK → invoices) BEFORE invoices.
    await db
      .delete(creditNotes)
      .where(eq(creditNotes.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(invoices)
      .where(eq(invoices.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('maps `anchored` from the anchor invoice effective-paid state (void/full-credit → not covered; partial/backfill/paid → covered)', async () => {
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const result = await loadPipeline(deps, {
      tenantId: tenant.ctx.slug,
      urgency: 't-30',
      limit: 50,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const s of scenarios) {
      const row = result.value.rows.find((r) => r.cycleId === s.cycleId);
      expect(row, `row for scenario ${s.key} present`).toBeDefined();
      expect(row?.anchored, `anchored for scenario ${s.key}`).toBe(
        s.expectedAnchored,
      );
    }
  });

  it('reconciliation guard is immune: no member is falsely flagged as unreconciled (would suppress reminders)', async () => {
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const flagged =
      await deps.memberRenewalFlagsRepo.listMemberIdsWithUnreconciledPaidMembershipInvoice(
        tenant.ctx.slug,
      );
    for (const s of scenarios) {
      expect(
        flagged.has(s.memberId),
        `member ${s.key} must NOT be flagged unreconciled`,
      ).toBe(false);
    }
  });
});

/**
 * M1 — seed a `credit_notes` row against the anchor invoice with an explicit
 * `retains_coverage`. The L1 pipeline read model reads only `tenant_id`,
 * `original_invoice_id`, and `retains_coverage` via a correlated EXISTS, so the
 * snapshot/PDF fields are placeholder-valid.
 */
async function insertRetentionCreditNote(
  tx: Parameters<Parameters<typeof runInTenant>[1]>[0],
  args: {
    readonly tenantSlug: string;
    readonly userId: string;
    readonly invoiceId: string;
    readonly sequenceNumber: number;
    readonly retainsCoverage: boolean;
  },
): Promise<void> {
  await tx.insert(creditNotes).values({
    tenantId: args.tenantSlug,
    creditNoteId: randomUUID(),
    originalInvoiceId: args.invoiceId,
    fiscalYear: 2026,
    sequenceNumber: args.sequenceNumber,
    documentNumber: `CN-2026-${String(args.sequenceNumber).padStart(6, '0')}`,
    issueDate: '2026-02-01',
    issuedByUserId: args.userId,
    reason: args.retainsCoverage
      ? 'paperwork correction — member not refunded, coverage retained'
      : 'refund — money returned',
    creditAmountSatang: asSatang(5_000_000n),
    vatSatang: asSatang(350_000n),
    totalSatang: TOTAL_SATANG,
    tenantIdentitySnapshot: { legalNameEn: 'Test', taxId: '0' } as unknown,
    memberIdentitySnapshot: { legal_name: 'Anchor Co Ltd' } as unknown,
    pdfBlobKey: `invoicing/${args.tenantSlug}/2026/cn-${args.sequenceNumber}.pdf`,
    pdfSha256: 'c'.repeat(64),
    pdfTemplateVersion: 1,
    retainsCoverage: args.retainsCoverage,
  });
}

async function insertAnchorInvoice(
  tx: Parameters<Parameters<typeof runInTenant>[1]>[0],
  args: {
    readonly tenantSlug: string;
    readonly userId: string;
    readonly invoiceId: string;
    readonly memberId: string;
    readonly planId: string;
    readonly status: AnchorInvoiceStatus;
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
      companyName: 'Anchor Co',
      country: 'TH',
      legal_name: 'Anchor Co Ltd',
      address: '1 Test Road, Bangkok 10110',
      primary_contact_name: 'Test Contact',
      primary_contact_email: 'anchor@example.com',
    } as unknown,
    pdfBlobKey: `invoicing/${args.tenantSlug}/2026/${args.invoiceId}.pdf`,
    pdfSha256: 'a'.repeat(64),
    pdfTemplateVersion: 1,
    paymentMethod: 'bank_transfer',
    paymentReference: 'ANCHOR-TEST-PAY',
    paymentRecordedByUserId: args.userId,
    paymentDate: PAID_AT.toISOString().slice(0, 10),
    paidAt: PAID_AT,
    // A `void` row must carry a reason + actor (CHECK invoices_void_has_reason).
    ...(args.status === 'void'
      ? {
          voidedAt: new Date(),
          voidReason: 'test fixture void',
          voidedByUserId: args.userId,
        }
      : {}),
  });
}
