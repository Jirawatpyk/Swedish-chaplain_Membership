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
import { logger } from '@/lib/logger';
import { substituteChamberName } from '../../domain/value-objects/template-snapshot';
import { asBroadcastId, type BroadcastId } from '../../domain/broadcast';
import type { BroadcastTemplatesPort } from '../ports/broadcast-templates-port';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import { BroadcastConcurrentMutationError } from '../ports/broadcasts-repo';
import type { TenantDisplayNamePort } from '../ports/tenant-display-name-port';
import type { AuditPort } from '../ports/audit-port';
import type { BroadcastStatus } from '../../domain/value-objects/broadcast-status';
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
  | { readonly kind: 'invalid_input'; readonly detail: string }
  // R1.2 H-sf-3: discriminate concurrent-mutation race from genuine
  // not-found so the route surfaces 409 (immutable-after-submit) instead
  // of a misleading 404. currentStatus comes from the repo's TOCTOU
  // probe inside updateDraftFromTemplate.
  | { readonly kind: 'draft_status_drift'; readonly currentStatus: BroadcastStatus };

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
  // 1. Parse draftId. Route already zod-validated; this is belt-and-
  //    braces against direct callers (e.g. tests, future internal jobs).
  let broadcastId: BroadcastId;
  try {
    broadcastId = asBroadcastId(input.draftId);
  } catch {
    return err({ kind: 'invalid_input', detail: 'draftId must be a UUID' });
  }

  // 2. Verify draft ownership BEFORE entering the mutation tx. Catches
  //    cross-member draft-hijack (CRIT-1) where member B guesses
  //    member A's draftId and tries to overwrite. RLS only confines
  //    to tenant; per-member ownership is enforced here.
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

  // 3. Resolve chamber name (env-backed adapter; never throws per
  //    TenantDisplayNamePort contract).
  const chamberName = await deps.tenantDisplayName.resolve(input.tenantId);

  // 4. Atomic withTx: template read (TOCTOU-safe via findByIdInTx) +
  //    snapshot audit + draft UPDATE + counter increment. All writes
  //    co-commit; failure on any rolls back the whole snapshot
  //    (Constitution I clause 3 atomicity).
  return deps.templatesPort.withTx(input.tenantId, async (tx) => {
    // R1.2 H-sf-2: read template INSIDE the same tx where the snapshot
    // mutation lands. Closes TOCTOU window between read and write.
    const template = await deps.templatesPort.findByIdInTx(
      input.tenantId,
      input.templateId,
      tx,
    );
    if (!template) {
      // RLS-confined null. Emit probe audit (safeAuditEmit so audit-
      // storage hiccup doesn't break the rollback flow).
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
      return err<SnapshotTemplateToDraftError>({ kind: 'template_not_found' });
    }

    // Substitute {{chamber_name}} (Domain VO; pure) — HTML-escaped per § 5.1.
    const substitutedSubject = substituteChamberName(
      template.subject,
      chamberName,
    );
    const substitutedBody = substituteChamberName(
      template.bodyHtml,
      chamberName,
    );

    // Snapshot-moment audit FIRST — captures actor + template + broadcast
    // + name BEFORE the mutations so forensic timeline has a "who/what/
    // when" record even if subsequent writes fail (which would roll back
    // this audit row too — that's correct semantics).
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
    try {
      await deps.broadcastsRepo.updateDraftFromTemplate(
        tx,
        input.tenantId as string,
        broadcastId,
        {
          subject: substitutedSubject,
          bodyHtml: substitutedBody,
          // bodySource mirrors bodyHtml for templates — admin authors
          // HTML only; no separate plain-text source.
          bodySource: substitutedBody,
          startedFromTemplateId: template.id,
          templateNameSnapshot: template.name,
        },
      );
    } catch (e) {
      // R1.2 H-sf-3: discriminate concurrent-mutation race (status
      // drifted out of 'draft' between findOwnedByMember check and
      // this UPDATE) from generic adapter failures. Emit `broadcast_
      // concurrent_action_blocked` audit (M-code-1 closure) and surface
      // a typed `draft_status_drift` kind so the route can return HTTP
      // 409 with broadcast_immutable_after_submit code.
      if (e instanceof BroadcastConcurrentMutationError) {
        await safeAuditEmit(deps.audit, null, {
          eventType: 'broadcast_concurrent_action_blocked',
          actorUserId: input.actorUserId,
          tenantId: input.tenantId,
          summary: `Concurrent mutation on snapshot-template draft ${input.draftId} (observed status=${e.observedStatus})`,
          payload: {
            broadcastId: input.draftId,
            observedStatus: e.observedStatus,
            attempt: 'snapshot-template',
          },
          requestId: input.requestId,
        });
        return err<SnapshotTemplateToDraftError>({
          kind: 'draft_status_drift',
          currentStatus: e.observedStatus,
        });
      }
      // Unexpected — log + rethrow. Route's outer try/catch maps to 500
      // internal_error (test mocks may also propagate via this branch).
      logger.error(
        {
          err: e instanceof Error ? e.message : String(e),
          tenantId: input.tenantId,
          draftId: input.draftId,
          templateId: input.templateId,
        },
        'broadcasts.snapshot.unexpected_error',
      );
      throw e;
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
