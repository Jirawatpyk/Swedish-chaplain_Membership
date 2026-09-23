/**
 * F119 T025 — `getBrandSettings` (FR-041b/c; contracts § GET …/brand).
 *
 * The view the Brand page and the compose hint read: colour, address,
 * `addressMissing`, the platform default, and the logo as a READ-only
 * object — its URL resolved through `TenantLogoUrlPort`, its source named,
 * and a `manageHref` that is non-null ONLY when the caller holds
 * `settings.invoicing` (the route decides that with the evaluator; this
 * use case never reads a role).
 */
import type { TenantSlug } from '@/modules/tenants';
import { DEFAULT_BRAND_PRIMARY_COLOR } from '../../domain/brand/brand-settings';
import type { BrandSettingsRepo } from '../ports/brand-settings-repo';
import type { TenantLogoUrlPort } from '../ports/tenant-logo-url-port';

export interface GetBrandSettingsDeps {
  readonly repo: Pick<BrandSettingsRepo, 'find'>;
  readonly logoUrl: TenantLogoUrlPort;
}

export interface GetBrandSettingsInput {
  readonly tenantId: TenantSlug;
  readonly canManageInvoiceSettings: boolean;
}

/** The page that owns the logo (super-admin only). */
export const INVOICE_SETTINGS_HREF = '/admin/settings/invoicing' as const;

export interface BrandSettingsView {
  readonly primaryColor: string | null;
  readonly postalAddress: string | null;
  readonly addressMissing: boolean;
  readonly logo: {
    readonly url: string | null;
    readonly source: 'invoice_settings';
    readonly manageHref: typeof INVOICE_SETTINGS_HREF | null;
  };
  readonly defaults: { readonly primaryColor: typeof DEFAULT_BRAND_PRIMARY_COLOR };
  readonly updatedAt: string | null;
}

export async function getBrandSettings(
  deps: GetBrandSettingsDeps,
  input: GetBrandSettingsInput,
): Promise<BrandSettingsView> {
  const [record, logoUrl] = await Promise.all([
    deps.repo.find(input.tenantId),
    deps.logoUrl.resolve(input.tenantId),
  ]);
  return {
    primaryColor: record.primaryColor,
    postalAddress: record.postalAddress,
    addressMissing: record.postalAddress === null,
    logo: {
      url: logoUrl,
      source: 'invoice_settings',
      manageHref: input.canManageInvoiceSettings ? INVOICE_SETTINGS_HREF : null,
    },
    defaults: { primaryColor: DEFAULT_BRAND_PRIMARY_COLOR },
    updatedAt: record.updatedAt === null ? null : record.updatedAt.toISOString(),
  };
}
