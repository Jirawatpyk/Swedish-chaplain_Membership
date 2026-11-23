/**
 * PR B — live Neon: `updateRenewalReplyTo` writes
 * `tenant_renewal_settings.reply_to_*` and one `renewal_reply_to_updated`
 * audit row in the same transaction, only when something changed, and the
 * audit payload carries the address's domain, never the address.
 *
 * Cross-tenant (Principle I): tenant A's save never changes tenant B's row or
 * writes an audit row under B. Rollback: an audit emit that throws leaves the
 * settings row as it was.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { tenantRenewalSettings } from '@/modules/renewals/infrastructure/schema-tenant-renewal-config';
import { loadRenewalReplyTo, makeRenewalsDeps, updateRenewalReplyTo } from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';

const A_EMAIL = 'membership@tenant-a.example.invalid';
const B_EMAIL = 'renewals@tenant-b.example.invalid';

async function auditRows(t: TestTenant) {
  return db
    .select({ payload: auditLog.payload, actorUserId: auditLog.actorUserId })
    .from(auditLog)
    .where(and(eq(auditLog.tenantId, t.ctx.slug), eq(auditLog.eventType, 'renewal_reply_to_updated')))
    .orderBy(auditLog.timestamp);
}

async function storedReplyTo(t: TestTenant) {
  const rows = await runInTenant(t.ctx, (tx) =>
    tx
      .select({ email: tenantRenewalSettings.replyToEmail, name: tenantRenewalSettings.replyToDisplayName })
      .from(tenantRenewalSettings)
      .where(eq(tenantRenewalSettings.tenantId, t.ctx.slug)),
  );
  return rows[0] ?? null;
}

describe('updateRenewalReplyTo (live Neon)', () => {
  let user: TestUser;
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  function input(t: TestTenant, email: string | null, displayName: string | null) {
    return {
      tenantId: t.ctx.slug,
      email,
      displayName,
      actorUserId: user.userId,
      actorRole: 'admin' as const,
      correlationId: `it-reply-to-${t.ctx.slug}`,
    };
  }

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
    tenantB = await createTestTenant('test-chamber');
    await seedRenewalPolicies(tenantA.ctx);
    await seedRenewalPolicies(tenantB.ctx);
    const r = await updateRenewalReplyTo(makeRenewalsDeps(tenantB.ctx.slug), input(tenantB, B_EMAIL, 'Chamber B'));
    expect(r.ok).toBe(true);
  }, 180_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      if (!t) continue;
      await db.delete(auditLog).where(eq(auditLog.tenantId, t.ctx.slug)).catch(() => {});
      await t.cleanup().catch(() => {});
    }
  }, 120_000);

  it('set → changed → cleared writes the row and one audit row each, with the domain only', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);

    expect(await updateRenewalReplyTo(deps, input(tenantA, A_EMAIL, 'Chamber A'))).toMatchObject({
      ok: true,
      value: { changed: true },
    });
    expect(await storedReplyTo(tenantA)).toEqual({ email: A_EMAIL, name: 'Chamber A' });

    // The same values again: no write, no audit row.
    expect(await updateRenewalReplyTo(deps, input(tenantA, A_EMAIL, 'Chamber A'))).toMatchObject({
      ok: true,
      value: { changed: false },
    });

    await updateRenewalReplyTo(deps, input(tenantA, 'renewals@other-a.example.invalid', null));
    await updateRenewalReplyTo(deps, input(tenantA, null, null));
    expect(await storedReplyTo(tenantA)).toEqual({ email: null, name: null });
    expect(await loadRenewalReplyTo(deps, tenantA.ctx.slug)).toEqual({
      ok: true,
      value: { email: null, displayName: null },
    });

    const rows = await auditRows(tenantA);
    expect(rows.map((r) => (r.payload as { change: string }).change)).toEqual(['set', 'changed', 'cleared']);
    expect(rows[0]?.payload).toMatchObject({
      change: 'set',
      email_set: true,
      email_domain: 'tenant-a.example.invalid',
      display_name_set: true,
    });
    expect(rows.every((r) => r.actorUserId === user.userId)).toBe(true);
    expect(JSON.stringify(rows.map((r) => r.payload))).not.toContain('@');

    const retention = await db.execute<{ retention_years: number }>(
      sql`SELECT retention_years FROM audit_log WHERE tenant_id = ${tenantA.ctx.slug} AND event_type = 'renewal_reply_to_updated'`,
    );
    expect([...retention].every((r) => Number(r.retention_years) === 5)).toBe(true);
  }, 120_000);

  it("tenant A's saves never change tenant B's row or write audit rows under B", async () => {
    expect(await storedReplyTo(tenantB)).toEqual({ email: B_EMAIL, name: 'Chamber B' });
    const rows = await auditRows(tenantB);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ change: 'set', email_domain: 'tenant-b.example.invalid' });
  }, 60_000);

  it('an audit emit that throws rolls the settings write back', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const spy = vi.spyOn(deps.auditEmitter, 'emitInTx').mockRejectedValueOnce(new Error('simulated audit failure'));
    const r = await updateRenewalReplyTo(deps, input(tenantA, 'rollback@tenant-a.example.invalid', null));
    expect(r).toMatchObject({ ok: false, error: { kind: 'server_error' } });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await storedReplyTo(tenantA)).toEqual({ email: null, name: null });
    expect((await auditRows(tenantA)).map((r) => (r.payload as { change: string }).change)).toEqual([
      'set',
      'changed',
      'cleared',
    ]);
  }, 60_000);
});
