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
 *   - tenant context threaded as `tenantId: TenantSlug` parameter (NOT
 *     constructor injection — explicit per-call binding is mandatory
 *     for cross-tenant safety)
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { MemberId } from '@/modules/members';
import type { TenantSlug } from '@/modules/tenants';
import type { Broadcast, BroadcastId } from '../../domain/broadcast';
import type { BroadcastStatus } from '../../domain/value-objects/broadcast-status';
import type { ChamberSubstitutedBody } from '../../domain/value-objects/template-snapshot';

/**
 * #400 item 1 — the ONLY `Broadcast` fields `applyTransition` writes besides
 * `status` / `updated_at`. The Drizzle adapter loops over this tuple, so a
 * key off the list used to be silently DROPPED; typing the parameter as
 * {@link TransitionFields} turns that into a compile error instead.
 *
 * Adding a key: check the immutability trigger first
 * (`broadcasts_immutable_after_submit_fn`, 0308) — a column it blocks after
 * submit must not ride a transition unless the trigger exempts that edge.
 */
export const TRANSITION_FIELDS = [
  'submittedAt',
  'approvedAt',
  'approvedByUserId',
  'rejectedAt',
  'rejectedByUserId',
  'rejectionReason',
  'scheduledFor',
  'sendingStartedAt',
  'sentAt',
  'cancelledAt',
  'cancelledByUserId',
  'cancellationReason',
  'failedToDispatchAt',
  'failureReason',
  'quotaYearConsumed',
  'quotaConsumedAt',
  'estimatedRecipientCount',
  // F119 (0308) — the approval-round bookkeeping a transition writes. Not in
  // the immutability trigger's blocklist; `scheduledFor` above is the one that
  // needs an exempt edge (E2).
  'stageEnteredAt',
  'currentRound',
  'approvedVersionId',
  'memberReminderStage',
  'memberExpiryNotifiedAt',
  // F119 FR-016 — the member's proposal, written by the `draft → submitted`
  // transition ONLY. Any post-draft write of it is refused by the
  // immutability trigger (0308 F1), loud, never silent.
  'proposedSendAt',
  // F119 T060 — the PROMOTION of the member-approved version. It must ride the
  // SAME statement as the `member_approved → approved` flip: that edge is the
  // immutability trigger's only content exemption (E1), so on every other
  // transition (or a separate UPDATE) the trigger still raises
  // `broadcast_immutable_after_submit` — loud, not silent.
  'subject',
  'bodyHtml',
  'bodySource',
] as const satisfies ReadonlyArray<keyof Broadcast>;

type TransitionKey = (typeof TRANSITION_FIELDS)[number];

/**
 * The fields a transition may write — {@link TRANSITION_FIELDS}, nothing else.
 *
 * Every OTHER `Broadcast` key is typed `?: never` (#400 T1): excess-property
 * checks cover object LITERALS only, so a `Partial<Broadcast>` variable passed
 * as `fields` used to compile with any column on it — and the adapter dropped
 * the unlisted ones. Now such a variable is refused wherever it is passed.
 */
export type TransitionFields = Partial<Pick<Broadcast, TransitionKey>> & {
  readonly [K in Exclude<keyof Broadcast, TransitionKey>]?: never;
};

