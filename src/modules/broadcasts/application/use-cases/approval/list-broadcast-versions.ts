/**
 * F119 T061 — `listBroadcastVersions` (FR-002, FR-007, FR-011, FR-032;
 * contracts/admin-eblast-formatting-api.md § `GET …/[id]/version`).
 *
 * The staff side of the history record: the member's original (v0), every
 * version sent to the member with who wrote it and when, every member
 * decision with its reason (attached by `versionId` to the version it
 * concerns — FR-011), the working copy if any with its `updatedAt`
 * concurrency token, and — on the approve-as-submitted path (FR-007), where
 * no version row exists at all — `approvedAsSubmitted { at, byUserId,
 * byUserName }`. It is its OWN record: the audit trail is never read to
 * build it (FR-032).
 *
 * Read-only: one tenant tx for the three reads, then the display names —
 * the version authors, the approve-as-submitted staff user and (UX review M7,
 * FR-032 "who") each decision's member user — in ONE `ActorNameDirectoryPort`
 * call (users are owned by auth; display name only, never an email).
 * `broadcasts.read` at the route, so a manager reads the full thread. The
 * member-side read never carries a decider (`_member-view.ts`).
 *
 * Pure Application — no framework imports.
 */
import { errKind } from '@/lib/log-id';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { BroadcastId } from '../../../domain/broadcast';
import type { BroadcastVersion } from '../../../domain/approval/broadcast-version';
import type { MemberDecision } from '../../../domain/approval/member-decision';
import { stageOf, type BroadcastStage } from '../../../domain/stage/broadcast-stage';
import type { BroadcastStatus } from '../../../domain/value-objects/broadcast-status';
import type { ActorNameDirectoryPort } from '../../ports/actor-name-directory-port';
import type { AuditPort } from '../../ports/audit-port';
import type { BroadcastDecisionsRepo } from '../../ports/broadcast-decisions-repo';
import type { BroadcastVersionsRepo } from '../../ports/broadcast-versions-repo';
import { emitCrossTenantProbe } from '../_emit-cross-tenant-probe';
import type { ApprovalBroadcastsRepo } from './_approval-tx';

export interface ListBroadcastVersionsDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: Pick<ApprovalBroadcastsRepo, 'withTx' | 'findByIdInTx'>;
  readonly versionsRepo: BroadcastVersionsRepo;
  readonly decisionsRepo: BroadcastDecisionsRepo;
  readonly names: ActorNameDirectoryPort;
  readonly audit: AuditPort;
}

export interface ListBroadcastVersionsInput {
  readonly broadcastId: BroadcastId;
  readonly actorUserId: string;
  readonly requestId: string | null;
}

export interface VersionThreadEntry {
  readonly version: BroadcastVersion;
  /** The author's display name; null when unknown or unnamed. */
  readonly authoredByName: string | null;
}

/** A member decision on the staff thread, with who recorded it (FR-032). */
export interface StaffThreadDecision extends MemberDecision {
  /** The deciding member user's display name; null when unknown or unnamed. */
  readonly decidedByName: string | null;
}

export interface BroadcastVersionThread {
  readonly broadcastId: BroadcastId;
  readonly status: BroadcastStatus;
  readonly stage: BroadcastStage;
  readonly round: number;
  readonly approvedVersionId: string | null;
  /** v0 — null until marketing first starts formatting. */
  readonly memberOriginal: VersionThreadEntry | null;
  /** Every version sent to the member (v1..vn), oldest first. */
  readonly sentVersions: readonly VersionThreadEntry[];
  /** The unsent working copy, if one is open. */
  readonly workingCopy: VersionThreadEntry | null;
  /** Every member decision, oldest first, with the decider's name. */
  readonly decisions: readonly StaffThreadDecision[];
  /** FR-007 — set only when no version row exists and the E-Blast was approved. */
  readonly approvedAsSubmitted: {
    readonly at: Date;
    readonly byUserId: string;
    readonly byUserName: string | null;
  } | null;
}

export type ListBroadcastVersionsError =
  | { readonly kind: 'not_found' }
  /** An infrastructure fault; `errKind` is the error CLASS only (never `e.message` — F7-5). */
  | { readonly kind: 'server_error'; readonly errKind: string };

export async function listBroadcastVersions(
  deps: ListBroadcastVersionsDeps,
  input: ListBroadcastVersionsInput,
): Promise<Result<BroadcastVersionThread, ListBroadcastVersionsError>> {
  const slug = deps.tenant.slug;
  try {
    const read = await deps.broadcastsRepo.withTx(async (tx) => {
      const broadcast = await deps.broadcastsRepo.findByIdInTx(tx, slug, input.broadcastId);
      if (broadcast === null) return null;
      // Sequential on purpose: one tx is one connection.
      const versions = await deps.versionsRepo.listByBroadcast(slug, input.broadcastId, tx);
      const decisions = await deps.decisionsRepo.listByBroadcast(slug, input.broadcastId, tx);
      return { broadcast, versions, decisions };
    });

    if (read === null) {
      await emitCrossTenantProbe({
        audit: deps.audit,
        tenantId: slug,
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        surface: { kind: 'broadcast', broadcastId: input.broadcastId as string, useCase: 'list-broadcast-versions' },
      });
      return err({ kind: 'not_found' });
    }
    const { broadcast, versions, decisions } = read;

    const approvedAsSubmittedBy =
      versions.length === 0 && broadcast.approvedAt !== null && broadcast.approvedByUserId !== null
        ? { at: broadcast.approvedAt, byUserId: broadcast.approvedByUserId }
        : null;

    const ids = new Set(versions.map((v) => v.authoredByUserId));
    for (const d of decisions) ids.add(d.decidedByUserId);
    if (approvedAsSubmittedBy !== null) ids.add(approvedAsSubmittedBy.byUserId);
    const names = await deps.names.resolveNames([...ids]);
    const entry = (version: BroadcastVersion): VersionThreadEntry => ({
      version,
      authoredByName: names.get(version.authoredByUserId) ?? null,
    });

    const original = versions.find((v) => v.versionNo === 0);
    const workingCopy = versions.find((v) => v.sentToMemberAt === null);
    return ok({
      broadcastId: input.broadcastId,
      status: broadcast.status,
      stage: stageOf(broadcast.status),
      round: broadcast.currentRound,
      approvedVersionId: broadcast.approvedVersionId,
      memberOriginal: original === undefined ? null : entry(original),
      sentVersions: versions.filter((v) => v.versionNo > 0 && v.sentToMemberAt !== null).map(entry),
      workingCopy: workingCopy === undefined ? null : entry(workingCopy),
      decisions: decisions.map((d) => ({ ...d, decidedByName: names.get(d.decidedByUserId) ?? null })),
      approvedAsSubmitted:
        approvedAsSubmittedBy === null
          ? null
          : { ...approvedAsSubmittedBy, byUserName: names.get(approvedAsSubmittedBy.byUserId) ?? null },
    });
  } catch (e) {
    return err({ kind: 'server_error', errKind: errKind(e) });
  }
}
