/**
 * T070 — `enforce-tenant-context.ts` Application use-case helper (F7).
 *
 * Cross-tenant probe defence — when a route handler resolves a broadcast
 * by id, this helper verifies the row's tenant matches the caller's
 * tenant context. Mismatch:
 *   1. Emits `broadcast_cross_tenant_probe` (separate tx)
 *   2. Returns Result.err — caller maps to 404 (NOT 403, to avoid
 *      leaking existence of other tenants' rows)
 *
 * Usage from `GET /api/broadcasts/[id]` route:
 *   const broadcast = await broadcastsRepo.findById(callerTenant, id);
 *   if (broadcast === null) return 404;
 *   const tenantCheck = await enforceTenantContext(deps, {
 *     callerTenantId: callerTenant.slug,
 *     observedTenantId: broadcast.tenantId,
 *     ...
 *   });
 *   if (!tenantCheck.ok) return 404;
 *
 * NOTE: With RLS+FORCE on `broadcasts`, a cross-tenant probe SHOULD
 * already return null at the repo layer — this helper is a belt-and-
 * suspenders check for the case where an attacker bypasses RLS via a
 * compromised admin role.
 */
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { AuditPort } from '../ports/audit-port';

export type CrossTenantProbeError = {
  readonly kind: 'broadcast_cross_tenant_probe';
  readonly observedTenantId: string;
  readonly expectedTenantId: string;
};

export interface EnforceTenantContextDeps {
  readonly tenant: TenantContext;
  readonly audit: AuditPort;
}

export interface EnforceTenantContextInput {
  readonly observedTenantId: string;
  readonly broadcastId: string;
  readonly actorUserId: string;
  readonly memberId: string | null;
  readonly requestId: string | null;
}

export async function enforceTenantContext(
  deps: EnforceTenantContextDeps,
  input: EnforceTenantContextInput,
): Promise<Result<true, CrossTenantProbeError>> {
  if (input.observedTenantId === deps.tenant.slug) {
    return ok(true);
  }

  // Belt-and-suspenders: emit cross-tenant probe audit, return error so
  // the route maps to 404 (avoid existence leak).
  const isMemberProbe = input.memberId !== null;
  try {
    await deps.audit.emit(null, {
      tenantId: deps.tenant.slug,
      eventType: isMemberProbe
        ? 'broadcast_cross_member_probe'
        : 'broadcast_cross_tenant_probe',
      actorUserId: input.actorUserId,
      summary: `Cross-${isMemberProbe ? 'member' : 'tenant'} probe on broadcast ${input.broadcastId}`,
      payload: {
        broadcastId: input.broadcastId,
        observedTenantId: input.observedTenantId,
        expectedTenantId: deps.tenant.slug,
        memberId: input.memberId,
      },
      requestId: input.requestId,
    });
  } catch {
    // best-effort — never 5xx the request because audit failed
  }

  return err({
    kind: 'broadcast_cross_tenant_probe',
    observedTenantId: input.observedTenantId,
    expectedTenantId: deps.tenant.slug,
  });
}
