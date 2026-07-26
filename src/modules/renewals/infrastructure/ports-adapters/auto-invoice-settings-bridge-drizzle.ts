/**
 * 107-auto-invoice Task 7 — Drizzle adapter for `AutoInvoiceSettingsPort`.
 *
 * Reads F4's PUBLIC `readAutoInvoiceSettingsForTenant` (already exported
 * from `@/modules/invoicing`'s barrel) — no F4 schema/ORM deep import,
 * mirroring the cross-context-via-public-barrel rule every other F8→F4
 * read follows (`f4-invoicing-bridge.ts`, `fiscal-year-settings-drizzle.ts`).
 *
 * Stateless singleton (mirrors `f4InvoicingForRenewalBridge` /
 * `f5RefundBridge` — every method takes `tenantId` explicitly, no
 * per-tenant construction needed).
 *
 * Pure Infrastructure — uses only F4's public barrel + the port
 * interface (no framework / Application-layer imports).
 */
import { readAutoInvoiceSettingsForTenant } from '@/modules/invoicing';
import type {
  AutoInvoiceSettingsPort,
  AutoInvoiceSettingsView,
} from '../../application/ports/auto-invoice-settings-port';

export const autoInvoiceSettingsBridge: AutoInvoiceSettingsPort = {
  async getAutoInvoiceSettings(
    tenantId: string,
  ): Promise<AutoInvoiceSettingsView | null> {
    return readAutoInvoiceSettingsForTenant(tenantId);
  },
};