export interface NewBroadcastDraftInput {
  readonly tenantId: TenantSlug;
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

/**
 * F119 T117 / T119 — two orders join the list:
 *   - `stage_entered_at_asc` — the staff dashboard's order: longest in the
 *     current stage first, served by `broadcasts_stage_queue_idx`. On the
 *     default Awaiting-marketing-review view it is the old submitted-first
 *     order (submit stamps `stage_entered_at`).
 *   - `stage_entered_at_desc` — the same column, most recent first: the order
 *     of every view that is not only waiting stages (Sent, Closed, show-all —
 *     UX review H1), so its first page is the latest, not the oldest.
 *   - `scheduled_for_asc` — the Upcoming sends preset: send-time order,
 *     served by `broadcasts_tenant_scheduled_idx`.
 * The keyset cursor carries the value of whichever column the sort orders by.
 */
export type ListByTenantStatusSort =
  | 'submitted_at_asc'
  | 'submitted_at_desc'
  | 'created_at_desc'
  | 'stage_entered_at_asc'
  | 'stage_entered_at_desc'
  | 'scheduled_for_asc';

export interface ListByTenantStatusOpts {
  readonly cursor?: string;
  readonly pageSize: number;
  readonly statusFilter?: ReadonlyArray<BroadcastStatus>;
  readonly memberIdFilter?: string;
  readonly sort?: ListByTenantStatusSort;
  /** F119 T119 — only rows whose `scheduled_for` is at or after this instant (the Upcoming sends preset). */
  readonly scheduledFrom?: Date;
  /**
   * F119 FR-030 — the dashboard's date range, on `submitted_at`: only rows
   * submitted at or after `submittedFrom` and strictly before
   * `submittedBefore` (half-open, so a whole `to` day is one bound with no
   * sub-millisecond gap). A never-submitted row is outside any range.
   */
  readonly submittedFrom?: Date;
  readonly submittedBefore?: Date;
}

export interface ListByTenantStatusResult {
  readonly rows: ReadonlyArray<Broadcast>;
  readonly nextCursor: string | null;
}

export class BroadcastNotFoundError extends Error {
  constructor(
    public readonly tenantId: TenantSlug,
    public readonly broadcastId: BroadcastId,
  ) {
    super(`Broadcast not found: ${broadcastId} in tenant ${tenantId}`);
    this.name = 'BroadcastNotFoundError';
  }
}

export class BroadcastConcurrentMutationError extends Error {
  constructor(
    public readonly tenantId: TenantSlug,
    public readonly broadcastId: BroadcastId,
    public readonly observedStatus: BroadcastStatus,
  ) {
    super(
      `Concurrent mutation on broadcast ${broadcastId}: observed status ${observedStatus}`,
    );
    this.name = 'BroadcastConcurrentMutationError';
  }
}

/**
 * F7 retention sweep — where the next `listExpiredForRetention` read starts:
 * strictly after this (anchor, id) pair, in the read's own order.
 * `anchorKey` is OPAQUE to the caller — the adapter's lossless text form of
 * the anchor (a JS `Date` would drop Postgres' microseconds and re-read the
 * same row).
 */
export interface RetentionCursor {
  readonly anchorKey: string;
  readonly broadcastId: string;
}

/** F7 retention sweep — one expired E-Blast and the Resend copies it still owns. */
export interface RetentionCandidate extends RetentionCursor {
  /**
   * Every Resend broadcast id the row knows: its own `resend_broadcast_id` and
   * any per-batch `broadcast_batch_manifests.provider_broadcast_id`, de-duplicated.
   * Empty when nothing was ever created at Resend (e.g. a rejected E-Blast).
   */
  readonly resendBroadcastIds: readonly string[];
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
    tenantId: TenantSlug,
    broadcastId: BroadcastId,
    patch: Partial<NewBroadcastDraftInput>,
  ): Promise<Broadcast>;

  /**
   * F7.1a US7 (T102 snapshotTemplateToDraft) — narrow patch that
   * records the template snapshot onto a draft.
   *
   * Writes subject + bodyHtml + bodySource + started_from_template_id
   * + template_name_snapshot atomically within the caller's tx.
   * Refuses unless status='draft' (immutable-after-submit invariant
   * Q3) — throws `BroadcastConcurrentMutationError` if the row
   * drifted out of draft state.
   *
   * Separate from `updateDraft` because the template-snapshot fields
   * are NOT in NewBroadcastDraftInput (they were added to the
   * broadcasts table by Phase 2 migration 0162 ADD COLUMN but are
   * conceptually a one-shot snapshot, not part of the draft form
   * patch shape).
   *
   * R3-S4 (Phase 5 Round 1) — promoted from optional to REQUIRED.
   * The runtime presence check in the snapshot use-case now becomes a
   * compile-time guarantee; every BroadcastsRepo mock must provide a
   * stub. The 13 existing mocks that didn't need US7 behaviour use
   * a `throw new Error('not used in <fixture>')` stub.
   */
  updateDraftFromTemplate(
    tx: unknown,
    tenantId: TenantSlug,
    broadcastId: BroadcastId,
    snapshot: {
      // R3-F1: subject + bodyHtml MUST be branded as
      // ChamberSubstitutedBody — the only producer is the Domain VO
      // `substituteChamberName`. Repo writers that accept this brand
      // cannot accidentally store raw template content with
      // un-substituted `{{chamber_name}}` literals or with an
      // XSS-leaking chamber-name suffix.
      readonly subject: ChamberSubstitutedBody;
      readonly bodyHtml: ChamberSubstitutedBody;
      readonly bodySource: ChamberSubstitutedBody;
      readonly startedFromTemplateId: string;
      readonly templateNameSnapshot: string;
    },
  ): Promise<Broadcast>;

  /**
   * Find by composite ID. Returns `null` for not-found (caller
   * decides whether to throw or return 404 + cross-tenant probe audit).
   */
  findById(
    tenantId: TenantSlug,
    broadcastId: BroadcastId,
  ): Promise<Broadcast | null>;

  findByIdInTx(
    tx: unknown,
    tenantId: TenantSlug,
    broadcastId: BroadcastId,
  ): Promise<Broadcast | null>;

  /**
   * Lock the row for update — used by status-transition use cases
   * (submit/approve/reject/cancel). Returns the current status so
   * the use case can verify it before transitioning.
   */
  lockForUpdate(
    tx: unknown,
    tenantId: TenantSlug,
    broadcastId: BroadcastId,
  ): Promise<BroadcastStatus | null>;

