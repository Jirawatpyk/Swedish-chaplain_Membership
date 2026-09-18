/**
 * F119 T031 — fail-soft brand read for the two dispatch use cases.
 *
 * Brand chrome is read LIVE at send time (FR-041c) and handed to the
 * gateway so the delivered email equals the preview. A missing port (a
 * pre-F119 composition) or a read fault degrades to no chrome — the
 * chamber-name header, the "Sent by" footer and the platform CTA colour —
 * because a brand outage must never fail a send. The degrade is logged so
 * an operator can tell "no brand set" from "brand read failed".
 */
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import type { TenantContext } from '@/modules/tenants';
import type { BrandSettings } from '../../domain/brand/brand-settings';
import type { BrandChromePort } from '../ports/brand-chrome-port';

const NO_BRAND: BrandSettings = { primaryColor: null, postalAddress: null, logoUrl: null };

export async function loadBrandChrome(
  port: BrandChromePort | undefined,
  tenant: TenantContext,
): Promise<BrandSettings> {
  if (port === undefined) return NO_BRAND;
  try {
    return await port.load(tenant.slug as never);
  } catch (e) {
    logger.warn({ err: errKind(e), tenantId: tenant.slug }, 'broadcasts.dispatch.brand_chrome_unavailable');
    return NO_BRAND;
  }
}
