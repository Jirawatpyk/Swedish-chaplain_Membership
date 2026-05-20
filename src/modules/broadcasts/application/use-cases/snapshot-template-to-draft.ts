/**
 * T102 (F7.1a US7) — `snapshotTemplateToDraft` Application use-case.
 *
 * Member compose flow per contracts/broadcast-template.md § 1.4 +
 * § 5 (variable resolution semantics) + SC-007a (≤500ms p95):
 *   1. Load template (RLS-scoped) — null → cross-tenant probe audit
 *      + template_not_found
 *   2. Resolve tenant display_name via TenantDisplayNamePort (env-
 *      backed adapter for single-tenant MVP — Phase 5E adapter).
 *      Returns 'SweCham' fallback so this never throws.
 *   3. Apply `substituteChamberName` (Domain VO T097) to template
 *      subject + bodyHtml — HTML-escapes the display name first to
 *      prevent XSS via tenant-name injection (§ 5.1 / critique E6).
 *   4. Atomic mutation+audit via repo.withTx:
 *      - broadcastsRepo.updateDraftFromTemplate (subject + bodyHtml +
 *        bodySource + started_from_template_id + template_name_snapshot)
 *      - templatesPort.incrementStartedFromCount (atomic +1)
 *      - No NEW audit event — extends existing broadcast_drafted
 *        payload at the draft-creation surface; this use-case is the
 *        snapshot moment, audited via the SC-007a metric path
 *
 * The snapshot is FROZEN — subsequent admin edits to the template do
 * NOT mutate the draft (broadcasts.body_html is a separate column,
 * verified by T094 integration test).
 *
 * Pure Application logic.
 */
import { err, ok, type Result } from '@/lib/result';
import { substituteChamberName } from '../../domain/value-objects/template-snapshot';
import { asBroadcastId, type BroadcastId } from '../../domain/broadcast';
import type { BroadcastTemplatesPort } from '../ports/broadcast-templates-port';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import type { TenantDisplayNamePort } from '../ports/tenant-display-name-port';
import type { AuditPort } from '../ports/audit-port';
import { safeAuditEmit } from './_safe-audit-emit';
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
        probedBroadcastId: input.templateId,
      },
      requestId: input.requestId,
    });
    return err({ kind: 'template_not_found' });
  }

  // 2. Resolve chamber name (env-backed adapter; never throws).
  const chamberName = await deps.tenantDisplayName.resolve(input.tenantId);

  // 3. Substitute {{chamber_name}} — HTML-escaped per § 5.1.
  const substitutedSubject = substituteChamberName(
    template.subject,
    chamberName,
  );
  const substitutedBody = substituteChamberName(
    template.bodyHtml,
    chamberName,
  );

  // 4. Atomic UPDATEs + counter increment. The two writes share the
  //    same tx so a transient failure rolls both back (draft + counter
  //    stay consistent).
  let broadcastId: BroadcastId;
  try {
    broadcastId = asBroadcastId(input.draftId);
  } catch {
    return err({ kind: 'invalid_input', detail: 'draftId must be a UUID' });
  }

  return deps.templatesPort.withTx(input.tenantId, async (tx) => {
    try {
      if (!deps.broadcastsRepo.updateDraftFromTemplate) {
        // Optional port method (see broadcasts-repo.ts JSDoc) — guards
        // against a test-mock or future adapter forgetting to wire it.
        // Production Drizzle adapter always provides this method.
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
          // bodySource mirrors bodyHtml for templates — there is no
          // separate plain-text source (admin authors HTML only).
          bodySource: substitutedBody,
          startedFromTemplateId: template.id,
          templateNameSnapshot: template.name,
        },
      );
    } catch (e) {
      // updateDraftFromTemplate throws when the draft row is missing
      // OR when its status has drifted out of 'draft'. Map both to
      // draft_not_found from the use-case boundary — the route will
      // surface 404 + the audit row from BroadcastConcurrentMutation
      // is sufficient forensic signal.
      const msg = e instanceof Error ? e.message : String(e);
      return err({
        kind: 'draft_not_found',
        // Preserve the underlying message in dev for debugging — in
        // prod the audit row carries the full forensic record.
        ...(process.env.NODE_ENV === 'development'
          ? { detail: msg } as Record<string, string>
          : {}),
      });
    }
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
