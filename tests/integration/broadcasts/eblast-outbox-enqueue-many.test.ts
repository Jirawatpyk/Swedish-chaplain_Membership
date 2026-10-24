/**
 * `eblastNotificationOutbox.enqueueManyInTx` on live Neon: one multi-row
 * INSERT into `notifications_outbox` on the caller's tenant transaction (the
 * E-Blast marketing hand-off, R81 class). Every row has the shape
 * `enqueueInTx` writes, and `context_data` is a jsonb OBJECT, not a string.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { notificationsOutbox } from '@/modules/auth/infrastructure/db/schema';
import { eblastNotificationOutbox } from '@/modules/broadcasts/infrastructure/email-transactional-bridge';
import type { EblastNotificationEnqueue } from '@/modules/broadcasts/application/ports/eblast-notification-outbox-port';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const BROADCAST_ID = '6b0f3c1e-5d2a-4e8b-9c7d-0a1b2c3d4e5f';

describe('integration: EblastNotificationOutboxPort.enqueueManyInTx', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
  });
  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  const request = (i: number): EblastNotificationEnqueue => ({
    type: 'eblast_submitted_marketing',
    toEmail: `marketing${i}@swecham.test`,
    locale: i === 0 ? 'th' : 'en',
    contextData: { tenantId: tenant.ctx.slug, broadcastId: BROADCAST_ID, recipientUserId: `u-${i}` },
  });

  const rowsOf = () =>
    db
      .select({
        toEmail: notificationsOutbox.toEmail,
        locale: notificationsOutbox.locale,
        status: notificationsOutbox.status,
        attempts: notificationsOutbox.attempts,
        contextData: notificationsOutbox.contextData,
        contextType: sql<string>`jsonb_typeof(${notificationsOutbox.contextData})`,
      })
      .from(notificationsOutbox)
      .where(and(eq(notificationsOutbox.tenantId, tenant.ctx.slug), eq(notificationsOutbox.notificationType, 'eblast_submitted_marketing')));

  it('inserts every request in one call, in the tenant, with the enqueueInTx row shape', async () => {
    await runInTenant(tenant.ctx, (tx) => eblastNotificationOutbox.enqueueInTx(tx, tenant.ctx, request(9)));
    await runInTenant(tenant.ctx, (tx) => eblastNotificationOutbox.enqueueManyInTx(tx, tenant.ctx, [0, 1, 2].map(request)));

    const rows = await rowsOf();
    expect(rows).toHaveLength(4);
    const single = rows.find((r) => r.toEmail === 'marketing9@swecham.test')!;
    for (const row of rows) {
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(0);
      expect(row.contextType).toBe('object');
      expect({ status: row.status, attempts: row.attempts, contextType: row.contextType }).toEqual({
        status: single.status,
        attempts: single.attempts,
        contextType: single.contextType,
      });
    }
    const batched = rows.filter((r) => r !== single).sort((a, b) => a.toEmail.localeCompare(b.toEmail));
    expect(batched.map((r) => [r.toEmail, r.locale])).toEqual([
      ['marketing0@swecham.test', 'th'],
      ['marketing1@swecham.test', 'en'],
      ['marketing2@swecham.test', 'en'],
    ]);
    expect(batched[1]!.contextData).toEqual({ tenantId: tenant.ctx.slug, broadcastId: BROADCAST_ID, recipientUserId: 'u-1' });
  });

  it('a failure later in the same tx rolls the whole batch back (SC-004)', async () => {
    const before = (await rowsOf()).length;
    await expect(
      runInTenant(tenant.ctx, async (tx) => {
        await eblastNotificationOutbox.enqueueManyInTx(tx, tenant.ctx, [3, 4].map(request));
        throw new Error('fault after the batch');
      }),
    ).rejects.toThrow('fault after the batch');
    expect(await rowsOf()).toHaveLength(before);
  });
});
