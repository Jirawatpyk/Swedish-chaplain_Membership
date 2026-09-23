/**
 * F119 T058 — `saveFormattedVersion` (FR-004, FR-006, FR-033;
 * contracts/admin-eblast-formatting-api.md § `PATCH …/[id]/version`).
 *
 * Saves marketing's working copy. The body passes the SAME content rules as
 * a member's, on EVERY save (FR-004), through the SAME helpers the compose
 * path uses — never a re-implementation:
 *   - subject: trimmed, 1–200 characters (`save-draft.ts` rule);
 *   - `sanitizeHtml` — the shared sanitiser policy + the 200 KB post-sanitise
 *     cap (design-block markup included, since the markers are in the HTML);
 *   - `validateBlocks(parseBlockMarkers(…))` — the FR-041 block rules;
 *   - `validateImageSourceAllowlist` — the per-tenant image-source allow-list.
 * Every one of them runs ABOVE the transaction, so a refused save writes
 * nothing. The sanitised HTML is what is stored; the raw body never is.
 *
 * Optimistic concurrency (FR-033, the "two marketing users" edge case): under
 * the broadcast row lock, the working copy's `updated_at` must equal
 * `expectedUpdatedAt`, else `version_changed` carrying the current token and
 * content so the client can say "someone else changed this" instead of
 * overwriting. The compare is made here in JS on the ms-precision `Date`, not
 * as a SQL `updated_at = $x` (the column is µs; the client echoes ms). The new
 * token is written explicitly and is strictly later than the old one, so two
 * saves in the same millisecond still invalidate each other.
 *
 * A save is not a hand-off: NO audit event (contract) — counted
 * `broadcasts_version_saved_total`. It voids nothing either: changing the
 * working copy (including only its `note_to_member`) never touches
 * `approved_version_id` — this use case has no `applyTransition` call at all.
 *
 * Pure Application — no framework imports.
 */
import { broadcastsMetrics } from '@/lib/metrics';
import { errKind } from '@/lib/log-id';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { BroadcastId } from '../../../domain/broadcast';
import type { BroadcastVersion } from '../../../domain/approval/broadcast-version';
import {
  hasBlockViolations,
  parseBlockMarkers,
  validateBlocks,
  type BlockViolations,
} from '../../../domain/design-blocks/block-markers';
import type { BroadcastStatus } from '../../../domain/value-objects/broadcast-status';
import type { AuditPort } from '../../ports/audit-port';
import type { BroadcastVersionsRepo } from '../../ports/broadcast-versions-repo';
import type { ClockPort } from '../../ports/clock-port';
import type { HtmlSanitizerPort } from '../../ports/html-sanitizer-port';
import type { ImageAllowlistPort } from '../../ports/image-allowlist-port';
import { emitCrossTenantProbe } from '../_emit-cross-tenant-probe';
import { sanitizeHtml } from '../sanitize-html';
import { validateImageSourceAllowlist } from '../validate-image-source-allowlist';
import { ApprovalRefusal, type ApprovalBroadcastsRepo } from './_approval-tx';

/** Mirrors `broadcast_versions_subject_length` and `save-draft.ts`. */
export const FORMATTED_VERSION_SUBJECT_MAX = 200;

export interface SaveFormattedVersionDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: Pick<ApprovalBroadcastsRepo, 'withTx' | 'lockForUpdate' | 'findByIdInTx'>;
  readonly versionsRepo: BroadcastVersionsRepo;
  readonly sanitizer: HtmlSanitizerPort;
  readonly imageAllowlist: ImageAllowlistPort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
}

export interface SaveFormattedVersionInput {
  readonly broadcastId: BroadcastId;
  readonly actorUserId: string;
  readonly requestId: string | null;
  readonly subject: string;
  readonly bodyHtml: string;
  readonly bodySource: string;
  /** ≤ 1,000 chars — bounded by the route's zod schema (FR-006). */
  readonly noteToMember: string | null;
  /** The `updatedAt` the client last read — the concurrency token. */
  readonly expectedUpdatedAt: Date;
}

export interface SaveFormattedVersionOutput {
  readonly version: BroadcastVersion;
}

export type SaveFormattedVersionError =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'stage_changed'; readonly status: BroadcastStatus }
  | { readonly kind: 'no_working_copy' }
  | { readonly kind: 'version_changed'; readonly current: BroadcastVersion }
  | { readonly kind: 'subject_invalid'; readonly reason: 'empty' | 'too_long' }
  | { readonly kind: 'body_too_large'; readonly bytes: number }
  | { readonly kind: 'unsafe_content'; readonly reason: string }
  | { readonly kind: 'content_rules'; readonly violations: BlockViolations }
  | { readonly kind: 'image_source_not_allowlisted'; readonly unsafeImageSources: readonly string[] }
  /** An infrastructure fault; `errKind` is the error CLASS only (never `e.message` — F7-5). */
  | { readonly kind: 'server_error'; readonly errKind: string };

