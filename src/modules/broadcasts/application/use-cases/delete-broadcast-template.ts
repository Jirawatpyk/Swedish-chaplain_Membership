/**
 * T101 (F7.1a US7) — `deleteBroadcastTemplate` Application use-case.
 *
 * Admin soft-delete per contracts/broadcast-template.md § 1.3 + FR-023:
 *   - Load existing template (RLS-scoped) — null → cross-tenant probe
 *     audit + not_found
 *   - port.softDelete (sets deleted_at = now())
 *   - audit broadcast_template_deleted with `started_from_count`
 *     snapshot at delete time (forensic visibility per FR-023)
 *
 * Drafts that originated from this template are NOT affected — the
 * broadcasts.started_from_template_id FK uses ON DELETE SET NULL but
 * templateNameSnapshot column on broadcasts preserves the name.
 *
 * Pure Application logic.
 */
import { err, ok, type Result } from '@/lib/result';
import type {
  BroadcastTemplatesPort,
  TemplateDeleteError,
} from '../ports/broadcast-templates-port';
import type { AuditPort } from '../ports/audit-port';
import { safeAuditEmit } from './_safe-audit-emit';
import type { TenantSlug } from '@/modules/tenants';

export interface DeleteBroadcastTemplateDeps {
  readonly port: BroadcastTemplatesPort;
  readonly audit: AuditPort;
}

export interface DeleteBroadcastTemplateInput {
  readonly tenantId: TenantSlug;
  readonly actorUserId: string;
  readonly templateId: string;
  readonly requestId: string;
}

export type DeleteBroadcastTemplateError = TemplateDeleteError;

export async function deleteBroadcastTemplate(
  deps: DeleteBroadcastTemplateDeps,
  input: DeleteBroadcastTemplateInput,
): Promise<Result<undefined, DeleteBroadcastTemplateError>> {
  // Load existing to capture the started_from_count snapshot AND to
  // detect cross-tenant probes (RLS-confined findById returns null
  // for foreign templates).
  const existing = await deps.port.findById(input.tenantId, input.templateId);
  if (!existing) {
    await safeAuditEmit(deps.audit, null, {
      eventType: 'broadcast_cross_tenant_probe',
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      summary: `Cross-tenant probe on delete-template ${input.templateId}`,
      payload: {
        probedTenantId: input.tenantId,
        probedTemplateId: input.templateId,
        resourceKind: 'template',
      },
      requestId: input.requestId,
    });
    return err({ kind: 'not_found' });
  }

  // Atomic soft-delete + audit. FR-023 — audit row preserves the
  // `started_from_count` at delete time for forensic auditing even
  // after the template is gone.
  return deps.port.withTx(input.tenantId, async (tx) => {
    const deleteRes = await deps.port.softDelete(
      input.tenantId,
      input.templateId,
      tx,
    );
    if (!deleteRes.ok) return err(deleteRes.error);

    await deps.audit.emit(tx, {
      eventType: 'broadcast_template_deleted',
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      summary: `Template deleted — ${existing.name} (started_from_count=${existing.startedFromCount})`,
      payload: {
        templateId: existing.id,
        name: existing.name,
        locale: existing.locale,
        startedFromCount: existing.startedFromCount,
        isSeeded: existing.isSeeded,
      },
      requestId: input.requestId,
    });
    return ok(undefined);
  });
}
