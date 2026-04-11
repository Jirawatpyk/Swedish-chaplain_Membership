/**
 * T142 — Integration: audit-diff round-trip for `fee_config_updated`
 * (SC-007, critique P9).
 *
 * Mirrors T126a (US4 state mutations) but for the US5 event. Calls the
 * real `updateFeeConfig` use case, reads the latest `audit_log` row,
 * runs it through `auditPayloadSchema.safeParse`, and asserts the diff
 * shape:
 *
 *   fee_config_updated: { diff: {
 *     vat_rate: { before: 0.07, after: 0.075 },
 *     registration_fee_minor_units: { before: 100_000, after: 200_000 },
 *   } }
 */
import { afterEach, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { auditPayloadSchema } from '@/modules/plans/domain/audit-event';
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

describe('Integration: fee_config_updated audit-diff round-trip (T142)', () => {
  let tenant: TestTenant;

  afterEach(async () => {
    if (tenant) await tenant.cleanup().catch(() => {});
  });

  it('payload round-trips through auditPayloadSchema with expected diff', async () => {
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
        patch: { vat_rate: 0.075, registration_fee_minor_units: 200_000 },
        actorUserId: user.userId,
        requestId: 'req-fee-audit',
        sourceIp: null,
        idempotencyKey: 'idem-fee-audit',
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
    expect(rows[0]).toBeDefined();

    const parsed = auditPayloadSchema.safeParse({
      event_type: rows[0]!.eventType,
      payload: rows[0]!.payload,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.event_type === 'fee_config_updated') {
      expect(parsed.data.payload.diff.vat_rate).toEqual({
        before: 0.07,
        after: 0.075,
      });
      expect(parsed.data.payload.diff.registration_fee_minor_units).toEqual({
        before: 100_000,
        after: 200_000,
      });
    }
  });
});
