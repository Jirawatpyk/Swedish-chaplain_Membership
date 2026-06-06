import { describe, it, expect } from 'vitest';
import type { TenantTx } from '@/lib/db';
import type { MemberSettingsReaderPort } from '@/modules/members/application/ports/member-settings-port';
import { asTenantId } from '@/modules/members';

describe('MemberSettingsReaderPort contract', () => {
  it('a conforming stub returns the per-tenant prefix string', async () => {
    const stub: MemberSettingsReaderPort = {
      getPrefix: async (_tx, tenantId) => {
        expect(typeof tenantId).toBe('string');
        return 'SCCM';
      },
    };

    const fakeTx = {} as TenantTx;
    const prefix = await stub.getPrefix(fakeTx, asTenantId('alpha'));
    expect(prefix).toBe('SCCM');
  });
});
