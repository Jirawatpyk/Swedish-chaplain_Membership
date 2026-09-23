/**
 * F119 T105 — the test copy's `broadcast_test_copy_sent` audit row EXISTS on
 * live Neon.
 *
 * `sendTestCopy` changes no state, so it emits with a NULL tx: the F7 audit
 * adapter then writes through the pool-global `db` with no
 * `app.current_tenant` GUC into an RLS + FORCE table, and swallows its own
 * failures by design. Every layer above the database can therefore look
 * correct while nothing is written — a unit test cannot tell. This is the
 * one place the row is asserted against the real database (the same class
 * was verified empirically for 107/money Task 3; a NEW null-tx emit gets its
 * own proof). The recipient address must not appear anywhere in the row.
 */
import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ok } from '@/lib/result';
import { db } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { f7AuditAdapter } from '@/modules/broadcasts/infrastructure/audit-adapter';
import { sendTestCopy } from '@/modules/broadcasts/application/use-cases/send-test-copy';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

describe('sendTestCopy — the null-tx audit row lands on live Neon', () => {
  let tenant: TestTenant;
  const requestId = `test-copy-audit-${randomUUID()}`;

  beforeAll(async () => {
    tenant = await createTestTenant('test');
  });

  afterAll(async () => {
    // `audit_log` is append-only (DELETE denied by trigger, security.md T-13);
    // the probe row stays under the throwaway tenant slug like every other
    // integration suite's audit rows.
    await tenant.cleanup();
  });

  it('writes exactly one broadcast_test_copy_sent row with related_member_id, a recipient hash and no address', async () => {
    const r = await sendTestCopy(
      {
        sanitizer: { sanitize: (h) => h },
        brand: { load: async () => ({ primaryColor: null, postalAddress: null, logoUrl: null }) },
        renderer: { render: (i) => `<!doctype html>${i.bodyHtml}` },
        mailer: { send: async () => ok({ messageId: 'fake-msg' }) },
        audit: f7AuditAdapter,
      },
      {
        tenantId: tenant.ctx.slug as never,
        tenantDisplayName: 'Audit Row Chamber',
        actorUserId: randomUUID(),
        actorRole: 'member',
        actorEmail: 'audit-row-probe@example.org',
        relatedMemberId: '33333333-3333-3333-3333-333333333333',
        broadcastId: null,
        versionId: null,
        requestId,
        subject: 'Audit row',
        bodyHtml: '<p>probe</p>',
        locale: 'en',
      },
    );
    expect(r.ok).toBe(true);

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenant.ctx.slug), eq(auditLog.requestId, requestId)))
      .orderBy(desc(auditLog.timestamp));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.eventType).toBe('broadcast_test_copy_sent');
    const payload = row.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      related_member_id: '33333333-3333-3333-3333-333333333333',
      broadcast_id: null,
      version_id: null,
      actor_role: 'member',
      locale: 'en',
    });
    expect(payload).not.toHaveProperty('member_id');
    expect(typeof payload.recipient_hash).toBe('string');
    expect(JSON.stringify(row)).not.toContain('audit-row-probe@example.org');
  });
});
