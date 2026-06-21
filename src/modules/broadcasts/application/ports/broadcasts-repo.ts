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
    fields: Partial<Broadcast>,
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
   * Idempotent: writing the same value twice is a no-op. Writing a
   * different value is allowed (caller is the only writer per the
   * dispatch advisory-lock invariant).
   */
  attachAudienceId(
    tx: unknown,
    tenantId: TenantSlug,
    broadcastId: BroadcastId,
    resendAudienceId: string,
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
  pruneExpiredDrafts(
    tenantId: TenantSlug,
    olderThan: Date,
  ): Promise<{ readonly prunedCount: number }>;

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
}
