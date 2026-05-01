/**
 * T028 — `BroadcastsRepo` Application port (F7).
 *
 * Domain-typed repository over the `broadcasts` table. Concrete
 * adapter (Phase 4 Infrastructure) wraps Drizzle; uses
 * `runInTenant(tenantCtx, fn)` for RLS-scoped execution.
 *
 * Method conventions (mirrors F4 `InvoiceRepo`):
 *   - `tx: unknown` parameter for transactional methods — adapter
 *     casts to Drizzle tx handle internally
 *   - throws on conflicts (`BroadcastNotFoundError`,
 *     `BroadcastConcurrentMutationError`); use-cases adapt to Result
 *     at boundaries
 *   - tenant context threaded as `tenantId: string` parameter (NOT
 *     constructor injection — explicit per-call binding is mandatory
 *     for cross-tenant safety)
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { Broadcast, BroadcastId } from '../../domain/broadcast';
import type { BroadcastStatus } from '../../domain/value-objects/broadcast-status';

export interface NewBroadcastDraftInput {
  readonly tenantId: string;
  readonly broadcastId: BroadcastId;
  readonly requestedByMemberId: string;
  readonly requestedByMemberPlanIdSnapshot: string;
  readonly submittedByUserId: string;
  readonly actorRole: 'member_self_service' | 'admin_proxy';
  readonly subject: string;
  readonly bodyHtml: string;
  readonly bodySource: string;
  readonly fromName: string;
  readonly replyToEmail: string;
  readonly segmentType: Broadcast['segmentType'];
  readonly segmentParams: Record<string, unknown> | null;
  readonly customRecipientEmails: ReadonlyArray<string> | null;
  readonly estimatedRecipientCount: number;
  readonly scheduledFor: Date | null;
}

export interface ListByTenantStatusOpts {
  readonly cursor?: string;
  readonly pageSize: number;
  readonly statusFilter?: ReadonlyArray<BroadcastStatus>;
  readonly memberIdFilter?: string;
  readonly sort?: 'submitted_at_asc' | 'submitted_at_desc' | 'created_at_desc';
}

export interface ListByTenantStatusResult {
  readonly rows: ReadonlyArray<Broadcast>;
  readonly nextCursor: string | null;
}

export class BroadcastNotFoundError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly broadcastId: BroadcastId,
  ) {
    super(`Broadcast not found: ${broadcastId} in tenant ${tenantId}`);
    this.name = 'BroadcastNotFoundError';
  }
}

export class BroadcastConcurrentMutationError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly broadcastId: BroadcastId,
    public readonly observedStatus: BroadcastStatus,
  ) {
    super(
      `Concurrent mutation on broadcast ${broadcastId}: observed status ${observedStatus}`,
    );
    this.name = 'BroadcastConcurrentMutationError';
  }
}

export interface BroadcastsRepo {
  /**
   * Open a Drizzle transaction. Use cases pass the resulting `tx`
   * handle to other repo methods to ensure atomicity.
   */
  withTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;

  /**
   * Insert a new draft broadcast. Idempotent on
   * (tenant_id, broadcast_id) primary key — duplicate insertion is a
   * programmer error, not a recoverable conflict.
   */
  insertDraft(tx: unknown, input: NewBroadcastDraftInput): Promise<Broadcast>;

  /**
   * Update an existing draft (subject/body/segment). Throws
   * `BroadcastConcurrentMutationError` if the row is no longer in
   * `draft` status (Q3 immutable-after-submit invariant).
   */
  updateDraft(
    tx: unknown,
    tenantId: string,
    broadcastId: BroadcastId,
    patch: Partial<NewBroadcastDraftInput>,
  ): Promise<Broadcast>;

  /**
   * Find by composite ID. Returns `null` for not-found (caller
   * decides whether to throw or return 404 + cross-tenant probe audit).
   */
  findById(
    tenantId: string,
    broadcastId: BroadcastId,
  ): Promise<Broadcast | null>;

  findByIdInTx(
    tx: unknown,
    tenantId: string,
    broadcastId: BroadcastId,
  ): Promise<Broadcast | null>;

  /**
   * Lock the row for update — used by status-transition use cases
   * (submit/approve/reject/cancel). Returns the current status so
   * the use case can verify it before transitioning.
   */
  lockForUpdate(
    tx: unknown,
    tenantId: string,
    broadcastId: BroadcastId,
  ): Promise<BroadcastStatus | null>;

  /**
   * Apply a status transition. Caller has already validated the
   * transition via the Domain `transition()` policy. Adapter sets
   * the corresponding lifecycle timestamp + actor field per status.
   */
  applyTransition(
    tx: unknown,
    tenantId: string,
    broadcastId: BroadcastId,
    target: BroadcastStatus,
    fields: Partial<Broadcast>,
  ): Promise<Broadcast>;

  /**
   * Set the `resend_audience_id` + `resend_broadcast_id` columns on
   * dispatch — separate write from the status flip so the unique
   * partial index lookup works on the next webhook event.
   */
  attachResendIds(
    tx: unknown,
    tenantId: string,
    broadcastId: BroadcastId,
    resendAudienceId: string,
    resendBroadcastId: string,
  ): Promise<void>;

  /**
   * Persist the `resend_audience_id` column ALONE, without changing
   * `resend_broadcast_id` or status. Called immediately after
   * `gateway.createAudience` succeeds during dispatch so a subsequent
   * retry (after a partial failure on `addContactsToAudience` or
   * `createBroadcast`) can REUSE the existing Resend audience instead
   * of creating an orphan one.
   *
   * Idempotent: writing the same value twice is a no-op. Writing a
   * different value is allowed (caller is the only writer per the
   * dispatch advisory-lock invariant).
   */
  attachAudienceId(
    tx: unknown,
    tenantId: string,
    broadcastId: BroadcastId,
    resendAudienceId: string,
  ): Promise<void>;

  /**
   * List broadcasts for the admin queue / member history surfaces.
   */
  listByTenantStatus(
    tenantId: string,
    opts: ListByTenantStatusOpts,
  ): Promise<ListByTenantStatusResult>;

  /**
   * Count derivation source for `compute-quota-counter.ts` (FR-003).
   * Returns counts grouped by status for a single member in a single
   * quota year. Tenant-scoped.
   */
  countForMemberQuota(
    tenantId: string,
    memberId: string,
    quotaYear: number,
  ): Promise<{
    readonly submittedOrApproved: number;
    readonly sent: number;
  }>;

  /**
   * Look up a broadcast by its Resend broadcast id — used by the
   * webhook handler to resolve the tenant before re-binding RLS.
   * Bypasses RLS at the adapter (`swecham_super` role) — the route
   * handler is the only caller; tenant resolution is deferred to
   * the lookup.
   */
  findByResendBroadcastIdBypassRls(
    resendBroadcastId: string,
  ): Promise<{ readonly tenantId: string; readonly broadcast: Broadcast } | null>;

  /**
   * F7 US3 read path — paginated history of a single member's own
   * broadcasts ordered by `created_at DESC`. OFFSET-based for MVP
   * simplicity; per-member dataset stays in the hundreds at the
   * FR-016a 5,000/year tenant cap. Cursor migration is F7.1 polish.
   */
  listForMemberPaginated(
    tenantId: string,
    memberId: string,
    opts: { readonly page: number; readonly perPage: number },
  ): Promise<{
    readonly rows: ReadonlyArray<Broadcast>;
    readonly total: number;
    readonly totalPages: number;
    readonly page: number;
  }>;

  /**
   * F7 US3 — fetch a single broadcast iff the requesting member owns
   * it. Returns `probeKind` so the use-case can emit
   * `broadcast_cross_member_probe` (Q19) when ownership mismatches;
   * the route still surfaces 404 in both cases (anti-enumeration).
   */
  findOwnedByMember(
    tenantId: string,
    memberId: string,
    broadcastId: BroadcastId,
  ): Promise<{
    readonly broadcast: Broadcast | null;
    readonly probeKind: 'not_found' | 'cross_member';
  }>;

  /**
   * F7 US3 AS3 — aggregated delivery counts for a single broadcast.
   * Reads `broadcast_deliveries` grouped by `status`; returns 0 for
   * any status that has no rows so the caller can render
   * "Delivered: 0 / Bounced: 0 / Complained: 0" deterministically.
   */
  aggregateDeliveryCountsForBroadcast(
    tenantId: string,
    broadcastId: BroadcastId,
  ): Promise<{
    readonly delivered: number;
    readonly bounced: number;
    readonly soft_bounced: number;
    readonly complained: number;
    readonly sent: number;
  }>;
}
