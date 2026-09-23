/**
 * F119 T031 — fail-soft brand read for the two dispatch use cases.
 *
 * Brand chrome is read LIVE at send time (FR-041c) and handed to the
 * gateway so the delivered email equals the preview. The port is REQUIRED
 * (a composition cannot omit it); a read FAULT degrades to no chrome — the
 * chamber-name header, the "Sent by" footer and the platform CTA colour —
 * because a brand outage must never fail a send. The degrade is logged and
 * metered so an operator can tell "no brand set" from "brand read failed".
 */
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { broadcastsMetrics } from '@/lib/metrics';
import type { TenantContext } from '@/modules/tenants';
import type { BrandSettings } from '../../domain/brand/brand-settings';
import type { BrandChromePort } from '../ports/brand-chrome-port';

const NO_BRAND: BrandSettings = { primaryColor: null, postalAddress: null, logoUrl: null };

/**
 * Which use case is degrading. Required, never defaulted: a shared helper that
 * stamps ONE caller's identity onto every call site is the F8 errorId defect
 * class — the operator needs to know which send path lost its brand.
 */
export type BrandChromeSurface = 'dispatch' | 'audience_tick';

export async function loadBrandChrome(
  port: BrandChromePort,
  tenant: TenantContext,
  surface: BrandChromeSurface,
): Promise<BrandSettings> {
  try {
    return await port.load(tenant.slug as never);
  } catch (e) {
    logger.warn(
      { err: errKind(e), tenantId: tenant.slug, surface },
      'broadcasts.dispatch.brand_chrome_unavailable',
    );
    // F2-8 — the durable, alertable signal: this send ships a footer WITHOUT
    // the postal address FR-041c requires. A warn log alone never pages.
    broadcastsMetrics.brandChromeUnavailable(tenant.slug, surface);
    return NO_BRAND;
  }
}
