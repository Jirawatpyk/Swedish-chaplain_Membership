/**
 * F8 Phase 6 round-3 TestQ2 fix — `seedRow` cross-tenant probe.
 *
 * Constitution Principle I (tenant isolation, NON-NEGOTIABLE):
 * `seedRow(ctx, ...)` is a public exported function. It trusts the
 * caller's `ctx`, then `runInTenant(ctx, ...)` sets the RLS+FORCE
 * tenant context. This test pins the cross-tenant write isolation:
 * a row inserted via tenant-B's ctx with the SAME companyName as a
 * tenant-A row must NOT be detected as a duplicate (the
 * idempotency check is `WHERE tenantId = ctx.slug`).
 *
 * Without this guardrail, a future refactor that drops the tenant
 * filter from the duplicate check (e.g. adopting a global "same
 * companyName already exists" cache) would silently coalesce
 * cross-tenant rows — a Constitution Principle I violation that
 * would only surface in production.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import {
  createActiveTestUser,
  type TestUser,
} from '../helpers/test-users';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedRow } from '@/../scripts/seed-demo-members';

const PLAN_ID = 'regular';
const PLAN_YEAR = 2026;
const COMPANY = 'CrossTenant Probe Co';

describe('seedRow cross-tenant write probe (Phase 6 round-3 TestQ2)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let userInA: TestUser;
  let userInB: TestUser;

  beforeAll(async () => {
    tenantA = await createTestTenant('test-swecham');
    tenantB = await createTestTenant('test-chamber');
    userInA = await createActiveTestUser('admin');
    userInB = await createActiveTestUser('admin');

    // Seed the plan in BOTH tenants — seedRow's `assertPlansExist`
    // only runs on the orchestration path, not the per-row helper.
    for (const [tenant, user] of [
      [tenantA, userInA],
      [tenantB, userInB],
    ] as const) {
      await db.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: PLAN_ID,
        planYear: PLAN_YEAR,
        planName: { en: 'Regular' },
        description: { en: '' },
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 5_000_000,
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      });
    }
  }, 180_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      await runInTenant(t.ctx, async (tx) => {
        await tx
          .delete(contacts)
          .where(eq(contacts.tenantId, t.ctx.slug))
          .catch(() => {});
        await tx
          .delete(members)
          .where(eq(members.tenantId, t.ctx.slug))
          .catch(() => {});
      });
      await db
        .delete(membershipPlans)
        .where(eq(membershipPlans.tenantId, t.ctx.slug))
        .catch(() => {});
      await db
        .delete(auditLog)
        .where(eq(auditLog.tenantId, t.ctx.slug))
        .catch(() => {});
      await t.cleanup().catch(() => {});
    }
  }, 120_000);

  function makeRow(emailLocal: string) {
    return {
      companyName: COMPANY,
      country: 'TH',
      taxId: null,
      planId: PLAN_ID,
      registrationDate: '2025-01-01',
      status: 'active' as const,
      notes: null,
      billingEmail: null,
      primaryContact: {
        firstName: 'Cross',
        lastName: 'Tenant',
        email: `${emailLocal}@cross-tenant.example`,
        phone: null,
        roleTitle: 'CEO',
        preferredLanguage: 'en' as const,
      },
    };
  }

  it('same companyName in tenant A + tenant B is NOT detected as a duplicate', async () => {
    const outcomeA = await seedRow(
      tenantA.ctx,
      userInA.userId,
      PLAN_YEAR,
      makeRow('a-side'),
    );
    expect(outcomeA).toBe('inserted');

    // Same companyName, different tenant — must NOT be skipped (the
    // idempotency check is tenant-scoped).
    const outcomeB = await seedRow(
      tenantB.ctx,
      userInB.userId,
      PLAN_YEAR,
      makeRow('b-side'),
    );
    expect(outcomeB).toBe('inserted');

    // Cross-check: each tenant has exactly ONE matching member row.
    const tenantARows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(members)
        .where(eq(members.companyName, COMPANY)),
    );
    expect(tenantARows.length).toBe(1);

    const tenantBRows = await runInTenant(tenantB.ctx, (tx) =>
      tx
        .select()
        .from(members)
        .where(eq(members.companyName, COMPANY)),
    );
    expect(tenantBRows.length).toBe(1);

    // Member ids MUST be different — they're independent rows in
    // separate tenants.
    expect(tenantARows[0]?.memberId).not.toBe(tenantBRows[0]?.memberId);
  });

  it('idempotency check stays tenant-scoped on second call from same tenant', async () => {
    // Re-call seedRow with tenant A, same row → 'skipped' (proves
    // intra-tenant idempotency is preserved despite the cross-tenant
    // row in tenant B from the previous test).
    const outcomeA2 = await seedRow(
      tenantA.ctx,
      userInA.userId,
      PLAN_YEAR,
      makeRow('a-side'),
    );
    expect(outcomeA2).toBe('skipped');
  });
});