  /**
   * Apply a status transition. Caller has already validated the
   * transition via the Domain `transition()` policy. Adapter sets
   * the corresponding lifecycle timestamp + actor field per status.
   *
   * **`expectedFromStatus` is REQUIRED** (verify-fix R4 / Types-#5,
   * 2026-05-02): the UPDATE adds `AND status = expectedFromStatus`
   * to its WHERE clause. If 0 rows are updated (the row's status
   * drifted since the caller read it — TOCTOU window between cron
   * eligibility scan + dispatch transition, OR concurrent admin
   * action), the adapter throws `BroadcastConcurrentMutationError`.
   *
   * Safe-by-default API: every caller MUST think about which source
   * state they expect. Previously this was an optional positional
   * parameter with unconditional-UPDATE default — the agent review
   * flagged that as an anti-pattern (optional positional that
   * silently changes SQL semantics; new transitions risked unsafe
   * default). Required now: callers who don't have a source state
   * to verify either (a) don't need this method, or (b) should
   * acquire one via `lockForUpdate()` first.
   */
  applyTransition(
    tx: unknown,
    tenantId: TenantSlug,
    broadcastId: BroadcastId,
    target: BroadcastStatus,
    fields: TransitionFields,
    expectedFromStatus: BroadcastStatus,
  ): Promise<Broadcast>;

  /**
   * Set the `resend_audience_id` + `resend_broadcast_id` columns on
   * dispatch — separate write from the status flip so the unique
   * partial index lookup works on the next webhook event.
   */
  attachResendIds(
    tx: unknown,
    tenantId: TenantSlug,
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
   * Idempotent on the SAME value: a retried tick that already attached this
   * audience writes it again harmlessly.
   *
   * **Writing a DIFFERENT value throws `BroadcastConcurrentMutationError`** —
   * or `BroadcastNotFoundError` if the row is gone. This docblock used to say
   * a different value "is allowed (caller is the only writer per the dispatch
   * advisory-lock invariant)". That invariant is false: `lockForUpdate`'s
   * advisory lock is released when its tx commits, which happens BEFORE any
   * gateway call, so two overlapping ticks both saw NULL and both created an
   * audience — leaking one against a 3-audience Free-plan allowance. The
   * precondition now rides on the write itself (108 Phase 9 review S13).
   *
   * **And only while the row is `approved`** (F119 T166 R-H1): a row that
   * left `approved` since the dispatcher's lock committed — withdrawn,
   * cancelled, re-opened for a new version — throws
   * `BroadcastConcurrentMutationError` naming its real status. The same holds
   * for `attachBroadcastId` and `attachAudienceImport`.
   */
  attachAudienceId(
    tx: unknown,
    tenantId: TenantSlug,
    broadcastId: BroadcastId,
    resendAudienceId: string,
  ): Promise<void>;

  /**
   * Persist the `resend_broadcast_id` column ALONE, without changing
   * `resend_audience_id` or status. The exact sibling of `attachAudienceId`
   * one step later in dispatch, and it exists for the same reason.
   *
   * **F4 — the double-send window.** `gateway.createBroadcast` mints a Resend
   * resource, and until this method existed the id lived only in a local
   * variable until the final `attachResendIds` + transition tx, on the far side
   * of `sendBroadcast`. A tick that died in that window re-entered, minted a
   * SECOND resource and sent to the whole audience again. `Idempotency-Key`
   * cannot collapse that — it is a different resource, and it was MEASURED
   * inert on `POST /broadcasts` anyway (2026-09-09).
   *
   * Called immediately after `createBroadcast` returns, in its OWN tx, so it
   * commits independently of the later status flip. That independence is the
   * point on the cancel-landing path too: when a cancel lands mid-dispatch the
   * transition finds 0 rows and rolls back, and the id must survive that
   * rollback or the webhook cannot correlate the mail that already went out.
   *
   * Same CAS contract as `attachAudienceId`: idempotent on the SAME value,
   * `BroadcastConcurrentMutationError` on a different one or on a row no
   * longer `approved`, `BroadcastNotFoundError` if the row is gone.
   */
  attachBroadcastId(
    tx: unknown,
    tenantId: TenantSlug,
    broadcastId: BroadcastId,
    resendBroadcastId: string,
  ): Promise<void>;


  /**
   * T086 (108 US5) — record that a Contacts-Import job has been handed to the
   * provider, stamping `audience_import_submitted_at` alongside the id.
   *
   * A non-null id is the idempotency guard: a later tick sees it and does not
   * submit a second import. The timestamp is what the 30-minute stuck rule
   * (FR-044 f) measures from — `scheduled_for` would be wrong, because a
   * broadcast can sit approved for hours before a tick picks it up.
   *
   * Idempotent on the SAME id: a retried tick re-attaching its own import is
   * harmless. A DIFFERENT id throws `BroadcastConcurrentMutationError` (or
   * `BroadcastNotFoundError` if the row is gone) — two live import jobs against
   * one broadcast would let `(resend_audience_id, audience_import_id)` come from
   * different ticks, validating counts for one audience while sending to the
   * other. Overwrite was the documented behaviour until 108 Phase 9 review S13.
   * A row no longer `approved` refuses it the same way (F119 T166 R-H1).
   *
   * Does NOT change status. The broadcast stays `approved` for the whole
   * build, which is what keeps it cancellable (`cancelBroadcast` accepts only
   * submitted/approved) — migration 0298 records why no `audience_building`
   * status exists.
   */
  attachAudienceImport(
    tx: unknown,
    tenantId: TenantSlug,
    broadcastId: BroadcastId,
    importId: string,
  ): Promise<void>;

