/**
 * `resendEmailPort.enqueueManyInTx` on live Neon: one multi-row INSERT into
 * `notifications_outbox` inside the caller's tenant transaction (the
 * change-request staff fan-out, R81). Same row shape as `enqueueInTx`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { notificationsOutbox } from '@/modules/auth/infrastructure/db/schema';
import { resendEmailPort } from '@/modules/members/infrastructure/adapters/resend-email-port';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

describe('integration: EmailPort.enqueueManyInTx', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
  });
  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('inserts every request in one call, in the tenant, with the enqueueInTx row shape', async () => {
    const requests = ['Reviewer.One@Swecham.Test', 'reviewer.two@swecham.test', 'REVIEWER.THREE@swecham.test'].map((toEmail, i) => ({
      type: 'member_change_request_submitted_staff' as const,
      toEmail,
      locale: 'en' as const,
      contextData: { requestId: `r-${i}`, fieldKeys: ['phone'] },
    }));
    const result = await runInTenant(tenant.ctx, (tx) => resendEmailPort.enqueueManyInTx(tx, tenant.ctx, requests));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outboxRowIds).toHaveLength(3);

    const rows = await db
      .select()
      .from(notificationsOutbox)
      .where(inArray(notificationsOutbox.id, [...result.value.outboxRowIds]));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.tenantId).toBe(tenant.ctx.slug);
      expect(row.notificationType).toBe('member_change_request_submitted_staff');
      expect(row.status).toBe('pending');
      expect(row.toEmail).toBe(row.toEmail.toLowerCase());
    }
    expect(rows.map((r) => r.toEmail).sort()).toEqual(['reviewer.one@swecham.test', 'reviewer.three@swecham.test', 'reviewer.two@swecham.test']);
  });

  it('an empty list is a no-op that returns no ids', async () => {
    const result = await runInTenant(tenant.ctx, (tx) => resendEmailPort.enqueueManyInTx(tx, tenant.ctx, []));
    expect(result).toEqual({ ok: true, value: { outboxRowIds: [] } });
  });
});
