/**
 * T114 — Integration: plan_updated audit-diff round-trip (US3, critique P9).
 *
 * Seeds a plan, mutates it, reads the latest `audit_log` row for that
 * tenant, and validates the payload through `auditPayloadSchema` with
 * `success: true`. Also asserts the `diff` field captures ONLY the
 * changed columns with the correct `{before, after}` shape.
 *
 * Exercises the real `updatePlan` use case + `planAuditAdapter` +
 * live Neon so the test covers the full Drizzle → JSONB serialization
 * boundary that unit tests cannot reach.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { auditPayloadSchema } from '@/modules/plans/domain/audit-event';
import { planRepo } from '@/modules/plans/infrastructure/db/plan-repo';
import { feeConfigRepo } from '@/modules/plans/infrastructure/db/fee-config-repo';
import { planAuditAdapter } from '@/modules/plans/infrastructure/audit/plan-audit-adapter';
import { stubMemberAttachmentChecker } from '@/modules/plans/infrastructure/members/stub-member-attachment-checker';
import { updatePlan } from '@/modules/plans/application/update-plan';
import { asPlanSlug, asPlanYear } from '@/modules/plans/domain/plan';
import { db } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import type { PlanDraftInput, ClockPort } from '@/modules/plans/application/ports';
import { createActiveTestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const MATRIX: BenefitMatrix = {
  eblast_per_year: 0,
  website_page_type: null,
  homepage_logo_category: null,
  directory_listing_size: null,
  event_discount_scope: 'none',
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: false,
  business_referrals: false,
  tailor_made_services: false,
  partnership: null,
};

const currentYearClock: ClockPort = {
  now: () => new Date('2027-06-15T00:00:00Z'),
  currentYear: () => 2027,
};

function seed(userId: string): PlanDraftInput {
  return {
    plan_id: 'premium',
    plan_year: 2027,
    plan_name: { en: 'Original' },
    description: { en: 'Original desc' },
    sort_order: 10,
    plan_category: 'corporate',
    member_type_scope: 'company',
    annual_fee_minor_units: 3_600_000,
    includes_corporate_plan_id: null,
    min_turnover_minor_units: null,
    max_turnover_minor_units: null,
    max_duration_years: null,
    max_member_age: null,
    benefit_matrix: MATRIX,
    isActive: true,
    createdBy: userId,
    updatedBy: userId,
  } as PlanDraftInput;
}

describe('Integration: plan_updated audit-diff round-trip (T114)', () => {
  let tenant: TestTenant;

  afterEach(async () => {
    if (tenant) await tenant.cleanup().catch(() => {});
  });

  it('payload round-trips through auditPayloadSchema with correct diff shape', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await feeConfigRepo.upsert(tenant.ctx, {
      currency_code: 'THB',
      vat_rate: 0.07,
      registration_fee_minor_units: 100_000,
      updated_by: user.userId,
    });
    await planRepo.insert(tenant.ctx, seed(user.userId));

    // Mutate plan_name.en + annual_fee_minor_units in one call
    const result = await updatePlan(
      {
        planId: asPlanSlug('premium'),
        year: asPlanYear(2027),
        patch: {
          plan_name: { en: 'Renamed Premium' },
          annual_fee_minor_units: 4_000_000,
        },
        actorUserId: user.userId,
        requestId: 'req-update-audit',
        sourceIp: null,
        idempotencyKey: 'idem-update-audit',
      },
      {
        tenant: tenant.ctx,
        planRepo,
        audit: planAuditAdapter,
        clock: currentYearClock,
        members: stubMemberAttachmentChecker,
      },
    );
    expect(result.ok).toBe(true);

    // Fetch the latest plan_updated row for this tenant
    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'plan_updated'),
        ),
      )
      .orderBy(desc(auditLog.timestamp))
      .limit(1);

    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    // Round-trip through auditPayloadSchema
    const parsed = auditPayloadSchema.safeParse({
      event_type: row.eventType,
      payload: row.payload,
    });
    expect(parsed.success).toBe(true);

    if (parsed.success && parsed.data.event_type === 'plan_updated') {
      const { diff, plan_id, plan_year } = parsed.data.payload;
      expect(plan_id).toBe('premium');
      expect(plan_year).toBe(2027);

      // Only the 2 changed fields should appear in the diff
      expect(Object.keys(diff)).toEqual(
        expect.arrayContaining(['plan_name', 'annual_fee_minor_units']),
      );
      expect(Object.keys(diff)).toHaveLength(2);

      // Verify before/after shapes
      expect(diff.plan_name?.before).toEqual({ en: 'Original' });
      expect(diff.plan_name?.after).toEqual({ en: 'Renamed Premium' });
      expect(diff.annual_fee_minor_units?.before).toBe(3_600_000);
      expect(diff.annual_fee_minor_units?.after).toBe(4_000_000);
    }
  });
});
