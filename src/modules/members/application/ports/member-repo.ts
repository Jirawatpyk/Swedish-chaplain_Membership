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
import type { Contact, ContactId } from '../../domain/contact';
import type { IsoCountryCode } from '../../domain/value-objects/iso-country-code';
import type { TaxId } from '../../domain/value-objects/tax-id';
import type { Email } from '../../domain/value-objects/email';

// --- Directory search types (US2) -------------------------------------------

export type RiskBand = 'healthy' | 'warning' | 'at-risk' | 'critical';

export type DirectoryFilter = {
  readonly q?: string;
  readonly status?: readonly ('active' | 'inactive' | 'archived')[];
  readonly planYear?: number;
  readonly country?: string;
  readonly planId?: string;
  /**
   * I1 round-10 ui-design-specialist — filter members by at-risk band
   * surfaced in the F8-fed `risk_score_band` column. Null/undefined =
   * no filter (default). When provided, matches members whose band is
   * the supplied value; members with `null` band (not yet scored) are
   * excluded from the filtered result.
   */
  readonly riskBand?: RiskBand | readonly RiskBand[];
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
  readonly riskBand?: RiskBand | readonly RiskBand[];
  /**
   * Sort column (FR-007a). `engagement` orders by the F8 risk score inverted
   * (engagement = 100 − risk): `desc` (default) = healthiest first; `asc` =
   * least-engaged first. Unscored members (null risk) always sort last.
   * `memberNumber` orders by the human-readable member number (ASC NULLS LAST;
   * `desc` reverses). Omitted → default recency order (`last_activity_at DESC`).
   */
  readonly sort?: 'engagement' | 'memberNumber';
  readonly order?: 'asc' | 'desc';
  readonly limit: number;
  readonly offset: number;
};

export type DirectoryRow = {
  readonly member: Member;
  readonly primaryContact: Contact | null;
  readonly planDisplayName: string | null;
  /**
   * F8 Phase 6 Wave H — at-risk score surfaced on /admin/members
   * directory table. Closes the cross-phase spec gap: F3 reserved
   * the `member_risk_flag` column placeholder ("Reserves the column
   * for F8" — `members-table.tsx:7`) but neither F3 nor F8 spec
   * explicitly task'd the wiring. Phase 6 Wave H closes the gap by
   * threading risk_score + risk_score_band from F3 `members.risk_score*`
   * (populated by F8's batched recompute use-case) through DirectoryRow
   * and the directory-search use-case so the column shows real data.
   *
   * Null when the at-risk recompute cron hasn't run yet for this
   * member (e.g. members below min-tenure or freshly imported).
   */
  readonly riskScore: number | null;
  readonly riskScoreBand:
    | 'healthy'
    | 'warning'
    | 'at-risk'
    | 'critical'
    | null;
};

export type RepoError =
  | { code: 'repo.not_found' }
  | { code: 'repo.conflict'; reason: string }
  | { code: 'repo.unexpected'; cause?: unknown };

/**
 * Narrow single-member risk read (B18 / FR-007a). The F8 risk columns live on
 * the members table but are NOT carried on the `Member` aggregate (only the
 * directory LIST projection surfaces them), so the profile page resolves them
 * via this dedicated read rather than widening `Member`.
 */
