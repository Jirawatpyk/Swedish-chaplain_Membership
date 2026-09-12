/**
 * F114 — Application port for the change-request aggregate (plan § III,
 * data-model.md § 1–2, research R2 / R3 / R9).
 *
 * Every `*InTx` method takes the caller's `runInTenant` tx — NEVER the global
 * `db` (RLS gotcha, F7.1a US2 incident). The two FOR UPDATE reads
 * (`findByIdInTx`, `findPendingBySubmitterInTx`) are what make the
 * replace-then-insert (R3) and the decide-once (R4) races serialise on the
 * row instead of on an advisory lock.
 *
 * Read-model methods (`listQueue`, `listByMember`, `listVisibleToUser`,
 * `pendingStats`, `findById`) open their own tenant tx via `ctx`.
 */
import type { TenantTx } from '@/lib/db';
import type { Member } from '../../domain/member';
import type { Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type {
  ChangeRequest,
  ChangeRequestId,
  ChangeRequestOutcome,
  ChangeRequestScope,
  ChangeRequestState,
  FieldOutcome,
  ProposedField,
  SubmitterRole,
  WithdrawnReason,
} from '../../domain/change-request/change-request';
import type { ProposableFieldKey } from '../../domain/change-request/proposable-fields';
import type { ContactId } from '../../domain/contact';
import type { UserId } from '../../domain/value-objects/user-id';
import type { MemberId, TenantId } from '../../domain/member';
import type { RepoError } from './member-repo';

/** What `submitChangeRequest` hands the repo — everything but the DB-owned columns. */
export type ChangeRequestDraft = {
  readonly id: ChangeRequestId;
  readonly tenantId: TenantId;
  readonly memberId: MemberId;
  readonly submittedByUserId: UserId;
  readonly submittedByContactId: ContactId;
  readonly submitterRoleAtSubmission: SubmitterRole;
  readonly scope: ChangeRequestScope;
  readonly submittedAt: Date;
  /** `now` when at least one staff row was queued, null when the roster was empty; T087 (PR-2) will inherit it from a replaced request when the staff email is coalesced (R8). */
  readonly staffNotifiedAt: Date | null;
  readonly fields: readonly Omit<ProposedField, 'outcome' | 'appliedAt'>[];
};

/** What `decideChangeRequest` writes in the same tx as the applied fields (R4). */
export type ChangeRequestDecision = {
  readonly decidedAt: Date;
  readonly decidedByUserId: UserId;
  readonly outcome: ChangeRequestOutcome;
  readonly reason: string | null;
  readonly note: string | null;
  readonly fields: ReadonlyArray<{
    readonly key: ProposableFieldKey;
    readonly outcome: FieldOutcome;
    /** Set iff approved — the tx time. */
    readonly appliedAt: Date | null;
  }>;
};

export type ChangeRequestListFilter = {
  readonly state?: ChangeRequestState;
  readonly outcome?: ChangeRequestOutcome;
  readonly memberId?: MemberId;
  readonly submitterUserId?: UserId;
  readonly from?: Date;
  readonly to?: Date;
};

/** Keyset cursor on `(submitted_at, id)` — opaque to callers, encoded by the route. */
export type ChangeRequestCursor = {
  readonly submittedAt: Date;
  readonly id: ChangeRequestId;
};

export type ChangeRequestPage = {
  readonly cursor: ChangeRequestCursor | null;
  readonly limit: number;
};

/** A queue / history row: the request plus the display facts the list needs (FR-027). */
export type ChangeRequestListRow = {
  readonly request: ChangeRequest;
  readonly member: {
    readonly companyName: string;
    readonly memberNumber: number;
    readonly status: Member['status'];
    readonly archived: boolean;
  };
  readonly submitter: {
    readonly displayName: string;
  };
  readonly decidedBy: {
    readonly displayName: string;
    readonly deactivated: boolean;
  } | null;
};

export type ChangeRequestListResult = {
  readonly items: readonly ChangeRequestListRow[];
  readonly nextCursor: ChangeRequestCursor | null;
};

export type PendingStats = {
  readonly count: number;
  readonly oldestSubmittedAt: Date | null;
};

export interface ChangeRequestRepo {
  /** Insert the request + its field rows. Fails `repo.conflict` on the one-pending-per-submitter index. */
  insertInTx(tx: TenantTx, draft: ChangeRequestDraft): Promise<Result<ChangeRequest, RepoError>>;

  /** `SELECT … FOR UPDATE` by id — the decide / withdraw / acknowledge lock (R4). */
  findByIdInTx(tx: TenantTx, id: ChangeRequestId): Promise<Result<ChangeRequest, RepoError>>;

  /** Plain read (no lock) for review / detail pages; `repo.not_found` outside the tenant (RLS). */
  findById(ctx: TenantContext, id: ChangeRequestId): Promise<Result<ChangeRequest, RepoError>>;

  /** The review / staff-detail projection: the request plus member, submitter and reviewer display facts. */
  findListRowById(ctx: TenantContext, id: ChangeRequestId): Promise<Result<ChangeRequestListRow, RepoError>>;

  /** The submitter's pending request, `FOR UPDATE`, or `null` (R3 replace path — the WRITERS: submit, withdraw). */
  findPendingBySubmitterInTx(
    tx: TenantTx,
    userId: UserId,
  ): Promise<Result<ChangeRequest | null, RepoError>>;

  /**
   * The same row as a PLAIN read (no lock, its own `runInTenant`) — for the
   * READ paths (the profile page, the edit page, the gate route), so a page
   * render never queues behind a decide / submit holding the row (PR-1
   * review, Rel M-5).
   */
  findPendingBySubmitter(ctx: TenantContext, userId: UserId): Promise<Result<ChangeRequest | null, RepoError>>;

  /** pending → withdrawn / `reason`; `replacedByRequestId` iff `reason === 'replaced'`. */
  withdrawInTx(
    tx: TenantTx,
    id: ChangeRequestId,
    input: {
      readonly reason: WithdrawnReason;
      readonly withdrawnAt: Date;
      readonly replacedByRequestId?: ChangeRequestId;
    },
  ): Promise<Result<ChangeRequest, RepoError>>;

  /** pending → decided: per-field outcomes + the decision columns, one statement each. */
  decideInTx(
    tx: TenantTx,
    id: ChangeRequestId,
    decision: ChangeRequestDecision,
  ): Promise<Result<ChangeRequest, RepoError>>;

  /** Sets `outcome_acknowledged_at` (idempotent — a second call keeps the first stamp). */
  acknowledgeInTx(tx: TenantTx, id: ChangeRequestId, at: Date): Promise<Result<ChangeRequest, RepoError>>;

  /** The durable 24 h cap (R9): rows by this submitter since `since`, and the oldest of them. */
  countSubmittedSince(
    tx: TenantTx,
    userId: UserId,
    since: Date,
  ): Promise<Result<{ readonly count: number; readonly oldestSubmittedAt: Date | null }, RepoError>>;

  /**
   * Tenant-wide queue: pending oldest-first by default, else newest-first (FR-027).
   *
   * The keyset cursor `(submittedAt, id)` has MILLISECOND resolution (it
   * round-trips through `Date.toISOString()`), and `submitted_at` is always
   * written from `clock.now()` (a JS Date — whole milliseconds), so no row
   * carries microseconds and the `lt(t) OR (eq(t) AND lt(id))` predicate is
   * exact. A backfill / import that writes `now()` from SQL MUST truncate to
   * milliseconds (`date_trunc('milliseconds', …)`), or the rows inside
   * `(t_truncated, t_actual)` fall silently out of a page (review round 1, REL-14).
   */
  listQueue(
    ctx: TenantContext,
    filter: ChangeRequestListFilter,
    page: ChangeRequestPage,
  ): Promise<Result<ChangeRequestListResult, RepoError>>;

  /** Per-member history, all states, newest first (FR-026). */
  listByMember(
    ctx: TenantContext,
    memberId: MemberId,
    page: ChangeRequestPage,
  ): Promise<Result<ChangeRequestListResult, RepoError>>;

  /**
   * FR-029 scope in SQL: `submitted_by_user_id = userId OR scope IN ('company','mixed')`
   * within `memberId` — never another contact's own-field request.
   */
  listVisibleToUser(
    ctx: TenantContext,
    userId: UserId,
    memberId: MemberId,
    page: ChangeRequestPage & { readonly state?: ChangeRequestState },
  ): Promise<Result<ChangeRequestListResult, RepoError>>;

  /** `count(*)`, `min(submitted_at)` over pending rows — dashboard / nav / gauges (R12). */
  pendingStats(ctx: TenantContext): Promise<Result<PendingStats, RepoError>>;
}
