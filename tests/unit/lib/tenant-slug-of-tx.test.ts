/**
 * 130 (D-030) — `tenantSlugOf(tx)`: the tenant a `runInTenant` transaction
 * was opened for, so a tx-only repo method can bind its D-029 `tenant_id`
 * predicate without a tenant argument. Fails CLOSED: a tx that did not come
 * from `runInTenant` (the global `db`, an owner-role `db.transaction`) throws
 * instead of yielding `undefined` — `eq(col, undefined)` would render
 * `tenant_id = NULL` and silently drop the application wall.
 */
import { describe, expect, it } from 'vitest';
import { TenantTxNotBoundError, bindTenantTx, tenantSlugOf } from '@/lib/db';

describe('tenantSlugOf (130, D-030)', () => {
  it('returns the slug bound to a tx', () => {
    const tx = {};
    bindTenantTx(tx, 'swecham');
    expect(tenantSlugOf(tx)).toBe('swecham');
  });

  it('throws TenantTxNotBoundError for a tx runInTenant never bound', () => {
    expect(() => tenantSlugOf({})).toThrow(TenantTxNotBoundError);
  });

  it('keeps transactions apart', () => {
    const a = {};
    const b = {};
    bindTenantTx(a, 'tenant-a');
    bindTenantTx(b, 'tenant-b');
    expect([tenantSlugOf(a), tenantSlugOf(b)]).toEqual(['tenant-a', 'tenant-b']);
  });
});
