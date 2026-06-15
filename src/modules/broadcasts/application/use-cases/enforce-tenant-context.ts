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
import { safeAuditEmit } from './_safe-audit-emit';

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
  // F7-SF-3 — route the best-effort probe-audit through safeAuditEmit so a
  // transient audit-storage failure is LOGGED ('broadcasts.audit.emit_failed')
  // AND increments broadcasts_audit_emit_failed_total (the SLO alarm source)
  // instead of being swallowed by a bare catch{}. safeAuditEmit still
  // preserves the security effect (caller's err() → 404, never 5xx) and
  // re-throws genuine adapter-invariant programmer bugs. This is the most
  // security-relevant audit in the module — Constitution v1.4.0 Principle I
  // sub-clause 4 requires failed tenant-isolation attempts to leave a
  // forensic trail, so it must not have the weakest failure path.
  await safeAuditEmit(deps.audit, null, {
    eventType: isMemberProbe
      ? 'broadcast_cross_member_probe'
      : 'broadcast_cross_tenant_probe',
    actorUserId: input.actorUserId,
    tenantId: deps.tenant.slug,
    summary: `Cross-${isMemberProbe ? 'member' : 'tenant'} probe on broadcast ${input.broadcastId}`,
    payload: {
      broadcastId: input.broadcastId,
      observedTenantId: input.observedTenantId,
      expectedTenantId: deps.tenant.slug,
      memberId: input.memberId,
    },
    requestId: input.requestId,
  });

  return err({
    kind: 'broadcast_cross_tenant_probe',
    observedTenantId: input.observedTenantId,
    expectedTenantId: deps.tenant.slug,
  });
}
