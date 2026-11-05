import type { Response } from '@playwright/test';

/**
 * True when `/admin/finance` is not served on this server
 * (FEATURE_INVOICE_DASHBOARD off).
 *
 * Since PR P the route is `force-dynamic` with its own `not-found.tsx`, so a
 * flag-off visit answers HTTP 404 (before that its `notFound()` streamed the
 * "Page not available" page as a 200 and this helper had to wait for the
 * heading — R136).
 */
export function invoiceDashboardIsOff(response: Response | null): boolean {
  return response?.status() === 404;
}
