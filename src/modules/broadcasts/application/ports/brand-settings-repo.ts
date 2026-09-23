/**
 * F119 T023 — `BrandSettingsRepo` Application port (FR-041b/c).
 *
 * Reads and writes the four `brand_*` columns of `tenant_broadcast_settings`
 * (migration 0304): ONE primary colour and the chamber postal address. The
 * logo is NOT here — it is read through `TenantLogoUrlPort` from the
 * invoicing module and never written from this feature.
 *
 * Every method that takes a `tx` runs on the caller's `runInTenant`
 * transaction; the adapter never reaches for the pool-global `db` (the
 * F7.1a US2 incident rule — a fresh connection has no
 * `app.current_tenant` and silently bypasses RLS).
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { TenantSlug } from '@/modules/tenants';
import type { BrandHexColor } from '../../domain/brand/brand-settings';

/** Opaque tx handle (see `ImageAllowlistTx` for why it stays `unknown`). */
export type BrandSettingsTx = unknown;

export interface BrandSettingsRecord {
  /** `#rrggbb` lower case, or null ⇒ the platform default applies at render. */
  readonly primaryColor: BrandHexColor | null;
  /** ≤ 300 chars, LF line breaks; null ⇒ the footer shows the chamber name only. */
  readonly postalAddress: string | null;
  readonly updatedAt: Date | null;
  readonly updatedByUserId: string | null;
}

export interface BrandSettingsWrite {
  readonly primaryColor: BrandHexColor | null;
  readonly postalAddress: string | null;
  readonly updatedByUserId: string;
}

export interface BrandSettingsRepo {
  /** Open a tenant tx so the write and its audit row share one rollback boundary. */
  withTx<T>(tenantId: TenantSlug, fn: (tx: BrandSettingsTx) => Promise<T>): Promise<T>;
  /** All-null record when the tenant has no settings row yet. */
  find(tenantId: TenantSlug, tx?: BrandSettingsTx | null): Promise<BrandSettingsRecord>;
  /**
   * The read a read-merge-write MUST use: ensures the tenant's settings row
   * exists (created lazily — a bare `FOR UPDATE` on a missing row locks
   * nothing), then locks it for the rest of `tx`. A concurrent writer blocks
   * here until this tx ends, so neither can merge onto a stale read.
   */
  findForUpdate(tenantId: TenantSlug, tx: BrandSettingsTx): Promise<BrandSettingsRecord>;
  /** Upsert the brand columns (the row may not exist yet — 0131 creates it lazily). */
  save(tenantId: TenantSlug, input: BrandSettingsWrite, tx: BrandSettingsTx): Promise<BrandSettingsRecord>;
}
