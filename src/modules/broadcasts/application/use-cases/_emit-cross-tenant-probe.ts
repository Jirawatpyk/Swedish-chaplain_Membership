/**
 * Phase 5 Round 1 R2.2 A2 — Shared helper for cross-tenant probe audits.
 *
 * Centralises the `safeAuditEmit(audit, null, {eventType: 'broadcast_
 * cross_tenant_probe', payload: {...}})` pattern used by template
 * use-cases (delete + update + snapshot) when a RLS-confined SELECT
 * returns null. Distinguishes templates from broadcasts via the
 * `resourceKind` discriminant in the payload (added in R1.1 along
 * with the `probedTemplateId` field).
 *
 * Why not generalise to broadcasts probes too: broadcast use-cases
 * have varied summary strings + extra payload fields (cancel adds
 * action context, retry adds attempt number, etc.). Templates have
 * a uniform shape so this helper is template-scoped.
 *
 * Returns void — the use-case still controls the error-result it
 * returns to the caller.
 */
import { safeAuditEmit } from './_safe-audit-emit';
import type { AuditPort } from '../ports/audit-port';
import type { TenantSlug } from '@/modules/tenants';

export interface TemplateProbeAuditInput {
  readonly audit: AuditPort;
  readonly tenantId: TenantSlug;
  readonly actorUserId: string;
  readonly templateId: string;
  readonly operation: string; // e.g. 'delete', 'update', 'snapshot'
  readonly requestId: string;
}

export async function emitTemplateCrossTenantProbeAudit(
  input: TemplateProbeAuditInput,
): Promise<void> {
  await safeAuditEmit(input.audit, null, {
    eventType: 'broadcast_cross_tenant_probe',
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    summary: `Cross-tenant probe on ${input.operation}-template ${input.templateId}`,
    payload: {
      probedTenantId: input.tenantId,
      probedTemplateId: input.templateId,
      resourceKind: 'template',
    },
    requestId: input.requestId,
  });
}
