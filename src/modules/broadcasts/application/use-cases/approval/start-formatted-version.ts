/**
 * F119 T056 + T057 + T152 — `startFormattedVersion` (FR-001, FR-012, FR-034;
 * contracts/admin-eblast-formatting-api.md § `POST …/[id]/version`).
 *
 * Marketing opens a working copy of an E-Blast. In ONE tenant tx, with
 * throw-to-rollback (`_approval-tx.ts`):
 *
 *   1. Re-read the broadcast `FOR UPDATE` (advisory lock + row lock) and
 *      re-check the stage from THAT read — never from the request.
 *   2. Materialise `version_no = 0` from `broadcasts.subject` / `body_html` /
 *      `body_source` if it does not exist yet (research R2 — the last moment
 *      the member's original is intact; FR-012a later promotes the approved
 *      version over those columns).
 *   3. Insert the working copy, seeded from the latest version the member
 *      has seen (v0 on round 1).
 *   4. Transition to `in_design`, stamping `stage_entered_at`.
 *   5. The voiding arm (T057): from `member_approved` / `approved` clear
 *      `approved_version_id` and `scheduled_for` (trigger exemption E2) and
 *      audit `broadcast_member_approval_voided`. Opening a new working copy is
 *      a content edit by definition, and the ONLY thing that voids an
 *      approval (FR-012) — a brand change, a schedule change or a
 *      note-only save never reaches this code.
 *   6. Audit `broadcast_version_started`.
 *
 * Accepted stages: `submitted`; `changes_requested`; `member_approved` /
 * `approved` only when `current_round >= 1` (else `round_zero` — an
 * approve-as-submitted E-Blast was never in a design round). `in_design` is
 * the idempotent arm: the existing working copy is returned, nothing is
 * written ("201 … or the existing working copy returned"). Anything else is
 * `stage_changed`. A `member_approved` / `approved` row the dispatcher has
 * already handed over (`hasDispatchBegun`, T166 R-H1) is `sending_started`.
 *
 * **T152 — the flag gates ONE edge, not the route** (research R18): with
 * `memberApprovalEnabled` false, a row whose RE-READ status is `submitted`
 * answers `not_found` (404) — that is the single entry into the approval
 * round. Every other arm stays available with the flag off, because
 * re-opening a working copy is the only way an in-flight E-Blast the member
 * sent back can be completed (FR-034; `/speckit.analyze` round 3 H1).
 *
 * Version 0 is stored with `sent_to_member_at` = the member's submit time.
 * It is the member's own original, frozen from the moment they submitted it,
 * and two facts force a non-null stamp: the partial unique index
 * `broadcast_versions_one_unsent_idx` allows ONE unsent row per E-Blast (the
 * working copy), and the immutability trigger protects only rows whose
 * `sent_to_member_at` is set. An unstamped v0 would collide with the working
 * copy and stay editable.
 *
 * 100 % branch pinned (T158). Pure Application — no framework imports; the
 * flag arrives as a boolean from the composition root.
 */
import { errKind } from '@/lib/log-id';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { Broadcast, BroadcastId } from '../../../domain/broadcast';
import type { BroadcastVersion } from '../../../domain/approval/broadcast-version';
import { hasDispatchBegun } from '../../../domain/stage/in-progress-statuses';
import type { BroadcastStatus } from '../../../domain/value-objects/broadcast-status';
import type { AuditPort } from '../../ports/audit-port';
import type { BroadcastVersionsRepo } from '../../ports/broadcast-versions-repo';
import type { ClockPort } from '../../ports/clock-port';
import { emitCrossTenantProbe } from '../_emit-cross-tenant-probe';
import { ApprovalRefusal, type ApprovalBroadcastsRepo } from './_approval-tx';

export interface StartFormattedVersionDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: ApprovalBroadcastsRepo;
  readonly versionsRepo: BroadcastVersionsRepo;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  /** T152 — `isEblastMemberApprovalEnabled()`, read per request by the composition root. */
  readonly memberApprovalEnabled: boolean;
}

export interface StartFormattedVersionInput {
  readonly broadcastId: BroadcastId;
  readonly actorUserId: string;
  /** The session role, recorded as-is (`?? null`), never a literal. */
  readonly actorRole: string | null;
  readonly requestId: string | null;
}

