/**
 * T028 (US1) — `dismissInsight` guard-branch unit tests.
 *
 * Covers the branches that short-circuit BEFORE `runInTenant` (no DB):
 *   - member role → forbidden (insights are staff-only, FR-007a)
 *   - unknown insight key → invalid_insight_key
 * The happy path (repo write + audit emit, incl. idempotent replay) is covered
 * by the live-Neon integration test. Together they give 100% branch coverage
 * on this security-relevant use-case (plan Constitution II).
 */
import { describe, expect, it, vi } from 'vitest';
import { asTenantContext } from '@/modules/tenants';
import {
  dismissInsight,
  type DismissInsightDeps,
  type DismissInsightMeta,
} from '@/modules/insights/application/use-cases/dismiss-insight';

const ctx = asTenantContext('test-tenant');

function stubDeps(): DismissInsightDeps {
  return {
    dismissalRepo: { dismissInTx: vi.fn(), isDismissedInTx: vi.fn() },
    audit: { recordInTx: vi.fn(), record: vi.fn() },
    clock: { now: () => new Date('2026-06-15T05:00:00Z') },
    tenantTimezone: 'Asia/Bangkok',
  };
}

const adminMeta: DismissInsightMeta = {
  actorUserId: 'u-1',
  actorRole: 'admin',
  requestId: 'req-1',
};

describe('dismissInsight — guard branches', () => {
  it('rejects a member (insights are staff-only) without touching the repo/audit', async () => {
    const deps = stubDeps();
    const result = await dismissInsight(
      { insightKey: 'unused_eblast_quota' },
      { ...adminMeta, actorRole: 'member' },
      ctx,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('forbidden');
    expect(deps.dismissalRepo.dismissInTx).not.toHaveBeenCalled();
    expect(deps.audit.recordInTx).not.toHaveBeenCalled();
  });

  it('rejects an unknown insight key with invalid_insight_key', async () => {
    const deps = stubDeps();
    const result = await dismissInsight(
      { insightKey: 'totally_made_up' },
      adminMeta,
      ctx,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid_insight_key');
    expect(deps.dismissalRepo.dismissInTx).not.toHaveBeenCalled();
  });
});
