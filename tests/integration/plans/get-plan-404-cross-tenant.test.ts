/**
 * T066 — Integration test: cross-tenant get returns 404 not 403 (US1, critique E6).
 *
 * Seeds a plan in Tenant B, then probes it from Tenant A's runInTenant
 * context. The repo returns `undefined` (because RLS filters it out);
 * the `get-plan` use case maps that to a `not_found` error; the test
 * asserts that the value is indistinguishable from "plan never existed".
 *
 * Also asserts that a matching `plan_not_found` audit event is written
 * into audit_log.payload with the exact shape from data-model.md § 2.6a.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { getPlan } from '@/modules/plans/application/get-plan';
import { planRepo } from '@/modules/plans/infrastructure/db/plan-repo';
import { planAuditAdapter } from '@/modules/plans/infrastructure/audit/plan-audit-adapter';
import { asPlanSlug, asPlanYear } from '@/modules/plans/domain/plan';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import type { PlanDraftInput } from '@/modules/plans/application/ports';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

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

function draft(planId: string, user: string): PlanDraftInput {
  return {
    plan_id: planId,
    plan_year: 2026,
    plan_name: { en: planId },
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
    isActive: true,
    createdBy: user,
    updatedBy: user,
  } as PlanDraftInput;
}

describe('Integration: get-plan 404 cross-tenant probe (T066)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    // Seed a plan in Tenant B only
    await planRepo.insert(tenantB.ctx, draft('secret-plan', user.userId));
  });

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  });

  it('getPlan from Tenant A context returns not_found (not forbidden)', async () => {
    const result = await getPlan(
      { planId: asPlanSlug('secret-plan'), year: asPlanYear(2026) },
      {
        tenant: tenantA.ctx,
        planRepo,
        audit: planAuditAdapter,
        actorUserId: user.userId,
        requestId: 'test-cross-tenant-1',
        sourceIp: '127.0.0.1',
        method: 'GET',
        route: '/api/plans/2026/secret-plan',
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('not_found');
    }
  });

  it('appends plan_not_found audit event with the expected payload shape', async () => {
    await getPlan(
      { planId: asPlanSlug('another-ghost'), year: asPlanYear(2026) },
      {
        tenant: tenantA.ctx,
        planRepo,
        audit: planAuditAdapter,
        actorUserId: user.userId,
        requestId: 'test-cross-tenant-audit',
        sourceIp: '127.0.0.1',
        method: 'GET',
        route: '/api/plans/2026/another-ghost',
      },
    );

    // Read from tenantA's context — we wrote the audit event scoped to A
    const rows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.requestId, 'test-cross-tenant-audit')),
    );
    expect(rows.length).toBeGreaterThan(0);
    const entry = rows.find((r) => r.eventType === 'plan_not_found');
    expect(entry).toBeDefined();
    const payload = entry!.payload as {
      requested_plan_id: string;
      requested_year: number;
      method: string;
      route: string;
    } | null;
    expect(payload).toBeDefined();
    expect(payload!.requested_plan_id).toBe('another-ghost');
    expect(payload!.requested_year).toBe(2026);
    expect(payload!.method).toBe('GET');
    expect(payload!.route).toBe('/api/plans/2026/another-ghost');
  });

  it('Tenant B can still see its own plan (control)', async () => {
    const result = await getPlan(
      { planId: asPlanSlug('secret-plan'), year: asPlanYear(2026) },
      {
        tenant: tenantB.ctx,
        planRepo,
        audit: planAuditAdapter,
        actorUserId: user.userId,
        requestId: 'test-control',
        sourceIp: '127.0.0.1',
        method: 'GET',
        route: '/api/plans/2026/secret-plan',
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.plan_id).toBe('secret-plan');
    }
  });
});