  /**
   * T086 — stamp `audience_import_completed_at`.
   *
   * The caller MUST have applied the full completion rule first: provider
   * status `completed`, `failed === 0`, `created + updated + skipped === total`,
   * and `total` equal to the count it resolved. `completed` alone is not
   * enough — one import in five identical probes reported `completed` with
   * `failed: 0` and `total: 0` and had attached nothing (research R9 V2 (c)).
   * This stamp is the gate `sendBroadcast` waits on, so a premature one sends
   * a broadcast to a partly-built or empty audience.
   */
  markAudienceImportCompleted(
    tx: unknown,
    tenantId: TenantSlug,
    broadcastId: BroadcastId,
  ): Promise<void>;

  /**
   * List broadcasts for the admin queue / member history surfaces.
   */
  listByTenantStatus(
    tenantId: TenantSlug,
    opts: ListByTenantStatusOpts,
  ): Promise<ListByTenantStatusResult>;

  /**
   * Count derivation source for `compute-quota-counter.ts` (FR-003).
   * Returns counts grouped by status for a single member in a single
   * quota year. Tenant-scoped.
   */
  countForMemberQuota(
    tenantId: TenantSlug,
    memberId: MemberId,
    quotaYear: number,
  ): Promise<{
    readonly submittedOrApproved: number;
    readonly sent: number;
  }>;

  /**
   * Bug #4 — TOCTOU-safe quota re-check. Acquires a per-(tenant, member,
   * quota-year) `pg_advisory_xact_lock` (held to caller-tx end) then returns
   * the SAME reservation/consumption counts as `countForMemberQuota`, read
   * WITHIN the caller's `tx`. The pre-tx `computeQuotaCounter` read is a
   * stale snapshot; without this, two concurrent submits at `remaining = 1`
   * both pass it and over-subscribe (which then trips the `over_subscription`
   * invariant → the quota endpoint + every further submit 500 — a member
   * self-lockout). The advisory lock serialises the racing submits so the
   * loser re-reads the fresh count and is cleanly quota-blocked.
   *
   * OPTIONAL so the ~13 BroadcastsRepo test fixtures need not stub it; when
   * absent the caller skips the re-check (single-threaded tests never race).
   * Lock namespace `broadcasts-quota:` is DISJOINT from the per-broadcast
   * `broadcasts:` lock and from F4 `invoicing:` / F5 `payments:`.
   */
  recheckMemberQuotaUnderLock?(
    tx: unknown,
    tenantId: TenantSlug,
    memberId: MemberId,
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
  ): Promise<{ readonly tenantId: TenantSlug; readonly broadcast: Broadcast } | null>;

  /**
   * F7 US3 read path — paginated history of a single member's own
   * broadcasts ordered by `created_at DESC`. OFFSET-based for MVP
   * simplicity; per-member dataset stays in the hundreds at the
   * FR-016a 5,000/year tenant cap. Cursor migration is F7.1 polish.
   */
  listForMemberPaginated(
    tenantId: TenantSlug,
    memberId: MemberId,
    opts: { readonly page: number; readonly perPage: number },
  ): Promise<{
    readonly rows: ReadonlyArray<Broadcast>;
    readonly total: number;
    readonly totalPages: number;
    readonly page: number;
  }>;

  /**
   * F7 US3 — fetch a single broadcast iff the requesting member owns
   * it. Returns a discriminated union so the `probeKind === 'owned'`
   * branch carries a non-null `broadcast` at the type level (no
   * runtime invariant required from callers):
   *
   *   - `{ probeKind: 'owned', broadcast: Broadcast }` → success
   *   - `{ probeKind: 'not_found', broadcast: null }`  → row absent;
   *                                                     no audit
   *   - `{ probeKind: 'cross_member', broadcast: null }` → row exists
   *                                                       but owned
   *                                                       by another
   *                                                       member;
   *                                                       caller emits
   *                                                       `broadcast_cross_member_probe`
   *                                                       audit (Q19).
   *
   * The route still surfaces 404 for both 'not_found' and 'cross_member'
   * (anti-enumeration); only the audit emission differs.
   *
   * Note on order: the JSDoc lists branches success-first for caller
   * reading clarity. The Drizzle adapter evaluates them in the order
   * `not_found` → `cross_member` → `owned` (early-return ladder by
   * row presence + ownership check) — adapter ordering is internal
   * and not part of this port's contract.
   */
  findOwnedByMember(
    tenantId: TenantSlug,
    memberId: MemberId,
    broadcastId: BroadcastId,
  ): Promise<
    | { readonly probeKind: 'owned'; readonly broadcast: Broadcast }
    | { readonly probeKind: 'not_found'; readonly broadcast: null }
    | { readonly probeKind: 'cross_member'; readonly broadcast: null }
  >;

