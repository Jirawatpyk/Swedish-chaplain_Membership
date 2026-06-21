/**
 * 063-renewal-audit-fixes — at-risk scorer CONVERGENCE regression guard.
 *
 * Before this fix the two at-risk scorers disagreed AND both diverged
 * from the spec on two factors:
 *
 *   1. e-blast quota used % (FR-029 line 3 — "E-Blast quota used <30% → +15")
 *      - Single-member scorer (`drizzle-at-risk-scorer.ts`) counted
 *        `broadcast_deliveries WHERE recipient_member_id = member`
 *        (RECEIVED axis — broadcasts OTHERS sent, unrelated to the
 *        member's own SENDING quota; contradicts F7 Q16 where the
 *        originator is the quota holder + is EXCLUDED from receiving
 *        their own broadcast).
 *      - Batch scorer (`drizzle-member-renewal-flags-repo.ts`) counted
 *        `broadcasts WHERE requested_by_member_id = member` (ORIGINATED
 *        — correct axis) but windowed on a ROLLING 12-month
 *        `quota_consumed_at` instead of the per-quota-YEAR window F7
 *        uses.
 *
 *   2. tier downgrade (FR-029 line 8 — "Tier downgraded in last 12mo")
 *      - Single-member scorer compared `annual_fee_minor_units` (so a
 *        same-bucket fee cut via custom pricing/override falsely
 *        registered as a downgrade).
 *      - Batch scorer compared the `renewal_tier_bucket` ORDINAL
 *        (correct — a downgrade is a move to a lower tier BUCKET).
 *
 * Both scorers now converge on the SPEC-correct definition:
 *   - e-blast: broadcasts the member ORIGINATED that were SENT in the
 *     current quota year, divided by `eblast_per_year`. This is F9's
 *     benefit-usage `used` (computeQuotaCounter.used = countForMemberQuota
 *     `sent`, the year-fenced sent bucket) — the engagement notion. It
 *     intentionally DIVERGES from F7's quota-ENFORCEMENT count, which also
 *     adds the `reserved` bucket (submitted/approved/failed_to_dispatch).
 *     Reserved rows carry `quota_year_consumed IS NULL` (no year fence),
 *     so a stale prior-year reservation would otherwise inflate this
 *     year's usage and suppress the +15 risk signal (#8 refinement of #3).
 *   - tier: lower new-bucket ORDINAL than old-bucket ordinal.
 *
 * This file is the regression guard: it seeds members where the OLD
 * code made the two scorers DIVERGE, then asserts they now AGREE on the
 * e_blast_quota_under_30pct + tier_downgraded_last_12mo factor outcome.
 *
 * Convergence is asserted by comparing the FACTOR-FIRED boolean from
 * BOTH paths for the SAME member:
 *   - single: `scoreMember(...).contributions`
 *   - batch:  `gatherAtRiskFactorsForTenant(...)` → Domain
 *             `computeAtRiskScore` (same pure function the batch
 *             use-case calls), so any axis/window/bucket drift surfaces.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import {
  broadcasts,
  broadcastDeliveries,
} from '@/modules/broadcasts/infrastructure/schema';
import { currentQuotaYear } from '@/modules/broadcasts';
import { env } from '@/lib/env';
import {
  computeAtRiskScore,
  type AtRiskFactors,
} from '@/modules/renewals/domain/at-risk-score';
import { makeRenewalsDeps } from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW_MS = Date.now();
const QUOTA_YEAR = currentQuotaYear(new Date(), env.tenant.timezone);

/**
 * The Domain factor key both scorers must agree on.
 */
const EBLAST_FACTOR = 'e_blast_quota_under_30pct' as const;
const TIER_FACTOR = 'tier_downgraded_last_12mo' as const;