export async function saveFormattedVersion(
  deps: SaveFormattedVersionDeps,
  input: SaveFormattedVersionInput,
): Promise<Result<SaveFormattedVersionOutput, SaveFormattedVersionError>> {
  const slug = deps.tenant.slug;

  // ---- Content rules, all ABOVE the tx (FR-004) --------------------------
  const subject = input.subject.trim();
  if (subject.length === 0) return err({ kind: 'subject_invalid', reason: 'empty' });
  if (subject.length > FORMATTED_VERSION_SUBJECT_MAX) return err({ kind: 'subject_invalid', reason: 'too_long' });

  const sanitised = sanitizeHtml({ sanitizer: deps.sanitizer }, { rawHtml: input.bodyHtml });
  if (!sanitised.ok) {
    switch (sanitised.error.kind) {
      case 'broadcast_body_too_large':
        return err({ kind: 'body_too_large', bytes: sanitised.error.bytes });
      case 'broadcast_body_unsafe_html':
        return err({ kind: 'unsafe_content', reason: sanitised.error.reason });
      case 'sanitizer_unavailable':
        return err({ kind: 'server_error', errKind: 'sanitizer_unavailable' });
    }
  }
  const bodyHtml = sanitised.value.sanitisedHtml;

  const violations = validateBlocks(parseBlockMarkers(bodyHtml));
  if (hasBlockViolations(violations)) return err({ kind: 'content_rules', violations });

  const images = await validateImageSourceAllowlist(
    { allowlistPort: deps.imageAllowlist, audit: deps.audit },
    { bodyHtml, tenantId: slug, actorUserId: input.actorUserId, requestId: input.requestId ?? 'save-formatted-version' },
  );
  if (!images.ok) {
    return err({ kind: 'image_source_not_allowlisted', unsafeImageSources: images.error.unsafeImageSources });
  }

  const noteToMember = input.noteToMember === null || input.noteToMember.trim() === '' ? null : input.noteToMember;

  // ---- One tenant tx, throw-to-rollback -----------------------------------
  let saved: BroadcastVersion;
  try {
    saved = await deps.broadcastsRepo.withTx(async (tx) => {
      await deps.broadcastsRepo.lockForUpdate(tx, slug, input.broadcastId);
      const broadcast = await deps.broadcastsRepo.findByIdInTx(tx, slug, input.broadcastId);
      if (broadcast === null) throw new ApprovalRefusal<SaveFormattedVersionError>({ kind: 'not_found' });
      if (broadcast.status !== 'in_design') {
        throw new ApprovalRefusal<SaveFormattedVersionError>({ kind: 'stage_changed', status: broadcast.status });
      }
      const versions = await deps.versionsRepo.listByBroadcast(slug, input.broadcastId, tx);
      const workingCopy = versions.find((v) => v.sentToMemberAt === null);
      if (workingCopy === undefined) throw new ApprovalRefusal<SaveFormattedVersionError>({ kind: 'no_working_copy' });
      if (workingCopy.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
        throw new ApprovalRefusal<SaveFormattedVersionError>({ kind: 'version_changed', current: workingCopy });
      }

      // Strictly later than the token the client holds, even inside one ms.
      const now = deps.clock.now();
      const updatedAt = new Date(Math.max(now.getTime(), workingCopy.updatedAt.getTime() + 1));
      const updated = await deps.versionsRepo.updateWorkingCopy(
        slug,
        workingCopy.id,
        { subject, bodyHtml, bodySource: input.bodySource, noteToMember, updatedAt },
        tx,
      );
      // Unreachable under the row lock (a send takes the same lock) — a
      // throw, so the tx rolls back rather than reporting a phantom save.
      if (updated === null) throw new Error('working copy vanished under the broadcast lock');
      return updated;
    });
  } catch (e) {
    if (e instanceof ApprovalRefusal) {
      const refusal = e.refusal as SaveFormattedVersionError;
      if (refusal.kind === 'not_found') {
        await emitCrossTenantProbe({
          audit: deps.audit,
          tenantId: slug,
          actorUserId: input.actorUserId,
          requestId: input.requestId,
          surface: { kind: 'broadcast', broadcastId: input.broadcastId as string, useCase: 'save-formatted-version' },
        });
      }
      return err(refusal);
    }
    return err({ kind: 'server_error', errKind: errKind(e) });
  }

  broadcastsMetrics.versionSaved(slug);
  return ok({ version: saved });
}
