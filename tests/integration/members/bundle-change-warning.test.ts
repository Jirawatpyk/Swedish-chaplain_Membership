/**
 * T076 — Integration perf: FR-010 / SC-008 bundle-warning count.
 *
 * Asserts `affectedMembersCount` returns correct counts and meets
 * the SC-008 SLO (p95 < 200ms at a 500-member tenant) backed by the
 * composite index `members_tenant_status_plan_idx`.
 *
 * Perf path is gated by `RUN_PERF=1` so CI is deterministic and
 * developers opt-in locally. The correctness assertions always run.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { affectedMembersCount } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import {
  membershipPlans,
  tenantFeeConfig,
} from '@/modules/plans/infrastructure/db/schema';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const RUN_PERF = process.env.RUN_PERF === '1';

describe('affected-members-count — SC-008 (T076)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(tenantFeeConfig).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeMinorUnits: 100000,
        updatedBy: admin.userId,
      });
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: 'premium',
        planYear: 2026,
        planName: { en: 'Premium' },
        description: { en: '' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        createdBy: admin.userId,
        updatedBy: admin.userId,
        benefitMatrix: {
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
        },
      });
    });
  });

  afterAll(async () => {
    await tenant.cleanup();
    await deleteTestUser(admin);
  });

  it('returns 0 when no members on the plan', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const result = await affectedMembersCount(
      { planId: 'premium', planYear: 2026 },
      { tenant: tenant.ctx, plans: deps.plans },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.count).toBe(0);
  }, 30_000);

  it('counts only active+inactive (archived excluded) for the target plan', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const ids = Array.from({ length: 5 }, () => randomUUID());
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values(
        ids.map((id, idx) => ({
          tenantId: tenant.ctx.slug,
          memberId: id,
          companyName: `Co ${idx}`,
          country: 'TH',
          planId: 'premium',
          planYear: 2026,
          status:
            idx === 0
              ? ('archived' as const)
              : idx === 1
                ? ('inactive' as const)
                : ('active' as const),
          // `archived_at` CHECK: status='archived' ⇔ archived_at NOT NULL
          ...(idx === 0 ? { archivedAt: new Date() } : {}),
        })),
      );
    });

    const result = await affectedMembersCount(
      { planId: 'premium', planYear: 2026 },
      { tenant: tenant.ctx, plans: deps.plans },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.count).toBe(4); // 5 - 1 archived
  }, 30_000);

  // SC-008 perf gate — only runs when RUN_PERF=1 so we don't seed 500
  // rows on every CI tick. Skip is observable in the test report.
  it.skipIf(!RUN_PERF)(
    'p95 < 200ms at 500-member tenant (SC-008)',
    async () => {
      const deps = buildMembersDeps(tenant.ctx);

      // Seed 500 active members on the plan. Insert in batches of 100
      // so the single-statement bind count stays under Postgres' cap.
      const batchSize = 100;
      for (let batch = 0; batch < 5; batch += 1) {
        const rows = Array.from({ length: batchSize }, (_, i) => ({
          tenantId: tenant.ctx.slug,
          memberId: randomUUID(),
          companyName: `Perf Co ${batch * batchSize + i}`,
          country: 'TH',
          planId: 'premium',
          planYear: 2026,
          status: 'active' as const,
        }));
        await runInTenant(tenant.ctx, (tx) =>
          tx.insert(members).values(rows),
        );
      }

      // 20 warmup calls + 100 measurements. p95 on sorted array.
      const runOnce = async () => {
        const t0 = performance.now();
        await affectedMembersCount(
          { planId: 'premium', planYear: 2026 },
          { tenant: tenant.ctx, plans: deps.plans },
        );
        return performance.now() - t0;
      };
      for (let i = 0; i < 20; i += 1) await runOnce();
      const samples: number[] = [];
      for (let i = 0; i < 100; i += 1) samples.push(await runOnce());
      samples.sort((a, b) => a - b);
      const p95 = samples[Math.ceil(0.95 * samples.length) - 1]!;
      console.log(`[T076] p95 = ${p95.toFixed(1)}ms over ${samples.length} samples`);
      expect(p95).toBeLessThan(200);
    },
    300_000,
  );
});
