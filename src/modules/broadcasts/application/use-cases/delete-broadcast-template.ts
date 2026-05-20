/**
 * T101 (F7.1a US7) — `deleteBroadcastTemplate` Application use-case.
 *
 * Admin soft-delete per contracts/broadcast-template.md § 1.3 + FR-023.
 *
 * Post-R3.2 flow (single tx via `withTxAllowDeleted`) — three branches
 * after `findByIdAllowDeletedInTx`:
 *   (a) row not found in RLS scope → cross-tenant probe → emit
 *       `broadcast_template_cross_tenant_probe` (tx=null, forensic
 *       record of the failure) → return `{kind: 'not_found'}`
 *   (b) row exists but already soft-deleted → idempotent no-op →
 *       `logger.info` benign branch (R4.3 M-5) → return
 *       `{kind: 'not_found'}` (audit emit skipped; first-delete audit
 *       row already exists)
 *   (c) live row → `port.softDelete` (sets deleted_at = now()) → emit
 *       `broadcast_template_deleted` with `startedFromCount` snapshot
 *       (FR-023 forensic visibility) → return `ok`
 *
 * Drafts that originated from this template are NOT affected — the
 * broadcasts.started_from_template_id FK uses ON DELETE SET NULL but
 * `templateNameSnapshot` column on broadcasts preserves the name.
 *
 * Pure Application logic.
 */
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import type {
  BroadcastTemplatesPort,
  TemplateDeleteError,
} from '../ports/broadcast-templates-port';
import type { AuditPort } from '../ports/audit-port';
import { emitTemplateCrossTenantProbeAudit } from './_emit-cross-tenant-probe';
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
  // R3.2 H-1 — load + delete + audit in ONE withTx so we can use
  // findByIdAllowDeletedInTx to distinguish:
  //   (a) cross-tenant probe (template doesn't exist in tenant) →
  //       emit cross-tenant-probe audit + return not_found
  //   (b) already soft-deleted (benign double-delete race) → return
  //       not_found SILENTLY (no false-positive probe audit)
  //   (c) live template → soft-delete + audit normally
  return deps.port.withTx(input.tenantId, async (tx) => {
    const existing = await deps.port.findByIdAllowDeletedInTx(
      input.tenantId,
      input.templateId,
      tx,
    );
    if (!existing) {
      // (a) — true cross-tenant probe. RLS confined the row.
      await emitTemplateCrossTenantProbeAudit({
        audit: deps.audit,
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        templateId: input.templateId,
        operation: 'delete',
        requestId: input.requestId,
      });
      return err<DeleteBroadcastTemplateError>({ kind: 'not_found' });
    }
    if (existing.deletedAt !== null) {
      // (b) — already soft-deleted. Benign double-delete race
      // (admin clicked twice, two admins raced). Return not_found
      // without polluting forensics with a false cross-tenant probe.
      // R4.3 M-5 — info-level observability so SRE can confirm the
      // benign branch is hit when a delete returns 404; cross-tenant
      // probes go to the audit log via path (a), but this branch has
      // historically been silent.
      // R6.4 M-3 — guard against Drizzle driver returning `deletedAt`
      // as `Date | string` depending on driver settings. The `!== null`
      // branch above ensures non-null but does NOT prove it's a Date.
      // Crashing here would convert the idempotent-no-op return into
      // a 500 internal_error and bypass the documented path-(b)
      // contract.
      logger.info(
        {
          tenantId: input.tenantId,
          templateId: input.templateId,
          actorUserId: input.actorUserId,
          deletedAt:
            existing.deletedAt instanceof Date
              ? existing.deletedAt.toISOString()
              : String(existing.deletedAt),
          requestId: input.requestId,
        },
        'broadcasts.template.delete_idempotent_noop',
      );
      return err<DeleteBroadcastTemplateError>({ kind: 'not_found' });
    }

    // (c) — live template. Atomic soft-delete + audit. FR-023 —
    // audit row preserves `started_from_count` at delete time for
    // forensic visibility even after the template is gone.
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
