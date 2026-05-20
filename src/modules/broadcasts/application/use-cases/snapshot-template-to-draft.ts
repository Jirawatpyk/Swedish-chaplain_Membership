/**
 * snapshotTemplateToDraft — member compose: pull a template into a draft.
 *
 * Per contracts/broadcast-template.md § 1.4 + § 5 + SC-007a:
 *   1. Load template (RLS-confined) — null → emit broadcast_cross_tenant
 *      _probe audit (with probedTemplateId + resourceKind='template')
 *      → return template_not_found
 *   2. Verify draft ownership via broadcastsRepo.findOwnedByMember.
 *      On `cross_member` probeKind → emit broadcast_cross_member_probe
 *      audit → return draft_not_found. On `not_found` → return draft_
 *      not_found (no audit; benign).
 *   3. Resolve tenant display_name (env-backed; never throws).
 *   4. Apply substituteChamberName (Domain VO) to subject + bodyHtml —
 *      HTML-escapes the display name to prevent XSS via tenant-name
 *      injection (§ 5.1).
 *   5. Atomic withTx: emit broadcast_template_snapshotted audit
 *      (Constitution I clause 3), then updateDraftFromTemplate, then
 *      incrementStartedFromCount. All co-commit or roll back together.
 *
 * The snapshot is FROZEN — subsequent admin edits to the template do
 * NOT mutate the draft (T094 integration test).
 */
import { err, ok, type Result } from '@/lib/result';
import { substituteChamberName } from '../../domain/value-objects/template-snapshot';
import { asBroadcastId, type BroadcastId } from '../../domain/broadcast';
import type { BroadcastTemplatesPort } from '../ports/broadcast-templates-port';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import type { TenantDisplayNamePort } from '../ports/tenant-display-name-port';
import type { AuditPort } from '../ports/audit-port';
import { safeAuditEmit } from './_safe-audit-emit';
import { asMemberId } from '@/modules/members';
import type { TenantSlug } from '@/modules/tenants';

export interface SnapshotTemplateToDraftDeps {
  readonly templatesPort: BroadcastTemplatesPort;
  readonly broadcastsRepo: BroadcastsRepo;
  readonly tenantDisplayName: TenantDisplayNamePort;
  readonly audit: AuditPort;
}

export interface SnapshotTemplateToDraftInput {
  readonly tenantId: TenantSlug;
  readonly actorUserId: string;
  readonly memberId: string;
  readonly draftId: string;
  readonly templateId: string;
  readonly requestId: string;
}

export type SnapshotTemplateToDraftError =
  | { readonly kind: 'template_not_found' }
  | { readonly kind: 'draft_not_found' }
  | { readonly kind: 'invalid_input'; readonly detail: string };

export interface SnapshotTemplateToDraftOutput {
  readonly draftId: string;
  readonly subject: string;
  readonly bodyHtml: string;
  readonly templateNameSnapshot: string;
}

export async function snapshotTemplateToDraft(
  deps: SnapshotTemplateToDraftDeps,
  input: SnapshotTemplateToDraftInput,
): Promise<
  Result<SnapshotTemplateToDraftOutput, SnapshotTemplateToDraftError>
> {
  // 1. Load template (RLS-confined). Null → cross-tenant probe.
  const template = await deps.templatesPort.findById(
    input.tenantId,
    input.templateId,
  );
  if (!template) {
    await safeAuditEmit(deps.audit, null, {
      eventType: 'broadcast_cross_tenant_probe',
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      summary: `Cross-tenant probe on snapshot-template ${input.templateId}`,
      payload: {
        probedTenantId: input.tenantId,
        probedTemplateId: input.templateId,
        resourceKind: 'template',
      },
      requestId: input.requestId,
    });
    return err({ kind: 'template_not_found' });
  }

  // 2. Parse draftId (UUID brand cast — never throws, but parseBroadcastId
  //    is the validating variant; route already zod-validated so the
  //    runtime check here is belt-and-braces against direct callers.)
  let broadcastId: BroadcastId;
  try {
    broadcastId = asBroadcastId(input.draftId);
  } catch {
    return err({ kind: 'invalid_input', detail: 'draftId must be a UUID' });
  }

  // 3. Verify draft ownership BEFORE entering the mutation tx. Catches
  //    cross-member draft-hijack (CRIT-1) where member B guesses
  //    member A's draftId and tries to overwrite. RLS only confines
  //    to tenant; per-member is enforced here.
  const ownership = await deps.broadcastsRepo.findOwnedByMember(
    input.tenantId as string,
    asMemberId(input.memberId),
    broadcastId,
  );
  if (ownership.probeKind === 'cross_member') {
    await safeAuditEmit(deps.audit, null, {
      eventType: 'broadcast_cross_member_probe',
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      summary: `Cross-member probe on snapshot-template draft ${input.draftId}`,
      payload: {
        probedMemberId: input.memberId,
        probedBroadcastId: input.draftId,
      },
      requestId: input.requestId,
    });
    return err({ kind: 'draft_not_found' });
  }
  if (ownership.probeKind === 'not_found') {
    return err({ kind: 'draft_not_found' });
  }

  // 4. Resolve chamber name (env-backed adapter; never throws per
  //    TenantDisplayNamePort contract).
  const chamberName = await deps.tenantDisplayName.resolve(input.tenantId);

  // 5. Substitute {{chamber_name}} — HTML-escaped per § 5.1.
  const substitutedSubject = substituteChamberName(
    template.subject,
    chamberName,
  );
  const substitutedBody = substituteChamberName(
    template.bodyHtml,
    chamberName,
  );

  // 6. Atomic withTx: snapshot audit + draft UPDATE + counter increment.
  //    All three writes co-commit; a transient failure on any rolls back
  //    the entire snapshot operation (Constitution I clause 3).
  return deps.templatesPort.withTx(input.tenantId, async (tx) => {
    // Snapshot-moment audit first — captures actor + template +
    // broadcast + name BEFORE the mutations so forensic timeline has
    // a "who/what/when" record even if the subsequent writes fail.
    await deps.audit.emit(tx, {
      eventType: 'broadcast_template_snapshotted',
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      summary: `Snapshotted template ${template.name} into draft ${input.draftId}`,
      payload: {
        broadcastId: input.draftId,
        templateId: template.id,
        templateNameSnapshot: template.name,
        memberId: input.memberId,
      },
      requestId: input.requestId,
    });
    if (!deps.broadcastsRepo.updateDraftFromTemplate) {
      throw new Error(
        'broadcastsRepo.updateDraftFromTemplate is not implemented — US7 snapshot path requires it',
      );
    }
    await deps.broadcastsRepo.updateDraftFromTemplate(
      tx,
      input.tenantId as string,
      broadcastId,
      {
        subject: substitutedSubject,
        bodyHtml: substitutedBody,
        // bodySource mirrors bodyHtml for templates — admin authors HTML
        // only; no separate plain-text source.
        bodySource: substitutedBody,
        startedFromTemplateId: template.id,
        templateNameSnapshot: template.name,
      },
    );
    await deps.templatesPort.incrementStartedFromCount(
      input.tenantId,
      template.id,
      tx,
    );
    return ok({
      draftId: input.draftId,
      subject: substitutedSubject,
      bodyHtml: substitutedBody,
      templateNameSnapshot: template.name,
    });
  });
}
