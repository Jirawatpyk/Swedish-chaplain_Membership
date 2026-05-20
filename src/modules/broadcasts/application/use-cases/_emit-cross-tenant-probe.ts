/**
 * Shared helper for template cross-tenant probe audits.
 *
 * Centralises the safeAuditEmit `broadcast_cross_tenant_probe` payload
 * shape used by template use-cases (delete + update + snapshot) when
 * a RLS-confined SELECT returns null. The `resourceKind: 'template'`
 * discriminant distinguishes template probes from broadcast probes.
 *
 * Template-scoped (not generalised to broadcasts) — broadcast use-cases
 * have varied summaries + extra payload fields that don't fit a single
 * shared signature.
 *
 * Returns void — the use-case still controls the error-result.
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
      // R3.5 M-10 — `probedTenantId` is the ACTOR'S OWN tenant (the
      // RLS boundary the actor was querying INTO). NOT a foreign
      // tenant id. Forensic analysts should read this as "tenant X
      // emitted a probe against its own namespace + got null back"
      // — typically a stale link, deleted-then-undeleted race, or
      // genuine attack attempt against UUID-guessed template ids.
      probedTenantId: input.tenantId,
      probedTemplateId: input.templateId,
      resourceKind: 'template',
    },
    requestId: input.requestId,
  });
}
