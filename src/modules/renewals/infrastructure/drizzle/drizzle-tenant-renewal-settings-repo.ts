/**
 * F8 Phase 5 wave K24 · T115a — Drizzle adapter for
 * `TenantRenewalSettingsRepo`.
 *
 * Wires the read + upsert surface against the
 * `tenant_renewal_settings` table (data-model.md § 2.3, migration 0089).
 * Created at K24 to back the new `lapseCyclesOnGraceExpiry` cron
 * (T115a Phase-5-deferred branch wiring) which needs to read
 * `grace_period_days` to compute the lapse-eligibility cutoff.
 *
 * Tenant scope: every method runs inside `runInTenant` so
 * `app.current_tenant` GUC is set and RLS+FORCE applies. Cross-tenant
 * reads return null (RLS hides the row); cross-tenant upserts fail
 * the WITH CHECK clause and throw at the DB.
 */
import { eq } from 'drizzle-orm';
import { runInTenant, type TenantTx } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import type {
  TenantRenewalSettingsRepo,
  UpdateTenantRenewalSettingsInput,
} from '../../application/ports/tenant-renewal-settings-repo';
import type { TenantRenewalSettings } from '../../domain/tenant-renewal-settings';
import {
  tenantRenewalSettings,
  type TenantRenewalSettingsInsert,
  type TenantRenewalSettingsRow,
} from '../schema-tenant-renewal-config';

function rowToDomain(row: TenantRenewalSettingsRow): TenantRenewalSettings {
  return {
    tenantId: row.tenantId,
    gracePeriodDays: row.gracePeriodDays,
    autoUpgradeEnabled: row.autoUpgradeEnabled,
    minTenureDaysForAtRisk: row.minTenureDaysForAtRisk,
    dispatchCronEnabled: row.dispatchCronEnabled,
    replyToEmail: row.replyToEmail,
    replyToDisplayName: row.replyToDisplayName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function makeDrizzleTenantRenewalSettingsRepo(
  ctx: TenantContext,
): TenantRenewalSettingsRepo {
  return {
    async findByTenant(
      tenantId: string,
    ): Promise<TenantRenewalSettings | null> {
      return runInTenant(ctx, async (tx) => {
        const rows = await tx
          .select()
          .from(tenantRenewalSettings)
          .where(eq(tenantRenewalSettings.tenantId, tenantId))
          .limit(1);
        const row = rows[0];
        return row ? rowToDomain(row) : null;
      });
    },

    async upsert(
      tx: TenantTx,
      tenantId: string,
      input: UpdateTenantRenewalSettingsInput,
    ): Promise<TenantRenewalSettings> {
      const now = new Date();
      // Round 5 staff-review (K24-Simplify-1): single-source-of-truth
      // patch-keys loop instead of 12 conditional spreads (6 fields ×
      // {insertValues, updateValues}). Mirrors F4 canonical pattern at
      // `src/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo.ts:74-99`.
      // Adding a 7th settings field becomes a 1-line change in the
      // `patchKeys` array; field-pair drift between insert/update
      // (caller adds key to one but forgets the other) is structurally
      // impossible.
      const patchKeys = [
        'gracePeriodDays',
        'autoUpgradeEnabled',
        'minTenureDaysForAtRisk',
        'dispatchCronEnabled',
        'replyToEmail',
        'replyToDisplayName',
      ] as const satisfies ReadonlyArray<keyof UpdateTenantRenewalSettingsInput>;
      const insertValues: TenantRenewalSettingsInsert = {
        tenantId,
        updatedAt: now,
      };
      const updateValues: Partial<TenantRenewalSettingsInsert> = {
        updatedAt: now,
      };
      for (const key of patchKeys) {
        const v = input[key];
        if (v !== undefined) {
          // The patch keys are statically the intersection of
          // UpdateTenantRenewalSettingsInput + Drizzle insert shape;
          // the cast erases the discriminator-by-key TS narrowing
          // which the for-loop can't preserve.
          (insertValues as Record<string, unknown>)[key] = v;
          (updateValues as Record<string, unknown>)[key] = v;
        }
      }
      const rows = await tx
        .insert(tenantRenewalSettings)
        .values(insertValues)
        .onConflictDoUpdate({
          target: tenantRenewalSettings.tenantId,
          set: updateValues,
        })
        .returning();
      const row = rows[0];
      if (!row) {
        throw new Error(
          `[drizzleTenantRenewalSettingsRepo] upsert returned no rows for tenant ${tenantId}`,
        );
      }
      return rowToDomain(row);
    },
  };
}