export type MemberRisk = {
  readonly riskScore: number | null;
  readonly riskScoreBand: RiskBand | null;
};

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
    // 088 US3 — §86/4 Head-Office / Branch particular (admin-managed edit).
    | 'isHeadOffice'
    | 'branchCode'
    | 'website'
    | 'description'
    | 'notes'
    | 'foundedYear'
    | 'turnoverThb'
    | 'addressLine1'
    | 'addressLine2'
    | 'city'
    | 'province'
    | 'postalCode'
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
   * B18 — narrow read of the F8 risk score + band for one member (the
   * engagement-score projection source on the profile page). Tenant-scoped via
   * ctx/RLS; `repo.not_found` when the member is absent or cross-tenant.
   */
  findRiskById(
    ctx: TenantContext,
    memberId: MemberId,
  ): Promise<Result<MemberRisk, RepoError>>;

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
   * `audit_log` carries an explicit `tenant_id` column under a *permissive*
   * RLS policy (migration 0007: `tenant_id IS NULL OR tenant_id =
   * current_setting('app.current_tenant')`). The policy allows NULL + own-tenant
   * rows but does NOT auto-stamp `tenant_id`, so the caller must supply `ctx` to
   * write the correct value into the row.
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
   * Insert member + primary contact rows inside the caller's transaction.
   * Returns the persisted Member + Contact (with DB-generated timestamps).
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
   *
   * `userId` is intentionally a plain `string` (not a branded `UserId`):
   * it is the F1 auth session user id, which crosses the auth↔members
   * module boundary as a raw string. Branding it here would force an
   * unvalidated `asUserId(session.user.id)` cast at all ~10 portal call
   * sites without adding any validation — a worse trade than the bare type.
   */
  findByLinkedUserId(
    ctx: TenantContext,
    userId: string,
  ): Promise<Result<Member, RepoError>>;

  /**
   * C6 round-10 ui-design-specialist — list every pending portal
   * invitation for the member's contacts. "Pending" =
   * `invitations.consumed_at IS NULL` (an UNCONSUMED invitation,
   * whether still live OR expired-unaccepted — Cluster 3 re-invite fix,
   * 2026-07-12). Cross-schema query joining auth `invitations` →
   * members `contacts` via `contacts.linked_user_id = invitations.user_id`.
   *
   * Tenant scope: `contacts.tenant_id` is filtered explicitly in the
   * adapter; the auth `invitations` table is cross-tenant by design
   * (a single user can hold a tenant-agnostic invite), so the join
   * via contacts is what enforces the tenant boundary.
   *
   * Column-level visibility (per migration 0017, staff-review R001):
   * `chamber_app` can read ONLY `user_id`, `consumed_at`, `expires_at`
   * from `invitations`. The `id` column (which IS the raw 7-day invite
   * token) and `created_at` are owner-role only — selecting either
   * triggers a Postgres `42501` permission denied. Therefore the
   * return shape projects ONLY the columns chamber_app may read; the
   * UI keys badges off `contactId` (1 pending invite per user is the
   * common case), not a separate invitationId.
   *
   * Returns at most ~10 rows in practice (small contact lists), so no
   * pagination needed.
   */
  findPendingInvitationsForMember(
    ctx: TenantContext,
    memberId: MemberId,
  ): Promise<
    Result<
      ReadonlyArray<{
        readonly contactId: ContactId;
        readonly contactFirstName: string;
        readonly contactLastName: string;
        readonly contactEmail: Email;
        readonly expiresAt: Date;
      }>,
      RepoError
    >
  >;

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
   * F7 — set `members.broadcasts_acknowledged_at = timestamp` ONLY when the
   * column is currently NULL (Q15 GDPR Art. 7 banner ack), via a single
   * atomic guarded UPDATE. Returns `{ affected, previouslyNull }`:
   *   - `affected === 0` → member not found.
   *   - `previouslyNull === true` → this call performed the first
   *     acknowledgement; the caller emits the audit on that branch only.
   * Re-acks are idempotent and preserve the original consent timestamp
   * (never returns `repo.conflict`; the caller short-circuits on
   * `previouslyNull === false`).
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
   * F7 R4 (verify-fix Types-#6, 2026-05-02) — read
   * `members.preferred_locale`. Returns `null` if the member has no
   * preference set (legacy rows + new members without explicit
   * choice) OR the member is not found. CHECK constraint on column
   * (migration 0082) guarantees stored values are `en|th|sv`.
   */
  findPreferredLocaleInTx(
    tx: TenantTx,
    memberId: MemberId,
  ): Promise<Result<'en' | 'th' | 'sv' | null, RepoError>>;

  /**
   * F7 R4 — set/clear `members.preferred_locale`. Pass `null` to
   * clear preference (member falls back to tenant default).
   * `affected === 0` ⇒ member not found.
   *
   * WARNING: the returned `previousValue` is NOT reliable — Postgres
   * `RETURNING` yields the POST-update value, so it echoes `nextLocale`.
   * Callers MUST load the prior value separately via
   * `findPreferredLocaleInTx` before deciding whether to emit the audit
   * (see `set-member-preferred-locale.ts`). The field is retained only
   * for signature stability and is intentionally unused.
   * Atomic; caller emits `member_preferred_locale_changed` audit in same tx.
   */
  updatePreferredLocaleInTx(
    tx: TenantTx,
    memberId: MemberId,
    nextLocale: 'en' | 'th' | 'sv' | null,
  ): Promise<
    Result<
      {
        readonly affected: number;
        readonly previousValue: 'en' | 'th' | 'sv' | null;
      },
      RepoError
    >
  >;

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
   *
   * Ordering: `ORDER BY "timestamp" DESC, id DESC`. The secondary
   * `id DESC` is a stable selector for tied timestamps, NOT a
   * proxy for insertion order — `audit_log.id` is UUID v4 random.
   * Two `member_plan_changed` events sharing an exact-millisecond
   * timestamp will pick a consistent row across reads, but it may
   * not be the last-inserted one. Sub-millisecond ordering is
   * undefined for this read.
   */
  findLastPlanChangedAt(
    ctx: TenantContext,
    memberId: MemberId,
  ): Promise<Result<Date | null, RepoError>>;

  /**
   * COMP-1 — anonymise the member row in place (Art. 17 / §33). Scrubs every
   * PII / quasi-identifier column on `members`: `company_name` (NOT NULL) →
   * ERASED_SENTINEL, the rest → NULL; then stamps `erased_at` + `updated_at`.
   * The authoritative SCRUBBED column set is enumerated in
   * `tests/unit/members/infrastructure/scrub-pii-column-coverage.test.ts` — a
   * build-failing partition guard that fails on any NEW unclassified `members`
   * column, so the set stays in sync without re-listing the columns here (which
   * silently rots — the H1 F8-era cluster was missing from the old enumeration).
   * Preserves `member_id`, `member_number`, `plan_*`, registration/created
   * dates, and `status` (erasure is orthogonal to archive). Idempotent.
   * `repo.not_found` when the member is absent / cross-tenant.
   */
  scrubPiiInTx(
    tx: TenantTx,
    memberId: MemberId,
    opts: { readonly erasedAt: Date },
  ): Promise<Result<void, RepoError>>;

  /**
   * COMP-1 — narrow read of the member's `erased_at` (the erasure pre-flight).
   * `erased_at` is NOT carried on the `Member` aggregate (only the scrub sets
   * it on the row), so the erase use-case resolves erasure state via this
   * dedicated read rather than widening `Member` — mirrors `findRiskById`.
   *
   * Serves a dual purpose for `eraseMember`'s pre-flight:
   *   - `repo.not_found` ⇒ the member is absent / cross-tenant: the use-case
   *     short-circuits with `not_found` BEFORE emitting `member_erasure_requested`
   *     (no DPO-log pollution / existence oracle).
   *   - `{ erasedAt: <Date> }` ⇒ already erased: skip the `member_erasure_requested`
   *     re-emit (do NOT restart the Art.12 clock); still re-drive the scrub +
   *     cascades.
   *   - `{ erasedAt: null }` ⇒ first request: emit `member_erasure_requested`.
   *
   * Tenant-scoped via ctx/RLS; threads the runInTenant tx, never the global db.
   */
  findErasedAtById(
    ctx: TenantContext,
    memberId: MemberId,
  ): Promise<Result<{ readonly erasedAt: Date | null }, RepoError>>;

  /**
   * COMP-1 US2d — reconciler candidate query. Returns erased members
   * (`erased_at IS NOT NULL`) that lack the `member_erased` completion audit
   * (a post-commit cascade failed AFTER the durable scrub tx committed),
   * oldest-erasure-first (the rows nearest the Art.12 completion deadline are
   * reconciled first), locked `FOR UPDATE SKIP LOCKED` (so concurrent
   * reconciler cron ticks don't double-drive the same row). `reason` is read
   * from the member's EARLIEST `member_erasure_requested` audit (defaults to
   * `'gdpr_erasure_request'` when absent) so the reconciler re-drives with the
   * original Art.17 / PDPA §33 reason — matching the insights `earliest()` fold
   * (erasure-evidence.ts) and the Art.12-clock invariant under a concurrent
   * double-request (two requested rows with different reasons → earliest wins).
   *
   * Both `audit_log` subqueries carry an EXPLICIT `tenant_id = <slug>` filter:
   * `audit_log` uses a PERMISSIVE RLS policy (NULL-tenant F1 identity rows are
   * visible to every context), so the filter is LOAD-BEARING — without it a
   * NULL-tenant or cross-tenant audit row could wrongly satisfy/spoil the
   * match. (Mirrors the at-risk-scorer's `audit_log` subquery, which documents
   * the same load-bearing-filter requirement.) `members` uses a strict
   * isolating RLS policy so its outer `WHERE` needs no explicit filter.
   *
   * Threads the runInTenant `tx` (RLS gotcha — never the global db).
   */
  findStuckErasuresInTx(
    tx: TenantTx,
    tenantSlug: string,
    limit: number,
  ): Promise<
    ReadonlyArray<{
      readonly memberId: MemberId;
      readonly reason: 'gdpr_erasure_request' | 'pdpa_deletion_request';
    }>
  >;
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
  readonly memberId: MemberId;
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
  readonly memberId: MemberId;
  readonly displayName: string;
  /** Timestamp from `members.updated_at` at the time of halt. */
  readonly haltedSinceAt: Date;
};
