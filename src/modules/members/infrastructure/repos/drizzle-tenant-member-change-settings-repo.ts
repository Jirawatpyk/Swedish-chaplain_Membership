/**
 * F114 FR-031 / research R11 — `TenantMemberChangeSettingsPort` over
 * `tenant_member_settings.member_change_approval_enabled` (migration 0300).
 *
 * `readInTenant` opens its own `runInTenant` (RLS) — a tenant provisioned
 * before the 0209 seed has NO row, which the gate resolver reads as
 * "approval off". `setApprovalEnabledInTx` upserts inside the caller's tx and
 * returns the PREVIOUS value so the use case can audit `{ previous, next }`
 * and no-op on an unchanged value. The 055 prefix column is never touched
 * (its DEFAULT applies on a fresh insert).
 */
import { sql } from 'drizzle-orm';
import { runInTenant, type TenantTx } from '@/lib/db';
import { err, ok } from '@/lib/result';
import type { TenantMemberChangeSettingsPort } from '../../application/ports/tenant-member-change-settings-port';
import type { TenantId } from '../../domain/member';
import { unexpected } from '../db/_repo-error';

export const drizzleTenantMemberChangeSettingsRepo: TenantMemberChangeSettingsPort = {
  async readInTenant(ctx) {
    try {
      const rows = (await runInTenant(ctx, (tx) =>
        tx.execute(sql`
          SELECT member_change_approval_enabled
            FROM tenant_member_settings
           WHERE tenant_id = ${ctx.slug}
        `),
      )) as unknown as Array<{ member_change_approval_enabled: boolean }>;
      const row = rows[0];
      return ok(row === undefined ? null : { memberChangeApprovalEnabled: row.member_change_approval_enabled });
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async setApprovalEnabledInTx(tx: TenantTx, tenantId: TenantId, enabled: boolean) {
    try {
      const before = (await tx.execute(sql`
        SELECT member_change_approval_enabled
          FROM tenant_member_settings
         WHERE tenant_id = ${tenantId}
           FOR UPDATE
      `)) as unknown as Array<{ member_change_approval_enabled: boolean }>;
      const previous = before[0]?.member_change_approval_enabled ?? false;
      await tx.execute(sql`
        INSERT INTO tenant_member_settings (tenant_id, member_change_approval_enabled)
        VALUES (${tenantId}, ${enabled})
        ON CONFLICT (tenant_id) DO UPDATE
          SET member_change_approval_enabled = EXCLUDED.member_change_approval_enabled,
              updated_at = now()
      `);
      return ok({ previous });
    } catch (e) {
      return err(unexpected(e));
    }
  },
};
