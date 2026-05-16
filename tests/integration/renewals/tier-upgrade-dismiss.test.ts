/**
 * F8 Phase 7 / Round 6 review-fix F-002 — `dismissTierUpgrade` integration tests.
 *
 * Closes the AS3 (Admin Dismiss) coverage gap flagged by the staff
 * review:
 *
 *   AS3: "Given an admin clicks Dismiss on a suggestion, When they
 *   confirm with an optional reason, Then the suggestion's status
 *   becomes `dismissed`, `suppressed_until` is set to `today + 90d`,
 *   audit event `tier_upgrade_dismissed` is emitted with the reason,
 *   and the cron will not re-suggest the same upgrade for that member
 *   for 90 days."
 *
 * Phase 7's Round 1–5 review cycles only verified the suppression-side
 * branch (a pre-seeded `dismissed` row hides the member from the cron's
 * candidate query). The `dismissTierUpgrade` use-case itself — the
 * `open` → `dismissed` transition + `suppressed_until` write + audit
 * emit — was untested at integration layer.
 *
 * Test scope:
 *   1. Dismiss happy path — open suggestion → dismissed, audit emitted
 *      with member_id + suggestion_id + suppressed_until.
 *   2. Dismiss with reason — reason persisted in `dismissed_reason`
 *      column and in the audit payload.
 *   3. Re-dismiss attempt — second `dismissTierUpgrade` on the same
 *      suggestion returns `suggestion_not_open` (the row is no longer
 *      `open` after the first dismiss).
 *   4. Suppression window ≈ 90d from now.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { tierUpgradeSuggestions } from '@/modules/renewals/infrastructure/schema-tier-upgrade-suggestions';
import {
  dismissTierUpgrade,
  makeRenewalsDeps,
  parseSuggestionId,
  type SuggestionId,
} from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// F4+F8 Satang migration (2026-05-16) — restore missing membership_plan
// seed. Pre-fix test inserted members with planId='regular', planYear=2026
// but no matching membership_plans row → FK violation
// `members_plan_tenant_year_fk`. Matches the catalogue-seed pattern
// from tier-upgrade-pending.test.ts.
const DEFAULT_TEST_BENEFIT_MATRIX: BenefitMatrix = {
  eblast_per_year: 1,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'regular',
  directory_listing_size: 'half_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: false,
  partnership: null,
};

async function seedPlan(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
): Promise<void> {
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId,
      planYear: 2026,
      planName: { en: planId },
      description: { en: '' },
      sortOrder: 10,
      planCategory: 'corporate',
      memberTypeScope: 'company',
      annualFeeMinorUnits: 5_000_000,
      includesCorporatePlanId: null,
      minTurnoverMinorUnits: null,
      maxTurnoverMinorUnits: null,
      maxDurationYears: null,
      maxMemberAge: null,
      benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
      isActive: true,
      createdBy: user.userId,
      updatedBy: user.userId,
    });
  });
}

interface SeededState {
  readonly memberId: string;
  readonly suggestionId: SuggestionId;
}

async function seedOpenSuggestion(
  tenant: TestTenant,
): Promise<SeededState> {
  const memberId = randomUUID();
  const suggestionUuid = randomUUID();

  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      companyName: 'Dismiss Probe Co',
      country: 'TH',
      planId: 'regular',
      planYear: 2026,
      turnoverThb: 120_000_000,
    });
    await tx.insert(tierUpgradeSuggestions).values({
      tenantId: tenant.ctx.slug,
      suggestionId: suggestionUuid,
      memberId,
      fromPlanId: 'regular',
      toPlanId: 'premium',
      reasonCode: 'declared_turnover_above_threshold',
      evidenceJsonb: {
        reasonCode: 'declared_turnover_above_threshold',
        turnoverThb: 120_000_000,
        thresholdMetAt: new Date().toISOString(),
      },
      status: 'open',
    });
  });

  const idResult = parseSuggestionId(suggestionUuid);
  if (!idResult.ok) throw new Error('seeded suggestion id failed parse');
  return { memberId, suggestionId: idResult.value };
}

async function clearTenant(tenant: TestTenant): Promise<void> {
  // F4+F8 Satang migration (2026-05-16) — wrap deletes in `runInTenant`.
  // Pre-fix `db.delete(...)` ran outside the tenant role context; with
  // FORCE ROW LEVEL SECURITY on tier_upgrade_suggestions the DELETE
  // matched zero rows (no `current_tenant()` set), leaking state across
  // tests → test 3 saw 3 accumulated suggestions and test 2's `[row]`
  // destructure picked an un-dismissed row's null `dismissedReason`.
  await runInTenant(tenant.ctx, async (tx) => {
    await tx
      .delete(tierUpgradeSuggestions)
      .where(eq(tierUpgradeSuggestions.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tx
      .delete(members)
      .where(eq(members.tenantId, tenant.ctx.slug))
      .catch(() => {});
  });
  // audit_log is append-only at trigger level + not bound to FORCE RLS
  // for owner cleanup; the existing `db.delete` is sufficient.
  await db
    .delete(auditLog)
    .where(eq(auditLog.tenantId, tenant.ctx.slug))
    .catch(() => {});
}

describe('F8 dismissTierUpgrade — integration (Round 6 F-002)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    // F4+F8 Satang migration (2026-05-16) — seed plan catalogue
    // referenced by the suggestion fixture.
    await seedPlan(tenant, admin, 'regular');
    await seedPlan(tenant, admin, 'premium');
  }, 180_000);

  afterAll(async () => {
    await clearTenant(tenant).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  beforeEach(async () => {
    await clearTenant(tenant).catch(() => {});
  });

  it('AS3 happy path — dismiss without reason transitions open → dismissed + sets suppressed_until ≈ today+90d + emits audit', async () => {
    const seeded = await seedOpenSuggestion(tenant);
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const before = Date.now();

    const result = await dismissTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      suggestionId: seeded.suggestionId,
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.suggestionId).toBe(seeded.suggestionId);

    const suppressedUntilMs = new Date(result.value.suppressedUntil).getTime();
    const target = before + 90 * MS_PER_DAY;
    // Allow 5-second slack for clock + tx commit.
    expect(suppressedUntilMs).toBeGreaterThanOrEqual(target - 5_000);
    expect(suppressedUntilMs).toBeLessThanOrEqual(target + 60_000);

    // Row state pinned.
    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(tierUpgradeSuggestions)
        .where(eq(tierUpgradeSuggestions.suggestionId, seeded.suggestionId)),
    );
    expect(row?.status).toBe('dismissed');
    expect(row?.suppressedUntil).not.toBeNull();
    // Domain encodes "no reason given" as the empty string (see
    // `dismiss-tier-upgrade.ts:84-90` — `dismissedReason: ''` when input
    // reason is undefined).
    expect(row?.dismissedReason).toBe('');
    expect(row?.closedAt).not.toBeNull();

    // Audit row asserts the canonical event type + member_id + null
    // reason in payload.
    // F4+F8 Satang migration (2026-05-16) — filter by seeded
    // suggestion_id in payload so audit-log accumulation from prior
    // tests in the same file does not poison the assertion.
    // audit_log is append-only at trigger level (cannot DELETE in
    // beforeEach), so per-test filtering is the only correct
    // isolation primitive.
    const audits = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.eventType, 'tier_upgrade_dismissed'),
            sql`${auditLog.payload}->>'suggestion_id' = ${seeded.suggestionId}`,
          ),
        ),
    );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const payload = audits[0]?.payload as Record<string, unknown>;
    expect(payload?.suggestion_id).toBe(seeded.suggestionId);
    expect(payload?.member_id).toBe(seeded.memberId);
    expect(payload?.reason).toBeNull();
  }, 60_000);

  it('AS3 with reason — reason persisted in dismissed_reason + audit payload', async () => {
    const seeded = await seedOpenSuggestion(tenant);
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const reason = 'Member already declined the upsell on a Q3 phone call.';

    const result = await dismissTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      suggestionId: seeded.suggestionId,
      reason,
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(result.ok).toBe(true);

    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(tierUpgradeSuggestions)
        .where(eq(tierUpgradeSuggestions.suggestionId, seeded.suggestionId)),
    );
    expect(row?.dismissedReason).toBe(reason);

    // F4+F8 Satang migration (2026-05-16) — filter by seeded
    // suggestion_id; audit_log is append-only across the whole file.
    const audits = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.eventType, 'tier_upgrade_dismissed'),
            sql`${auditLog.payload}->>'suggestion_id' = ${seeded.suggestionId}`,
          ),
        ),
    );
    const payload = audits[0]?.payload as Record<string, unknown>;
    expect(payload?.reason).toBe(reason);
  }, 60_000);

  it('Re-dismiss attempt — second call on same suggestion returns suggestion_not_open + B row unchanged', async () => {
    const seeded = await seedOpenSuggestion(tenant);
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    const first = await dismissTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      suggestionId: seeded.suggestionId,
      reason: 'first dismiss',
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(first.ok).toBe(true);

    const second = await dismissTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      suggestionId: seeded.suggestionId,
      reason: 'second dismiss attempt',
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.kind).toBe('suggestion_not_open');

    // First reason persists; second attempt did NOT overwrite the row.
    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(tierUpgradeSuggestions)
        .where(eq(tierUpgradeSuggestions.suggestionId, seeded.suggestionId)),
    );
    expect(row?.dismissedReason).toBe('first dismiss');

    // Exactly one `tier_upgrade_dismissed` audit row, not two.
    // F4+F8 Satang migration (2026-05-16) — filter by seeded
    // suggestion_id so prior-test audit rows don't inflate the count.
    const audits = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.eventType, 'tier_upgrade_dismissed'),
            sql`${auditLog.payload}->>'suggestion_id' = ${seeded.suggestionId}`,
          ),
        ),
    );
    expect(audits).toHaveLength(1);
  }, 60_000);
});
