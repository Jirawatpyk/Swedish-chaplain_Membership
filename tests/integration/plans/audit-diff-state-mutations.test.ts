/**
 * T126a — Integration: audit-diff round-trip for US4 state mutations
 * (analyze C1, close SC-007 coverage for US4 events).
 *
 * For each state mutation (activate, deactivate, soft-delete, undelete)
 * this test mutates the plan via the Application use case, reads the
 * latest `audit_log` row, runs it through `auditPayloadSchema.safeParse`,
 * and verifies the expected diff shape:
 *
 *   plan_activated:   { is_active: { before: false, after: true } }
 *   plan_deactivated: { is_active: { before: true, after: false } }
 *   plan_soft_deleted:{ deleted_at: { before: null, after: <ISO string> } }
 *   plan_undeleted:   { deleted_at: { before: <ISO string>, after: null },
 *                       is_active: forced false per US4 AS4 — but since
 *                       the plan was already inactive before undelete,
 *                       we assert deleted_at clears cleanly and optionally
 *                       surface is_active diff if it would have changed. }
 *
 * Exercises the real use cases + `planAuditAdapter` + live Neon so the
 * test covers the full Drizzle → JSONB serialization boundary.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { auditPayloadSchema } from '@/modules/plans/domain/audit-event';
import { planRepo } from '@/modules/plans/infrastructure/db/plan-repo';
import { feeConfigRepo } from '@/modules/plans/infrastructure/db/fee-config-repo';
import { planAuditAdapter } from '@/modules/plans/infrastructure/audit/plan-audit-adapter';
import { stubMemberAttachmentChecker } from '@/modules/plans/infrastructure/members/stub-member-attachment-checker';
import { activatePlan } from '@/modules/plans/application/activate-plan';
import { deactivatePlan } from '@/modules/plans/application/deactivate-plan';
import { softDeletePlan } from '@/modules/plans/application/soft-delete-plan';
import { undeletePlan } from '@/modules/plans/application/undelete-plan';
import { asPlanSlug, asPlanYear } from '@/modules/plans/domain/plan';
import { db } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import type { ClockPort, PlanDraftInput } from '@/modules/plans/application/ports';
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

const clock: ClockPort = {
  now: () => new Date('2027-06-15T00:00:00Z'),
  currentYear: () => 2027,
};

function seed(userId: string, isActive: boolean): PlanDraftInput {
  return {
    plan_id: 'premium',
    plan_year: 2027,
    plan_name: { en: 'Premium' },
    description: { en: '' },
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
    isActive,
    createdBy: userId,
    updatedBy: userId,
  } as PlanDraftInput;
}

function buildCtx(tenant: TestTenant) {
  return {
    tenant: tenant.ctx,
    planRepo,
    feeConfigRepo,
    audit: planAuditAdapter,
    clock,
    members: stubMemberAttachmentChecker,
  };
}

type US4EventType =
  | 'plan_activated'
  | 'plan_deactivated'
  | 'plan_soft_deleted'
  | 'plan_undeleted';

async function readLatestAudit(
  tenant: TestTenant,
  eventType: US4EventType,
) {
  const rows = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenantId, tenant.ctx.slug),
        eq(auditLog.eventType, eventType),
      ),
    )
    .orderBy(desc(auditLog.timestamp))
    .limit(1);
  return rows[0];
}

describe('Integration: US4 state-mutation audit-diff round-trip (T126a)', () => {
  let tenant: TestTenant;

  afterEach(async () => {
    if (tenant) await tenant.cleanup().catch(() => {});
  });

  it('plan_activated — payload round-trips with is_active diff', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await feeConfigRepo.upsert(tenant.ctx, {
      currency_code: 'THB',
      vat_rate: 0.07,
      registration_fee_minor_units: 100_000,
      updated_by: user.userId,
    });
    await planRepo.insert(tenant.ctx, seed(user.userId, false));

    const result = await activatePlan(
      {
        planId: asPlanSlug('premium'),
        year: asPlanYear(2027),
        actorUserId: user.userId,
        requestId: 'req-act',
        sourceIp: null,
        idempotencyKey: 'idem-act',
      },
      buildCtx(tenant),
    );
    expect(result.ok).toBe(true);

    const row = await readLatestAudit(tenant, 'plan_activated');
    expect(row).toBeDefined();
    const parsed = auditPayloadSchema.safeParse({
      event_type: row!.eventType,
      payload: row!.payload,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.event_type === 'plan_activated') {
      expect(parsed.data.payload.plan_id).toBe('premium');
      expect(parsed.data.payload.plan_year).toBe(2027);
      expect(parsed.data.payload.diff).toBeDefined();
      expect(parsed.data.payload.diff!.is_active).toEqual({
        before: false,
        after: true,
      });
    }
  });

  it('plan_deactivated — payload round-trips with is_active diff', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await feeConfigRepo.upsert(tenant.ctx, {
      currency_code: 'THB',
      vat_rate: 0.07,
      registration_fee_minor_units: 100_000,
      updated_by: user.userId,
    });
    await planRepo.insert(tenant.ctx, seed(user.userId, true));

    const result = await deactivatePlan(
      {
        planId: asPlanSlug('premium'),
        year: asPlanYear(2027),
        actorUserId: user.userId,
        requestId: 'req-deact',
        sourceIp: null,
        idempotencyKey: 'idem-deact',
      },
      buildCtx(tenant),
    );
    expect(result.ok).toBe(true);

    const row = await readLatestAudit(tenant, 'plan_deactivated');
    expect(row).toBeDefined();
    const parsed = auditPayloadSchema.safeParse({
      event_type: row!.eventType,
      payload: row!.payload,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.event_type === 'plan_deactivated') {
      expect(parsed.data.payload.diff!.is_active).toEqual({
        before: true,
        after: false,
      });
    }
  });

  it('plan_soft_deleted — payload round-trips with deleted_at diff (before: null, after: ISO)', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await feeConfigRepo.upsert(tenant.ctx, {
      currency_code: 'THB',
      vat_rate: 0.07,
      registration_fee_minor_units: 100_000,
      updated_by: user.userId,
    });
    await planRepo.insert(tenant.ctx, seed(user.userId, false));

    const result = await softDeletePlan(
      {
        planId: asPlanSlug('premium'),
        year: asPlanYear(2027),
        actorUserId: user.userId,
        requestId: 'req-soft',
        sourceIp: null,
        idempotencyKey: 'idem-soft',
      },
      buildCtx(tenant),
    );
    expect(result.ok).toBe(true);

    const row = await readLatestAudit(tenant, 'plan_soft_deleted');
    expect(row).toBeDefined();
    const parsed = auditPayloadSchema.safeParse({
      event_type: row!.eventType,
      payload: row!.payload,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.event_type === 'plan_soft_deleted') {
      expect(parsed.data.payload.diff).toBeDefined();
      const deletedAtDiff = parsed.data.payload.diff!.deleted_at;
      expect(deletedAtDiff).toBeDefined();
      expect(deletedAtDiff!.before).toBeNull();
      expect(typeof deletedAtDiff!.after).toBe('string');
    }
  });

  it('plan_undeleted — payload round-trips with deleted_at diff (before: ISO, after: null)', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await feeConfigRepo.upsert(tenant.ctx, {
      currency_code: 'THB',
      vat_rate: 0.07,
      registration_fee_minor_units: 100_000,
      updated_by: user.userId,
    });
    await planRepo.insert(tenant.ctx, seed(user.userId, false));

    // First soft-delete it
    await softDeletePlan(
      {
        planId: asPlanSlug('premium'),
        year: asPlanYear(2027),
        actorUserId: user.userId,
        requestId: 'req-soft-pre',
        sourceIp: null,
        idempotencyKey: 'idem-soft-pre',
      },
      buildCtx(tenant),
    );

    // Then undelete
    const result = await undeletePlan(
      {
        planId: asPlanSlug('premium'),
        year: asPlanYear(2027),
        actorUserId: user.userId,
        requestId: 'req-undel',
        sourceIp: null,
        idempotencyKey: 'idem-undel',
      },
      buildCtx(tenant),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    // AS4: undelete target state is Inactive (forced), never Active
    expect(result.value.is_active).toBe(false);
    expect(result.value.deleted_at).toBeNull();

    const row = await readLatestAudit(tenant, 'plan_undeleted');
    expect(row).toBeDefined();
    const parsed = auditPayloadSchema.safeParse({
      event_type: row!.eventType,
      payload: row!.payload,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.event_type === 'plan_undeleted') {
      expect(parsed.data.payload.diff).toBeDefined();
      const deletedAtDiff = parsed.data.payload.diff!.deleted_at;
      expect(deletedAtDiff).toBeDefined();
      expect(typeof deletedAtDiff!.before).toBe('string');
      expect(deletedAtDiff!.after).toBeNull();
    }
  });
});