  /**
   * F7 US3 AS3 — aggregated delivery counts for a single broadcast.
   * Reads `broadcast_deliveries` grouped by `status`; returns 0 for
   * any status that has no rows so the caller can render
   * "Delivered: 0 / Bounced: 0 / Complained: 0" deterministically.
   * Returns camelCase (Application convention) — the Drizzle adapter
   * does the SQL→object snake_case→camelCase rename at its boundary.
   */
  aggregateDeliveryCountsForBroadcast(
    tenantId: TenantSlug,
    broadcastId: BroadcastId,
  ): Promise<{
    readonly delivered: number;
    readonly bounced: number;
    readonly softBounced: number;
    readonly complained: number;
    readonly sent: number;
  }>;

  /**
   * F7 US6 / Phase 8 — T171a draft-expiry prune (FR-001a).
   *
   * Deletes rows in `broadcasts` where `tenant_id = $1`,
   * `status = 'draft'`, AND `updated_at < $2`. Returns the count of
   * deleted rows for cron observability. NO audit event (per FR-001a
   * — drafts are user-controlled scratch space; preserving the
   * "drafts do NOT consume or reserve quota" invariant means the
   * prune is invisible).
   *
   * Tenant isolation: enforced at the SQL level (`WHERE tenant_id = $1`)
   * AND defence-in-depth via `assertTenantBoundTx` in the adapter so
   * a different `runInTenant` context cannot accidentally prune
   * another tenant's drafts (Constitution Principle I clause 1+2).
   */
  /**
   * F119 review finding F2-1 — `tx` and `prunedDrafts` were added so the
   * caller can stamp each pruned draft's `broadcast_images` rows INSIDE this
   * DELETE's transaction. `owner_id` has no FK, so the delete left the image
   * rows live and un-stamped; the sweep reads `deleted_at IS NOT NULL`, so
   * those bytes became unreachable at a public blob URL — permanently, and
   * including by the erasure cascade. Omitting `tx` keeps the old behaviour of
   * opening one.
   */
  /**
   * ROUND-2 R-M1 — `limit` bounds ONE statement. The DELETE was unqualified,
   * so a tenant with a backlog held row locks on every expired draft for the
   * length of one transaction (and the caller then issued one image-stamp
   * UPDATE per draft inside it). The adapter selects the oldest `limit` drafts
   * and the caller loops until a short batch or its time budget. Omitting it
   * falls back to the adapter's own bound — never to "all of them".
   */
  pruneExpiredDrafts(
    tenantId: TenantSlug,
    olderThan: Date,
    tx?: unknown | null,
    limit?: number,
  ): Promise<{
    /** The drafts this batch deleted; its `length` is the batch's count. */
    readonly prunedDrafts: readonly {
      readonly broadcastId: string;
      /** The owning member, for the image audit's `related_member_id`. */
      readonly requestedByMemberId: string | null;
    }[];
  }>;

  /**
   * F7 retention sweep (migration 0310), phase 1 — READ up to `limit` CLOSED
   * E-Blasts whose retention has run out (the eligibility rule is the one
   * `deleteExpiredForRetention` documents below), oldest anchor first, strictly
   * after `after` when given. NO lock, own tenant transaction: the caller
   * deletes the Resend copies next, over the network, and no row lock may be
   * held across that call.
   *
   * `after` is the last candidate of the previous read, so a row the caller
   * KEPT (its Resend copy could not be deleted) is not read again in the same
   * run; the next daily run starts from the oldest again and retries it.
   */
  listExpiredForRetention(
    tenantId: TenantSlug,
    now: Date,
    limit: number,
    after: RetentionCursor | null,
  ): Promise<readonly RetentionCandidate[]>;

  /**
   * F7 retention sweep (migration 0310), phase 3 — delete the given CLOSED
   * E-Blasts on the caller's `tx`, RE-CHECKING that each is still eligible and
   * skipping any row another transaction holds (`FOR UPDATE SKIP LOCKED`), and
   * return what was deleted. The caller passes only rows whose Resend copies
   * are confirmed gone. The first statement is `SET LOCAL lock_timeout = '5s'`,
   * so a lock wait (the cascade into children another transaction holds) ends
   * the batch with 55P03 instead of hanging it.
   *
   * Eligible = ALL of:
   *   - `status` in `TERMINAL_BROADCAST_STATUSES`;
   *   - anchor + `retention_years` <= `now`, the anchor per status from
   *     `RETENTION_ANCHOR_FIELD` (Domain) — never `updated_at`;
   *   - NO live Resend audience (`resend_audience_id IS NULL OR
   *     audience_deleted_at IS NOT NULL`). `cleanup-audiences` reaps the
   *     audience first; deleting the row before it would orphan the audience
   *     on the provider's side (Free plan: 3 segments), with nothing left in
   *     the database that knows it exists.
   *
   * Children leave by ON DELETE CASCADE, never by a direct DELETE:
   * `broadcast_deliveries` (FK + trigger amendment in 0310),
   * `broadcast_versions` + `broadcast_member_decisions` (0308),
   * `broadcast_batch_manifests` → `broadcast_batch_delivery_events`
   * (0163 / 0218). `broadcast_images` has no FK (two possible parents): the
   * CALLER stamps them in the same `tx` from the returned ids.
   *
   * `tx` is REQUIRED: the caller's image stamp must co-commit with this
   * DELETE. Tenant isolation: `WHERE tenant_id = $1` plus RLS+FORCE plus the
   * adapter's `assertTenantBoundTx`.
   */
  deleteExpiredForRetention(
    tenantId: TenantSlug,
    now: Date,
    broadcastIds: readonly string[],
    tx: unknown,
  ): Promise<{
    /** The E-Blasts this batch deleted; its `length` is the batch's count. */
    readonly swept: readonly {
      readonly broadcastId: string;
      /** The owning member, for the image audit's `related_member_id`. */
      readonly requestedByMemberId: string | null;
      /** The row's retention anchor — for the run row's anchor range. */
      readonly anchor: Date;
    }[];
  }>;

