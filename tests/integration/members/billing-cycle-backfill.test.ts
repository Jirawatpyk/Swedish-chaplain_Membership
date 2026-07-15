/**
 * 065 renewal-swecham-alignment (§5.1) — members.billing_cycle backfill logic.
 *
 * The column defaults 'rolling'; migration 0255 flips a member to 'calendar'
 * when their LATEST renewal cycle starts January 1 (Asia/Bangkok). The one-shot
 * migration UPDATE only touches rows that existed at migration time, so this
 * test validates the exact classification SQL by re-running it TENANT-SCOPED
 * (via `runInTenant` RLS — the migration runs it un-scoped over all tenants) on
 * freshly-seeded members whose latest cycle we control through registration_date
 * (advanced to the current period, preserving the anniversary day):
 *
 *   - registration Jan 1  → period_from Jan 1 → backfill flips to 'calendar';
 *   - registration mid-year → period_from mid-year → stays 'rolling';
 *   - a brand-new member (before backfill) reads the 'rolling' DB default.
 *
 * KNOWN LIMITATION under test elsewhere by design: a rolling member who first
 * paid in January collides with a calendar member — both period_from Jan 1 —
 * so the heuristic over-marks them 'calendar'. That is accepted (§5.1); the
 * field drives no behaviour this round and the admin-review gate is mandatory.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db, runInTenant } from '@/lib/db';
import { createMember } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { f8OnCreateMemberCallbacks } from '@/modules/renewals';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

// The exact backfill UPDATE from migration 0255. Run inside runInTenant so RLS
// scopes it to the test tenant's rows only (the migration runs it un-scoped).
const BACKFILL_SQL = sql`
  UPDATE "members" m
  SET "billing_cycle" = 'calendar'
  FROM (
    SELECT DISTINCT ON (rc."member_id")
      rc."tenant_id", rc."member_id", rc."period_from"
    FROM "renewal_cycles" rc
    ORDER BY rc."member_id", rc."created_at" DESC, rc."cycle_id" DESC
  ) latest
  WHERE latest."tenant_id" = m."tenant_id"
    AND latest."member_id" = m."member_id"
    AND EXTRACT(MONTH FROM (latest."period_from" AT TIME ZONE 'Asia/Bangkok')) = 1
    AND EXTRACT(DAY   FROM (latest."period_from" AT TIME ZONE 'Asia/Bangkok')) = 1
`;

describe('Integration — billing_cycle default + derive-from-dates backfill (065 §5.1)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    planId = `bc-backfill-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Billing-cycle Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
  }, 180_000);

  afterAll(async () => {
    await db.delete(renewalCycles).where(eq(renewalCycles.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 60_000);

  async function seedMember(registrationDate: string, tag: string): Promise<string> {
    const deps = buildMembersDeps(tenant.ctx);
    const seedSlug = randomUUID().slice(0, 8);
    const created = await createMember(
      {
        company_name: `${tag} ${seedSlug}`,
        country: 'SE',
        plan_id: planId,
        plan_year: 2026,
        registration_date: registrationDate,
        primary_contact: {
          first_name: tag,
          last_name: 'Test',
          email: `${seedSlug}@bc-test.example`,
          preferred_language: 'en' as const,
        },
      },
      { actorUserId: user.userId, requestId: `bc-${tag}-${seedSlug}` },
      { ...deps, onboardingListeners: f8OnCreateMemberCallbacks(tenant.ctx.slug) },
    );
    if (!created.ok) throw new Error(`create failed: ${JSON.stringify(created.error)}`);
    return created.value.memberId;
  }

  async function readBillingCycle(memberId: string): Promise<string> {
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ bc: members.billingCycle })
        .from(members)
        .where(and(eq(members.tenantId, tenant.ctx.slug), eq(members.memberId, memberId))),
    );
    return rows[0]!.bc;
  }

  it('a new member reads the "rolling" DB default (column NOT NULL DEFAULT rolling)', async () => {
    // Mid-year registration → onboarding cycle period_from mid-year, not Jan 1.
    const memberId = await seedMember('2020-03-15', 'Default');
    expect(await readBillingCycle(memberId)).toBe('rolling');
  }, 60_000);

  it('backfill flips a Jan-1-latest-cycle member to "calendar"; leaves mid-year AND Jan-but-not-1st members "rolling"', async () => {
    // A: Jan-1 anniversary → current-period anchor keeps period_from = Jan 1.
    const calendarMember = await seedMember('2020-01-01', 'CalendarA');
    // B: mid-year anniversary → period_from mid-year.
    const rollingMember = await seedMember('2020-06-20', 'RollingB');
    // C: January but NOT the 1st → proves the predicate requires day=1, not
    // just month=1 (guards against a simplified `EXTRACT(MONTH)=1` classifier).
    const janMidMember = await seedMember('2020-01-15', 'JanMid');

    // Before backfill: all are the 'rolling' default.
    expect(await readBillingCycle(calendarMember)).toBe('rolling');
    expect(await readBillingCycle(rollingMember)).toBe('rolling');
    expect(await readBillingCycle(janMidMember)).toBe('rolling');

    // Run the exact migration backfill, tenant-scoped via RLS.
    await runInTenant(tenant.ctx, (tx) => tx.execute(BACKFILL_SQL));

    expect(await readBillingCycle(calendarMember)).toBe('calendar');
    expect(await readBillingCycle(rollingMember)).toBe('rolling');
    expect(await readBillingCycle(janMidMember)).toBe('rolling'); // Jan 15 ≠ Jan 1
  }, 60_000);
});
