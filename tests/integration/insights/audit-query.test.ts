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
import { auditQuery, auditExport, makeAuditQueryDeps } from '@/modules/insights';
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

  it('FR-012 (staff-review R010): auditExport writes an audit_log_exported row (live Neon)', async () => {
    const exporter = randomUUID();
    const res = await auditExport(
      { eventType: ['role_changed'], limit: 100 },
      { actorUserId: exporter, actorRole: 'admin', requestId: `aq-exp-${randomUUID()}` },
      tenantA.ctx,
      makeAuditQueryDeps(),
    );
    expect(res.ok).toBe(true);
    // The export ACTION itself must be audited (FR-012) — verify the real
    // audit port wrote the row to live Neon (the contract test mocks it).
    const rows = await runInTenant(tenantA.ctx, async (tx) =>
      tx.execute(sql`
        SELECT 1 FROM audit_log
        WHERE tenant_id = ${tenantA.ctx.slug}
          AND event_type = 'audit_log_exported'
          AND actor_user_id = ${exporter}
        LIMIT 1
      `),
    );
    expect(rows.length).toBe(1);
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

  it('FR-009 (Round 2 #14): a row in the final µs of the day survives the `to` bound', async () => {
    // Insert a row at .999500Z via raw SQL — a JS Date is ms-only and cannot
    // represent sub-ms. Before the #14 fix the `to` bound was funnelled through
    // `new Date(...)`, truncating .999999Z → .999Z, so this .999500 row
    // (.999500 > .999000) was wrongly EXCLUDED. With the µs string cast to
    // `::timestamptz` it is correctly included.
    const microActor = randomUUID();
    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.execute(sql`
        INSERT INTO audit_log (tenant_id, event_type, actor_user_id, summary, request_id, timestamp, payload)
        VALUES (${tenantA.ctx.slug}, 'role_changed', ${microActor}, 'micro-boundary row',
                ${`aq-micro-${randomUUID()}`}, '2031-03-15T23:59:59.999500Z'::timestamptz, '{}'::jsonb)
      `);
    });

    // µs-precise day-end `to` (the .999999 cap tenantDayEndUtc produces): INCLUDED.
    const included = await auditQuery(
      { actorUserId: microActor, from: '2031-03-15T00:00:00.000Z', to: '2031-03-15T23:59:59.999999Z', limit: 10 },
      meta('admin'),
      tenantA.ctx,
      makeAuditQueryDeps(),
    );
    expect(included.ok).toBe(true);
    if (included.ok) {
      expect(included.value.rows.some((r) => r.summary === 'micro-boundary row')).toBe(true);
    }

    // A `to` bound BELOW the row's µs (.999000) correctly EXCLUDES it — proving
    // the boundary discriminates at microsecond precision, not millisecond.
    const excluded = await auditQuery(
      { actorUserId: microActor, from: '2031-03-15T00:00:00.000Z', to: '2031-03-15T23:59:59.999000Z', limit: 10 },
      meta('admin'),
      tenantA.ctx,
      makeAuditQueryDeps(),
    );
    expect(excluded.ok).toBe(true);
    if (excluded.ok) {
      expect(excluded.value.rows.some((r) => r.summary === 'micro-boundary row')).toBe(false);
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

      // Bidirectional: from page 2 (older), the backward (gt + ASC) keyset via
      // prevCursor must recover the NEWER same-ms row — proving Previous pages
      // honour the same µs-precision keyset, not just forward ones.
      expect(page2.value.prevCursor).not.toBeNull();
      const back = await auditQuery(
        {
          actorUserId: sameMsActor,
          limit: 1,
          cursor: page2.value.prevCursor!,
          direction: 'backward',
        },
        meta('admin'),
        tenantA.ctx,
        makeAuditQueryDeps(),
      );
      expect(back.ok).toBe(true);
      if (back.ok) {
        // Exact (limit 1) — the backward page is precisely the newer row, not
        // just "contains" it.
        expect(back.value.rows.map((r) => r.summary)).toEqual(['same-ms newer']);
      }
    }
  });

  it('keyset tie-breaks on id when two rows share the EXACT same µs timestamp (forward + backward id arm)', async () => {
    // The most fragile keyset arm is `(ts = c AND id </> c.id)` — only reached
    // when two rows share the exact µs timestamp. Insert two with explicit,
    // ordered UUIDs at one instant and page across the tie in both directions.
    const tieActor = randomUUID();
    const idLow = 'aaaaaaaa-0000-4000-8000-000000000001';
    const idHigh = 'bbbbbbbb-0000-4000-8000-000000000002';
    const ts = '2031-02-02 00:00:00.777777+00';
    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.execute(sql`
        INSERT INTO audit_log (id, event_type, actor_user_id, summary, request_id, tenant_id, timestamp)
        VALUES
          (${idLow}::uuid, 'sign_in_success', ${tieActor}, 'tie low', ${'tl-' + randomUUID()}, ${tenantA.ctx.slug}, ${ts}::timestamptz),
          (${idHigh}::uuid, 'sign_in_success', ${tieActor}, 'tie high', ${'th-' + randomUUID()}, ${tenantA.ctx.slug}, ${ts}::timestamptz)
      `);
    });

    // Forward page 1 (DESC → higher id first).
    const p1 = await auditQuery({ actorUserId: tieActor, limit: 1 }, meta('admin'), tenantA.ctx, makeAuditQueryDeps());
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;
    expect(p1.value.rows.map((r) => r.summary)).toEqual(['tie high']);

    // Forward page 2 (id < cursor.id → lower id) — the forward id arm.
    const p2 = await auditQuery(
      { actorUserId: tieActor, limit: 1, cursor: p1.value.nextCursor! },
      meta('admin'),
      tenantA.ctx,
      makeAuditQueryDeps(),
    );
    expect(p2.ok).toBe(true);
    if (!p2.ok) return;
    expect(p2.value.rows.map((r) => r.summary)).toEqual(['tie low']);

    // Backward from page 2 (id > cursor.id → higher id) — the backward id arm.
    const back = await auditQuery(
      { actorUserId: tieActor, limit: 1, cursor: p2.value.prevCursor!, direction: 'backward' },
      meta('admin'),
      tenantA.ctx,
      makeAuditQueryDeps(),
    );
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.value.rows.map((r) => r.summary)).toEqual(['tie high']);
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
