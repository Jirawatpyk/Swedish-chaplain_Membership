/**
 * T068 — `save-draft.ts` Application use-case (F7).
 *
 * Multi-draft create + update entry point (Ultraplan AD7 correction —
 * spec allows multiple concurrent drafts per member; no partial-unique).
 *
 * Flow:
 *   - Validate subject (≤200), sanitise HTML, enforce 200KB cap
 *   - Resolve member primary contact (FR-002 precondition `j`) — drafts
 *     without a deliverable reply-to are blocked at the draft boundary
 *     so members do not waste effort composing a draft they cannot
 *     submit
 *   - If `draftId` is provided → update existing draft (NO audit per FR-004)
 *   - Else → create new draft + emit `broadcast_drafted` (one event per
 *     create; subsequent edits do NOT re-audit)
 *
 * Returns the persisted Broadcast aggregate with status='draft'.
 */
import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from '@/lib/result';
import { broadcastsMetrics } from '@/lib/metrics';
import type { TenantContext } from '@/modules/tenants';
import {
  asBroadcastId,
  type Broadcast,
  type BroadcastActorRole,
} from '../../domain/broadcast';
import type { BroadcastSegmentType } from '../../domain/value-objects/segment-type';
import { composeBroadcastFromName } from '../../domain/from-name';
import type { AuditPort } from '../ports/audit-port';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import type { HtmlSanitizerPort } from '../ports/html-sanitizer-port';
import type { MembersBridgePort } from '../ports/members-bridge-port';
import { sanitizeHtml, type SanitizeHtmlError } from './sanitize-html';

const MAX_SUBJECT_LENGTH = 200;

export type SaveDraftError =
  | { readonly kind: 'broadcast_subject_too_long'; readonly length: number }
  | { readonly kind: 'broadcast_subject_empty' }
  | SanitizeHtmlError
  | {
      readonly kind: 'broadcast_member_missing_primary_contact_email';
      readonly memberId: string;
    }
  | {
      readonly kind: 'broadcast_immutable_after_submit';
      readonly broadcastId: string;
      readonly currentStatus: string;
    }
  | { readonly kind: 'broadcast_not_found'; readonly broadcastId: string }
  | { readonly kind: 'save_draft.server_error'; readonly message: string };

export interface SaveDraftDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: BroadcastsRepo;
  readonly sanitizer: HtmlSanitizerPort;
  readonly membersBridge: MembersBridgePort;
  readonly audit: AuditPort;
  readonly clock: { now(): Date };
}

export interface SaveDraftInput {
  readonly memberId: string;
  readonly submittedByUserId: string;
  readonly actorRole: Exclude<BroadcastActorRole, 'system'>;
  /** Plan ID snapshot at draft time — preserved at submit too. */
  readonly memberPlanIdSnapshot: string;
  /** Tenant display name used to compose `from_name` ("X via Tenant"). */
  readonly tenantDisplayName: string;
  /**
   * DV-17 — requesting member's display name (F3 `companyName`), the "X"
   * in the `from_name` "X via Tenant" composition (data-model.md:59).
   */
  readonly memberDisplayName: string;
  /** Existing draft id to update; omit to create a new draft. */
  readonly draftId?: string;
  readonly subject: string;
  readonly bodySource: string;
  readonly bodyHtml: string;
  readonly segmentType: BroadcastSegmentType;
  readonly segmentParams: Record<string, unknown> | null;
  readonly customRecipientEmails: ReadonlyArray<string> | null;
  readonly scheduledFor: Date | null;
  readonly requestId: string | null;
}

export interface SaveDraftOutput {
  readonly broadcast: Broadcast;
  readonly created: boolean;
}

