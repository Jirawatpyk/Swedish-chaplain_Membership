/**
 * F119 T023 — Drizzle adapter for `BrandSettingsRepo` (migration 0304).
 *
 * Reads and writes the four `brand_*` columns of `tenant_broadcast_settings`
 * THROUGH THE CALLER'S `tx` (`withTenantTxOrOpen`): a method that reached for
 * the pool-global `db` would get a fresh connection with no
 * `app.current_tenant` and silently bypass RLS + FORCE (the F7.1a US2 rule).
 * The settings row is created lazily by 0131's readers, so `save` upserts
 * and `find` returns an all-null record when there is no row yet.
 * `findForUpdate` is the locking read for a read-merge-write: it creates the
 * row if absent (every other column has a default or is nullable — 0165 +
 * 0304) and then takes the row lock, so two concurrent brand saves serialise
 * instead of the second silently reverting the first.
 */
import { eq } from 'drizzle-orm';
import { runInTenant, withTenantTxOrOpen, type TenantTx } from '@/lib/db';
import { asTenantContext, type TenantSlug } from '@/modules/tenants';
import type { BrandHexColor } from '../../domain/brand/brand-settings';
import type {
  BrandSettingsRecord,
  BrandSettingsRepo,
  BrandSettingsTx,
  BrandSettingsWrite,
} from '../../application/ports/brand-settings-repo';
import { tenantBroadcastSettings } from '../schema';

const EMPTY: BrandSettingsRecord = {
  primaryColor: null,
  postalAddress: null,
  updatedAt: null,
  updatedByUserId: null,
};

function toRecord(row: {
  brandPrimaryColor: string | null;
  brandPostalAddress: string | null;
  brandUpdatedAt: Date | null;
  brandUpdatedByUserId: string | null;
}): BrandSettingsRecord {
  return {
    // The ONE place a stored colour becomes a `BrandHexColor` without going
    // through `parseBrandPrimaryColor`: the column's 0304 CHECK
    // (`~ '^#[0-9a-fA-F]{6}$'`) guarantees the format of every row, and every
    // write reaches it through `setBrandSettings`, which parses first.
    primaryColor: row.brandPrimaryColor as BrandHexColor | null,
    postalAddress: row.brandPostalAddress,
    updatedAt: row.brandUpdatedAt,
    updatedByUserId: row.brandUpdatedByUserId,
  };
}

const BRAND_COLUMNS = {
  brandPrimaryColor: tenantBroadcastSettings.brandPrimaryColor,
  brandPostalAddress: tenantBroadcastSettings.brandPostalAddress,
  brandUpdatedAt: tenantBroadcastSettings.brandUpdatedAt,
  brandUpdatedByUserId: tenantBroadcastSettings.brandUpdatedByUserId,
} as const;

export const drizzleBrandSettingsRepo: BrandSettingsRepo = {
  async withTx<T>(tenantId: TenantSlug, fn: (tx: BrandSettingsTx) => Promise<T>): Promise<T> {
    return runInTenant(asTenantContext(tenantId as unknown as string), async (tx) => fn(tx));
  },

  async find(tenantId: TenantSlug, tx?: BrandSettingsTx | null): Promise<BrandSettingsRecord> {
    return withTenantTxOrOpen(tenantId, tx ?? null, async (innerTx: TenantTx) => {
      const rows = await innerTx
        .select(BRAND_COLUMNS)
        .from(tenantBroadcastSettings)
        .where(eq(tenantBroadcastSettings.tenantId, tenantId as string))
        .limit(1);
      const row = rows[0];
      return row === undefined ? EMPTY : toRecord(row);
    });
  },

  async findForUpdate(tenantId: TenantSlug, tx: BrandSettingsTx): Promise<BrandSettingsRecord> {
    const inner = tx as TenantTx;
    // Create-then-lock: a concurrent first save waits on this INSERT (the
    // uncommitted conflicting row), a later one on the FOR UPDATE below.
    await inner
      .insert(tenantBroadcastSettings)
      .values({ tenantId: tenantId as string })
      .onConflictDoNothing({ target: tenantBroadcastSettings.tenantId });
    const rows = await inner
      .select(BRAND_COLUMNS)
      .from(tenantBroadcastSettings)
      .where(eq(tenantBroadcastSettings.tenantId, tenantId as string))
      .limit(1)
      .for('update');
    const row = rows[0];
    if (row === undefined) throw new Error('brand_settings_lock_row_missing');
    return toRecord(row);
  },

  async save(tenantId: TenantSlug, input: BrandSettingsWrite, tx: BrandSettingsTx): Promise<BrandSettingsRecord> {
    const now = new Date();
    const inner = tx as TenantTx;
    const rows = await inner
      .insert(tenantBroadcastSettings)
      .values({
        tenantId: tenantId as string,
        brandPrimaryColor: input.primaryColor,
        brandPostalAddress: input.postalAddress,
        brandUpdatedAt: now,
        brandUpdatedByUserId: input.updatedByUserId,
      })
      .onConflictDoUpdate({
        target: tenantBroadcastSettings.tenantId,
        set: {
          brandPrimaryColor: input.primaryColor,
          brandPostalAddress: input.postalAddress,
          brandUpdatedAt: now,
          brandUpdatedByUserId: input.updatedByUserId,
          updatedAt: now,
        },
      })
      .returning(BRAND_COLUMNS);
    const row = rows[0];
    if (row === undefined) throw new Error('brand_settings_upsert_returned_no_row');
    return toRecord(row);
  },
};
