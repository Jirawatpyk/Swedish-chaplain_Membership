/**
 * P1-4 / FR-004 — cross-member quota insights integration (live Neon).
 *
 * Seeds two plans (one with eblast entitlement 0 to prove the "not-applicable"
 * exclusion) and five active members spanning every quota branch — under-using
 * one/both/neither benefit, fully consumed, and prior-year-only — then runs the
 * REAL `computeDashboardSnapshot` (real member-enumeration + the two batched
 * GROUP BY aggregates + plan entitlements). Asserts the `unused_eblast_quota` /
 * `underused_event_tickets` counts, the UNION `underDeliveredBenefitCount`, and:
 *   - prior-year consumption is excluded (year scoping at the SQL layer);
 *   - an entitlement-0 benefit is excluded (not "under-used");
 *   - dismissing one quota card suppresses only it (per-key cycle);
 *   - EQUIVALENCE: the batched aggregate count equals the per-member source
 *     (`broadcastSourceAdapter`) for a seeded member — pins the GROUP BY filter
 *     against the per-member path so an F6/F7 filter change fails here first.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import {
  computeDashboardSnapshot,
  dismissInsight,
  makeComputeDashboardSnapshotDeps,
  makeDismissInsightDeps,
} from '@/modules/insights';
import { broadcastSourceAdapter } from '@/modules/insights/infrastructure/sources/broadcast-source-adapter';
import { benefitConsumptionAggregateAdapter } from '@/modules/insights/infrastructure/sources/benefit-consumption-aggregate-adapter';
import { eventSourceAdapter } from '@/modules/insights/infrastructure/sources/event-source-adapter';
import { planSourceAdapter } from '@/modules/insights/infrastructure/sources/plan-source-adapter';
import { countUnderUsedQuota, planKey } from '@/modules/insights/domain/quota-underuse';
import { dashboardMetricsCache, smartInsightDismissals } from '@/modules/insights/infrastructure/db/schema-insights';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { broadcasts } from '@/modules/broadcasts/infrastructure/schema';
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { tenantYearBoundsUtcMs } from '@/modules/insights/application/tenant-year';
import { env } from '@/lib/env';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const TZ = env.tenant.timezone;
// Membership year = calendar year in the tenant tz (FR-023) — computed the same
// way the use-case does so the seed + the snapshot agree on the year.
const SEED_YEAR = Number(
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric' }).format(new Date()),
);
const { startMs } = tenantYearBoundsUtcMs(SEED_YEAR, TZ);
// A safely-past, in-year instant for current-year consumption. The cultural
// aggregate caps its window at min(yearEnd, Date.now()), so the seed date MUST be
// <= now; it must also be >= yearStart. Clamp to [yearStart+1s, now-60s] so the
// test is robust at ANY run instant (incl. the first hour of the tenant-tz year),
// with a 60s margin for the gap between module-load and the live query's now.
const THIS_YEAR = new Date(
  Math.max(startMs + 1_000, Math.min(startMs + 3_600_000, Date.now() - 60_000)),
);
const PRIOR_YEAR = new Date(`${SEED_YEAR - 1}-08-01T09:00:00.000Z`);

// planA: eblast 3 / cultural 2 (small so "fully consumed" needs few rows).
const PLAN_A_MATRIX = {
  ...DEFAULT_TEST_BENEFIT_MATRIX,
  eblast_per_year: 3,
  cultural_tickets_per_year: 2,
} as const;
// planB: eblast 0 (not applicable) / cultural 2.
const PLAN_B_MATRIX = {
  ...DEFAULT_TEST_BENEFIT_MATRIX,
  eblast_per_year: 0,
  cultural_tickets_per_year: 2,
} as const;

describe('F9 quota insights — cross-member roll-up (P1-4 / FR-004, live Neon)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  const planA = `f9q-a-${randomUUID().slice(0, 8)}`;
  const planB = `f9q-b-${randomUUID().slice(0, 8)}`;
  const mA = randomUUID(); // planA: under both (1 eblast, 1 cultural)
  const mB = randomUUID(); // planA: under both (0, 0)
  const mC = randomUUID(); // planA: full both (3 eblast, 2 cultural) — NOT under
  const mD = randomUUID(); // planB: eblast n/a, under cultural (0, 1)
  const mE = randomUUID(); // planA: PRIOR-year only → under both this year
  // FR-008c (finding C-followup): mF's ONLY current-year e-blast is
  // `partial_delivery_accepted`, which CONSUMES the quota slot exactly like
  // `sent` (schema CHECK `broadcasts_quota_year_only_on_sent` stamps
  // quota_year_consumed for BOTH states). On the pre-fix `sent`-only filter the
  // batched aggregate reads mF as used=0 → mF is mis-flagged "didn't use e-blast"
  // (counted in unused_eblast_quota) AND its per-member lastUsedAt is null.
  const mF = randomUUID(); // planA: 3-of-3 eblast via partial-accept → NOT under, full

  function sentBroadcast(memberId: string, quotaYear: number, sentAt: Date) {
    return {
      tenantId: tenant.ctx.slug,
      requestedByMemberId: memberId,
      requestedByMemberPlanIdSnapshot: planA,
      submittedByUserId: admin.userId,
      actorRole: 'admin_proxy' as const,
      subject: 'Quota seed',
      bodyHtml: '<p>hi</p>',
      bodySource: 'hi',
      fromName: 'SweCham',
      replyToEmail: 'noreply@swecham.test',
      segmentType: 'all_members' as const,
      estimatedRecipientCount: 1,
      status: 'sent' as const,
      sentAt,
      // Sent rows require quota_year_consumed + quota_consumed_at (CHECK).
      quotaYearConsumed: quotaYear,
      quotaConsumedAt: sentAt,
    };
  }

  async function seedSent(tx: Parameters<Parameters<typeof runInTenant>[1]>[0], memberId: string, n: number, quotaYear: number, at: Date) {
    for (let i = 0; i < n; i += 1) {
      await tx.insert(broadcasts).values(sentBroadcast(memberId, quotaYear, at));
    }
  }

  // FR-008c — a TERMINAL `partial_delivery_accepted` broadcast. Consumes the
  // quota slot exactly like `sent`: the schema CHECK
  // `broadcasts_quota_year_only_on_sent` requires quota_year_consumed +
  // quota_consumed_at NON-NULL for this state too. `partial_delivery_accepted_at`
  // is the timestamp the F9 last-used scan must coalesce on (no `sent_at`).
  async function seedPartialAccepted(
    tx: Parameters<Parameters<typeof runInTenant>[1]>[0],
    memberId: string,
    n: number,
    quotaYear: number,
    at: Date,
  ) {
    for (let i = 0; i < n; i += 1) {
      await tx.insert(broadcasts).values({
        ...sentBroadcast(memberId, quotaYear, at),
        status: 'partial_delivery_accepted' as const,
        // A partial-accept row has NO sent_at — the only usage timestamp is
        // partial_delivery_accepted_at (the F9 lastUsedAt coalesce target).
        sentAt: null,
        partialDeliveryAcceptedAt: at,
        partialDeliveryAcceptedByUserId: admin.userId,
      });
    }
  }

  async function seedCultural(tx: Parameters<Parameters<typeof runInTenant>[1]>[0], memberId: string, n: number, startDate: Date) {
    for (let i = 0; i < n; i += 1) {
      const eventId = randomUUID();
      await tx.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId: `f9q-evt-${randomUUID().slice(0, 8)}`,
        name: 'Cultural night',
        startDate,
        isPartnerBenefit: false,
        isCulturalEvent: true,
      } as unknown as NewEventRow);
      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId: randomUUID(),
        eventId,
        externalId: `f9q-reg-${randomUUID().slice(0, 8)}`,
        attendeeEmail: `attendee-${randomUUID().slice(0, 8)}@quota.test`,
        attendeeName: 'Quota Attendee',
        matchType: 'member_domain',
        matchedMemberId: memberId,
        paymentStatus: 'paid',
        registeredAt: startDate,
      } as unknown as NewEventRegistrationRow);
    }
  }

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: planA,
        planName: { en: 'Quota Plan A', th: 'แผนโควตา เอ' },
        benefitMatrix: PLAN_A_MATRIX,
        createdBy: admin.userId,
      });
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: planB,
        planName: { en: 'Quota Plan B' },
        benefitMatrix: PLAN_B_MATRIX,
        createdBy: admin.userId,
      });
      const member = (memberId: string, planId: string) => ({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Quota Co',
        country: 'TH',
        planId,
        planYear: 2026,
        status: 'active' as const,
        riskScore: null,
        riskScoreBand: null,
      });
      await tx.insert(members).values([
        member(mA, planA),
        member(mB, planA),
        member(mC, planA),
        member(mD, planB),
        member(mE, planA),
        member(mF, planA),
      ]);

      // E-Blast (sent) consumption — current year unless noted.
      await seedSent(tx, mA, 1, SEED_YEAR, THIS_YEAR); // 1/3 → under
      await seedSent(tx, mC, 3, SEED_YEAR, THIS_YEAR); // 3/3 → full
      await seedSent(tx, mE, 1, SEED_YEAR - 1, PRIOR_YEAR); // prior year → excluded
      // FR-008c — mF's whole e-blast usage is via partial-accept (3/3 → full,
      // NOT under). On the pre-fix `sent`-only filter mF reads 0/3 → under.
      await seedPartialAccepted(tx, mF, 3, SEED_YEAR, THIS_YEAR);

      // Cultural consumption — current year unless noted.
      await seedCultural(tx, mA, 1, THIS_YEAR); // 1/2 → under
      await seedCultural(tx, mC, 2, THIS_YEAR); // 2/2 → full
      await seedCultural(tx, mD, 1, THIS_YEAR); // 1/2 → under
      await seedCultural(tx, mE, 1, PRIOR_YEAR); // prior year → excluded
    });
  }, 180_000);

  afterAll(async () => {
    const slug = tenant.ctx.slug;
    await db.delete(dashboardMetricsCache).where(eq(dashboardMetricsCache.tenantId, slug)).catch(() => {});
    await db.delete(smartInsightDismissals).where(eq(smartInsightDismissals.tenantId, slug)).catch(() => {});
    await db.delete(eventRegistrations).where(eq(eventRegistrations.tenantId, slug)).catch(() => {});
    await db.delete(events).where(eq(events.tenantId, slug)).catch(() => {});
    await db.delete(broadcasts).where(eq(broadcasts.tenantId, slug)).catch(() => {});
    await db.delete(members).where(eq(members.tenantId, slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  function insightCount(snap: { topInsights: readonly { key: string; count: number }[] }, key: string) {
    return snap.topInsights.find((i) => i.key === key)?.count;
  }

  it('counts under-use per benefit + UNION underDeliveredBenefitCount (year-scoped, entitlement-0 excluded)', async () => {
    const r = await computeDashboardSnapshot(tenant.ctx, makeComputeDashboardSnapshotDeps(tenant.ctx.slug));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // unused_eblast_quota: mA (1/3), mB (0/3), mE (prior-year → 0/3). mC full, mD
    // n/a (0 entitlement). mF is full via partial-accept (3/3, FR-008c) → NOT
    // counted: on the pre-fix `sent`-only filter mF reads 0/3 → this would be 4.
    expect(insightCount(r.value, 'unused_eblast_quota')).toBe(3);
    // underused_event_tickets: mA (1/2), mB (0/2), mD (1/2), mE (prior → 0/2),
    // mF (0/2 cultural → under). mC full.
    expect(insightCount(r.value, 'underused_event_tickets')).toBe(5);
    // UNION {mA, mB, mD, mE, mF} = 5 (mC under neither; mF under cultural only).
    expect(r.value.underDeliveredBenefitCount).toBe(5);
  });

  // 067 Task 5 — the SAME real snapshot compute also resolves the tier +
  // invoice-status chart aggregates. This suite already seeds TWO distinct
  // plans (planA/planB) with real `plan_name` rows, so it is a natural place
  // to pin `getPlanLabel` end-to-end (F2 `planRepo.findOne` -> full `plan_name`
  // LocaleText, TH included) alongside the existing quota assertions, rather
  // than a third bespoke tenant.
  it('067: tierDistribution resolves real plan labels as full LocaleText (TH round-trips); invoiceStatus reads zeroed (no invoices seeded)', async () => {
    const r = await computeDashboardSnapshot(tenant.ctx, makeComputeDashboardSnapshotDeps(tenant.ctx.slug));
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // 5 members on planA (mA,mB,mC,mE,mF) + 1 on planB (mD) = 6 active; every
    // member's plan resolves a label, so there is NO 'unassigned' bucket.
    const byTier = new Map(r.value.tierDistribution.map((s) => [s.tierKey, s]));
    // Full LocaleText round-trips through compute → snapshot (TH preserved),
    // so a Thai/Swedish admin sees the localised tier name, not the EN fallback.
    expect(byTier.get(planA)).toEqual({
      tierKey: planA,
      label: { en: 'Quota Plan A', th: 'แผนโควตา เอ' },
      count: 5,
    });
    expect(byTier.get(planB)).toEqual({ tierKey: planB, label: { en: 'Quota Plan B' }, count: 1 });
    expect(byTier.has('unassigned')).toBe(false);
    expect(r.value.tierDistribution.reduce((sum, s) => sum + s.count, 0)).toBe(
      r.value.counts.active,
    );

    // No invoices exist in this tenant — the real InvoiceSource adapter still
    // returns exactly 3 zeroed buckets + draftCount 0 (never throws on an
    // empty tenant; convenient for a chart consumer per the adapter's own doc).
    expect(r.value.invoiceStatus).toEqual({
      buckets: [
        { bucket: 'paid', satang: '0', count: 0 },
        { bucket: 'unpaid', satang: '0', count: 0 },
        { bucket: 'overdue', satang: '0', count: 0 },
      ],
      draftCount: 0,
    });
  });

  // EQUIVALENCE pins BOTH batched aggregates against their per-member sources so a
  // future F6/F7 filter change fails here first. Pinned at an at-cap member (mC)
  // AND an under-cap member (mA) — the under-cap case is the one that actually
  // exercises a non-saturated count (the at-cap case could pass by coincidence).
  // Valid for SEED_YEAR = the current calendar year (the only year F9 views;
  // getEblastConsumption derives its quota year from the system clock).
  it('EQUIVALENCE: batched eblast aggregate == per-member source (filter pin)', async () => {
    const map = await benefitConsumptionAggregateAdapter.eblastUsedByMember(tenant.ctx, SEED_YEAR);
    const perMemberC = await broadcastSourceAdapter.getEblastConsumption(tenant.ctx, mC, SEED_YEAR);
    const perMemberA = await broadcastSourceAdapter.getEblastConsumption(tenant.ctx, mA, SEED_YEAR);
    expect(map.get(mC)).toBe(3);
    expect(map.get(mC)).toBe(perMemberC.used); // at-cap: batched GROUP BY == per-member counter
    expect(map.get(mA)).toBe(1);
    expect(map.get(mA)).toBe(perMemberA.used); // under-cap: non-saturated agreement
    expect(map.has(mB)).toBe(false); // 0 sent → absent (caller reads ?? 0)
  });

  it('EQUIVALENCE: batched cultural aggregate == per-member source (filter pin — the riskier JOIN + window filter)', async () => {
    const map = await benefitConsumptionAggregateAdapter.culturalUsedByMember(tenant.ctx, SEED_YEAR);
    // The per-member event source honours its membershipYear arg (unlike eblast),
    // so this pins the isCulturalEvent + [yearStart, min(yearEnd, now)] + pii/
    // archived-null filter set against the per-member path for two members.
    const perMemberC = await eventSourceAdapter.getCulturalConsumption(tenant.ctx, mC, SEED_YEAR);
    const perMemberA = await eventSourceAdapter.getCulturalConsumption(tenant.ctx, mA, SEED_YEAR);
    expect(map.get(mC)).toBe(2);
    expect(map.get(mC)).toBe(perMemberC.used); // full
    expect(map.get(mA)).toBe(1);
    expect(map.get(mA)).toBe(perMemberA.used); // under
    expect(map.has(mB)).toBe(false); // 0 attended → absent
  });

  it('dismissing unused_eblast_quota suppresses only it; underused_event_tickets survives', async () => {
    const dismiss = await dismissInsight(
      { insightKey: 'unused_eblast_quota' },
      { actorUserId: admin.userId, actorRole: 'admin', requestId: `q-dismiss-${randomUUID()}` },
      tenant.ctx,
      makeDismissInsightDeps(tenant.ctx.slug),
    );
    expect(dismiss.ok).toBe(true);

    const r = await computeDashboardSnapshot(tenant.ctx, makeComputeDashboardSnapshotDeps(tenant.ctx.slug));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(insightCount(r.value, 'unused_eblast_quota')).toBeUndefined(); // dismissed
    expect(insightCount(r.value, 'underused_event_tickets')).toBe(5); // survives (different key/cycle)
  });

  // ── Finding C-followup / FR-008c — the F9 benefit-usage count (the 4th query
  // the prior finding-C fix-wave missed) must count `partial_delivery_accepted`
  // alongside `sent` (year-fenced), so a member whose ONLY current-year e-blast
  // was partial-accepted is NEITHER mis-flagged "didn't use their e-blast" NOR
  // shown "used, but never used" (null lastUsedAt). RED on the pre-fix
  // `status='sent'` filter; GREEN after `inArray(['sent','partial_delivery_accepted'])`.
  it('FR-008c: a partial-accept-only member is COUNTED (not under-using e-blast) and has a non-null lastUsedAt', async () => {
    // 1) Batched aggregate (eblastUsedByMember → unused_eblast_quota card):
    //    mF's 3 partial-accepted rows are counted (=== entitlement 3 → full).
    //    Pre-fix this map has NO mF entry (sent-only) → mF reads used=0 → under.
    const eblast = await benefitConsumptionAggregateAdapter.eblastUsedByMember(tenant.ctx, SEED_YEAR);
    expect(eblast.get(mF)).toBe(3);

    // 2) Live-wired roll-up: mF (3/3 via partial-accept) is NOT under-using
    //    e-blast. The `unused_eblast_quota` CARD count of exactly 3 = {mA, mB,
    //    mE} — mF excluded — is asserted by the first test (it runs BEFORE the
    //    dismiss test, which suppresses that card for the current cycle here).
    //    This test pins the SAME wiring dismissal-independently: feed the live
    //    aggregate map + real plan entitlement into the pure `countUnderUsedQuota`
    //    rule and assert mF is excluded (used 3 === entitlement 3 → no shortfall).
    //    Pre-fix the map lacks mF → used 0 < 3 → mF wrongly counted.
    const entA = await planSourceAdapter.getEntitlements(tenant.ctx, planA, 2026);
    expect(entA).not.toBeNull();
    if (entA === null) return;
    const cultural = await benefitConsumptionAggregateAdapter.culturalUsedByMember(tenant.ctx, SEED_YEAR);
    const rollUp = countUnderUsedQuota({
      members: [{ memberId: mF, planId: planA, planYear: 2026 }],
      eblastUsedByMember: eblast,
      culturalUsedByMember: cultural,
      entitlementByPlanKey: new Map([
        [planKey(planA, 2026), { eblastPerYear: entA.eblastPerYear, culturalTicketsPerYear: entA.culturalTicketsPerYear }],
      ]),
    });
    expect(rollUp.unusedEblastMembers).toBe(0); // mF full on e-blast → not under

    // 3) Per-member source (member benefit view): used>0 AND lastUsedAt non-null.
    //    Pre-fix `getEblastConsumption` would (via computeQuotaCounter's sent-only
    //    count) read used=0 AND the last-sent scan guards `status !== 'sent'` →
    //    null lastUsedAt ("used, but never used"). Post-fix: used=3, the scan
    //    accepts partial_delivery_accepted and coalesces partialDeliveryAcceptedAt.
    const perMemberF = await broadcastSourceAdapter.getEblastConsumption(tenant.ctx, mF, SEED_YEAR);
    expect(perMemberF.used).toBe(3);
    expect(perMemberF.lastUsedAt).not.toBeNull();
    expect(perMemberF.lastUsedAt).toBe(THIS_YEAR.toISOString());
  });
});

/**
 * P1-4 — tenant-scoping of the NEW cross-member aggregate GROUP BY queries.
 * Seeds tenant B with sent-broadcast + cultural consumption, runs the aggregate
 * adapter under `runInTenant(tenantA.ctx)`, and asserts tenant B's rows never
 * surface in tenant A's map.
 *
 * SCOPE NOTE (honest framing): the aggregate carries an explicit
 * `eq(tenantId, ctx.slug)` predicate, so this test proves the ADAPTER is
 * tenant-safe (predicate + RLS defence-in-depth) — it does NOT isolate the
 * DB-layer RLS guarantee on its own (the explicit predicate alone would filter
 * tenant B even with RLS disabled). The pure RLS+FORCE guarantee is covered by
 * the F9 own-tables suite `cross-tenant-isolation.test.ts` (T019), which probes
 * via direct DB writes WITHOUT the app predicate. The control assertion below
 * (tenant B's OWN context DOES see its rows) keeps this test non-vacuous.
 */
