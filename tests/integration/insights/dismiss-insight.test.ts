/**
 * T028 (US1) — `dismissInsight` integration test (live Neon).
 *
 * Covers the write path: tenant-scoped dismissal row + atomic
 * `smart_insight_dismissed` audit, idempotent replay (1 row, 2 audits), and
 * manager-allowed (staff). Guard branches (member-forbidden / invalid key) are
 * unit-tested separately.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { dismissInsight, makeDismissInsightDeps } from '@/modules/insights';
import { smartInsightDismissals } from '@/modules/insights/infrastructure/db/schema-insights';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

describe('F9 dismissInsight — integration (T028)', () => {
  let tenant: TestTenant;
  let other: TestTenant;

  beforeAll(async () => {
    const pair = await createTwoTestTenants();
    tenant = pair.a;
    other = pair.b;
  }, 120_000);

  afterAll(async () => {
    const slugs = [tenant.ctx.slug, other.ctx.slug];
    await db.delete(smartInsightDismissals).where(inArray(smartInsightDismissals.tenantId, slugs));
    // audit_log is append-only (immutability trigger) — cannot DELETE; the
    // throwaway test-tenant audit rows are disposable (same as other suites).
    await tenant.cleanup().catch(() => {});
    await other.cleanup().catch(() => {});
  });

  it('admin dismisses an insight → 1 tenant-scoped row + smart_insight_dismissed audit', async () => {
    const actorUserId = randomUUID();
    const requestId = `dismiss-${randomUUID()}`;
    const result = await dismissInsight(
      { insightKey: 'unused_eblast_quota' },
      { actorUserId, actorRole: 'admin', requestId },
      tenant.ctx,
      makeDismissInsightDeps(tenant.ctx.slug),
    );
    expect(result.ok).toBe(true);

    const rows = await db
      .select()
      .from(smartInsightDismissals)
      .where(
        and(
          eq(smartInsightDismissals.tenantId, tenant.ctx.slug),
          eq(smartInsightDismissals.insightKey, 'unused_eblast_quota'),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.scopeRef).toBe('');
    expect(rows[0]?.dismissedBy).toBe(actorUserId);
    expect(rows[0]?.cycleKey).toMatch(/^\d{4}$/); // membership_year granularity

    const audit = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(audit).toHaveLength(1);
    expect(audit[0]?.eventType).toBe('smart_insight_dismissed');
    expect(audit[0]?.tenantId).toBe(tenant.ctx.slug);
  });

  it('a repeated dismiss in the same cycle is idempotent (1 row, 2 audits)', async () => {
    const requestId2 = `dismiss-replay-${randomUUID()}`;
    const result = await dismissInsight(
      { insightKey: 'unused_eblast_quota' },
      { actorUserId: randomUUID(), actorRole: 'admin', requestId: requestId2 },
      tenant.ctx,
      makeDismissInsightDeps(tenant.ctx.slug),
    );
    expect(result.ok).toBe(true);

    const rows = await db
      .select()
      .from(smartInsightDismissals)
      .where(
        and(
          eq(smartInsightDismissals.tenantId, tenant.ctx.slug),
          eq(smartInsightDismissals.insightKey, 'unused_eblast_quota'),
        ),
      );
    expect(rows).toHaveLength(1); // still ONE row (idempotent)

    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'smart_insight_dismissed'),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(2); // every dismiss emits an audit
  });

  it('manager (staff) may dismiss', async () => {
    const result = await dismissInsight(
      { insightKey: 'at_risk_followup' },
      { actorUserId: randomUUID(), actorRole: 'manager', requestId: `dismiss-mgr-${randomUUID()}` },
      tenant.ctx,
      makeDismissInsightDeps(tenant.ctx.slug),
    );
    expect(result.ok).toBe(true);
    const rows = await db
      .select()
      .from(smartInsightDismissals)
      .where(
        and(
          eq(smartInsightDismissals.tenantId, tenant.ctx.slug),
          eq(smartInsightDismissals.insightKey, 'at_risk_followup'),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cycleKey).toMatch(/^\d{4}-W\d{2}$/); // iso_week granularity
  });
});
