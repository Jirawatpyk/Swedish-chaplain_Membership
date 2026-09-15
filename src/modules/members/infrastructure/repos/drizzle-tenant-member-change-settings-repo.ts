/**
 * F114 FR-031 / research R11 — `TenantMemberChangeSettingsPort` over
 * `tenant_member_settings.member_change_approval_enabled` (migration 0300).
 *
 * `readInTenant` opens its own `runInTenant` (RLS) — a tenant provisioned
 * before the 0209 seed has NO row, which the gate resolver reads as
 * "approval off". `setApprovalEnabledInTx` materialises-then-locks-then-updates
 * inside the caller's tx and returns the PREVIOUS value so the use case can
 * audit `{ previous, next }` and skip the audit on an unchanged value. The 055
 * prefix column is never touched (its DEFAULT applies on a fresh insert).
 *
 * The three statements are one serialisation point per tenant: the insert
 * makes the row exist (so `FOR UPDATE` has something to hold and a concurrent
 * writer queues on the unique index), the locked read is the audited
 * `previous`, and the update is the only writer of the new value. Pinned on
 * live Neon by the two overlapping transactions in
 * `tests/integration/members/change-requests-tenant-isolation.test.ts`.
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
      // PR-3 review (reliability R-M1): MATERIALISE the row before locking it.
      // `SELECT … FOR UPDATE` cannot lock a row that does not exist, and a
      // tenant provisioned before the 0209 seed has none — so two concurrent
      // PATCHes both read `previous = false` and one of them audits
      // `{ previous: false, next: … }` for a transition the stored value does
      // not match. `ON CONFLICT DO NOTHING` makes the second writer wait on
      // the unique index instead, and the `FOR UPDATE` below then always has a
      // row to hold. The insert seeds the CURRENT value (`false`, the
      // new-tenant default of FR-031), never `enabled` — the UPDATE below is
      // the one writer of the new value, so `previous` stays truthful on both
      // the create and the update path. The 055 prefix column is untouched and
      // takes its DEFAULT.
      await tx.execute(sql`
        INSERT INTO tenant_member_settings (tenant_id, member_change_approval_enabled)
        VALUES (${tenantId}, false)
        ON CONFLICT (tenant_id) DO NOTHING
      `);
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
