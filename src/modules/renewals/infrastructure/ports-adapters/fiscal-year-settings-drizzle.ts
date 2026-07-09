/**
 * FIX-3 (PR #173 review, 2026-07-09) — Drizzle adapter for
 * `FiscalYearStartMonthPort`.
 *
 * Reads F4's PUBLIC `drizzleTenantSettingsRepo.getForIssue` (already
 * exported from `@/modules/invoicing`'s barrel) — no F4 schema/ORM deep
 * import, mirroring the cross-context-via-public-barrel rule every other
 * F8→F4 read follows (`f4-invoicing-bridge.ts`).
 *
 * Pure Infrastructure — uses only F4's public barrel + `pino` logger + the
 * port interface (no framework / Application-layer imports).
 */
import { logger } from '@/lib/logger';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing';
import type { FiscalYearStartMonthPort } from '../../application/ports/fiscal-year-settings-port';

const DEFAULT_FISCAL_YEAR_START_MONTH = 1;

export function makeDrizzleFiscalYearStartMonth(): FiscalYearStartMonthPort {
  return {
    async getFiscalYearStartMonth(tenantId: string): Promise<number> {
      const settings = await drizzleTenantSettingsRepo.getForIssue(tenantId);
      if (!settings) {
        logger.warn(
          { tenantId },
          '[fiscal-year-settings] no tenant_invoice_settings row — defaulting fiscal_year_start_month to January',
        );
        return DEFAULT_FISCAL_YEAR_START_MONTH;
      }
      const raw = settings.fiscalYearStartMonth;
      if (!Number.isInteger(raw) || raw < 1 || raw > 12) {
        logger.warn(
          { tenantId, raw },
          '[fiscal-year-settings] fiscal_year_start_month out of range — defaulting to January',
        );
        return DEFAULT_FISCAL_YEAR_START_MONTH;
      }
      return raw;
    },
  };
}
