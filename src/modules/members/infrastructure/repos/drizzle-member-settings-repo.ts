/**
 * 055-member-number — per-tenant member-number SETTINGS reader.
 *
 * Read-only (design §2: prefix is seed-only + immutable after first
 * member; no UPDATE method exists by design). Runs at display time —
 * touches ONLY `tenant_member_settings`, never the sequence table, so it
 * never participates in the allocation lock graph (lock-order discipline).
 *
 * Returns the column DEFAULT `'M'` when no row exists, so a tenant
 * provisioned before the settings seed still renders a valid number.
 */
import { sql } from 'drizzle-orm';
import type { TenantTx } from '@/lib/db';
import type { MemberSettingsReaderPort } from '../../application/ports/member-settings-port';
import type { TenantId } from '../../domain/member';

export const drizzleMemberSettingsRepo: MemberSettingsReaderPort = {
  async getPrefix(tx: TenantTx, tenantId: TenantId): Promise<string> {
    const rows = (await tx.execute(sql`
      SELECT member_number_prefix
        FROM tenant_member_settings
       WHERE tenant_id = ${tenantId}
    `)) as unknown as Array<{ member_number_prefix: string }>;

    // No row → tenant provisioned before the settings seed. Fall back to
    // the column DEFAULT so display never breaks (design §4.3).
    return rows[0]?.member_number_prefix ?? 'M';
  },
};
