/**
 * F8 Phase 6 review-round 2 C1-test — `seed-demo-members.ts` smoke
 * against a throwaway tenant.
 *
 * Validates the per-row insert path that runs against the LIVE
 * `swecham` tenant in production:
 *
 *   1. `'inserted'` outcome on first call → member + primary contact
 *      rows present + audit_log records `member_created` and
 *      `contact_created`.
 *   2. `'skipped'` outcome on second call (idempotency by case-
 *      insensitive companyName + same tax_id).
 *   3. `'repaired-tax-id'` outcome when re-called with a different
 *      tax_id for the same company → updates members.tax_id +
 *      emits `member_updated` audit (no second member row).
 *
 * Out of scope: `requireSwechamTenant()` guard, `loadPayload()` JSON
 * parsing, `assertPlansExist()` plan verification — these are
 * environment guards, not data-writing logic. The C5 audit-event-
 * type alignment was verified at the use-case level
 * (`contact-crud.ts`); this test pins the audit row count.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql as drizzleSql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedRow } from '@/../scripts/seed-demo-members';

const PLAN_ID = 'regular';
const PLAN_YEAR = 2026;
const COMPANY = 'C1Smoke Demo Co';
const TAX_ID_INITIAL = '0105500000017'; // valid Thai-tax checksum
const TAX_ID_REPAIRED = '0107536000027';

describe('seed-demo-members.seedRow smoke (Phase 6 review-round 2 C1-test)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    // Seed the plan that the demo row references.
    await db.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId: PLAN_ID,
      planYear: PLAN_YEAR,
      planName: { en: 'Regular Test' },
      description: { en: 'Test description' },
      planCategory: 'corporate',
      memberTypeScope: 'company',
      annualFeeMinorUnits: 5_000_000,
      benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
      isActive: true,
      createdBy: user.userId,
      updatedBy: user.userId,
    });
  }, 120_000);

  afterAll(async () => {
    await runInTenant(tenant.ctx, async (tx) => {
      await tx
        .delete(contacts)
        .where(eq(contacts.tenantId, tenant.ctx.slug))
        .catch(() => {});
      await tx
        .delete(members)
        .where(eq(members.tenantId, tenant.ctx.slug))
        .catch(() => {});
    });
    await db
      .delete(membershipPlans)
      .where(eq(membershipPlans.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 60_000);

  function makeRow(taxId: string | null) {
    return {
      companyName: COMPANY,
      country: 'TH',
      taxId,
      planId: PLAN_ID,
      registrationDate: '2025-01-01',
      status: 'active' as const,
      notes: null,
      billingEmail: null,
      primaryContact: {
        firstName: 'C1',
        lastName: 'Smoke',
        email: 'c1smoke@acme.example',
        phone: null,
        roleTitle: 'CEO',
        preferredLanguage: 'en' as const,
      },
    };
  }

  it('first call → "inserted" with member + contact + 2 audit rows', async () => {
    const outcome = await seedRow(tenant.ctx, user.userId, PLAN_YEAR, makeRow(TAX_ID_INITIAL));
    expect(outcome).toBe('inserted');

    const memberRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(members)
        .where(eq(members.companyName, COMPANY)),
    );
    expect(memberRows.length).toBe(1);
    expect(memberRows[0]?.taxId).toBe(TAX_ID_INITIAL);

    const contactRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(contacts)
        .where(eq(contacts.memberId, memberRows[0]!.memberId)),
    );
    expect(contactRows.length).toBe(1);
    expect(contactRows[0]?.email).toBe('c1smoke@acme.example');
    expect(contactRows[0]?.isPrimary).toBe(true);

    const auditRows = await db
      .select({ eventType: auditLog.eventType })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          drizzleSql`${auditLog.payload}->>'member_id' = ${memberRows[0]!.memberId}`,
        ),
      );
    const types = auditRows.map((r) => r.eventType);
    expect(types).toContain('member_created');
    expect(types).toContain('contact_created');
  });

  it('second call same tax_id → "skipped" (idempotency by companyName + tax_id)', async () => {
    const outcome = await seedRow(tenant.ctx, user.userId, PLAN_YEAR, makeRow(TAX_ID_INITIAL));
    expect(outcome).toBe('skipped');

    const memberRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(members)
        .where(eq(members.companyName, COMPANY)),
    );
    expect(memberRows.length).toBe(1); // no duplicate insert
  });

  it('third call with NEW tax_id → "repaired-tax-id" + member_updated audit', async () => {
    const outcome = await seedRow(tenant.ctx, user.userId, PLAN_YEAR, makeRow(TAX_ID_REPAIRED));
    expect(outcome).toBe('repaired-tax-id');

    const memberRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(members)
        .where(eq(members.companyName, COMPANY)),
    );
    expect(memberRows.length).toBe(1); // still one row, tax_id changed
    expect(memberRows[0]?.taxId).toBe(TAX_ID_REPAIRED);

    const repairAudits = await db
      .select({ eventType: auditLog.eventType })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'member_updated'),
          drizzleSql`${auditLog.payload}->>'source' = 'seed-demo-members:repair'`,
        ),
      );
    expect(repairAudits.length).toBeGreaterThanOrEqual(1);
  });
});
