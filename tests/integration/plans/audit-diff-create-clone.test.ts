/**
 * T096 — Integration: audit payload round-trip for plan_created + plan_cloned
 * (US2, critique P9).
 *
 * Verifies that every audit event emitted by the create + clone use
 * cases passes `auditPayloadSchema.safeParse(...)` with `success: true`.
 * The schema is the single source of truth for audit payload shape;
 * any drift between the use-case write path and the schema is a
 * red-bar CI event.
 *
 * These tests invoke the Application use cases against the real
 * `planRepo` + `planAuditAdapter` + live Neon, so they cover the
 * full path including the Drizzle → JSONB serialization boundary.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { auditPayloadSchema } from '@/modules/plans/domain/audit-event';
import { planRepo } from '@/modules/plans/infrastructure/db/plan-repo';
import { planAuditAdapter } from '@/modules/plans/infrastructure/audit/plan-audit-adapter';
import { asPlanYear } from '@/modules/plans/domain/plan';
import { createPlan } from '@/modules/plans/application/create-plan';
import { clonePlansToYear } from '@/modules/plans/application/clone-plans-to-year';
import { stubMemberAttachmentChecker } from '@/modules/plans/infrastructure/members/stub-member-attachment-checker';
import { db } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import type { PlanSchemaInput } from '@/modules/plans/domain/plan-validators';
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

function buildInput(planId: string, year: number): PlanSchemaInput {
  return {
    plan_id: planId,
    plan_year: year,
    plan_name: { en: `Plan ${planId}` },
    description: { en: '' },
    sort_order: 10,
    plan_category: 'corporate',
    member_type_scope: 'company',
    annual_fee_minor_units: 1_000_000,
    includes_corporate_plan_id: null,
    min_turnover_minor_units: null,
    max_turnover_minor_units: null,
    max_duration_years: null,
    max_member_age: null,
    benefit_matrix: MATRIX,
  };
}

const systemClock = {
  now: () => new Date(),
  currentYear: () => new Date().getUTCFullYear(),
};

describe('Integration: audit-diff round-trip for create + clone (T096)', () => {
  let tenant: TestTenant;

  afterEach(async () => {
    if (tenant) {
      await tenant.cleanup().catch(() => {});
    }
  });

  it('plan_created audit payload round-trips through auditPayloadSchema', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    const result = await createPlan(
      {
        input: buildInput('premium', 2027),
        actorUserId: user.userId,
        requestId: 'req-create-1',
        sourceIp: '203.0.113.5',
        idempotencyKey: 'idem-create-1',
      },
      {
        tenant: tenant.ctx,
        planRepo,
        audit: planAuditAdapter,
        clock: systemClock,
        members: stubMemberAttachmentChecker,
      },
    );
    expect(result.ok).toBe(true);

    // Fetch the latest audit row for this tenant
    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'plan_created'),
        ),
      )
      .orderBy(desc(auditLog.timestamp))
      .limit(1);

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    const parsed = auditPayloadSchema.safeParse({
      event_type: row.eventType,
      payload: row.payload,
    });
    expect(parsed.success).toBe(true);
  });

  it('plan_cloned audit payload round-trips through auditPayloadSchema', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    // Seed 3 source-year plans
    for (let i = 0; i < 3; i++) {
      await createPlan(
        {
          input: buildInput(`source-${i}`, 2026),
          actorUserId: user.userId,
          requestId: `req-seed-${i}`,
          sourceIp: '203.0.113.5',
          idempotencyKey: `idem-seed-${i}`,
        },
        {
          tenant: tenant.ctx,
          planRepo,
          audit: planAuditAdapter,
          clock: systemClock,
          members: stubMemberAttachmentChecker,
        },
      );
    }

    const result = await clonePlansToYear(
      {
        sourceYear: asPlanYear(2026),
        targetYear: asPlanYear(2027),
        activateCloned: false,
        actorUserId: user.userId,
        requestId: 'req-clone-1',
        sourceIp: '203.0.113.5',
        idempotencyKey: 'idem-clone-1',
      },
      {
        tenant: tenant.ctx,
        planRepo,
        audit: planAuditAdapter,
        clock: systemClock,
        members: stubMemberAttachmentChecker,
      },
    );
    expect(result.ok).toBe(true);

    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'plan_cloned'),
        ),
      )
      .orderBy(desc(auditLog.timestamp))
      .limit(1);

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    const parsed = auditPayloadSchema.safeParse({
      event_type: row.eventType,
      payload: row.payload,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.event_type === 'plan_cloned') {
      expect(parsed.data.payload.count).toBe(3);
      expect(parsed.data.payload.source_year).toBe(2026);
      expect(parsed.data.payload.target_year).toBe(2027);
      expect(parsed.data.payload.plan_ids).toHaveLength(3);
    }
  });
});
