/**
 * Application port — Member repository.
 *
 * Infrastructure adapter (Drizzle) implements this; use cases depend on
 * this interface only (Clean Architecture, Principle III).
 */
import type { TenantTx } from '@/lib/db';
import type { Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { Member, MemberId, PlanId } from '../../domain/member';
import type { Contact } from '../../domain/contact';
import type { IsoCountryCode } from '../../domain/value-objects/iso-country-code';
import type { TaxId } from '../../domain/value-objects/tax-id';

// --- Directory search types (US2) -------------------------------------------

export type DirectoryFilter = {
  readonly q?: string;
  readonly status?: readonly ('active' | 'inactive' | 'archived')[];
  readonly planYear?: number;
  readonly country?: string;
  readonly planId?: string;
  readonly limit: number;
  readonly cursor?: string;
};

/**
 * Offset-based filter for numbered pagination — used by admin lists
 * that need a total count + jump-to-page-N UX (instead of cursor
 * load-more). Offset pagination is fine here because admin tables
 * cap at ~1,000 rows per tenant.
 */
export type DirectoryOffsetFilter = {
  readonly q?: string;
  readonly status?: readonly ('active' | 'inactive' | 'archived')[];
  readonly planYear?: number;
  readonly country?: string;
  readonly planId?: string;
  readonly limit: number;
  readonly offset: number;
};

export type DirectoryRow = {
  readonly member: Member;
  readonly primaryContact: Contact | null;
  readonly planDisplayName: string | null;
};

export type RepoError =
  | { code: 'repo.not_found' }
  | { code: 'repo.conflict'; reason: string }
  | { code: 'repo.unexpected'; cause?: unknown };

/**
 * Narrowed patch type for `updateFields` — only fields that are safe
 * to mutate via a partial update. Identity fields (`tenantId`, `memberId`,
 * `createdAt`, etc.) are intentionally excluded so callers cannot
 * accidentally pass them and have them silently ignored.
 */
export type MemberPatch = Partial<
  Pick<
    Member,
    | 'companyName'
    | 'legalEntityType'
    | 'website'
    | 'description'
    | 'notes'
    | 'foundedYear'
    | 'turnoverThb'
  > & {
    country: IsoCountryCode;
    taxId: TaxId | null;
    planId: PlanId;
    planYear: number;
  }
>;

export interface MemberRepo {
  findById(
    ctx: TenantContext,
    memberId: MemberId,
  ): Promise<Result<Member, RepoError>>;

  /**
   * In-transaction variant of findById with row-level lock (SELECT ... FOR UPDATE).
   * Required by inline-edit + other atomic read-modify-write paths to avoid
   * TOCTOU races where a concurrent actor mutates the row between the read
   * and the write. Caller already holds an open transaction via runInTenant.
   *
   * SS-5: the `*InTx` variants intentionally take only `tx` (not `ctx`). The
   * transaction session already carries tenant scope via the
   * `SET LOCAL ROLE chamber_app` + `SET LOCAL app.current_tenant` statements
   * issued by `runInTenant` — RLS filters rows automatically. This contrasts
   * with `audit.recordInTx(tx, ctx, event)` where `ctx` is required because
   * `audit_log` has an explicit `tenant_id` column (not RLS-scoped).
   */
  findByIdInTx(
    tx: TenantTx,
    memberId: MemberId,
  ): Promise<Result<Member, RepoError>>;

  /**
   * Batched in-transaction lookup with row-level locks on ALL returned rows.
   * Backs the US4 bulk-action use case (SB-1 + SW-1): one
   * `SELECT ... WHERE member_id = ANY($1) FOR UPDATE` instead of N serial
   * round-trips. Locks are released on COMMIT / ROLLBACK of the ambient tx.
   *
   * Returns a `Map<MemberId, Member>` for O(1) per-item access in the caller.
   * Missing ids are absent from the Map; caller is responsible for
   * enumerating the expected vs found set and raising `not_found` as needed.
   */
  findManyByIdsInTx(
    tx: TenantTx,
    memberIds: readonly MemberId[],
  ): Promise<Result<ReadonlyMap<MemberId, Member>, RepoError>>;

  findSoftDuplicate(
    ctx: TenantContext,
    companyName: string,
    country: string,
  ): Promise<Result<Member | null, RepoError>>;

  /**
   * Transactional create: inserts the Member, its first primary Contact,
   * and the matching `member_created` audit row in one DB transaction.
   * Returns the persisted Member + Contact (with DB-generated timestamps).
   */
  /**
   * Insert member + primary contact rows inside the caller's transaction.
   * Does NOT emit audit events — caller emits `member_created` +
   * `contact_created` via `AuditPort.recordInTx` so Application-layer
   * ownership of audit emission is preserved (Principle III, S1).
   */
  createWithPrimaryContactInTx(
    tx: TenantTx,
    draft: {
      readonly member: Omit<Member, 'createdAt' | 'updatedAt'>;
      readonly primaryContact: Omit<
        Contact,
        'createdAt' | 'updatedAt' | 'memberId'
      >;
    },
  ): Promise<Result<{ member: Member; contact: Contact }, RepoError>>;

  /**
   * Persist a status-transition snapshot. Caller is responsible for
   * emitting `member_status_changed` / `member_archived` / `member_undeleted`
   * audit events via AuditPort — the repo only writes the row. Archive/
   * activate use cases will wire this up in US4 (not shipped in US1-US3).
   */
  updateStatus(
    ctx: TenantContext,
    memberId: MemberId,
    next: Member,
  ): Promise<Result<Member, RepoError>>;

  /**
   * In-transaction variant for atomic persist+audit on status changes
   * (archive, activate, inactivate). Required by US4 bulk-action and
   * inline-edit use cases to keep the status update + audit row in the
   * same tx as other mutations in the batch (FR-019 all-or-nothing).
   */
  updateStatusInTx(
    tx: TenantTx,
    memberId: MemberId,
    next: Member,
  ): Promise<Result<Member, RepoError>>;

  updateFields(
    ctx: TenantContext,
    memberId: MemberId,
    patch: MemberPatch,
  ): Promise<Result<Member, RepoError>>;

  /** In-transaction variant for atomic persist+audit (COR-8). */
  updateFieldsInTx(
    tx: TenantTx,
    memberId: MemberId,
    patch: MemberPatch,
  ): Promise<Result<Member, RepoError>>;

  /**
   * Resolve member by a linked contact's user_id. Used by portal
   * self-service (US5) to derive the member from the session user.
   * Returns the member whose contact has `linked_user_id = userId`
   * and `removed_at IS NULL`. Returns `repo.not_found` if no such
   * link exists within the tenant.
   */
  findByLinkedUserId(
    ctx: TenantContext,
    userId: string,
  ): Promise<Result<Member, RepoError>>;

  /** US2 directory search — substring across company, contact name, email. */
  searchDirectory(
    ctx: TenantContext,
    filter: DirectoryFilter,
  ): Promise<
    Result<
      { readonly items: DirectoryRow[]; readonly nextCursor: string | null },
      RepoError
    >
  >;

  // ===========================================================================
  // F7 Batch C extensions (T029) — segment resolution + halt/ack flags
  // ===========================================================================

  /**
   * F7 segment resolution. Returns members matching the segment with
   * their PRIMARY contact joined. Excludes:
   *   - members with `broadcastsHaltedUntilAdminReview = true` (Q14)
   *   - members with NULL primary-contact email (caller emits
   *     `member_missing_primary_contact` audit per FR-015c)
   *
   * Hard cap: 5,000 returned rows (FR-016a). Caller is responsible for
   * suppression filter (`marketing_unsubscribes`) at F7 dispatch boundary
   * — NOT applied here per Q8 + FR-015c separation of concerns.
   *
   * For `event_attendees_last_90d` segment: F6 stub-port returns `[]`
   * until F6 ships (FR-015a). This repo method does NOT handle that
   * segment — F7's resolver delegates to `EventAttendeesRepository`
   * stub instead.
   */
  findMembersBySegmentForBroadcast(
    ctx: TenantContext,
    params: {
      readonly segmentType: 'all_members' | 'tier';
      readonly tierCodes?: readonly string[];
    },
  ): Promise<Result<readonly F7MemberRecipient[], RepoError>>;

  /**
   * F7 — list members with `broadcasts_halted_until_admin_review = true`.
   * Powers Q14 admin queue red banner (T121, Phase 3+).
   */
  findMembersHaltedForBroadcast(
    ctx: TenantContext,
  ): Promise<Result<readonly F7MemberHaltSummary[], RepoError>>;

  /**
   * F7 — set/clear `members.broadcasts_halted_until_admin_review` flag
   * (Q14). Atomic; caller emits `broadcast_member_halted_pending_review`
   * (when set true) or `broadcast_member_dispatch_resumed` (when set
   * false) audit event in same tx.
   */
  updateBroadcastsHaltedInTx(
    tx: TenantTx,
    memberId: MemberId,
    halted: boolean,
  ): Promise<Result<{ affected: number }, RepoError>>;

  /**
   * F7 — set `members.broadcasts_acknowledged_at = now()` (Q15 GDPR
   * Art. 7 banner ack). Idempotent on already-acknowledged members
   * (returns `repo.conflict` with reason `already_acknowledged` so
   * caller can short-circuit audit emit).
   */
  updateBroadcastsAcknowledgedAtInTx(
    tx: TenantTx,
    memberId: MemberId,
    timestamp: Date,
  ): Promise<Result<{ affected: number; previouslyNull: boolean }, RepoError>>;

  /**
   * F7 — get a member's primary contact email. Returns `null` if the
   * member has no primary contact OR the email is empty. Used by
   * FR-002 precondition `j` reply-to derivation.
   */
  findPrimaryContactEmailInTx(
    tx: TenantTx,
    memberId: MemberId,
  ): Promise<Result<string | null, RepoError>>;

  /**
   * F7 — reverse lookup: find a member whose primary contact email
   * matches the given lowercase email string. Returns `null` if no
   * match. Used by FR-015d resolution branch 1 (custom-recipient
   * tenant-graph validation).
   */
  findMemberByPrimaryContactEmailInTx(
    tx: TenantTx,
    emailLower: string,
  ): Promise<Result<F7MemberRecipient | null, RepoError>>;

  /**
   * Offset-based directory search with total count — powers numbered
   * pagination on `/admin/members`. Two queries in one transaction:
   *   1. `COUNT(*) OVER ()` using the same filters
   *   2. Paged SELECT with `LIMIT + OFFSET`
   * Total count lets the UI show "Showing 1–50 of 131".
   */
  searchDirectoryWithCount(
    ctx: TenantContext,
    filter: DirectoryOffsetFilter,
  ): Promise<
    Result<
      { readonly items: DirectoryRow[]; readonly total: number },
      RepoError
    >
  >;

  /**
   * F7 US3 AS2 — most-recent `member_plan_changed` audit timestamp
   * for a member, scoped to the tenant. Returns `null` when the
   * member has no recorded plan changes (or the member doesn't
   * exist in the tenant — caller treats both cases as "no
   * explainer needed"). Read-only; does NOT need a tx parameter
   * (audit_log is append-only and the read tolerates non-tx
   * snapshots).
   */
  findLastPlanChangedAt(
    ctx: TenantContext,
    memberId: MemberId,
  ): Promise<Result<Date | null, RepoError>>;
}

// ---------------------------------------------------------------------------
// F7 Batch C — projection types for segment + halt/ack queries
// ---------------------------------------------------------------------------

/**
 * Minimal member projection returned by F7 segment resolution. NOT the
 * full F3 Member aggregate — F7 only needs identity + primary contact
 * email + tier code + halt flag for dispatch + filter purposes.
 *
 * Tier code is read from F2 `membership_plans.plan_category` (no
 * dedicated `tier_code` column on F2 plans schema as of F2 ship). If
 * F2 evolves a dedicated `tier_code` column (F2.1+), this projection
 * updates accordingly.
 */
export type F7MemberRecipient = {
  readonly memberId: string;
  readonly displayName: string;
  readonly primaryContactEmail: string | null;
  readonly tierCode: string | null;
  readonly broadcastsHaltedUntilAdminReview: boolean;
};

/**
 * Summary row for the Q14 admin halt-state banner. Includes timing
 * metadata so the banner can show "halted since X days ago".
 */
export type F7MemberHaltSummary = {
  readonly memberId: string;
  readonly displayName: string;
  /** Timestamp from `members.updated_at` at the time of halt. */
  readonly haltedSinceAt: Date;
};
