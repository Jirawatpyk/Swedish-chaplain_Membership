/**
 * F119 T027 / T031 / T032 — `BrandChromePort`: the live brand chrome a
 * render needs (FR-041c).
 *
 * Logo URL, primary colour and postal address are read at RENDER time —
 * for every preview, test copy and send — and never frozen into a version,
 * which is why a brand change never voids an approval (FR-012). Composed in
 * `src/lib/broadcast-brand-deps.ts` over `BrandSettingsRepo` +
 * `TenantLogoUrlPort`. Every miss is fail-soft `null` (chamber name in the
 * header, "Sent by" line in the footer, platform colour on a CTA).
 */
import type { TenantSlug } from '@/modules/tenants';
import type { BrandSettings } from '../../domain/brand/brand-settings';

export interface BrandChromePort {
  load(tenantId: TenantSlug): Promise<BrandSettings>;
}