describe('063 at-risk scorer convergence — e-blast axis + tier bucket', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedRenewalPolicies(tenant.ctx);
  }, 180_000);

  afterAll(async () => {
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
    // audit_log cleanup intentionally skipped — append-only trigger
    // blocks all DELETEs (see tests/integration/helpers/test-tenant.ts).
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  /** Did the single-member scorer fire `factor` for `memberId`? */
  async function singleFires(
    memberId: string,
    factor: typeof EBLAST_FACTOR | typeof TIER_FACTOR,
  ): Promise<boolean> {
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const result = await deps.atRiskScorer.scoreMember(
      tenant.ctx.slug,
      memberId,
    );
    return result.contributions.some((c) => c.factor === factor);
  }

  /**
   * Did the BATCH path fire `factor` for `memberId`? Drives the same
   * `gatherAtRiskFactorsForTenant` CTE + Domain `computeAtRiskScore` the
   * `recomputeAtRiskScoresBatch` use-case runs, so any divergence in the
   * batch CTE's e-blast window/axis or tier-bucket logic surfaces here.
   */
  async function batchFires(
    memberId: string,
    factor: typeof EBLAST_FACTOR | typeof TIER_FACTOR,
  ): Promise<boolean> {
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
    const tenureDays = Math.floor(
      (NOW_MS - new Date(row.memberCreatedAt).getTime()) / MS_PER_DAY,
    );
    const factors: AtRiskFactors = {
      tenureDays,
      invoicesOverdueCount: row.invoicesOverdueCount,
      ...(row.eblastQuotaPctUsed !== null
        ? { eBlastQuotaPctUsed: row.eblastQuotaPctUsed }
        : {}),
      tierDowngradedLast12Months: row.tierDowngradedLast12Months,
    };
    const r = computeAtRiskScore(factors, {
      minTenureDays: 30,
      // F6 stubbed false in F7 era; e-blast + tier are F6-independent so
      // this does not affect either asserted factor.
      eventAttendeesAvailable: false,
    });
    if (!r.ok) throw new Error('unreachable: Domain returns Result<_, never>');
    return r.value.contributions.some((c) => c.factor === factor);
  }

  /**
   * Seed an ACTIVE member with a non-lapsed renewal cycle (so the batch
   * CTE's `WHERE m.status='active' AND EXISTS(non-lapsed cycle)` admits
   * it) on `planId`. Backdated `created_at` clears the FR-035 min-tenure
   * gate. Returns the new member id.
   */
  async function seedActiveMember(planId: string): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Conv Co ${memberId.slice(0, 6)}`,
        country: 'TH',
        planId,
        planYear: 2026,
        status: 'active',
        createdAt: new Date(NOW_MS - 365 * MS_PER_DAY),
        lastActivityAt: new Date(NOW_MS - 30 * MS_PER_DAY),
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Conv',
        lastName: 'Member',
        email: `conv-${memberId.slice(0, 6)}@acme.example`,
        isPrimary: true,
        preferredLanguage: 'en',
      });
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: randomUUID(),
        memberId,
        // `upcoming` is NOT in the batch CTE's lapsed/cancelled exclusion
        // and satisfies the partial-unique active-cycle constraint.
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

  /** Insert a `sent` broadcast ORIGINATED by `memberId` in the quota year. */
  async function seedOriginatedSentBroadcast(memberId: string): Promise<void> {
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(broadcasts).values({
        tenantId: tenant.ctx.slug,
        broadcastId: randomUUID(),
        requestedByMemberId: memberId,
        requestedByMemberPlanIdSnapshot: 'snap',
        submittedByUserId: user.userId,
        actorRole: 'admin_proxy',
        subject: 'Originated',
        bodyHtml: '<p>x</p>',
        bodySource: '<p>x</p>',
        fromName: 'Test',
        replyToEmail: 'reply@example.com',
        segmentType: 'all_members',
        estimatedRecipientCount: 1,
        status: 'sent',
        quotaYearConsumed: QUOTA_YEAR,
        quotaConsumedAt: new Date(),
        sentAt: new Date(NOW_MS - 7 * MS_PER_DAY),
      });
    });
  }

  /**
   * Insert a RESERVED broadcast ORIGINATED by `memberId` that must be
   * IGNORED by the at-risk engagement count (which counts only sent
   * rows). Reserved rows (`submitted` / `approved` / `failed_to_dispatch`)
   * carry `quota_year_consumed IS NULL` (CHECK
   * `broadcasts_quota_year_only_on_sent`), so they have no year fence.
   * NOTE: `failed_to_dispatch` RELEASES the quota slot (Design D1,
   * 2026-06-21); `submitted`/`approved` still hold a slot in F7's
   * enforcement count while in-flight.
   *
   * This is the #8 hazard: a stale reserved row would inflate the at-risk
   * ENGAGEMENT usage count, masking a disengaged member. The at-risk
   * factor must IGNORE reserved rows and count only sent-this-year
   * (matching F9 `computeQuotaCounter.used`).
   */
  async function seedOriginatedReservedBroadcast(
    memberId: string,
    status: 'submitted' | 'approved' | 'failed_to_dispatch',
    submittedAtMs: number,
  ): Promise<void> {
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(broadcasts).values({
        tenantId: tenant.ctx.slug,
        broadcastId: randomUUID(),
        requestedByMemberId: memberId,
        requestedByMemberPlanIdSnapshot: 'snap',
        submittedByUserId: user.userId,
        actorRole: 'admin_proxy',
        subject: 'Stale Reserved',
        bodyHtml: '<p>x</p>',
        bodySource: '<p>x</p>',
        fromName: 'Test',
        replyToEmail: 'reply@example.com',
        segmentType: 'all_members',
        estimatedRecipientCount: 1,
        status,
        // Reserved rows MUST leave quota_year_consumed NULL per the
        // broadcasts_quota_year_only_on_sent CHECK — the absence of a
        // year fence is exactly why a stale prior-year reservation
        // leaks into F7's enforcement count.
        quotaYearConsumed: null,
        quotaConsumedAt: null,
        submittedAt: new Date(submittedAtMs),
      });
    });
  }

  /**
   * Insert a `partial_delivery_accepted` broadcast ORIGINATED by
   * `memberId` in the current quota year. Finding C: this terminal state
   * CONSUMES the annual quota slot exactly like `sent` (it stamps
   * `quota_year_consumed` per the schema CHECK + `acceptPartial`), so the
   * at-risk ENGAGEMENT usage count MUST include it. Counting only `sent`
   * undercounts usage and falsely fires the +15 "didn't use e-blast"
   * factor for a member who did send (partial accept).
   */
  async function seedOriginatedPartialAcceptedBroadcast(
    memberId: string,
  ): Promise<void> {
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(broadcasts).values({
        tenantId: tenant.ctx.slug,
        broadcastId: randomUUID(),
        requestedByMemberId: memberId,
        requestedByMemberPlanIdSnapshot: 'snap',
        submittedByUserId: user.userId,
        actorRole: 'admin_proxy',
        subject: 'Partial Accepted',
        bodyHtml: '<p>x</p>',
        bodySource: '<p>x</p>',
        fromName: 'Test',
        replyToEmail: 'reply@example.com',
        segmentType: 'all_members',
        estimatedRecipientCount: 1,
        status: 'partial_delivery_accepted',
        // Both quota fields are mandatory for this terminal state
        // (CHECK broadcasts_quota_year_only_on_sent), mirroring the
        // `acceptPartial` repo write.
        quotaYearConsumed: QUOTA_YEAR,
        quotaConsumedAt: new Date(),
        partialDeliveryAcceptedAt: new Date(NOW_MS - 7 * MS_PER_DAY),
        partialDeliveryAcceptedByUserId: user.userId,
      });
    });
  }

  /**
   * Insert a `sent` broadcast originated by SOMEONE ELSE that was
   * DELIVERED TO `recipientMemberId` (the received axis). This must NOT
   * count toward the recipient's own SENDING quota.
   */
  async function seedReceivedBroadcast(
    recipientMemberId: string,
    senderMemberId: string,
  ): Promise<void> {
    await runInTenant(tenant.ctx, async (tx) => {
      const broadcastId = randomUUID();
      await tx.insert(broadcasts).values({
        tenantId: tenant.ctx.slug,
        broadcastId,
        requestedByMemberId: senderMemberId,
        requestedByMemberPlanIdSnapshot: 'snap',
        submittedByUserId: user.userId,
        actorRole: 'admin_proxy',
        subject: 'Received',
        bodyHtml: '<p>x</p>',
        bodySource: '<p>x</p>',
        fromName: 'Test',
        replyToEmail: 'reply@example.com',
        segmentType: 'all_members',
        estimatedRecipientCount: 1,
        status: 'sent',
        quotaYearConsumed: QUOTA_YEAR,
        quotaConsumedAt: new Date(),
        sentAt: new Date(NOW_MS - 7 * MS_PER_DAY),
      });
      await tx.insert(broadcastDeliveries).values({
        tenantId: tenant.ctx.slug,
        deliveryId: randomUUID(),
        broadcastId,
        resendEventId: `evt_${randomUUID().slice(0, 8)}`,
        resendMessageId: `msg_${randomUUID().slice(0, 8)}`,
        recipientEmailLower: `conv-${recipientMemberId.slice(0, 6)}@acme.example`,
        recipientMemberId,
        status: 'sent',
        eventTimestamp: new Date(NOW_MS - 7 * MS_PER_DAY),
      });
    });
  }

  // ---------------------------------------------------------------------
  // E-blast axis convergence
  // ---------------------------------------------------------------------

  it('e-blast: member ORIGINATED 50% of quota → factor does NOT fire on EITHER scorer (old single mis-fired on recipient axis)', async () => {
    // Plan eblast_per_year = 4. Member originates 2 sent broadcasts this
    // quota year (50% used) and RECEIVES 0. 50% >= 30% → factor must NOT
    // fire. Old single counted received (=0 → 0% → +15) → would diverge.
    const planId = `conv-orig50-${randomUUID().slice(0, 6)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Orig50 Plan' },
        benefitMatrix: { ...DEFAULT_TEST_BENEFIT_MATRIX, eblast_per_year: 4 },
        createdBy: user.userId,
      }),
    );
    const memberId = await seedActiveMember(planId);
    await seedOriginatedSentBroadcast(memberId);
    await seedOriginatedSentBroadcast(memberId);

    const single = await singleFires(memberId, EBLAST_FACTOR);
    const batch = await batchFires(memberId, EBLAST_FACTOR);

    // Both must agree, and both must be FALSE (50% used → not <30%).
    expect(single).toBe(batch);
    expect(single).toBe(false);
  }, 90_000);

  it('e-blast: member RECEIVED 2 but ORIGINATED 0 → factor FIRES on BOTH (proves axis is sender, not recipient)', async () => {
    // Plan eblast_per_year = 4. Member originates 0 (0% used → <30% →
    // +15) but RECEIVES 2 broadcasts from another member. Old single
    // counted the 2 received (50% used → no fire) → would diverge from
    // the batch (which fired on 0% originated).
    const planId = `conv-recv-${randomUUID().slice(0, 6)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Recv Plan' },
        benefitMatrix: { ...DEFAULT_TEST_BENEFIT_MATRIX, eblast_per_year: 4 },
        createdBy: user.userId,
      }),
    );
    const memberId = await seedActiveMember(planId);
    // A second member is the SENDER of the broadcasts this member receives.
    const senderId = await seedActiveMember(planId);
    await seedReceivedBroadcast(memberId, senderId);
    await seedReceivedBroadcast(memberId, senderId);

    const single = await singleFires(memberId, EBLAST_FACTOR);
    const batch = await batchFires(memberId, EBLAST_FACTOR);

    expect(single).toBe(batch);
    expect(single).toBe(true);
  }, 90_000);

  it('finding C e-blast: 1 sent + 1 partial_delivery_accepted this year → usage=2 (partial COUNTED) → +15 does NOT fire on BOTH', async () => {
    // Plan eblast_per_year = 4. Member has:
    //   (a) 1 `sent` broadcast in the current quota year
    //   (b) 1 `partial_delivery_accepted` broadcast in the current quota
    //       year (admin accepted a partial delivery — this CONSUMES the
    //       quota slot, FR-008c).
    // Correct usage = 2/4 = 50% >= 30% → the +15 "didn't use e-blast"
    // factor MUST NOT fire. The pre-fix code counted only `sent` = 1/4 =
    // 25% < 30% → factor WOULD fire (the undercount bug). Both scorers
    // (single + batch) must now agree the factor does NOT fire.
    const planId = `conv-partial-${randomUUID().slice(0, 6)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Partial Accepted Plan' },
        benefitMatrix: { ...DEFAULT_TEST_BENEFIT_MATRIX, eblast_per_year: 4 },
        createdBy: user.userId,
      }),
    );
    const memberId = await seedActiveMember(planId);
    await seedOriginatedSentBroadcast(memberId); // counts (1)
    await seedOriginatedPartialAcceptedBroadcast(memberId); // counts (2) — Finding C

    const single = await singleFires(memberId, EBLAST_FACTOR);
    const batch = await batchFires(memberId, EBLAST_FACTOR);

    // Both agree, and both do NOT fire: usage = 2 (50% >= 30%). If the
    // partial-accepted row were dropped, usage = 1 (25% < 30%) and the
    // factor would (wrongly) fire — that is the regression this guards.
    expect(single).toBe(batch);
    expect(single).toBe(false);
  }, 90_000);

  // ---------------------------------------------------------------------
  // #8 — at-risk eBlast usage = sent THIS quota year (year-fenced),
  // matching F9 `computeQuotaCounter.used`. A stale prior-year
  // `failed_to_dispatch` row (quota_year_consumed IS NULL) must be
  // IGNORED by the ENGAGEMENT usage count — it does NOT hold a slot
  // (Design D1, 2026-06-21: failed_to_dispatch releases the quota slot),
  // and counting it would silently suppress the +15 risk factor for a
  // disengaged member.
  // ---------------------------------------------------------------------

  it('#8 e-blast: 1 sent-this-year + 1 stale prior-year RESERVED → usage=1 (reserved NOT counted) → +15 FIRES on BOTH', async () => {
    // Plan eblast_per_year = 4. Member has:
    //   (a) 1 `sent` broadcast in the CURRENT quota year
    //   (b) 1 `failed_to_dispatch` broadcast SUBMITTED two years ago
    //       (quota_year_consumed IS NULL — ignored by D1; releases the
    //       slot rather than holding it).
    // F9 benefit-usage `used` counts only (a) = 1/4 = 25% < 30% → the
    // engagement factor MUST fire. The pre-#8 code counted (a)+(b) = 2/4
    // = 50% >= 30% → factor suppressed (the bug). Both scorers must now
    // agree the factor FIRES (usage = 1, reserved dropped).
    const planId = `conv-stale-${randomUUID().slice(0, 6)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Stale Reserved Plan' },
        benefitMatrix: { ...DEFAULT_TEST_BENEFIT_MATRIX, eblast_per_year: 4 },
        createdBy: user.userId,
      }),
    );
    const memberId = await seedActiveMember(planId);
    await seedOriginatedSentBroadcast(memberId); // current-year sent → counts
    await seedOriginatedReservedBroadcast(
      memberId,
      'failed_to_dispatch',
      NOW_MS - 730 * MS_PER_DAY, // submitted ~2 years ago
    );

    const single = await singleFires(memberId, EBLAST_FACTOR);
    const batch = await batchFires(memberId, EBLAST_FACTOR);

    // Both agree, and both FIRE: usage = 1 (25% < 30%), the stale
    // prior-year reserved row is excluded.
    expect(single).toBe(batch);
    expect(single).toBe(true);
  }, 90_000);

  it('#8 e-blast: 2 sent-this-year + 1 stale prior-year RESERVED → usage=2 (50% >= 30%) → factor does NOT fire on BOTH', async () => {
    // Same plan cap = 4. Member sent 2 this year (50% used) + has a stale
    // `submitted` reserved row from a prior year. usage = 2 (reserved
    // dropped) = 50% >= 30% → factor must NOT fire. Confirms the
    // year-fenced count is the ONLY input — the reserved row neither adds
    // to nor changes the outcome. (Pre-#8 code would count 3/4 = 75%,
    // same not-fire outcome here, so this case alone can't catch the bug;
    // it pins that dropping reserved does not over-correct.)
    const planId = `conv-stale2-${randomUUID().slice(0, 6)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Stale Reserved Plan 2' },
        benefitMatrix: { ...DEFAULT_TEST_BENEFIT_MATRIX, eblast_per_year: 4 },
        createdBy: user.userId,
      }),
    );
    const memberId = await seedActiveMember(planId);
    await seedOriginatedSentBroadcast(memberId);
    await seedOriginatedSentBroadcast(memberId);
    await seedOriginatedReservedBroadcast(
      memberId,
      'submitted',
      NOW_MS - 400 * MS_PER_DAY, // prior year
    );

    const single = await singleFires(memberId, EBLAST_FACTOR);
    const batch = await batchFires(memberId, EBLAST_FACTOR);

    expect(single).toBe(batch);
    expect(single).toBe(false);
  }, 90_000);

  /**
   * Like `seedOriginatedSentBroadcast` but records the broadcast under
   * an EXPLICIT quota year. Used to prove the year-fence: a `sent` row
   * with `quota_year_consumed = QUOTA_YEAR - 1` must NOT count toward the
   * CURRENT year's engagement usage.
   */
  async function seedOriginatedSentBroadcastInYear(
    memberId: string,
    quotaYear: number,
  ): Promise<void> {
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(broadcasts).values({
        tenantId: tenant.ctx.slug,
        broadcastId: randomUUID(),
        requestedByMemberId: memberId,
        requestedByMemberPlanIdSnapshot: 'snap',
        submittedByUserId: user.userId,
        actorRole: 'admin_proxy',
        subject: 'Prior-year Sent',
        bodyHtml: '<p>x</p>',
        bodySource: '<p>x</p>',
        fromName: 'Test',
        replyToEmail: 'reply@example.com',
        segmentType: 'all_members',
        estimatedRecipientCount: 1,
        status: 'sent',
        quotaYearConsumed: quotaYear,
        quotaConsumedAt: new Date(NOW_MS - 400 * MS_PER_DAY),
        sentAt: new Date(NOW_MS - 400 * MS_PER_DAY),
      });
    });
  }

  // ---------------------------------------------------------------------
  // #8 edge cases — document the TWO boundary conditions that prove the
  // year-fence and the reserved-exclusion independently of each other.
  // ---------------------------------------------------------------------

  it('#8 edge: 0 sent + N reserved THIS year → usage=0 (reserved excluded) → +15 FIRES on BOTH', async () => {
    // A member who has NEVER originated a sent e-blast this quota year,
    // but HAS a submitted (reserved) broadcast in-flight. The reserved row
    // holds a quota slot in F7's enforcement count but carries
    // quota_year_consumed IS NULL, so it must NOT count toward the at-risk
    // engagement usage. usage = 0/4 = 0% < 30% → factor fires.
    // Proves: dropping the reserved bucket means a pure-reserved member
    // counts as zero usage, triggering the +15 risk signal correctly.
    const planId = `conv-pureresv-${randomUUID().slice(0, 6)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Pure Reserved Plan' },
        benefitMatrix: { ...DEFAULT_TEST_BENEFIT_MATRIX, eblast_per_year: 4 },
        createdBy: user.userId,
      }),
    );
    const memberId = await seedActiveMember(planId);
    // Seed two reserved broadcasts (submitted + approved) — no sent rows.
    await seedOriginatedReservedBroadcast(
      memberId,
      'submitted',
      NOW_MS - 14 * MS_PER_DAY,
    );
    await seedOriginatedReservedBroadcast(
      memberId,
      'approved',
      NOW_MS - 7 * MS_PER_DAY,
    );

    const single = await singleFires(memberId, EBLAST_FACTOR);
    const batch = await batchFires(memberId, EBLAST_FACTOR);

    // Both scorers agree and both FIRE: usage = 0 (0% < 30%).
    expect(single).toBe(batch);
    expect(single).toBe(true);
  }, 90_000);

  it('#8 edge: 1 sent PRIOR quota year + 1 submitted THIS year → usage=0 (year-fence excludes both) → +15 FIRES on BOTH', async () => {
    // A member with:
    //   (a) 1 `sent` broadcast from the PRIOR quota year
    //       (quota_year_consumed = QUOTA_YEAR - 1, sentAt ~400 days ago)
    //   (b) 1 `submitted` (reserved) broadcast from THIS quota year
    //       (quota_year_consumed IS NULL)
    // The year-fence excludes (a) — it was sent last year, not this year.
    // The reserved-exclusion excludes (b) — it was never sent.
    // So current-year engagement usage = 0/4 = 0% < 30% → factor fires.
    // Proves: a prior-year sent does NOT count toward this year's usage,
    // and a this-year reserved likewise does NOT count.
    const planId = `conv-prioryear-${randomUUID().slice(0, 6)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Prior Year Sent Plan' },
        benefitMatrix: { ...DEFAULT_TEST_BENEFIT_MATRIX, eblast_per_year: 4 },
        createdBy: user.userId,
      }),
    );
    const memberId = await seedActiveMember(planId);
    // (a) sent last quota year — must NOT count toward current-year usage.
    await seedOriginatedSentBroadcastInYear(memberId, QUOTA_YEAR - 1);
    // (b) reserved this year — must NOT count toward engagement usage.
    await seedOriginatedReservedBroadcast(
      memberId,
      'submitted',
      NOW_MS - 30 * MS_PER_DAY,
    );

    const single = await singleFires(memberId, EBLAST_FACTOR);
    const batch = await batchFires(memberId, EBLAST_FACTOR);

    // Both scorers agree and both FIRE: usage = 0 (0% < 30%).
    expect(single).toBe(batch);
    expect(single).toBe(true);
  }, 90_000);

  // ---------------------------------------------------------------------
  // Tier-downgrade bucket convergence
  // ---------------------------------------------------------------------

  it('tier: same-bucket fee CUT → factor does NOT fire on EITHER scorer (old single mis-fired on annual_fee axis)', async () => {
    // Both plans are in the `premium` bucket but the new plan has a LOWER
    // annual fee (custom pricing override). A same-bucket fee cut is NOT
    // a tier downgrade. Old single compared annual_fee (lower → +15) →
    // would diverge from the batch (bucket ordinal equal → no fire).
    const oldPlanId = `conv-fee-old-${randomUUID().slice(0, 6)}`;
    const newPlanId = `conv-fee-new-${randomUUID().slice(0, 6)}`;
    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: oldPlanId,
        planName: { en: 'Premium High Fee' },
        annualFeeMinorUnits: 100_000_000,
        renewalTierBucket: 'premium',
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: newPlanId,
        planName: { en: 'Premium Low Fee' },
        annualFeeMinorUnits: 25_000_000, // lower fee, SAME bucket
        renewalTierBucket: 'premium',
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });
    });
    const memberId = await seedActiveMember(newPlanId);
    await seedPlanChange(memberId, oldPlanId, newPlanId);

    const single = await singleFires(memberId, TIER_FACTOR);
    const batch = await batchFires(memberId, TIER_FACTOR);

    expect(single).toBe(batch);
    expect(single).toBe(false);
  }, 90_000);

  it('tier: real bucket downgrade premium→regular → factor FIRES on BOTH', async () => {
    const oldPlanId = `conv-buck-old-${randomUUID().slice(0, 6)}`;
    const newPlanId = `conv-buck-new-${randomUUID().slice(0, 6)}`;
    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: oldPlanId,
        planName: { en: 'Premium' },
        annualFeeMinorUnits: 100_000_000,
        renewalTierBucket: 'premium',
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: newPlanId,
        planName: { en: 'Regular' },
        annualFeeMinorUnits: 25_000_000,
        renewalTierBucket: 'regular', // lower bucket ordinal than premium
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });
    });
    const memberId = await seedActiveMember(newPlanId);
    await seedPlanChange(memberId, oldPlanId, newPlanId);

    const single = await singleFires(memberId, TIER_FACTOR);
    const batch = await batchFires(memberId, TIER_FACTOR);

    expect(single).toBe(batch);
    expect(single).toBe(true);
  }, 90_000);

  /** Emit a `member_plan_changed` audit row (payload mirrors F3 change-plan). */
  async function seedPlanChange(
    memberId: string,
    oldPlanId: string,
    newPlanId: string,
  ): Promise<void> {
    await runInTenant(tenant.ctx, async (tx) => {
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
          old_plan_id: oldPlanId,
          old_plan_year: 2026,
          new_plan_id: newPlanId,
          new_plan_year: 2026,
        },
      });
    });
  }
});
