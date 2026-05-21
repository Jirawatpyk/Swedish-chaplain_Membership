/**
 * snapshotTemplateToDraft — member compose: pull a template into a draft.
 *
 * Per contracts/broadcast-template.md § 1.4 + § 5 + SC-007a. 6-stage
 * flow:
 *
 *   STAGE 1 (pre-tx) — Parse draftId via parseBroadcastId (Result-
 *     returning; defensive against direct callers bypassing the
 *     route's zod validation).
 *   STAGE 2 (pre-tx) — Verify draft ownership via
 *     broadcastsRepo.findOwnedByMember. On `cross_member` probeKind
 *     → emit `broadcast_cross_member_probe` audit → return
 *     `draft_not_found`. On `not_found` → return `draft_not_found`
 *     silently (benign).
 *   STAGE 3 (pre-tx) — Resolve tenant display_name (env-backed;
 *     never throws per TenantDisplayNamePort contract).
 *   STAGE 4 (withTx open) — Load template via
 *     `findByIdAllowDeletedInTx`. Branch:
 *       (a) null → cross-tenant probe → emit
 *           `broadcast_cross_tenant_probe` → return
 *           `template_not_found`
 *       (b) deletedAt !== null → emit
 *           `broadcast_template_snapshot_refused_deleted` audit on
 *           the active tx → return `template_soft_deleted` (HTTP 410)
 *       (c) live template → continue
 *   STAGE 5 (in-tx) — substituteChamberName (Domain VO) HTML-escapes
 *     the chamber name into subject + body (§ 5.1 XSS guard).
 *   STAGE 6 (in-tx, audit-LAST) — `updateDraftFromTemplate` (typed
 *     ChamberSubstitutedBody parameters) + `incrementStartedFromCount`,
 *     then emit `broadcast_template_snapshotted` audit on the active
 *     tx (Constitution I clause 3 atomicity). Audit fires AFTER both
 *     mutations succeed so a thrown BroadcastConcurrentMutationError
 *     can roll back the whole tx without leaving a ghost audit row.
 *
 * Error kinds: `template_not_found` (404), `template_soft_deleted`
 * (410), `draft_not_found` (404), `draft_status_drift` (409 from
 * BroadcastConcurrentMutationError), `invalid_input` (400). Bare
 * BroadcastNotFoundError thrown by the adapter (post-ownership-check
 * disappearance — Constitution I clause 2 invariant violation) is
 * caught + mapped to `draft_not_found` + logged at error severity.
 *
 * The snapshot is FROZEN — subsequent admin edits to the template do
 * NOT mutate the draft (T094 integration test).
 */
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { substituteChamberName } from '../../domain/value-objects/template-snapshot';
import { parseBroadcastId } from '../../domain/broadcast';
import type { BroadcastTemplatesPort } from '../ports/broadcast-templates-port';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import {
  BroadcastConcurrentMutationError,
  BroadcastNotFoundError,
} from '../ports/broadcasts-repo';
import type { TenantDisplayNamePort } from '../ports/tenant-display-name-port';
import type { AuditPort } from '../ports/audit-port';
import type { BroadcastStatus } from '../../domain/value-objects/broadcast-status';
import { safeAuditEmit, safeAuditEmitTyped } from './_safe-audit-emit';
import { emitTemplateCrossTenantProbeAudit } from './_emit-cross-tenant-probe';
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
  // R3-F11 — distinguishes "template was soft-deleted between picker
  // render and snapshot click" (TOCTOU race) from "template never
  // existed in this tenant" (cross-tenant probe / stale picker). The
  // route surfaces this as HTTP 410 Gone with a member-facing message
  // hint ("This template was deleted by an admin. Choose another or
  // start blank.") instead of a confusing 404.
  | { readonly kind: 'template_soft_deleted' }
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
  //    braces against direct callers (tests + future internal jobs).
  //    R2.2 D3 — collapsed try/catch via Result-returning parseBroadcastId
  //    (asBroadcastId is the trusted-input variant and doesn't throw).
  const parsed = parseBroadcastId(input.draftId);
  if (!parsed.ok) {
    return err({ kind: 'invalid_input', detail: 'draftId must be a UUID' });
  }
  const broadcastId = parsed.value;

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

  // 4. Atomic withTx: template read (TOCTOU-safe via findByIdAllowDeletedInTx) +
  //    snapshot audit + draft UPDATE + counter increment. All writes
  //    co-commit; failure on any rolls back the whole snapshot
  //    (Constitution I clause 3 atomicity).
  return deps.templatesPort.withTx(input.tenantId, async (tx) => {
    // R1.2 H-sf-2 + R3-F11: read template INSIDE the same tx where
    // the snapshot mutation lands (TOCTOU-safe). Use the
    // allow-deleted variant so we can distinguish soft-deleted from
    // never-existed without an extra query.
    const template = await deps.templatesPort.findByIdAllowDeletedInTx(
      input.tenantId,
      input.templateId,
      tx,
    );
    // R3-F11: discriminate soft-deleted (TOCTOU race after picker
    // render) from genuine not-found / cross-tenant probe. The
    // template's `deletedAt` is populated by the allow-deleted query.
    if (template && template.deletedAt !== null) {
      // R3.1 C-3 — distinct event from `broadcast_template_snapshotted`
      // so SIEM count filters don't conflate refusals with successes.
      //
      // R6.4 M-1 — refused-deleted is a TERMINAL READ-ONLY outcome
      // with NO mutations to co-commit. Use `safeAuditEmitTyped(null, ...)`
      // so an audit-storage hiccup does NOT roll back the (empty) tx
      // and convert the user-visible HTTP 410 → 500. R3.2 H-2's prior
      // `audit.emit(tx, ...)` choice presumed atomicity-with-mutation,
      // but no mutations run on this branch — the forensic record
      // survives best-effort and the 410 status remains correct.
      //
      // R8.1 M-1 — upgraded from `safeAuditEmit` (wide payload) to
      // `safeAuditEmitTyped<E>` (narrow payload). Restores the
      // compile-time payload narrowing the success branch (line 320)
      // already enjoys via `emitTyped`. Symmetric type contract across
      // both audit-of-refusal + audit-of-success paths.
      await safeAuditEmitTyped(deps.audit, null, {
        eventType: 'broadcast_template_snapshot_refused_deleted',
        actorUserId: input.actorUserId,
        tenantId: input.tenantId,
        summary: `Refused snapshot of soft-deleted template ${input.templateId}`,
        payload: {
          broadcastId: input.draftId,
          templateId: template.id,
          templateNameSnapshot: template.name,
          memberId: input.memberId,
        },
        requestId: input.requestId,
      });
      return err<SnapshotTemplateToDraftError>({ kind: 'template_soft_deleted' });
    }
    if (!template) {
      // RLS-confined null. Emit probe audit (safeAuditEmit so audit-
      // storage hiccup doesn't break the rollback flow). R2.2 A2
      // helper handles the resourceKind='template' payload shape.
      await emitTemplateCrossTenantProbeAudit({
        audit: deps.audit,
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        templateId: input.templateId,
        operation: 'snapshot',
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

    // R4.1 C-3 — AUDIT-LAST pattern: mutations run FIRST so failures
    // (BroadcastConcurrentMutationError / BroadcastNotFoundError /
    // unexpected throws) bubble out of withTx → Drizzle rolls back
    // → no audit row persists for failed snapshots. The pre-R4.1 order
    // (audit FIRST, then mutations) left ghost `broadcast_template_
    // snapshotted` rows on the audit log when subsequent UPDATEs threw
    // because the use-case caught + returned err(...) — but Drizzle
    // only rolls back on THROWN exceptions, not returned-Err Results.
    // SIEM false-positives the ghost rows as successful snapshots.
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
      await deps.templatesPort.incrementStartedFromCount(
        input.tenantId,
        template.id,
        tx,
      );
    } catch (e) {
      // R1.2 H-sf-3: discriminate concurrent-mutation race (status
      // drifted out of 'draft' between findOwnedByMember check and
      // this UPDATE) from generic adapter failures. Emit `broadcast_
      // concurrent_action_blocked` via safeAuditEmit(null) so the
      // failure-audit survives the tx rollback (forensic record of
      // the failure — co-commits with the snapshot tx would make it
      // disappear). Different semantics from the success audit below
      // which DOES need atomic co-commit.
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
      // R3.3 H-6 — typed BroadcastNotFoundError = post-ownership-check
      // disappearance (should never fire — Constitution I clause 2
      // invariant violation if it does). Surface as draft_not_found
      // to give the route handler a clean 404 path; log at error
      // severity so observability picks up the invariant violation
      // separately from the user-facing 404.
      if (e instanceof BroadcastNotFoundError) {
        logger.error(
          {
            tenantId: input.tenantId,
            draftId: input.draftId,
            templateId: input.templateId,
          },
          'broadcasts.snapshot.post_ownership_check_disappearance',
        );
        return err<SnapshotTemplateToDraftError>({ kind: 'draft_not_found' });
      }
      // Unexpected — log + rethrow. Route's outer try/catch maps to 500
      // internal_error (test mocks may also propagate via this branch).
      //
      // R6.5 L-3 — Sentry-readiness note (mirror of `template-form.tsx`
      // R4.3 M-7): when Sentry is added in F7.1b, wrap with
      // `Sentry.captureException(e)` BEFORE `throw e` so the
      // exception lands in Sentry with full stack + correlationId
      // (currently in scope as `input.requestId`). The structured
      // `err: e.message` log loses the stack — Sentry would preserve
      // it.
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
    // R4.1 C-3 — emit success audit AFTER mutations succeed. If
    // audit storage fails here, the withTx rolls back the mutations
    // (audit failure is a stop-the-line signal — mutations + audit
    // must co-commit per Constitution I clause 3).
    //
    // R4.3 M-15 — emitTyped narrows payload to
    // F7AuditPayloadShapes['broadcast_template_snapshotted'].
    // R6.2 H1 — see refused-deleted-branch sibling comment for why the
    // R4.3 `??` fallback was dropped (it silently widened the payload).
    await deps.audit.emitTyped(tx, {
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
    return ok({
      draftId: input.draftId,
      subject: substitutedSubject,
      bodyHtml: substitutedBody,
      templateNameSnapshot: template.name,
    });
  });
}
