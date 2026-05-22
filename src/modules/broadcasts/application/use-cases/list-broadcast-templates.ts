/**
 * T103 (F7.1a US7) — `listBroadcastTemplates` Application use-case.
 *
 * Member compose picker + admin library list per contracts § 1.5 +
 * FR-047. Cascading locale filter:
 *   - If `currentUserLocale` is given, return that locale's templates
 *   - Else if `tenantDefaultLocale` is given, return that locale's
 *   - Else default to 'en'
 *   - Caller passes `includeAllLocales=true` to bypass the cascade
 *     (admin library "Show all" toggle / power-user picker mode)
 *
 * MRU ordering is enforced at the repo (ORDER BY updated_at DESC),
 * which serves as the F7.1a interim proxy for the spec-level "most-
 * recently-used-by-this-member" ordering — a per-member usage table
 * is deferred (F7.1b backlog) per contracts § 1.5 implementation note.
 *
 * Pure read path — no audit, no Result wrapper (read-paths cannot
 * fail meaningfully; RLS-scoped findByTenantId returns empty array
 * on cross-tenant probe).
 */
import type {
  BroadcastTemplate,
  BroadcastTemplatesPort,
  TemplateLocale,
} from '../ports/broadcast-templates-port';
import type { TenantSlug } from '@/modules/tenants';

export interface ListBroadcastTemplatesDeps {
  readonly port: BroadcastTemplatesPort;
}

export interface ListBroadcastTemplatesInput {
  readonly tenantId: TenantSlug;
  readonly currentUserLocale?: TemplateLocale;
  readonly tenantDefaultLocale?: TemplateLocale;
  /** Power-user toggle — bypasses the locale cascade. */
  readonly includeAllLocales?: boolean;
}

export type ListBroadcastTemplatesOutput = readonly BroadcastTemplate[];

export async function listBroadcastTemplates(
  deps: ListBroadcastTemplatesDeps,
  input: ListBroadcastTemplatesInput,
): Promise<ListBroadcastTemplatesOutput> {
  if (input.includeAllLocales === true) {
    return deps.port.findByTenantId(input.tenantId);
  }
  // Cascading default: current-user → tenant-default → 'en'
  const locale: TemplateLocale =
    input.currentUserLocale ?? input.tenantDefaultLocale ?? 'en';
  return deps.port.findByTenantId(input.tenantId, { locale });
}