export async function saveDraft(
  deps: SaveDraftDeps,
  input: SaveDraftInput,
): Promise<Result<SaveDraftOutput, SaveDraftError>> {
  // 1. Subject length
  const trimmedSubject = input.subject.trim();
  if (trimmedSubject.length === 0) {
    return err({ kind: 'broadcast_subject_empty' });
  }
  if (trimmedSubject.length > MAX_SUBJECT_LENGTH) {
    return err({
      kind: 'broadcast_subject_too_long',
      length: trimmedSubject.length,
    });
  }

  // 2. Sanitise body + size cap
  const sanitised = sanitizeHtml(
    { sanitizer: deps.sanitizer },
    { rawHtml: input.bodyHtml },
  );
  if (!sanitised.ok) {
    return err(sanitised.error);
  }

  // 3. Member primary contact (reply-to)
  const replyTo = await deps.membersBridge.getMemberPrimaryContact(
    deps.tenant,
    input.memberId,
  );
  if (replyTo === null) {
    return err({
      kind: 'broadcast_member_missing_primary_contact_email',
      memberId: input.memberId,
    });
  }

  // DV-17 — "<member> via <tenant>" Resend From display name (data-model.md:59).
  const fromName = composeBroadcastFromName(
    input.memberDisplayName,
    input.tenantDisplayName,
  );
  const now = deps.clock.now();

  // 4. Persist (create or update) inside a single transaction
  try {
    return await deps.broadcastsRepo.withTx(async (tx) => {
      let broadcast: Broadcast;
      let created: boolean;

      if (input.draftId === undefined) {
        // CREATE
        const broadcastId = asBroadcastId(randomUUID());
        broadcast = await deps.broadcastsRepo.insertDraft(tx, {
          tenantId: deps.tenant.slug,
          broadcastId,
          requestedByMemberId: input.memberId,
          requestedByMemberPlanIdSnapshot: input.memberPlanIdSnapshot,
          submittedByUserId: input.submittedByUserId,
          actorRole: input.actorRole,
          subject: trimmedSubject,
          bodyHtml: sanitised.value.sanitisedHtml,
          bodySource: input.bodySource,
          fromName,
          replyToEmail: replyTo as string,
          segmentType: input.segmentType,
          segmentParams: input.segmentParams,
          customRecipientEmails: input.customRecipientEmails,
          estimatedRecipientCount: 0,
          scheduledFor: input.scheduledFor,
        });
        created = true;

        await deps.audit.emit(tx, {
          tenantId: deps.tenant.slug,
          eventType: 'broadcast_drafted',
          actorUserId: input.submittedByUserId,
          summary: `Member ${input.memberId} created draft broadcast ${broadcastId}`,
          payload: {
            broadcastId,
            memberId: input.memberId,
            actorRole: input.actorRole,
            segmentType: input.segmentType,
            createdAt: now.toISOString(),
          },
          requestId: input.requestId,
        });
        // T172 — emit-site wiring (Phase 9). Compose-funnel TOF.
        broadcastsMetrics.draftCount(
          deps.tenant.slug,
          input.actorRole === 'admin_proxy' ? 'admin_proxy' : 'member_self_service',
        );
        broadcastsMetrics.auditEmitCount(deps.tenant.slug, 'broadcast_drafted');
      } else {
        // UPDATE — caller asserted draft exists; FR-004 → no audit on edit
        const broadcastId = asBroadcastId(input.draftId);
        const existing = await deps.broadcastsRepo.findByIdInTx(
          tx,
          deps.tenant.slug,
          broadcastId,
        );
        if (existing === null) {
          return err({
            kind: 'broadcast_not_found',
            broadcastId: input.draftId,
          });
        }
        // Bug #9 fix (2026-07-10): enforce per-member draft ownership. RLS
        // scopes to the tenant, NOT the individual member, and SweCham runs
        // ~95 members in one tenant — without this check a member could
        // overwrite a sibling's private draft by supplying its id. Mirror
        // the DELETE / GET / snapshot siblings (which all enforce
        // `requestedByMemberId === memberId`) and return not_found so the
        // route maps to 404 rather than leaking the draft's existence.
        if (existing.requestedByMemberId !== input.memberId) {
          return err({
            kind: 'broadcast_not_found',
            broadcastId: input.draftId,
          });
        }
        if (existing.status !== 'draft') {
          return err({
            kind: 'broadcast_immutable_after_submit',
            broadcastId: input.draftId,
            currentStatus: existing.status,
          });
        }
        broadcast = await deps.broadcastsRepo.updateDraft(
          tx,
          deps.tenant.slug,
          broadcastId,
          {
            subject: trimmedSubject,
            bodyHtml: sanitised.value.sanitisedHtml,
            bodySource: input.bodySource,
            fromName,
            replyToEmail: replyTo as string,
            segmentType: input.segmentType,
            segmentParams: input.segmentParams,
            customRecipientEmails: input.customRecipientEmails,
            scheduledFor: input.scheduledFor,
          },
        );
        created = false;
      }

      return ok({ broadcast, created });
    });
  } catch (e) {
    return err({
      kind: 'save_draft.server_error',
      message: e instanceof Error ? e.message : 'unknown error',
    });
  }
}