export interface StartFormattedVersionOutput {
  readonly stage: 'in_design';
  /** false on the idempotent arm (the working copy already existed). */
  readonly started: boolean;
  readonly version: BroadcastVersion;
  readonly memberOriginal: BroadcastVersion;
}

export type StartFormattedVersionError =
  /** Unknown id / another tenant's row (probe audited) — or the flag is off on `submitted`. */
  | { readonly kind: 'not_found'; readonly reason: 'unknown' | 'flag_off' }
  | { readonly kind: 'stage_changed'; readonly status: BroadcastStatus }
  | { readonly kind: 'round_zero' }
  /** T166 R-H1 — the dispatcher already handed the approved row to the provider (`hasDispatchBegun`). */
  | { readonly kind: 'sending_started'; readonly status: BroadcastStatus }
  /** An infrastructure fault; `errKind` is the error CLASS only (never `e.message` — F7-5). */
  | { readonly kind: 'server_error'; readonly errKind: string };

/** The authored role of a staff-written version (the `broadcast_actor_role` enum has one staff value). */
const STAFF_AUTHOR_ROLE = 'admin_proxy' as const;

export async function startFormattedVersion(
  deps: StartFormattedVersionDeps,
  input: StartFormattedVersionInput,
): Promise<Result<StartFormattedVersionOutput, StartFormattedVersionError>> {
  const slug = deps.tenant.slug;
  try {
    return ok(
      await deps.broadcastsRepo.withTx(async (tx) => {
        await deps.broadcastsRepo.lockForUpdate(tx, slug, input.broadcastId);
        const broadcast = await deps.broadcastsRepo.findByIdInTx(tx, slug, input.broadcastId);
        if (broadcast === null) {
          throw new ApprovalRefusal<StartFormattedVersionError>({ kind: 'not_found', reason: 'unknown' });
        }
        const voiding = admitStage(broadcast, deps.memberApprovalEnabled);

        const versions = await deps.versionsRepo.listByBroadcast(slug, input.broadcastId, tx);
        const existingOriginal = versions.find((v) => v.versionNo === 0);
        const existingWorkingCopy = versions.find((v) => v.sentToMemberAt === null);

        if (broadcast.status === 'in_design') {
          // Idempotent arm — nothing is written. A row in `in_design` always
          // holds both (this use case wrote them in the tx that entered it).
          if (existingOriginal === undefined || existingWorkingCopy === undefined) {
            throw new Error('in_design broadcast without a member original and a working copy');
          }
          return { stage: 'in_design' as const, started: false, version: existingWorkingCopy, memberOriginal: existingOriginal };
        }

        const now = deps.clock.now();
        const memberOriginal =
          existingOriginal ??
          (await deps.versionsRepo.insert(
            slug,
            {
              broadcastId: input.broadcastId,
              versionNo: 0,
              subject: broadcast.subject,
              bodyHtml: broadcast.bodyHtml,
              bodySource: broadcast.bodySource,
              noteToMember: null,
              authoredByUserId: broadcast.submittedByUserId,
              authoredByRole: broadcast.actorRole,
              sentToMemberAt: broadcast.submittedAt ?? now,
            },
            tx,
          ));

        const version =
          existingWorkingCopy ??
          (await deps.versionsRepo.insert(
            slug,
            {
              broadcastId: input.broadcastId,
              versionNo: nextVersionNo(versions, memberOriginal),
              ...contentOf(latestSeen(versions, memberOriginal)),
              noteToMember: null,
              authoredByUserId: input.actorUserId,
              authoredByRole: STAFF_AUTHOR_ROLE,
              sentToMemberAt: null,
            },
            tx,
          ));

        await deps.broadcastsRepo.applyTransition(
          tx,
          slug,
          input.broadcastId,
          'in_design',
          voiding
            ? { stageEnteredAt: now, approvedVersionId: null, scheduledFor: null }
            : { stageEnteredAt: now },
          broadcast.status,
        );

        const relatedMemberId = broadcast.requestedByMemberId;
        const actorRole = input.actorRole ?? null;
        if (voiding) {
          await deps.audit.emitTyped(tx, {
            eventType: 'broadcast_member_approval_voided',
            tenantId: slug,
            requestId: input.requestId,
            actorUserId: input.actorUserId,
            summary: `E-Blast ${input.broadcastId} member approval voided by a new working copy`,
            payload: {
              related_member_id: relatedMemberId,
              broadcast_id: input.broadcastId,
              voided_version_id: broadcast.approvedVersionId,
              round: broadcast.currentRound,
              cancelled_schedule_at: broadcast.scheduledFor?.toISOString() ?? null,
              actor_role: actorRole,
            },
          });
        }
        await deps.audit.emitTyped(tx, {
          eventType: 'broadcast_version_started',
          tenantId: slug,
          requestId: input.requestId,
          actorUserId: input.actorUserId,
          summary: `E-Blast ${input.broadcastId} formatted version ${version.versionNo} started`,
          payload: {
            related_member_id: relatedMemberId,
            broadcast_id: input.broadcastId,
            version_id: version.id,
            round: version.versionNo,
            from_stage: broadcast.status,
            actor_role: actorRole,
          },
        });

        return { stage: 'in_design' as const, started: true, version, memberOriginal };
      }),
    );
  } catch (e) {
    if (e instanceof ApprovalRefusal) {
      const refusal = e.refusal as StartFormattedVersionError;
      if (refusal.kind === 'not_found' && refusal.reason === 'unknown') {
        await emitCrossTenantProbe({
          audit: deps.audit,
          tenantId: slug,
          actorUserId: input.actorUserId,
          requestId: input.requestId,
          surface: { kind: 'broadcast', broadcastId: input.broadcastId as string, useCase: 'start-formatted-version' },
        });
      }
      return err(refusal);
    }
    return err({ kind: 'server_error', errKind: errKind(e) });
  }
}

