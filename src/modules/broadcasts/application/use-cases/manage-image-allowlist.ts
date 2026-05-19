/**
 * T072 (F7.1a US2) — `manageImageAllowlist` Application use-case.
 *
 * Admin add/remove of a tenant's image-source allowlist (FR-010 +
 * FR-015). Emits `broadcast_image_allowlist_updated` audit with
 * before/after count + actor. Idempotent — duplicate add does NOT
 * emit audit (no-op).
 *
 * Pure Application logic — no framework imports.
 */
import { err, ok, type Result } from '@/lib/result';
import { asHostname } from '../../domain/value-objects/image-source-allowlist';
import type {
  AllowlistEntry,
  ImageAllowlistPort,
  AllowlistAddError,
  AllowlistRemoveError,
} from '../ports/image-allowlist-port';
import type { AuditPort } from '../ports/audit-port';
import type { TenantSlug } from '@/modules/tenants';

export interface ManageImageAllowlistDeps {
  readonly port: ImageAllowlistPort;
  readonly audit: AuditPort;
}

export interface ManageImageAllowlistInput {
  readonly tenantId: TenantSlug;
  readonly actorUserId: string;
  readonly action: 'add' | 'remove';
  readonly hostname: string;
  readonly requestId: string;
}

export type ManageImageAllowlistError =
  | { readonly kind: 'invalid_hostname'; readonly detail: string }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'cannot_remove_default' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'storage_error'; readonly detail: string };

export interface ManageImageAllowlistOutput {
  readonly allowlist: readonly AllowlistEntry[];
}

export async function manageImageAllowlist(
  deps: ManageImageAllowlistDeps,
  input: ManageImageAllowlistInput,
): Promise<
  Result<ManageImageAllowlistOutput, ManageImageAllowlistError>
> {
  const hRes = asHostname(input.hostname);
  if (!hRes.ok) {
    return err({ kind: 'invalid_hostname', detail: hRes.error.detail });
  }
  const hostname = hRes.value;

  const before = await deps.port.findByTenantId(input.tenantId);
  const beforeCount = before.length;

  if (input.action === 'add') {
    const r = await deps.port.add(input.tenantId, hostname, input.actorUserId);
    if (!r.ok) return err(r.error as AllowlistAddError);
  } else {
    const r = await deps.port.remove(input.tenantId, hostname);
    if (!r.ok) return err(r.error as AllowlistRemoveError);
  }

  const after = await deps.port.findByTenantId(input.tenantId);

  await deps.audit.emit(null, {
    eventType: 'broadcast_image_allowlist_updated',
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    summary: `Allowlist ${input.action}: ${hostname}`,
    payload: {
      action: input.action,
      hostname,
      beforeCount,
      afterCount: after.length,
    },
    requestId: input.requestId,
  });

  return ok({ allowlist: after });
}
