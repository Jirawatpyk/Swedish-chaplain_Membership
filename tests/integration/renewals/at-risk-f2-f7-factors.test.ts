/**
 * F8 PR #24 Round 9 — integration test for the 2 at-risk factors that
 * Round 7 unblocked when F2 (Membership Plans) + F7 (Email Broadcast)
 * shipped: `tier_downgraded_last_12mo` and `eBlastQuotaPctUsed`.
 *
 * Closes the test-coverage gap surfaced by Round 8 deep-review: the
 * Round 7 wires were guarded by typecheck and unit-test branch coverage
 * of the Domain `computeAtRiskScore` function, but no integration test
 * actually seeded:
 *   - a `member_plan_changed` audit_log row (so the SQL JOIN scan is
 *     exercised against real JSONB → text path operators)
 *   - a `broadcast_deliveries` row JOINed to its parent `broadcasts` row
 *     with `quota_year_consumed` populated (so the JOIN that Round 8
 *     fixed — broadcast_deliveries → broadcasts — is exercised)
 *
 * Without this test, a future regression in either SQL query (typo in
 * a JSONB path operator, wrong join column, or schema drift) would
 * pass typecheck + unit suite + production deploy and surface only
 * when an admin notices the at-risk dashboard is silently mis-scoring.
 *
 * The test seeds two plans with different annual fees, one member who
 * was on the higher-fee plan and downgraded to the lower one, plus a
 * broadcast + delivery row, then calls `scoreMember()` and asserts
 * BOTH factors landed non-default values.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { asSatang } from '@/lib/money';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import {
  broadcasts,
  broadcastDeliveries,
} from '@/modules/broadcasts/infrastructure/schema';
import { makeRenewalsDeps } from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW_MS = Date.now();

describe('F8 at-risk Round 7 factors — F2 tier-downgrade + F7 e-blast quota', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedRenewalPolicies(tenant.ctx);
  }, 180_000);

  afterAll(async () => {
    // Clean up in reverse dep order: deliveries → broadcasts → audit →
    // cycles → contacts → members. tenant.cleanup() handles tenant-level
    // teardown; the explicit deletes scope to this test's data only.
    await db
      .delete(broadcastDeliveries)
      .where(eq(broadcastDeliveries.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(broadcasts)
      .where(eq(broadcasts.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('detects a tier downgrade in the last 12mo via audit_log JSONB scan', async () => {
    const memberId = randomUUID();
    const premiumPlanId = `f8-r9-prem-${randomUUID().slice(0, 6)}`;
    const standardPlanId = `f8-r9-std-${randomUUID().slice(0, 6)}`;

    await runInTenant(tenant.ctx, async (tx) => {
      // 063 — a downgrade is a move to a lower tier BUCKET, not just a
      // fee decrease. Seed the old plan in the `premium` bucket and the
      // new plan in the lower `regular` bucket. (Pre-063 this test relied
      // solely on annual_fee 250k < 1M with both plans defaulting to the
      // `regular` bucket — which the corrected bucket-ordinal logic no
      // longer treats as a downgrade.)
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: premiumPlanId,
        planName: { en: 'Premium' },
        annualFeeMinorUnits: 100_000_000, // 1,000,000 THB
        renewalTierBucket: 'premium',
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: standardPlanId,
        planName: { en: 'Standard' },
        annualFeeMinorUnits: 25_000_000, // 250,000 THB — lower
        renewalTierBucket: 'regular', // lower bucket ordinal than premium
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });
      // Seed member CURRENTLY on the lower (standard) plan.
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Downgrade Co',
        country: 'TH',
        planId: standardPlanId,
        planYear: 2026,
        // Backdate so member clears FR-035 min-tenure gate.
        createdAt: new Date(NOW_MS - 365 * MS_PER_DAY),
        lastActivityAt: new Date(NOW_MS - 30 * MS_PER_DAY),
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Down',
        lastName: 'Grade',
        email: `down-${memberId.slice(0, 6)}@acme.example`,
        isPrimary: true,
        preferredLanguage: 'en',
      });
      // Emit the historical plan-change audit row that the at-risk
      // SQL JOIN scans for. Payload shape mirrors F3 change-plan.ts:227.
      await tx.insert(auditLog).values({
        eventType: 'member_plan_changed',
        actorUserId: user.userId,
        targetUserId: null,
        sourceIp: null,
        summary: `member_plan_changed ${memberId}`,
        requestId: randomUUID(),
        tenantId: tenant.ctx.slug,
        timestamp: new Date(NOW_MS - 60 * MS_PER_DAY),
        payload: {
          member_id: memberId,
          old_plan_id: premiumPlanId,
          old_plan_year: 2026,
          new_plan_id: standardPlanId,
          new_plan_year: 2026,
        },
      });
    });

    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const result = await deps.atRiskScorer.scoreMember(
      tenant.ctx.slug,
      memberId,
    );

    // The member's score should reflect the downgrade — the Domain
    // weight for `tier_downgraded_last_12mo` is +15 (per
    // src/modules/renewals/domain/at-risk-score.ts). Since the rest of
    // the factors (no overdue invoices, no missing payments) are
    // healthy, the score should equal the downgrade weight.
    expect(result.score).toBeGreaterThanOrEqual(15);
    expect(
      result.contributions.some((c) => c.factor === 'tier_downgraded_last_12mo'),
    ).toBe(true);
  }, 60_000);

  it('counts e-blasts the member ORIGINATED against their sending quota', async () => {
    // 063 — the e-blast quota factor counts broadcasts the member
    // ORIGINATED (requested_by_member_id), NOT broadcasts they received
    // (per F7 Q16 the originator holds the quota; the sender is excluded
    // from receiving their own broadcast). This test seeds one ORIGINATED
    // sent broadcast (no delivery row — receipt is irrelevant to the
    // sending quota) on a 4-quota plan: 1/4 = 25% used → <30% → +15.
    const memberId = randomUUID();
    const planId = `f8-r9-eblast-${randomUUID().slice(0, 6)}`;
    const broadcastId = randomUUID();
    const currentYear = new Date().getFullYear();

    await runInTenant(tenant.ctx, async (tx) => {
      // Plan with eblast quota = 4 (so 1 originated broadcast = 25% used
      // → triggers the "<30% used" factor).
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'EBlast Plan' },
        benefitMatrix: { ...DEFAULT_TEST_BENEFIT_MATRIX, eblast_per_year: 4 },
        createdBy: user.userId,
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'EBlast Co',
        country: 'TH',
        planId,
        planYear: 2026,
        createdAt: new Date(NOW_MS - 365 * MS_PER_DAY),
        lastActivityAt: new Date(NOW_MS - 30 * MS_PER_DAY),
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'EBlast',
        lastName: 'Member',
        email: `eblast-${memberId.slice(0, 6)}@acme.example`,
        isPrimary: true,
        preferredLanguage: 'en',
      });
      // Broadcast ORIGINATED by the member — quota_year_consumed
      // populated per F7's FR-007 invariant (only set on `status='sent'`).
      // No broadcast_deliveries row: receipt is irrelevant to the
      // member's own SENDING quota (063 axis fix).
      await tx.insert(broadcasts).values({
        tenantId: tenant.ctx.slug,
        broadcastId,
        requestedByMemberId: memberId,
        requestedByMemberPlanIdSnapshot: planId,
        submittedByUserId: user.userId,
        actorRole: 'admin_proxy',
        subject: 'Test Broadcast',
        bodyHtml: '<p>x</p>',
        bodySource: '<p>x</p>',
        fromName: 'Test',
        replyToEmail: 'reply@example.com',
        segmentType: 'all_members',
        estimatedRecipientCount: 1,
        status: 'sent',
        quotaYearConsumed: currentYear,
        quotaConsumedAt: new Date(),
        sentAt: new Date(NOW_MS - 7 * MS_PER_DAY),
      });
    });

    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const result = await deps.atRiskScorer.scoreMember(
      tenant.ctx.slug,
      memberId,
    );

    // 1 originated broadcast / 4 quota = 25% used → triggers the "<30%
    // used" factor weighted +15 per FR-029. Score should reflect at least
    // that contribution; we don't pin a tighter equality because other
    // factors (tenureDays etc.) may also contribute small amounts.
    expect(result.score).toBeGreaterThanOrEqual(15);
    expect(
      result.contributions.some((c) => c.factor === 'e_blast_quota_under_30pct'),
    ).toBe(true);
  }, 60_000);

  // ---------------------------------------------------------------------
  // Review Task 11 — F-3 status filter: MAX(paid_at) FILTER (WHERE status
  // IN ('paid','partially_credited')) in BOTH scorers (commit 2d1e348d).
  // Closes the test-coverage gap the review flagged: the fix shipped with
  // zero integration coverage. These 3 tests seed real invoices through
  // the fully-credited / partially-credited transitions and assert the
  // filtered MAX against both the batch CTE (`gatherAtRiskFactorsForTenant`
  // → `lastPaidAtIso`) and the single-member scorer (`scoreMember` →
  // `days_since_last_payment_gt_180` contribution).
  // ---------------------------------------------------------------------

  /**
   * Seed an ACTIVE member with a non-lapsed renewal cycle so the batch
   * CTE's `WHERE m.status='active' AND EXISTS(non-lapsed cycle)` admits
   * it (mirrors `at-risk-scorer-convergence.test.ts`'s `seedActiveMember`).
   * Backdated `created_at` clears the FR-035 min-tenure gate.
   */
  async function seedActiveMemberWithCycle(planId: string): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `F-3 Co ${memberId.slice(0, 6)}`,
        country: 'TH',
        planId,
        planYear: 2026,
        createdAt: new Date(NOW_MS - 365 * MS_PER_DAY),
        lastActivityAt: new Date(NOW_MS - 30 * MS_PER_DAY),
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'F3',
        lastName: 'Payer',
        email: `f3-${memberId.slice(0, 6)}@acme.example`,
        isPrimary: true,
        preferredLanguage: 'en',
      });
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: randomUUID(),
        memberId,
        status: 'upcoming',
        periodFrom: new Date(NOW_MS - 30 * MS_PER_DAY),
        periodTo: new Date(NOW_MS + 335 * MS_PER_DAY),
        expiresAt: new Date(NOW_MS + 335 * MS_PER_DAY),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      });
    });
    return memberId;
  }

  /**
   * Insert a paid invoice for `memberId`, then (optionally) transition it
   * to `credited` (fully) or `partially_credited` via a follow-up UPDATE —
   * mirroring how the real F4 credit-note flow leaves `paid_at` untouched
   * (it is a forensic record of when the ORIGINAL payment landed, not of
   * the credit event). Always inserts as `status='paid'` first to satisfy
   * `invoices_paid_has_payment` (paid_at + payment_method) and
   * `invoices_paid_has_receipt_status` (receipt_pdf_status NOT NULL); the
   * follow-up UPDATE only needs to satisfy `invoices_credited_status_matches`
   * (migration 0019): credited_total_satang must equal total_satang for
   * `credited`, and be strictly between 0 and total_satang for
   * `partially_credited`.
   */
  async function seedInvoiceWithPaymentStatus(
    memberId: string,
    planId: string,
    opts: {
      readonly finalStatus: 'paid' | 'credited' | 'partially_credited';
      readonly paidAtMs: number;
    },
  ): Promise<string> {
    const invoiceId = randomUUID();
    const totalSatang = 5_350_000n;
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId,
        status: 'paid',
        pdfDocKind: 'invoice',
        receiptPdfStatus: 'rendered',
        draftByUserId: user.userId,
        fiscalYear: 2026,
        sequenceNumber: Math.floor(Math.random() * 1_000_000) + 1,
        documentNumber: `INV-2026-${String(Math.floor(Math.random() * 900000) + 100000)}`,
        issueDate: '2026-08-01',
        dueDate: '2026-08-31',
        currency: 'THB',
        subtotalSatang: asSatang(5_000_000n),
        vatRateSnapshot: '0.0700',
        vatSatang: asSatang(350_000n),
        totalSatang: asSatang(totalSatang),
        proRatePolicySnapshot: 'whole_year',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: { legalNameEn: 'Test', taxId: '0' } as unknown,
        memberIdentitySnapshot: {
          companyName: 'F-3 Payer Co',
          country: 'TH',
          legal_name: 'F-3 Payer Co Ltd',
          address: '1 Test Road, Bangkok 10110',
          primary_contact_name: 'Test Contact',
          primary_contact_email: 'f3-payer@example.com',
        } as unknown,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
        paymentMethod: 'bank_transfer',
        paymentReference: 'F3-STATUS-FILTER-TEST',
        paymentRecordedByUserId: user.userId,
        paymentDate: new Date(opts.paidAtMs).toISOString().slice(0, 10),
        paidAt: new Date(opts.paidAtMs),
      });

      if (opts.finalStatus !== 'paid') {
        // Fully credited ⇒ credited_total_satang === total_satang.
        // Partially credited ⇒ strictly between 0 and total_satang.
        const creditedTotal =
          opts.finalStatus === 'credited' ? totalSatang : totalSatang / 2n;
        await tx
          .update(invoices)
          .set({
            status: opts.finalStatus,
            creditedTotalSatang: asSatang(creditedTotal),
          })
          .where(
            and(
              eq(invoices.tenantId, tenant.ctx.slug),
              eq(invoices.invoiceId, invoiceId),
            ),
          );
      }
    });
    return invoiceId;
  }

  /** Batch-scorer row for `memberId`, via the same CTE the weekly recompute uses. */
  async function batchRowFor(memberId: string) {
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const rows = await runInTenant(tenant.ctx, (tx) =>
      deps.memberRenewalFlagsRepo.gatherAtRiskFactorsForTenant(
        tx,
        tenant.ctx.slug,
      ),
    );
    const row = rows.find((r) => r.memberId === memberId);
    if (row === undefined) {
      throw new Error(
        `batch gather returned no row for member ${memberId} — is the member active with a non-lapsed renewal cycle?`,
      );
    }
    return row;
  }

  it('F-3: a fully CREDITED invoice is excluded from lastPaidAtIso (batch scorer) and does not fire days_since_last_payment (single scorer)', async () => {
    // Member's ONLY invoice was paid 200 days ago, then fully credited
    // (refunded). Post-fix, the FILTER excludes 'credited' rows from
    // MAX(paid_at) entirely — there is no live payment on record at all,
    // so both the batch row's `lastPaidAtIso` AND the single scorer's
    // `daysSinceLastPayment` input come back with no signal (undefined),
    // and the Domain function skips the `days_since_last_payment_gt_180`
    // contribution rather than treating "no live payment" as "very stale".
    const planId = `f3-credited-${randomUUID().slice(0, 6)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'F-3 Credited Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
    const memberId = await seedActiveMemberWithCycle(planId);
    await seedInvoiceWithPaymentStatus(memberId, planId, {
      finalStatus: 'credited',
      paidAtMs: NOW_MS - 200 * MS_PER_DAY,
    });

    const row = await batchRowFor(memberId);
    expect(row.lastPaidAtIso).toBeNull();

    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const single = await deps.atRiskScorer.scoreMember(
      tenant.ctx.slug,
      memberId,
    );
    expect(
      single.contributions.some(
        (c) => c.factor === 'days_since_last_payment_gt_180',
      ),
    ).toBe(false);
  }, 60_000);

  it('F-3: a stale live payment is NOT masked by a more-recent fully-credited invoice (single + batch convergence)', async () => {
    // Invoice A: paid 200 days ago, remains `paid` (live, unrefunded).
    // Invoice B: paid 5 days ago, then FULLY credited (refunded) — a more
    // recent payment that was subsequently reversed. Pre-fix, an
    // unfiltered MAX(paid_at) picks the literal largest timestamp
    // regardless of status — invoice B's recent-but-reversed paid_at —
    // which would WRONGLY mask the member's true (stale, >180d) last live
    // payment and suppress the at-risk signal. Post-fix, the FILTER drops
    // invoice B from the aggregate and the stale invoice A correctly wins.
    const planId = `f3-mask-${randomUUID().slice(0, 6)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'F-3 Masking Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
    const memberId = await seedActiveMemberWithCycle(planId);
    const staleLivePaidAtMs = NOW_MS - 200 * MS_PER_DAY;
    await seedInvoiceWithPaymentStatus(memberId, planId, {
      finalStatus: 'paid',
      paidAtMs: staleLivePaidAtMs,
    });
    await seedInvoiceWithPaymentStatus(memberId, planId, {
      finalStatus: 'credited',
      paidAtMs: NOW_MS - 5 * MS_PER_DAY,
    });

    const row = await batchRowFor(memberId);
    expect(row.lastPaidAtIso).toBe(new Date(staleLivePaidAtMs).toISOString());

    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const single = await deps.atRiskScorer.scoreMember(
      tenant.ctx.slug,
      memberId,
    );
    expect(
      single.contributions.some(
        (c) => c.factor === 'days_since_last_payment_gt_180',
      ),
    ).toBe(true);
  }, 60_000);

  it('F-3: a PARTIALLY credited invoice still counts as a live payment (single + batch)', async () => {
    // Member's ONLY invoice was paid 5 days ago and later partially
    // credited (a partial refund/adjustment, not a full reversal). The
    // FILTER's `status IN ('paid','partially_credited')` keeps this row
    // in the MAX aggregate — the member DID make a live payment, so both
    // scorers must treat it as recent (healthy), not stale.
    const planId = `f3-partial-${randomUUID().slice(0, 6)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'F-3 Partial Credit Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
    const memberId = await seedActiveMemberWithCycle(planId);
    const recentPaidAtMs = NOW_MS - 5 * MS_PER_DAY;
    await seedInvoiceWithPaymentStatus(memberId, planId, {
      finalStatus: 'partially_credited',
      paidAtMs: recentPaidAtMs,
    });

    const row = await batchRowFor(memberId);
    expect(row.lastPaidAtIso).toBe(new Date(recentPaidAtMs).toISOString());

    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const single = await deps.atRiskScorer.scoreMember(
      tenant.ctx.slug,
      memberId,
    );
    expect(
      single.contributions.some(
        (c) => c.factor === 'days_since_last_payment_gt_180',
      ),
    ).toBe(false);
  }, 60_000);
});
