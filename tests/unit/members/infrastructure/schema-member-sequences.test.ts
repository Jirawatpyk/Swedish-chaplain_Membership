import { describe, expect, it } from 'vitest';
import { getTableName } from 'drizzle-orm';
import {
  tenantMemberSequences,
  type TenantMemberSequenceRow,
} from '@/modules/members/infrastructure/db/schema-member-sequences';
import {
  tenantMemberSettings,
  type TenantMemberSettingsRow,
} from '@/modules/members/infrastructure/db/schema-member-settings';

describe('schema-member-sequences', () => {
  it('tenantMemberSequences has required columns inferred correctly', () => {
    type _CheckRow = TenantMemberSequenceRow & {
      tenant_id: string;
      last_number: number;
      updated_at: Date;
    };
    expect(getTableName(tenantMemberSequences)).toBe('tenant_member_sequences');
  });
});

describe('schema-member-settings', () => {
  it('tenantMemberSettings has required columns inferred correctly', () => {
    type _CheckRow = TenantMemberSettingsRow & {
      tenant_id: string;
      member_number_prefix: string;
      created_at: Date;
      updated_at: Date;
    };
    expect(getTableName(tenantMemberSettings)).toBe('tenant_member_settings');
  });
});
