/**
 * 126 (#1 + #3) — bulk `change_plan` is removed.
 *
 * The arm was a second, weaker copy of `changePlan`: it accepted a
 * soft-deleted plan (`getPlan` returns them), took no soft-delete advisory
 * lock, and skipped every policy gate, the `member_plan_manually_changed`
 * audit and the F8 listeners. It was also unreachable in practice — its
 * schema demanded a UUID `new_plan_id` while plan ids are slugs, and the
 * admin UI dropped the button (bulk-action-bar.tsx, I9 round-10). Deleting
 * it closes both findings; a future bulk plan change must go through the
 * single `changePlan` rules.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const runInTenantMock = vi.fn();
vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: (...a: unknown[]) => runInTenantMock(...a),
}));

import { bulkAction, type BulkActionDeps } from '@/modules/members/application/use-cases/bulk-action';
import { asTenantContext } from '@/modules/tenants';

describe('bulkAction — change_plan is no longer a bulk action (126)', () => {
  it('rejects action change_plan as invalid_body without opening a tx', async () => {
    const r = await bulkAction(
      {
        action: 'change_plan',
        member_ids: ['11111111-1111-4111-8111-111111111111'],
        params: {
          new_plan_id: '22222222-2222-4222-8222-222222222222',
          new_plan_year: 2026,
        },
      },
      { actorUserId: 'admin-1', requestId: 'req-126' },
      { tenant: asTenantContext('test-tenant') } as unknown as BulkActionDeps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.type).toBe('invalid_body');
    expect(runInTenantMock).not.toHaveBeenCalled();
  });
});