describe('F9 quota aggregate — cross-tenant scoping (P1-4, live Neon)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let admin: TestUser;
  const planBId = `f9qx-${randomUUID().slice(0, 8)}`;
  const mInB = randomUUID();

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
    tenantB = await createTestTenant('test-swecham');

    // Seed consumption ONLY in tenant B (a sent broadcast + a cultural reg).
    await runInTenant(tenantB.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenantB.ctx.slug,
        planId: planBId,
        planName: { en: 'X Plan' },
        benefitMatrix: PLAN_A_MATRIX,
        createdBy: admin.userId,
      });
      await tx.insert(members).values({
        tenantId: tenantB.ctx.slug,
        memberId: mInB,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'B Co',
        country: 'TH',
        planId: planBId,
        planYear: 2026,
        status: 'active',
        riskScore: null,
        riskScoreBand: null,
      });
      await tx.insert(broadcasts).values({
        tenantId: tenantB.ctx.slug,
        requestedByMemberId: mInB,
        requestedByMemberPlanIdSnapshot: planBId,
        submittedByUserId: admin.userId,
        actorRole: 'admin_proxy',
        subject: 'B seed',
        bodyHtml: '<p>b</p>',
        bodySource: 'b',
        fromName: 'B',
        replyToEmail: 'b@swecham.test',
        segmentType: 'all_members',
        estimatedRecipientCount: 1,
        status: 'sent',
        sentAt: THIS_YEAR,
        quotaYearConsumed: SEED_YEAR,
        quotaConsumedAt: THIS_YEAR,
      });
      const eventId = randomUUID();
      await tx.insert(events).values({
        tenantId: tenantB.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId: `f9qx-evt-${randomUUID().slice(0, 8)}`,
        name: 'B cultural',
        startDate: THIS_YEAR,
        isPartnerBenefit: false,
        isCulturalEvent: true,
      } as unknown as NewEventRow);
      await tx.insert(eventRegistrations).values({
        tenantId: tenantB.ctx.slug,
        registrationId: randomUUID(),
        eventId,
        externalId: `f9qx-reg-${randomUUID().slice(0, 8)}`,
        attendeeEmail: `b-${randomUUID().slice(0, 8)}@quota.test`,
        attendeeName: 'B Attendee',
        matchType: 'member_domain',
        matchedMemberId: mInB,
        paymentStatus: 'paid',
        registeredAt: THIS_YEAR,
      } as unknown as NewEventRegistrationRow);
    });
  }, 180_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      const slug = t?.ctx.slug;
      if (!slug) continue;
      await db.delete(eventRegistrations).where(eq(eventRegistrations.tenantId, slug)).catch(() => {});
      await db.delete(events).where(eq(events.tenantId, slug)).catch(() => {});
      await db.delete(broadcasts).where(eq(broadcasts.tenantId, slug)).catch(() => {});
      await db.delete(members).where(eq(members.tenantId, slug)).catch(() => {});
    }
    await tenantA?.cleanup().catch(() => {});
    await tenantB?.cleanup().catch(() => {});
  }, 120_000);

  it('aggregate run under tenant A never sees tenant B consumption rows', async () => {
    const eblast = await benefitConsumptionAggregateAdapter.eblastUsedByMember(tenantA.ctx, SEED_YEAR);
    const cultural = await benefitConsumptionAggregateAdapter.culturalUsedByMember(tenantA.ctx, SEED_YEAR);
    // Tenant B's member + consumption must be invisible from tenant A's context.
    expect(eblast.has(mInB)).toBe(false);
    expect(cultural.has(mInB)).toBe(false);
    // Sanity: tenant B's OWN context DOES see them (proves the seed is real).
    const eblastB = await benefitConsumptionAggregateAdapter.eblastUsedByMember(tenantB.ctx, SEED_YEAR);
    expect(eblastB.get(mInB)).toBe(1);
  });
});
