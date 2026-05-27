/**
 * F9 US2 (T040) — `auditQuery` integration test (live Neon).
 *
 * Seeds audit rows across two tenants and asserts: tenant scoping (RLS — A never
 * sees B), newest-first keyset order, event-type filtering, per-role payload
 * redaction (FR-011 — manager loses the sensitive `reason` field; admin keeps
 * it), actor identity visible to managers (FR-011), and the invalid-range guard.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { auditQuery, makeAuditQueryDeps } from '@/modules/insights';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

const meta = (role: 'admin' | 'manager' | 'member') => ({
  actorUserId: randomUUID(),
  actorRole: role,
  requestId: `audit-q-${randomUUID()}`,
});

describe('F9 auditQuery — integration (T040)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  const actorA = randomUUID();
  const targetA = randomUUID();

  beforeAll(async () => {
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    // 3 future-dated role_changed rows for A (oldest→newest) carrying a
    // sensitive `reason` payload field, + 1 for B. Future-dated so our seeds
    // sit above the shared DB's null-tenant / harness audit noise.
    await runInTenant(tenantA.ctx, async (tx) => {
      for (let i = 0; i < 3; i++) {
        await tx.insert(auditLog).values({
          tenantId: tenantA.ctx.slug,
          eventType: 'role_changed',
          actorUserId: actorA,
          targetUserId: randomUUID(),
          summary: `A role change ${i}`,
          requestId: `aq-A-${i}-${randomUUID()}`,
          timestamp: new Date(Date.UTC(2030, 0, 1, 0, i, 0)),
          payload: { from: 'member', to: 'manager', reason: `secret reason ${i}` },
        });
      }
      // One extra row with a known targetUserId for the target-filter test.
      await tx.insert(auditLog).values({
        tenantId: tenantA.ctx.slug,
        eventType: 'account_disabled',
        actorUserId: actorA,
        targetUserId: targetA,
        summary: 'A disabled a specific account',
        requestId: `aq-A-tgt-${randomUUID()}`,
        timestamp: new Date(Date.UTC(2030, 0, 1, 0, 30, 0)),
        payload: { reason: 'policy' },
      });
    });
    await runInTenant(tenantB.ctx, async (tx) => {
      await tx.insert(auditLog).values({
        tenantId: tenantB.ctx.slug,
        eventType: 'role_changed',
        actorUserId: randomUUID(),
        summary: 'B role change',
        requestId: `aq-B-${randomUUID()}`,
        timestamp: new Date(Date.UTC(2030, 0, 1, 0, 9, 0)),
        payload: { from: 'member', to: 'admin', reason: 'tenant B only' },
      });
    });
  }, 120_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  });

  it('scopes to the tenant (RLS) and returns newest-first', async () => {
    const res = await auditQuery(
      { eventType: ['role_changed'], limit: 100 },
      meta('admin'),
      tenantA.ctx,
      makeAuditQueryDeps(),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const summaries = res.value.rows.map((r) => r.summary);
      expect(summaries).not.toContain('B role change'); // RLS isolation
      expect(summaries.slice(0, 3)).toEqual([
        'A role change 2',
        'A role change 1',
        'A role change 0',
      ]);
    }
  });

  it('keeps the sensitive payload field for admin but strips it for manager (FR-011)', async () => {
    const adminRes = await auditQuery(
      { eventType: ['role_changed'], limit: 5 },
      meta('admin'),
      tenantA.ctx,
      makeAuditQueryDeps(),
    );
    const mgrRes = await auditQuery(
      { eventType: ['role_changed'], limit: 5 },
      meta('manager'),
      tenantA.ctx,
      makeAuditQueryDeps(),
    );
    expect(adminRes.ok && mgrRes.ok).toBe(true);
    if (adminRes.ok && mgrRes.ok) {
      expect(adminRes.value.rows[0]!.payload).toHaveProperty('reason');
      expect(mgrRes.value.rows[0]!.payload).not.toHaveProperty('reason');
      // Non-sensitive fields survive for the manager.
      expect(mgrRes.value.rows[0]!.payload).toHaveProperty('to');
      // FR-011 — actor identity is visible to the manager (not redacted).
      expect(mgrRes.value.rows[0]!.actorUserId).toBe(actorA);
    }
  });

  it('filters by acting user', async () => {
    const res = await auditQuery(
      { actorUserId: actorA, limit: 100 },
      meta('admin'),
      tenantA.ctx,
      makeAuditQueryDeps(),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.rows.length).toBeGreaterThanOrEqual(3);
      expect(res.value.rows.every((r) => r.actorUserId === actorA)).toBe(true);
    }
  });

  it('filters by target record (targetRef → target_user_id)', async () => {
    const res = await auditQuery(
      { targetRef: targetA, limit: 100 },
      meta('admin'),
      tenantA.ctx,
      makeAuditQueryDeps(),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.rows.length).toBeGreaterThanOrEqual(1);
      expect(res.value.rows.every((r) => r.targetUserId === targetA)).toBe(true);
      expect(res.value.rows.some((r) => r.summary === 'A disabled a specific account')).toBe(true);
    }
  });

  it('paginates without dropping same-millisecond rows (µs-precision keyset)', async () => {
    // Two rows at the SAME millisecond but different microseconds — a
    // ms-truncated cursor would skip the second on page 2 (review finding).
    // Two rows at the SAME millisecond (.500) but different microseconds,
    // inserted via raw SQL so the µs fraction is preserved (a Drizzle Date bind
    // would truncate to ms). Future-dated so they sort at the very top.
    const sameMsActor = randomUUID();
    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.execute(sql`
        INSERT INTO audit_log (event_type, actor_user_id, summary, request_id, tenant_id, timestamp)
        VALUES
          ('sign_in_success', ${sameMsActor}, 'same-ms newer', ${'ms-' + randomUUID()}, ${tenantA.ctx.slug}, TIMESTAMPTZ '2031-01-01 00:00:00.500456+00'),
          ('sign_in_success', ${sameMsActor}, 'same-ms older', ${'ms-' + randomUUID()}, ${tenantA.ctx.slug}, TIMESTAMPTZ '2031-01-01 00:00:00.500123+00')
      `);
    });
    const page1 = await auditQuery(
      { actorUserId: sameMsActor, limit: 1 },
      meta('admin'),
      tenantA.ctx,
      makeAuditQueryDeps(),
    );
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    expect(page1.value.rows[0]!.summary).toBe('same-ms newer');
    expect(page1.value.nextCursor).not.toBeNull();

    const page2 = await auditQuery(
      { actorUserId: sameMsActor, limit: 1, cursor: page1.value.nextCursor! },
      meta('admin'),
      tenantA.ctx,
      makeAuditQueryDeps(),
    );
    expect(page2.ok).toBe(true);
    if (page2.ok) {
      // The same-ms older row MUST appear on page 2 (not silently dropped).
      expect(page2.value.rows.map((r) => r.summary)).toContain('same-ms older');
    }
  });

  it('rejects an inverted date range', async () => {
    const res = await auditQuery(
      { from: '2030-02-01T00:00:00Z', to: '2030-01-01T00:00:00Z' },
      meta('admin'),
      tenantA.ctx,
      makeAuditQueryDeps(),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('invalid_range');
  });

  it('forbids members', async () => {
    const res = await auditQuery({}, meta('member'), tenantA.ctx, makeAuditQueryDeps());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('forbidden');
  });
});