  /**
   * F7 Phase 9 / T178a — list `submitted` + `approved` broadcasts owned
   * by `memberId`, used by the F3 archival/erasure cascade to
   * auto-cancel in-flight broadcasts when their originating member is
   * archived or GDPR-erased (Spec § Edge Cases L353 / Coverage Gap C2).
   *
   * Tenant-scoped via WHERE clause + RLS+FORCE on `broadcasts`. Status
   * filter is intentionally narrow — `sending` is NOT eligible for
   * cancel cascade per FR-004a / Q10 cancellation cutoff (point of no
   * return at Resend dispatch). Returns full Broadcast rows (not just
   * ids) so the caller can audit `requestedByMemberId` and
   * `replyToEmail` snapshots without a second roundtrip.
   */
  listInFlightOwnedByMember(
    tenantId: TenantSlug,
    memberId: MemberId,
  ): Promise<ReadonlyArray<Broadcast>>;

  /**
   * COMP-1 US2b — GDPR Art.17 / PDPA §33 content redaction. Inside the
   * caller's erasure tx (threaded `tx` from `runInTenant`), redacts the
   * PII a member authored into ALL their broadcasts (every status,
   * including `draft`): subject/body_html/body_source → `[redacted]`,
   * from_name/reply_to_email → `[redacted]`, and custom_recipient_emails
   * → `['[redacted]']` on `custom` rows (the broadcasts_custom_recipient_cap
   * CHECK forbids NULL on custom rows) / NULL otherwise.
   *
   * Sets `SET LOCAL app.allow_broadcast_redaction = 'on'` first so the
   * `broadcasts_immutable_after_submit_fn` trigger (migration 0224) permits
   * the PII columns to change on post-`draft` rows. FAIL-LOUD: a DB error
   * propagates and rolls the caller's tx back (never swallowed to a no-op).
   *
   * `tx` is `unknown` at the port boundary (the Drizzle adapter casts to
   * its internal TenantTx); the caller passes the live `runInTenant` tx.
   * Returns the count of redacted broadcasts for audit/observability.
   */
  scrubContentForMemberInTx(
    tx: unknown,
    tenantSlug: TenantSlug,
    memberId: MemberId,
  ): Promise<{ readonly scrubbedCount: number }>;

  /**
   * COMP-1 US2b — GDPR Art.17 / PDPA §33 delivery tombstone. Inside the
   * caller's erasure tx, sets `recipient_member_id` → NULL and
   * `recipient_email_lower` → `erased+<delivery_id>@erased.invalid` for
   * every `broadcast_deliveries` row whose `recipient_email_lower` is one of
   * the erased member's email addresses (`recipientEmails`). The rows are
   * RETAINED (never deleted) for record-of-processing (PDPA §39 / GDPR
   * Art.30).
   *
   * KEYED ON EMAIL, NOT recipient_member_id (the 2026-06-18 /code-review
   * fix): `recipient_member_id` is NEVER populated in production (the Resend
   * webhook hard-codes it NULL at both insert sites, no resolver exists), so
   * a member-id-keyed tombstone matched 0 rows — a silent no-op that let the
   * erased member's plaintext recipient email survive while erasure reported
   * complete. Deliveries are correlated to members by `recipient_email_lower`
   * (the sole recipient lookup index). The caller passes the member's
   * LIVE-contact emails ONLY — deliveries are only ever addressed to contact
   * emails, so the linked-login axis adds zero coverage and a cross-member
   * over-tombstone risk (live-only because a removed contact's address is
   * ambiguously owned). The adapter lower-cases each address before matching,
   * de-dupes, and short-circuits an empty set to `{ tombstonedCount: 0 }`
   * without running the UPDATE.
   *
   * Sets `SET LOCAL app.allow_broadcast_redaction = 'on'` first so the
   * `broadcast_deliveries_append_only_fn` trigger (migration 0225) permits
   * this UPDATE-only change to the THREE recipient-PII columns it writes:
   * `recipient_member_id` + `recipient_email_lower` + `error_message` (the
   * last holds raw Resend bounce diagnostics that can embed the recipient
   * email). A change to any other column would RAISE
   * `broadcast_deliveries_redaction_only_pii_cols`. FAIL-LOUD: a DB error
   * propagates and rolls the caller's tx back.
   *
   * Returns the count of tombstoned deliveries.
   */
  tombstoneDeliveriesForMemberInTx(
    tx: unknown,
    tenantSlug: TenantSlug,
    recipientEmails: readonly string[],
  ): Promise<{ readonly tombstonedCount: number }>;

