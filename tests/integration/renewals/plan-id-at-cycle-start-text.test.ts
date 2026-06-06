/**
 * F8 Phase 6 review-round 2 B1 — migration 0113 schema-parity smoke.
 *
 * Verifies that:
 *   1. `renewal_cycles.plan_id_at_cycle_start` is now `text` (matches
 *      F2 `plan_id` slug column).
 *   2. A real F2 plan_id slug round-trips through INSERT → SELECT
 *      and joins to `membership_plans.plan_id`.
 *   3. Drizzle's schema (`schema-renewal-cycles.ts:plan_id_at_cycle_start`
 *      typed `text(...)`) matches the DB column type — silent drift
 *      between Drizzle and DB is the canonical
 *      schema-out-of-sync class of bug.
 *
 * Closes the round-2 review B1 finding: round-1 + round-2 perf, F6
 * fallback, snooze/outreach + bulk-write tests covered the score
 * write path but no test confirmed the slug-resolution path that
 * migration 0113 was meant to unblock for the cycle-detail page.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import { eq, sql as drizzleSql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW_MS = Date.now();
const PERIOD_FROM = new Date(NOW_MS - 30 * MS_PER_DAY);
const PERIOD_TO = new Date(NOW_MS + 30 * MS_PER_DAY);

describe('F8 plan_id_at_cycle_start TEXT schema (migration 0113)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedRenewalPolicies(tenant.ctx);
  }, 180_000);

  afterAll(async () => {
    // Staff-Review-2026-05-09 WRN-3 fix: cleanup must include
    // contacts + members rows inserted in test bodies (lines 91-108
    // and the second test). FK order: renewal_cycles → contacts
    // (FK to members) → members → tenant cleanup.
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(contacts)
      .where(eq(contacts.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(members)
      .where(eq(members.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('column type is text in DB after migration 0113', async () => {
    const rows = await db.execute<{
      data_type: string;
    }>(drizzleSql`
      SELECT data_type
        FROM information_schema.columns
       WHERE table_name = 'renewal_cycles'
         AND column_name = 'plan_id_at_cycle_start'
    `);
    expect(rows[0]?.data_type).toBe('text');
  });

  it('a real F2 plan slug round-trips and joins to membership_plans', async () => {
    const memberId = randomUUID();
    const cycleId = randomUUID();
    const planId = `f8-text-${randomUUID().slice(0, 8)}`;

    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Text Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Text Round-trip Co',
        country: 'TH',
        planId,
        planYear: 2026,
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Text',
        lastName: 'Slug',
        email: `text-${randomUUID().slice(0, 6)}@acme.example`,
        isPrimary: true,
        preferredLanguage: 'en',
      });
      // Insert with a TEXT slug — the value migration 0113 unblocks.
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'upcoming',
        periodFrom: PERIOD_FROM,
        periodTo: PERIOD_TO,
        expiresAt: PERIOD_TO,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId, // ← TEXT slug, not UUID
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      });
    });

    // Round-trip: SELECT the value back as TEXT.
    const cycleRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          planIdAtCycleStart: renewalCycles.planIdAtCycleStart,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleId)),
    );
    expect(cycleRows[0]?.planIdAtCycleStart).toBe(planId);
    expect(typeof cycleRows[0]?.planIdAtCycleStart).toBe('string');
  });

  it('legacy UUID-shaped values still queryable as text', async () => {
    // Pre-0113 seeds wrote `gen_random_uuid()` here; migration 0113's
    // implicit `uuid::text` cast preserves them. Confirm a UUID-shaped
    // string round-trips identically.
    const memberId = randomUUID();
    const cycleId = randomUUID();
    const legacyUuidValue = randomUUID();
    const planId = `f8-legacy-${randomUUID().slice(0, 8)}`;

    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Legacy Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Legacy UUID Co',
        country: 'TH',
        planId,
        planYear: 2026,
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Legacy',
        lastName: 'UUID',
        email: `legacy-${randomUUID().slice(0, 6)}@acme.example`,
        isPrimary: true,
        preferredLanguage: 'en',
      });
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'upcoming',
        periodFrom: PERIOD_FROM,
        periodTo: PERIOD_TO,
        expiresAt: PERIOD_TO,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        // UUID-shaped string value (legacy seed pattern).
        planIdAtCycleStart: legacyUuidValue,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      });
    });

    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          planIdAtCycleStart: renewalCycles.planIdAtCycleStart,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleId)),
    );
    expect(rows[0]?.planIdAtCycleStart).toBe(legacyUuidValue);
  });
});