/**
 * The stage + flag + round gate, on the RE-READ row. Returns whether this
 * start voids a member approval; throws the refusal otherwise.
 */
function admitStage(broadcast: Broadcast, memberApprovalEnabled: boolean): boolean {
  switch (broadcast.status) {
    case 'submitted':
      // T152 — the only flagged edge: `submitted → in_design`.
      if (!memberApprovalEnabled) {
        throw new ApprovalRefusal<StartFormattedVersionError>({ kind: 'not_found', reason: 'flag_off' });
      }
      return false;
    case 'changes_requested':
    case 'in_design':
      return false;
    case 'member_approved':
    case 'approved':
      if (broadcast.currentRound < 1) {
        throw new ApprovalRefusal<StartFormattedVersionError>({ kind: 'round_zero' });
      }
      // T166 R-H1 — voiding an approval the dispatcher has already handed
      // over (its lock committed before the provider call) cannot stop that
      // send, and would leave its id for the next round to inherit.
      if (hasDispatchBegun(broadcast)) {
        throw new ApprovalRefusal<StartFormattedVersionError>({ kind: 'sending_started', status: broadcast.status });
      }
      return true;
    default:
      // Fail-CLOSED: every other status (draft, sending, awaiting the member,
      // every closed one) is refused — never `return _exhaustive`.
      throw new ApprovalRefusal<StartFormattedVersionError>({ kind: 'stage_changed', status: broadcast.status });
  }
}

/** The highest version the member has seen — v0 on round 1. */
function latestSeen(versions: readonly BroadcastVersion[], memberOriginal: BroadcastVersion): BroadcastVersion {
  return versions.reduce<BroadcastVersion>(
    (latest, v) => (v.sentToMemberAt !== null && v.versionNo > latest.versionNo ? v : latest),
    memberOriginal,
  );
}

/** One past the highest `version_no` on the E-Blast (v0 counts). */
function nextVersionNo(versions: readonly BroadcastVersion[], memberOriginal: BroadcastVersion): number {
  return versions.reduce((max, v) => Math.max(max, v.versionNo), memberOriginal.versionNo) + 1;
}

function contentOf(v: BroadcastVersion): Pick<BroadcastVersion, 'subject' | 'bodyHtml' | 'bodySource'> {
  return { subject: v.subject, bodyHtml: v.bodyHtml, bodySource: v.bodySource };
}
