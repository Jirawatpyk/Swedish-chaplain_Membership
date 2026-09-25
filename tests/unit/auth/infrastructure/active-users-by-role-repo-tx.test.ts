/**
 * F119 T166 follow-up — `listActiveUserIdsWithRole` runs on the caller's tx
 * when one is given.
 *
 * The E-Blast send, the schedule confirmation and the day-30 expiry call it
 * (through `memberPortalRecipients`) INSIDE a transaction that holds the
 * broadcast row's `FOR UPDATE` lock. On the pool-global `db` it took a SECOND
 * pool connection while the first sat locked — ~10 concurrent calls starve the
 * pool (max 10), the R-L3 class. `users` has no `tenant_id` and no RLS, and
 * `chamber_app` holds `SELECT` on it (0006), so the tenant tx can read it.
 */
import { describe, expect, it, vi } from 'vitest';

const poolSelect = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('pool-global db used');
  }),
);
vi.mock('@/lib/db', () => ({ db: { select: poolSelect } }));

import { listActiveUserIdsWithRole } from '@/modules/auth/infrastructure/db/active-users-by-role-repo';

function recordingTx(rows: Array<{ id: string }>) {
  const where = vi.fn(async () => rows);
  const select = vi.fn(() => ({ from: () => ({ where }) }));
  return { tx: { select } as never, select };
}

describe('listActiveUserIdsWithRole — the tx it is handed', () => {
  it('reads through the given tx, never the pool-global db', async () => {
    const { tx, select } = recordingTx([{ id: 'u-1' }]);

    const active = await listActiveUserIdsWithRole(['u-1', 'u-2'], 'member', tx);

    expect([...active]).toEqual(['u-1']);
    expect(select).toHaveBeenCalledTimes(1);
    expect(poolSelect).not.toHaveBeenCalled();
  });

  it('with no tx it still reads the pool-global db (the cross-tenant callers)', async () => {
    await expect(listActiveUserIdsWithRole(['u-1'], 'member')).rejects.toThrow('pool-global db used');
  });
});
