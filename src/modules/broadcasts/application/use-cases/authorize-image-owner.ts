/**
 * F119 T106 / T107 / T146 — `authorizeImageOwner` (FR-040, US3-AS3, US6-AS7):
 * who may attach an image to what, decided INSIDE the tenant context before
 * a single byte is scanned or stored.
 *
 *   member   → the caller's OWN member's `draft` — the existing member route
 *              took `draftId` as an unvalidated form string (its docblock
 *              claimed a check it never made). Another member's row in the
 *              same tenant → not_found + `broadcast_cross_member_probe`; an
 *              unknown or other-tenant id (RLS makes them indistinguishable)
 *              → not_found + `broadcast_cross_tenant_probe`. Never 403: no
 *              existence leak. A closed broadcast → `closed`.
 *   staff    → a broadcast in the accepted stage set
 *              (`IMAGE_UPLOAD_STAFF_STAGES` = draft, submitted, in_design —
 *              T106a added in_design with migration 0305), same tenant. A
 *              SENT version is read-only, so awaiting_member_approval and
 *              every later stage are `closed`. Returns the
 *              owning member so the upload audit carries `related_member_id`.
 *   template → an existing template of the tenant (`owner_kind='template'`),
 *              staff only; a miss → not_found + the template probe.
 *
 * Pure Application — no framework imports.
 */
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import type { MemberId } from '@/modules/members';
import type { TenantContext } from '@/modules/tenants';
import type { BroadcastId } from '../../domain/broadcast';
import type { BroadcastStatus } from '../../domain/value-objects/broadcast-status';
import type { AuditPort } from '../ports/audit-port';
import type { BroadcastImageOwnerKind } from '../ports/broadcast-images-repo';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import type { BroadcastTemplatesPort } from '../ports/broadcast-templates-port';
import { emitCrossTenantProbe, emitTemplateCrossTenantProbeAudit } from './_emit-cross-tenant-probe';
import { safeAuditEmitTyped } from './_safe-audit-emit';

/**
 * The stage set for a STAFF image upload to an E-Blast: the
 * compose-on-behalf draft, a member's submission the proxy author may still
 * illustrate, and (T106a, PR-2) the formatted version marketing is working
 * on — `in_design`, the only stage with an editable working copy.
 */
export const IMAGE_UPLOAD_STAFF_STAGES: readonly BroadcastStatus[] = ['draft', 'submitted', 'in_design'];

/** A member may only illustrate their own unsent draft. */
export const IMAGE_UPLOAD_MEMBER_STAGES: readonly BroadcastStatus[] = ['draft'];

export interface AuthorizeImageOwnerDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: Pick<BroadcastsRepo, 'findOwnedByMember' | 'findById'>;
  readonly templates: Pick<BroadcastTemplatesPort, 'findById'>;
  readonly audit: AuditPort;
}

export type ImageUploadActor =
  | { readonly kind: 'member'; readonly memberId: MemberId }
  | { readonly kind: 'staff' };

export interface AuthorizeImageOwnerInput {
  readonly tenantId: TenantContext['slug'];
  readonly owner: { readonly kind: BroadcastImageOwnerKind; readonly id: string };
  readonly actor: ImageUploadActor;
  readonly actorUserId: string;
  readonly requestId: string;
}

export type AuthorizeImageOwnerError =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'closed'; readonly status: BroadcastStatus };

export interface AuthorizeImageOwnerOutput {
  /** The member the E-Blast is FOR (null for a template) — the audit's `related_member_id`. */
  readonly relatedMemberId: string | null;
}

export async function authorizeImageOwner(
  deps: AuthorizeImageOwnerDeps,
  input: AuthorizeImageOwnerInput,
): Promise<Result<AuthorizeImageOwnerOutput, AuthorizeImageOwnerError>> {
  if (input.owner.kind === 'template') {
    if (input.actor.kind === 'member') {
      // A member never writes to a template; treat as an unknown resource.
      return err({ kind: 'not_found' });
    }
    const template = await deps.templates.findById(input.tenantId, input.owner.id);
    if (template === null) {
      await emitTemplateCrossTenantProbeAudit({
        audit: deps.audit,
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        templateId: input.owner.id,
        operation: 'update',
        requestId: input.requestId,
      });
      return err({ kind: 'not_found' });
    }
    return ok({ relatedMemberId: null });
  }

  const broadcastId = input.owner.id as BroadcastId;
  if (input.actor.kind === 'member') {
    const found = await deps.broadcastsRepo.findOwnedByMember(input.tenantId, input.actor.memberId, broadcastId);
    if (found.broadcast === null) {
      if (found.probeKind === 'cross_member') {
        // F2-5: emit through the COMPILE-CHECKED shape with the camelCase keys
        // the sibling emitter (`snapshot-template-to-draft`) uses. The spelling
        // is deliberate: `member_id` is the one key the 0009 `last_activity_at`
        // trigger reads, so a REFUSED probe must not carry it — otherwise an
        // attacker guessing broadcast ids refreshes the probed member's recency.
        await safeAuditEmitTyped(deps.audit, null, {
          eventType: 'broadcast_cross_member_probe',
          actorUserId: input.actorUserId,
          tenantId: input.tenantId,
          summary: `Member ${input.actor.memberId} tried to attach an image to broadcast ${broadcastId} owned by another member`,
          payload: {
            probedMemberId: input.actor.memberId,
            probedBroadcastId: broadcastId,
            operation: 'image_upload',
          },
          requestId: input.requestId,
        });
      } else {
        await emitCrossTenantProbe({
          audit: deps.audit,
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          requestId: input.requestId,
          surface: { kind: 'broadcast', broadcastId, useCase: 'upload-inline-image' },
        });
      }
      return err({ kind: 'not_found' });
    }
    if (!IMAGE_UPLOAD_MEMBER_STAGES.includes(found.broadcast.status)) {
      return err({ kind: 'closed', status: found.broadcast.status });
    }
    return ok({ relatedMemberId: input.actor.memberId });
  }

  const broadcast = await deps.broadcastsRepo.findById(input.tenantId, broadcastId);
  if (broadcast === null) {
    await emitCrossTenantProbe({
      audit: deps.audit,
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      surface: { kind: 'broadcast', broadcastId, useCase: 'upload-inline-image' },
    });
    return err({ kind: 'not_found' });
  }
  if (!IMAGE_UPLOAD_STAFF_STAGES.includes(broadcast.status)) {
    logger.info(
      { tenantId: input.tenantId, broadcastId, status: broadcast.status, actorUserId: input.actorUserId },
      'broadcasts.image_upload.stage_refused',
    );
    return err({ kind: 'closed', status: broadcast.status });
  }
  return ok({ relatedMemberId: broadcast.requestedByMemberId });
}