  /**
   * COMP-1 FIX-9 — GDPR Art.17 / PDPA §33 cross-author custom-recipient
   * redaction. Inside the caller's atomic erasure tx, ELEMENT-WISE redacts the
   * erased member's email out of OTHER authors' `custom_recipient_emails`
   * tenant-wide (segment_type='custom'); the AUTHOR scrub
   * (`scrubContentForMemberInTx`, keyed on `requested_by_member_id`) handles
   * the member's OWN rows, but the erased member's email sitting in a sibling
   * author's recipient list is never reached by that scrub and would survive as
   * plaintext PII.
   *
   * Keyed on EMAIL (case-insensitive — each element + the erasure set are
   * lower-cased before matching). The caller passes the erased member's
   * LIVE-contact emails ONLY (the cross-member over-redaction guard: a removed
   * contact's address is ambiguously owned and may belong to a different
   * member). ELEMENT-WISE (not whole-array) so the sibling author's OTHER
   * legitimate recipients are preserved, with order preserved. The adapter
   * short-circuits an empty set to `{ redactedCount: 0 }` without running the
   * UPDATE; the count reflects rows CHANGED (an EXISTS guard) so a re-drive is
   * a clean no-op.
   *
   * Sets `SET LOCAL app.allow_broadcast_redaction = 'on'` first so the
   * `broadcasts_immutable_after_submit_fn` trigger (migration 0224) permits the
   * `custom_recipient_emails` change on post-`draft` rows. FAIL-LOUD: a DB error
   * propagates and rolls the caller's tx back.
   *
   * `tx` is `unknown` at the port boundary (the Drizzle adapter casts to its
   * internal TenantTx); the caller passes the live `runInTenant` tx.
   */
  redactMemberEmailFromCustomRecipientsInTx(
    tx: unknown,
    tenantSlug: TenantSlug,
    recipientEmails: readonly string[],
  ): Promise<{ readonly redactedCount: number }>;

  /**
   * COMP-1 US3-C — GDPR Art.17 / PDPA §33 sub-processor (Resend) audience
   * propagation. Inside the caller's erasure tx, reads the
   * `(resend_audience_id, recipient_email_lower)` pairs the erased member
   * received broadcasts in, so a later cascade can remove the member's email
   * from those Resend AUDIENCES.
   *
   * Must be called BEFORE `tombstoneDeliveriesForMemberInTx` in the same atomic
   * scrub tx: the tombstone redacts `broadcast_deliveries.recipient_email_lower`
   * (and `recipient_member_id` is always NULL in production), destroying the
   * join keys this read depends on. Capturing the pairs WHILE the emails are
   * still live is the whole point.
   *
   * KEYED ON EMAIL (same axis as the delivery tombstone): correlate the
   * delivery to its broadcast by `broadcast_id`, then read the broadcast's
   * `resend_audience_id`. Only rows whose broadcast carries a non-null
   * `resend_audience_id` are returned (a broadcast that never reached Resend
   * dispatch has no audience to scrub). Emails are lower-cased + de-duped
   * inside the adapter before matching: `recipient_email_lower` is always
   * lower-cased by the webhook, but a contact email is case-PRESERVED in
   * storage, so a `Mixed.Case@…` contact would otherwise never match its own
   * lower-stored delivery (coverage survival → the contact survives in a Resend
   * audience). An empty email set short-circuits to `[]`.
   *
   * Tenant-scoped via WHERE `broadcast_deliveries.tenant_id = $1` + RLS+FORCE.
   * Result pairs are DISTINCT (a member may have many deliveries into the same
   * audience). This is a READ — it mutates nothing — so it is NOT GUC-gated and
   * does not require the append-only exemption.
   *
   * `tx` is `unknown` at the port boundary (the Drizzle adapter casts to its
   * internal TenantTx); the caller passes the live `runInTenant` tx.
   */
  listMemberResendAudienceContactsInTx(
    tx: unknown,
    tenantSlug: TenantSlug,
    emails: readonly string[],
  ): Promise<ReadonlyArray<{ readonly audienceId: string; readonly email: string }>>;

