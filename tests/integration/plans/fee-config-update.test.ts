/**
 * T140 — Integration: `update-fee-config` end-to-end against live Neon.
 *
 * Scope:
 *   - admin PATCHes vat_rate + registration_fee_minor_units → repo
 *     persists new values + audit row `fee_config_updated` is appended
 *     with the expected diff shape
 *   - manager-role routing is covered at the HTTP layer (contract
 *     test T138) — this test runs the Application use case directly,
 *     so the read-only enforcement is verified via the route handler
 *     in the matching E2E spec (T143)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { feeConfigRepo } from '@/modules/plans/infrastructure/db/fee-config-repo';
import { planRepo } from '@/modules/plans/infrastructure/db/plan-repo';
import { planAuditAdapter } from '@/modules/plans/infrastructure/audit/plan-audit-adapter';
import { stubMemberAttachmentChecker } from '@/modules/plans/infrastructure/members/stub-member-attachment-checker';
import { updateFeeConfig } from '@/modules/plans/application/update-fee-config';
import { db } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import type { ClockPort } from '@/modules/plans/application/ports';
import { createActiveTestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const clock: ClockPort = {
  now: () => new Date('2027-06-15T00:00:00Z'),
  currentYear: () => 2027,
};

function buildDeps(tenant: TestTenant) {
  return {
    tenant: tenant.ctx,
    planRepo,
    feeConfigRepo,
    audit: planAuditAdapter,
    clock,
    members: stubMemberAttachmentChecker,
  };
}

describe('Integration: update-fee-config vs live Neon (T140, US5)', () => {
  let tenant: TestTenant;

  afterEach(async () => {
    if (tenant) await tenant.cleanup().catch(() => {});
  });

  it('admin edits vat_rate + registration_fee — repo persists + audit event captures diff', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    // Seed initial fee config
    await feeConfigRepo.upsert(tenant.ctx, {
      currency_code: 'THB',
      vat_rate: 0.07,
      registration_fee_minor_units: 100_000,
      updated_by: user.userId,
    });

    const result = await updateFeeConfig(
      {
        patch: {
          vat_rate: 0.075,
          registration_fee_minor_units: 150_000,
        },
        actorUserId: user.userId,
        requestId: 'req-fee-update',
        sourceIp: null,
        idempotencyKey: 'idem-fee-update',
      },
      buildDeps(tenant),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.vat_rate).toBeCloseTo(0.075, 4);
    expect(result.value.registration_fee_minor_units).toBe(150_000);
    expect(result.value.currency_code).toBe('THB');

    // Verify repo actually persisted
    const fresh = await feeConfigRepo.findByTenant(tenant.ctx);
    expect(fresh).toBeDefined();
    expect(fresh!.vat_rate).toBeCloseTo(0.075, 4);
    expect(fresh!.registration_fee_minor_units).toBe(150_000);

    // Verify audit row
    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'fee_config_updated'),
        ),
      )
      .orderBy(desc(auditLog.timestamp))
      .limit(1);
    expect(rows[0]).toBeDefined();
    const payload = rows[0]!.payload as {
      diff: Record<string, { before: unknown; after: unknown }>;
    };
    expect(payload.diff.vat_rate).toEqual({ before: 0.07, after: 0.075 });
    expect(payload.diff.registration_fee_minor_units).toEqual({
      before: 100_000,
      after: 150_000,
    });
  });

  it('patch with only vat_rate — diff contains only the changed field', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await feeConfigRepo.upsert(tenant.ctx, {
      currency_code: 'THB',
      vat_rate: 0.07,
      registration_fee_minor_units: 100_000,
      updated_by: user.userId,
    });

    const result = await updateFeeConfig(
      {
        patch: { vat_rate: 0.08 },
        actorUserId: user.userId,
        requestId: 'req-fee-update-partial',
        sourceIp: null,
        idempotencyKey: 'idem-fee-update-partial',
      },
      buildDeps(tenant),
    );
    expect(result.ok).toBe(true);

    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'fee_config_updated'),
        ),
      )
      .orderBy(desc(auditLog.timestamp))
      .limit(1);
    const payload = rows[0]!.payload as {
      diff: Record<string, { before: unknown; after: unknown }>;
    };
    expect(payload.diff.vat_rate).toEqual({ before: 0.07, after: 0.08 });
    expect(payload.diff.registration_fee_minor_units).toBeUndefined();
  });
});
