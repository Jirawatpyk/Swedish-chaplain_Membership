/**
 * `readOwnPendingRequest` — the portal edit page's pending read (round 5,
 * silent-failure #1). A fault used to read as "no pending request": the form
 * then prefilled from the LIVE record and the member's next submit REPLACED
 * their pending proposal without anyone noticing. A fault is now a fault.
 */
import { describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: vi.fn(async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> => fn({ __tx: true })),
}));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { asTenantContext } from '@/modules/tenants';
import type { UserId } from '@/modules/members/domain/value-objects/user-id';
import { readOwnPendingRequest } from '@/lib/portal-own-pending';

const tenant = asTenantContext('test-tenant');
const USER = 'a6c5b1a2-0000-4000-8000-00000000bbbb' as UserId;

describe('readOwnPendingRequest', () => {
  it('ok(row) / ok(null) pass through', async () => {
    const row = { id: 'r1' } as never;
    expect(await readOwnPendingRequest({ findPendingBySubmitter: async () => ok(row) }, tenant, USER)).toEqual(ok(row));
    expect(await readOwnPendingRequest({ findPendingBySubmitter: async () => ok(null) }, tenant, USER)).toEqual(ok(null));
  });

  it('a repo Result fault is err(read_failed) — never "no pending request"', async () => {
    const r = await readOwnPendingRequest({ findPendingBySubmitter: async () => err({ code: 'repo.unexpected' as const }) }, tenant, USER);
    expect(r).toEqual({ ok: false, error: { type: 'read_failed', code: 'repo.unexpected' } });
  });

  it('a throw is err(read_failed) with the error kind', async () => {
    const r = await readOwnPendingRequest({ findPendingBySubmitter: async () => { throw new Error('neon down'); } }, tenant, USER);
    expect(r).toEqual({ ok: false, error: { type: 'read_failed', code: 'Error' } });
  });
});
