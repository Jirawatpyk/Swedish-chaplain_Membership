/**
 * F119 T027 — `TenantLogoUrlPort` (FR-041a/b, research R12).
 *
 * The chamber logo the email header shows is the one already on file for
 * invoices; this port READS its public URL through the invoicing module's
 * barrel export (`getTenantLogoPublicUrl`), composed in
 * `src/lib/broadcast-brand-deps.ts`. `null` ⇒ no logo on file (or a
 * transient miss) ⇒ the header renders the chamber name exactly as today.
 * There is no write method, by design.
 */
import type { TenantSlug } from '@/modules/tenants';

export interface TenantLogoUrlPort {
  resolve(tenantId: TenantSlug): Promise<string | null>;
}
