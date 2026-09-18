/**
 * F119 T108 (FR-046) — count one template start.
 *
 * `broadcast_templates.started_from_count` is the template library's only
 * adoption signal, and until this use case nothing on the shipped path wrote
 * to it. `snapshotTemplateToDraft` increments it, but it needs a SAVED draft
 * to snapshot into; the member picks a template before any draft exists (the
 * picker re-seeds the form in place — T140), and the `?template=` deep link
 * only pre-populates the compose page. Every row read `0`.
 *
 * This is the counting half of that path and nothing else: it does not touch a
 * draft, it writes no content, and it is called once per accepted start by
 * `POST /api/broadcasts/templates/[id]/started`. `snapshotTemplateToDraft`
 * keeps its own increment — the two paths are alternatives, never both for one
 * start, because the snapshot route is only reachable from a saved draft.
 *
 * No success audit event: the counter IS the record, and a new
 * `audit_event_type` value costs five places (§ Gotchas) for telemetry that no
 * compliance surface reads. A REFUSAL on an unknown / other-tenant id is a
 * different matter — that is a probe, and it is audited exactly as the sibling
 * template use cases audit it.
 */
import { err, ok, type Result } from '@/lib/result';
import type { TenantSlug } from '@/modules/tenants';
import type { AuditPort } from '../ports/audit-port';
import type { BroadcastTemplatesPort } from '../ports/broadcast-templates-port';
import { emitTemplateCrossTenantProbeAudit } from './_emit-cross-tenant-probe';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CountTemplateStartDeps {
  readonly templatesPort: BroadcastTemplatesPort;
  readonly audit: AuditPort;
}

export interface CountTemplateStartInput {
  readonly tenantId: TenantSlug;
  readonly actorUserId: string;
  readonly templateId: string;
  readonly requestId: string;
}

export type CountTemplateStartError =
  | { readonly kind: 'invalid_input'; readonly detail: string }
  | { readonly kind: 'template_not_found' }
  /**
   * The picker's list can outlive an admin's delete. A start from a template
   * that is gone is refused rather than counted — the row it would count is
   * no longer in the library.
   */
  | { readonly kind: 'template_soft_deleted' };

export interface CountTemplateStartOutput {
  readonly counted: true;
}

export async function countTemplateStart(
  deps: CountTemplateStartDeps,
  input: CountTemplateStartInput,
): Promise<Result<CountTemplateStartOutput, CountTemplateStartError>> {
  if (!UUID_RE.test(input.templateId)) {
    return err({ kind: 'invalid_input', detail: 'templateId must be a UUID' });
  }

  return deps.templatesPort.withTx(input.tenantId, async (tx) => {
    // Read INSIDE the tx that carries the increment (TOCTOU-safe), with the
    // allow-deleted variant so "deleted since the picker rendered" and "never
    // existed in this tenant" stay distinguishable — the sibling snapshot
    // use case's contract.
    const template = await deps.templatesPort.findByIdAllowDeletedInTx(
      input.tenantId,
      input.templateId,
      tx,
    );
    if (!template) {
      await emitTemplateCrossTenantProbeAudit({
        audit: deps.audit,
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        templateId: input.templateId,
        operation: 'start',
        requestId: input.requestId,
      });
      return err<CountTemplateStartError>({ kind: 'template_not_found' });
    }
    if (template.deletedAt !== null) {
      return err<CountTemplateStartError>({ kind: 'template_soft_deleted' });
    }

    await deps.templatesPort.incrementStartedFromCount(
      input.tenantId,
      template.id,
      tx,
    );
    return ok<CountTemplateStartOutput>({ counted: true });
  });
}
