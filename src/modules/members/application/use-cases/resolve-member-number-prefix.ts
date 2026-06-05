/**
 * 055-member-number — shared per-tenant member-number prefix resolver.
 *
 * The display-time prefix lookup (`runInTenant(ctx, (tx) =>
 * settings.getPrefix(tx, tenant.slug))`) was hand-copied across 5
 * presentation surfaces (admin members list + detail, portal dashboard +
 * profile, command-palette member search). Each copy independently had to
 * remember to wrap the read in `runInTenant` so the RLS GUC
 * (`SET LOCAL app.current_tenant`) is set — a 6th caller forgetting the
 * wrapper would reach a pool-fresh connection and silently bypass RLS
 * (F7.1a US2 incident class). Centralising the incantation here removes
 * that footgun: callers pass the tenant + the settings port and get the
 * formatted prefix back, with `runInTenant` applied internally.
 *
 * Read-only: the settings reader touches ONLY `tenant_member_settings`
 * (never the sequence table), so it stays out of the allocation lock
 * graph. Falls back to the column DEFAULT `'M'` inside the port when no
 * settings row exists — this resolver never throws on a missing row.
 *
 * Lives in the application layer (mirrors `create-member.ts`, which also
 * imports `runInTenant` from `@/lib/db` — the sanctioned RLS boundary).
 */
import { runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import type { MemberSettingsReaderPort } from '../ports/member-settings-port';
import type { TenantId } from '../../domain/member';

export async function resolveMemberNumberPrefix(
  tenant: TenantContext,
  settings: MemberSettingsReaderPort,
): Promise<string> {
  return runInTenant(tenant, (tx) =>
    settings.getPrefix(tx, tenant.slug as TenantId),
  );
}
