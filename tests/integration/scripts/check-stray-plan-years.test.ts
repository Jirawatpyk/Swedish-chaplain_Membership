/**
 * Integration test: scripts/check-stray-plan-years.ts
 *
 * Verifies the stray-plan-year diagnostic correctly:
 *   - REPORTS implausible-year rows (future + below-floor) across tenants
 *   - classifies inactive + unreferenced rows as DELETABLE
 *   - classifies active OR referenced rows as SKIPPED (never deleted)
 *   - dry-run mutates nothing; `--fix` deletes ONLY the deletable set
 *   - is idempotent (second fix run finds nothing)
 *
 * Runs against live Neon. Uses a `test-*` tenant slug so the rows are
 * also swept by `clear-test-data.ts` if a teardown is skipped.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import {
  checkStrayPlanYears,
  isImplausiblePlanYear,
} from '@/../scripts/check-stray-plan-years';
import { users } from '@/modules/auth/infrastructure/db/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { asTenantContext } from '@/modules/tenants';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { argon2Hasher } from '@/modules/auth/infrastructure/password/argon2-hasher';

const MATRIX: BenefitMatrix = {
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

// Future-stray year well above currentYear+1 (and the chamber's real
// catalogue) so it is unambiguously implausible regardless of wall-clock.
const STRAY_YEAR = 2099;

const slug = `test-stray-${randomUUID().slice(0, 8)}`;
const ctx = asTenantContext(slug);
const seedEmail = `test-${Date.now()}-stray-seed@swecham.test`;
const refMemberId = randomUUID();
let seedUserId: string;

describe('checkStrayPlanYears script', () => {
  beforeAll(async () => {
    const seedHash = await argon2Hasher.hash('Test-Password-Stray-Seed-2026!');
    const seedRows = await db
      .insert(users)
      .values({
        email: seedEmail,
        role: 'admin',
        status: 'active',
        passwordHash: seedHash,
        lastPasswordChangedAt: new Date(),
      })
      .returning();
    seedUserId = seedRows[0]!.id;

    await runInTenant(ctx, async (tx) => {
      // (1) DELETABLE: inactive + implausible-year + unreferenced.
      await tx.insert(membershipPlans).values({
        tenantId: slug,
        planId: 'stray-deletable',
        planYear: STRAY_YEAR,
        planName: { en: 'Stray Deletable' },
        description: { en: 'd' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        benefitMatrix: MATRIX,
        isActive: false,
        createdBy: seedUserId,
        updatedBy: seedUserId,
      });
      // (2) SKIPPED-active: implausible-year but is_active = true.
      await tx.insert(membershipPlans).values({
        tenantId: slug,
        planId: 'stray-active',
        planYear: STRAY_YEAR,
        planName: { en: 'Stray Active' },
        description: { en: 'd' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        benefitMatrix: MATRIX,
        isActive: true,
        createdBy: seedUserId,
        updatedBy: seedUserId,
      });
      // (3) SKIPPED-referenced: inactive + implausible-year BUT a
      //     renewal_cycle references its plan_id → must NOT be deleted.
      await tx.insert(membershipPlans).values({
        tenantId: slug,
        planId: 'stray-referenced',
        planYear: STRAY_YEAR,
        planName: { en: 'Stray Referenced' },
        description: { en: 'd' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        benefitMatrix: MATRIX,
        isActive: false,
        createdBy: seedUserId,
        updatedBy: seedUserId,
      });
      // A member is required so the renewal_cycle's
      // `renewal_cycles_member_fk` (tenant_id, member_id → members) is
      // satisfied; bind it to the stray-referenced plan via the
      // members_plan_tenant_year_fk composite key.
      await tx.insert(members).values({
        tenantId: slug,
        memberId: refMemberId,
        memberNumber: 1,
        companyName: 'Stray Ref Member',
        country: 'TH',
        planId: 'stray-referenced',
        planYear: STRAY_YEAR,
        registrationDate: '2026-01-01',
        registrationFeePaid: false,
        status: 'active',
      });
      await tx.insert(renewalCycles).values({
        tenantId: slug,
        memberId: refMemberId,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: 'stray-referenced',
        frozenPlanPriceThb: '15000.00',
        frozenPlanTermMonths: 12,
        periodFrom: new Date('2026-01-01T00:00:00Z'),
        periodTo: new Date('2026-12-31T00:00:00Z'),
        expiresAt: new Date('2026-12-31T00:00:00Z'),
        status: 'upcoming',
      });
    });
  });

  afterAll(async () => {
    // FK-order teardown: cycle → member → plans → user.
    await db.execute(
      sql`DELETE FROM renewal_cycles WHERE tenant_id = ${slug}`,
    );
    await db.execute(sql`DELETE FROM members WHERE tenant_id = ${slug}`);
    await db.execute(
      sql`DELETE FROM membership_plans WHERE tenant_id = ${slug}`,
    );
    await db.execute(sql`DELETE FROM users WHERE email = ${seedEmail}`);
  });

  it('classifies implausible plan years correctly (pure helper)', () => {
    expect(isImplausiblePlanYear(2026, 2026)).toBe(false);
    expect(isImplausiblePlanYear(2027, 2026)).toBe(false); // currentYear+1 ok
    expect(isImplausiblePlanYear(2028, 2026)).toBe(true); // > currentYear+1
    expect(isImplausiblePlanYear(2068, 2026)).toBe(true);
    expect(isImplausiblePlanYear(2019, 2026)).toBe(true); // < floor
    expect(isImplausiblePlanYear(2020, 2026)).toBe(false); // == floor ok
  });

  it('dry-run reports our 3 seeded stray rows and mutates nothing', async () => {
    const report = await checkStrayPlanYears({ fix: false });

    const mine = report.strayRows.filter((r) => r.tenantId === slug);
    expect(mine).toHaveLength(3);

    const deletableMine = report.deletable.filter((r) => r.tenantId === slug);
    expect(deletableMine).toHaveLength(1);
    expect(deletableMine[0]!.planId).toBe('stray-deletable');

    const skippedMine = report.skipped.filter((r) => r.tenantId === slug);
    expect(skippedMine.map((r) => r.planId).sort()).toEqual([
      'stray-active',
      'stray-referenced',
    ]);

    // The referenced row carries the cycle ref count.
    const referenced = skippedMine.find((r) => r.planId === 'stray-referenced');
    expect(referenced!.renewalCycleRefs).toBeGreaterThanOrEqual(1);

    // No deletes happened in dry-run.
    expect(report.deleted).toHaveLength(0);
    const still = await db.execute(
      sql`SELECT count(*)::int AS n FROM membership_plans WHERE tenant_id = ${slug}`,
    );
    const rows = Array.isArray(still)
      ? (still as unknown as Array<{ n: number }>)
      : ((still as unknown as { rows: Array<{ n: number }> }).rows ?? []);
    expect(rows[0]!.n).toBe(3);
  });

  it('--fix deletes ONLY the inactive + unreferenced stray row, and is idempotent', async () => {
    const first = await checkStrayPlanYears({ fix: true });
    const deletedMine = first.deleted.filter((r) => r.tenantId === slug);
    expect(deletedMine).toHaveLength(1);
    expect(deletedMine[0]!.planId).toBe('stray-deletable');

    // The active + referenced rows survive.
    const survivors = await db.execute(
      sql`SELECT plan_id FROM membership_plans WHERE tenant_id = ${slug} ORDER BY plan_id`,
    );
    const survivorRows = Array.isArray(survivors)
      ? (survivors as unknown as Array<{ plan_id: string }>)
      : ((survivors as unknown as { rows: Array<{ plan_id: string }> }).rows ?? []);
    expect(survivorRows.map((r) => r.plan_id)).toEqual([
      'stray-active',
      'stray-referenced',
    ]);

    // Idempotent: a second fix run deletes nothing more for our tenant.
    const second = await checkStrayPlanYears({ fix: true });
    expect(second.deleted.filter((r) => r.tenantId === slug)).toHaveLength(0);
  });
});