  /**
   * PR-2 Task 2 — Audience cleanup: list terminal broadcasts whose Resend
   * audience is still live (not yet cleaned up).
   *
   * Returns broadcasts where:
   *   - `status IN ('sent','failed_to_dispatch','cancelled','rejected',
   *                 'partial_delivery_accepted')` — terminal (no retries)
   *   - `resend_audience_id IS NOT NULL` — has a Resend audience to delete
   *   - `audience_deleted_at IS NULL` — not yet cleaned up
   *   - `updated_at < graceCutoff` — past the grace window (so a very
   *     recent terminal status doesn't race with Resend's own processing)
   *
   * Ordered by `updated_at ASC` (oldest-terminal-first) and limited to
   * `limit` rows so the cleanup cron can process in safe batches.
   *
   * Tenant-scoped via `WHERE tenant_id = $1` + RLS+FORCE on `broadcasts`.
   * Does NOT use `runInTenant` (read-only, no RLS manipulation needed —
   * the Drizzle adapter runs its own `runInTenant` internally).
   */
  listTerminalBroadcastsWithLiveAudience(
    tenantId: TenantSlug,
    graceCutoff: Date,
    limit: number,
  ): Promise<ReadonlyArray<{ readonly broadcastId: string; readonly resendAudienceId: string }>>;

  /**
   * PR-2 Task 2 — Audience cleanup: stamp `audience_deleted_at = now()` on
   * a single broadcast row. Called by the cleanup cron AFTER the Resend
   * audience has been successfully deleted, inside the caller's
   * `runInTenant` tx so the stamp is atomic with the delete confirmation.
   *
   * Idempotent-safe: stamping a row that already has `audience_deleted_at`
   * set re-writes it to a fresh `now()` — the impl's WHERE clause is
   * intentionally permissive on `audience_deleted_at` so a re-drive after a
   * partial cron failure does not silently skip. A re-stamp therefore still
   * MATCHES the row (1 affected); callers MUST NOT rely on the affected-row
   * count to detect an already-cleaned row.
   *
   * `tx` is `unknown` at the port boundary (the Drizzle adapter casts
   * to its internal `TenantTx`). Callers MUST pass the live `runInTenant`
   * tx — NOT the bare `db` singleton — so the GUC `app.current_tenant`
   * is set for RLS+FORCE (Constitution Principle I).
   */
  markAudienceDeletedInTx(
    tx: unknown,
    broadcastId: string,
  ): Promise<void>;

  /**
   * PR-2 Task 2 — Orphan-reclaim: return the subset of `broadcastIds` that
   * still have a `broadcasts` row for the given tenant.
   *
   * Called by the audience orphan-reclaim use-case, which parses broadcast
   * UUIDs out of Resend audience names and needs to know which ones STILL
   * exist locally (so it can skip deletion for active broadcasts and reclaim
   * only the truly orphaned Resend audiences whose local broadcast row has
   * already been purged).
   *
   * Behaviour:
   *   - Empty `broadcastIds` → returns `new Set()` immediately without
   *     querying the database.
   *   - Otherwise queries `broadcasts WHERE tenant_id = $1 AND
   *     broadcast_id = ANY(ARRAY[...]::uuid[])` and returns the matching ids
   *     as a `ReadonlySet<BroadcastId>`. Non-matching ids (orphans) are
   *     simply absent from the set.
   *   - The caller is responsible for passing syntactically-valid UUIDs;
   *     a malformed value causes Postgres to surface a cast error (22P02)
   *     that propagates as a throw.
   *
   * Tenant-scoped via `WHERE tenant_id = $1` + RLS+FORCE policy on
   * `broadcasts` (Constitution Principle I). Runs its own `runInTenant`
   * call (read-only, no caller-supplied tx needed).
   */
  existingBroadcastIds(
    tenantId: TenantSlug,
    broadcastIds: ReadonlyArray<BroadcastId>,
  ): Promise<ReadonlySet<BroadcastId>>;

  /**
   * Bug #16 — for a set of broadcast ids, return a map of the ones that STILL
   * have a live row → the SET of EVERY Resend audience id that row references:
   * `broadcasts.resend_audience_id` (the F7 MVP single-audience path) UNION
   * every `broadcast_batch_manifests.provider_audience_id` for that broadcast
   * (the F7.1a US1 split/multi-batch path). Ids whose broadcast row is gone are
   * simply absent from the map; a live row with no referenced audience maps to
   * an empty set.
   *
   * Used by `reclaim-orphaned-audiences` to delete a dangling Resend audience
   * whose broadcast row references it NOWHERE (the crash-before-attach
   * duplicate: dispatch created A1, crashed before persisting it, the next tick
   * minted A2 and persisted THAT — A1 is referenced by no row). The set MUST
   * include the per-batch audiences, otherwise a live split broadcast's in-use
   * batch audiences (stored only in the manifests, NOT in
   * broadcasts.resend_audience_id which stays NULL on the split path) would be
   * misclassified as orphans and deleted.
   *
   * OPTIONAL so the ~13 BroadcastsRepo test fixtures need not stub it; when
   * absent, reclaim falls back to the legacy existence-only check.
   */
  referencedAudienceIdsForBroadcasts?(
    tenantId: TenantSlug,
    broadcastIds: ReadonlyArray<BroadcastId>,
  ): Promise<ReadonlyMap<BroadcastId, ReadonlySet<string>>>;
}
