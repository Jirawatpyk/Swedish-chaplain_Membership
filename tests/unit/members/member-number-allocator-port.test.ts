import { describe, it, expect } from 'vitest';
import type { TenantTx } from '@/lib/db';
import type { MemberNumberAllocatorPort } from '@/modules/members/application/ports/member-number-allocator-port';
import { asTenantId } from '@/modules/members';
import { asMemberNumber } from '@/modules/members/domain/value-objects/member-number';

describe('MemberNumberAllocatorPort contract', () => {
  it('a conforming stub allocates a branded MemberNumber for a tenant', async () => {
    // The stub is the conformance proof: if the port signature drifts
    // (e.g. drops `tx`, returns `number`, takes raw string), this fails
    // to type-check and the suite goes red.
    const stub: MemberNumberAllocatorPort = {
      allocate: async (_tx, tenantId) => {
        expect(typeof tenantId).toBe('string'); // TenantId is a branded string
        return asMemberNumber(42);
      },
    };

    const fakeTx = {} as TenantTx;
    const n = await stub.allocate(fakeTx, asTenantId('alpha'));
    expect(n).toBe(42);
  });
});
