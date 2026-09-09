/**
 * T028 — `BroadcastsGatewayPort` Application port (F7).
 *
 * Abstraction over the **Resend Broadcasts API** (separate Resend
 * product from F1+F4 transactional Resend). Hides SDK shape behind
 * narrowed envelopes per Constitution Principle III + OWASP A06
 * sanitiser-boundary discipline.
 *
 * Workflow per broadcast (FR-020 + US2 send-now path):
 *   1. `createAudience(name)` — fresh audience per broadcast
 *   2. `addContactsToAudience(audienceId, contacts)` — paginated if
 *      recipients > 100 (Resend per-call limit)
 *   3. `createBroadcast(input)` — registers the broadcast resource
 *   4. `sendBroadcast(broadcastId, idempotencyKey)` — fires the dispatch
 *
 * Reconciliation path (T161 R2-NEW-3 — 24h stuck-`sending` recovery):
 *   - `retrieveBroadcast(broadcastId)` returns a discriminated union
 *     (`{kind:'present',resource}|{kind:'not_found'}`) allowing the
 *     reconcile job to detect Resend-side resource missing →
 *     emits `broadcast_resend_resource_missing` audit
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */

/**
 * Transport-class tag on `retryable` errors so OTel metrics can split
 * network outage from server-side bugs (review I6 — 2026-04-30).
 */
export type GatewayRetryableSubKind = 'network' | 'timeout' | 'server_5xx' | 'api';

export type BroadcastsGatewayError =
  | {
      readonly kind: 'retryable';
      readonly subKind: GatewayRetryableSubKind;
      readonly reason: string;
    }
  | { readonly kind: 'idempotency_conflict'; readonly reason: string }
  | { readonly kind: 'resource_missing'; readonly resourceType: 'audience' | 'broadcast'; readonly resourceId: string }
  | { readonly kind: 'permanent'; readonly code: string; readonly reason: string };

export interface AudienceContact {
  readonly emailLower: string;
  readonly firstName?: string;
  readonly lastName?: string;
}

export interface CreateBroadcastInput {
  readonly audienceId: string;
  readonly subject: string;
  /**
   * Sanitised, member-authored inner HTML — the gateway adapter wraps
   * this in a chamber-branded shell + locale-aware footer carrying the
   * unsubscribe CTA before submitting to the upstream provider
   * (T147 — F7 US4 / FR-029). Callers MUST NOT pre-wrap; double-wrap
   * would corrupt the unsubscribe merge tag.
   */
  readonly htmlBody: string;
  readonly fromName: string;
  readonly fromEmail: string;
  readonly replyToEmail: string;
  readonly broadcastNameForResendDashboard: string;
  /**
   * Recipient locale used to render the footer strings (T147 — F7 US4).
   * Resolved by the dispatch use-case from the tenant default until F12
   * adds per-tenant + per-recipient locale columns. Required so the
   * footer's bilingual unsubscribe CTA matches the body language.
   */
  readonly locale: 'en' | 'th' | 'sv';
  /** Tenant display name for the chamber-branded header + footer. */
  readonly tenantDisplayName: string;
}

export interface RetrievedBroadcastResource {
  readonly id: string;
  readonly status: 'queued' | 'sending' | 'sent' | 'cancelled';
  readonly sentAt: string | null;
}

/**
 * Discriminated union for `retrieveBroadcast` (review TYPES
 * recommendation). Replaces `T | null` so the caller cannot mistake
 * "404 not found" for "transient null" — explicit `kind` means a
 * future "soft delete" or "in-tombstone" Resend status can extend the
 * union without breaking call sites.
 */
export type RetrieveBroadcastOutcome =
  | { readonly kind: 'present'; readonly resource: RetrievedBroadcastResource }
  | { readonly kind: 'not_found' };

/**
 * Discriminated union for `getAudienceContactCount` (review TYPES-2
 * round 2 + TYPES-#4 round 3). Mirrors `RetrieveBroadcastOutcome` for
 * cross-port consistency — both unions use the SAME `'not_found'`
 * tail so callers can grep + reason about resource-missing semantics
 * with one mental model.
 */
export type GetAudienceContactCountOutcome =
  | { readonly kind: 'present'; readonly count: number }
  | { readonly kind: 'not_found' };

export interface BroadcastsGatewayPort {
  createAudience(name: string): Promise<{ readonly audienceId: string }>;

  addContactsToAudience(
    audienceId: string,
    contacts: ReadonlyArray<AudienceContact>,
  ): Promise<void>;

  createBroadcast(
    input: CreateBroadcastInput,
  ): Promise<{ readonly broadcastId: string }>;

  /**
   * Send a previously-created broadcast. The `idempotencyKey` MUST be
   * stable per (tenant, broadcast) — the same broadcast_id retried
   * MUST use the same key so Resend short-circuits replays.
   *
   * Stable format: `broadcast-{tenantId}-{broadcastId}` per FR-020.
   */
  sendBroadcast(
    broadcastId: string,
    idempotencyKey: string,
  ): Promise<void>;

  /**
   * Retrieve a broadcast resource — used by the 24h stuck-`sending`
   * reconciliation job (T161). Returns a discriminated union: `present`
   * with the resource, or `not_found` when Resend reports 404 (emits
   * `broadcast_resend_resource_missing` downstream).
   */
  retrieveBroadcast(
    broadcastId: string,
  ): Promise<RetrieveBroadcastOutcome>;

  /**
   * Round-4 IMP-5 — count contacts present in a Resend audience. Used
   * by the dispatch worker on idempotency-replay paths to verify the
   * prior attempt's `addContactsToAudience` populated all expected
   * recipients. A mismatch surfaces as
   * `broadcast_resend_audience_drift` audit emission so ops can
   * investigate partial-delivery before the broadcast ships.
   *
   * Returns a discriminated union: `present` with the count, or
   * `audience_missing` when Resend reports 404 on the audience.
   */
  getAudienceContactCount(
    audienceId: string,
  ): Promise<GetAudienceContactCountOutcome>;

  /**
   * Detach a contact from ONE audience. A 404 (contact or audience already
   * absent) resolves (idempotent); a 5xx / network error throws a retryable
   * GatewayThrowable so the caller can classify it as a propagation failure.
   *
   * ⚠️ This does NOT satisfy GDPR Art. 17, and its provider response says
   * otherwise. Measured 2026-09-09 (108 Phase 9 review U1): after a successful
   * call answering `{"deleted": true}`, the audience-scoped read 404s while an
   * audience-less `GET /contacts/{email}` still returns the contact at 200. It
   * detaches.
   *
   * **This is nevertheless the call the erasure cascade makes, on purpose.**
   * Round 3 finding 3-10: this line used to read "For erasure use
   * `deleteContactGlobally` below", which contradicted the only erasure caller
   * (`subprocessor-erasure-adapter.ts:68`) and pointed a compliance reader at a
   * call the codebase deliberately does not make. The Resend account is ONE
   * account shared by every tenant, so a global delete during tenant A's
   * erasure would destroy tenant B's contact record — including the
   * Resend-side `unsubscribed` flag that `on_conflict=upsert` exists to
   * preserve, resurrecting B's objecting member as SUBSCRIBED on the next
   * import. That trades an Art. 17 residual for an Art. 21 regression on
   * someone who never asked for anything.
   *
   * The residual is tracked as 8a in `docs/compliance/processing-records.md`.
   * Read that before changing this, not this docblock alone.
   */
  removeContactFromAudience(audienceId: string, email: string): Promise<void>;

  /**
   * COMP-1 US3-C — DELETE the contact record itself, across every audience.
   *
   * **Not called by the erasure cascade** — see `removeContactFromAudience`
   * above for why, and residual 8a. It stays on the port because it is the only
   * call that genuinely erases, and the day the Resend account is split per
   * tenant it becomes the right one.
   *
   * Measured in the same run (U1b): `DELETE /contacts/{email}` answers 200 and
   * the read-back is a genuine 404, so unlike the audience-scoped call above
   * this is the one that actually erases. The erasure cascade had been calling
   * the other one and reporting `resendOutcome: 'ok'` while every address
   * remained at the processor — on both dispatch paths, not just the import.
   *
   * Same idempotency contract: a 404 resolves, transport errors throw
   * retryable.
   */
  deleteContactGlobally(email: string): Promise<void>;

  /**
   * T086 (108 US5) — hand an entire audience to the provider in ONE call.
   *
   * The alternative, `addContactsToAudience`, is a serial loop bounded by
   * latency (~2.08 req/s measured), so roughly 623 contacts is all a 300 s
   * function can drain. This is size-independent: one multipart request,
   * ~412 ms whether it carries one address or fifty thousand, because the
   * provider processes it asynchronously and answers with a job id.
   *
   * The caller MUST NOT treat the returned id as delivery. Nothing has been
   * added yet — `getContactImport` is how completion is learned, and its
   * completion rule is the only safe send signal.
   *
   * Throws the same classified `GatewayThrowable` as every other method here.
   * A 4xx is `permanent` and must not be retried: the archetypal one is the
   * account contact cap, where each retry consumes the resource whose
   * exhaustion caused the failure.
   */
  createContactImport(
    audienceId: string,
    emails: readonly string[],
  ): Promise<{ readonly importId: string }>;

  /**
   * T086 — poll one import job.
   *
   * Returns the provider's `status` and `counts` VERBATIM; the completion
   * decision belongs to the Application layer, which requires ALL of:
   * `status === 'completed'`, `failed === 0`,
   * `created + updated + skipped === total`, and `total` equal to the count it
   * resolved. That rule is load-bearing, not defensive — one import in five
   * identical probes returned `completed` with `failed: 0` and `total: 0` and
   * attached nothing (research R9 V2 (c)). A caller that reads only `status`
   * will eventually send a broadcast to an empty audience.
   *
   * Absent counts (a job still `pending` has none) are returned as zeros, so
   * arithmetic on them compares rather than yielding NaN.
   */
  getContactImport(importId: string): Promise<{
    readonly status: string;
    readonly counts: {
      readonly total: number;
      readonly created: number;
      readonly updated: number;
      readonly skipped: number;
      readonly failed: number;
    };
  }>;

  /**
   * PR-2 #5 — delete an ephemeral per-broadcast Resend audience after the
   * broadcast reaches a terminal status (sent / cancelled / failed).
   * Best-effort: 404 (already gone) resolves (idempotent); 5xx / network
   * errors throw a retryable `GatewayThrowable` so the cleanup cron can
   * retry next tick without blocking normal broadcast flow.
   */
  deleteAudience(audienceId: string): Promise<void>;

  /**
   * PR-2 orphan-reclaim — list all Resend audiences for the configured
   * Broadcasts API key. Used by the orphan-reclaim cron to find audiences
   * that exist in Resend but have no matching `broadcasts` DB row
   * (i.e. were leaked by a failed cleanup or a crash mid-dispatch).
   *
   * Returns a flat array of `ResendAudienceSummary` — only the fields
   * needed to correlate with DB records. `createdAt` is a parsed `Date`
   * (UTC) from Resend's `created_at` field; the gateway adapter owns the
   * parse so callers work with a proper Date, not raw strings.
   */
  listAudiences(): Promise<ReadonlyArray<ResendAudienceSummary>>;
}

/**
 * Summary of a single Resend audience as returned by the `listAudiences`
 * port method. `createdAt` is a parsed `Date` (UTC) — the gateway adapter
 * maps `created_at: string` → `createdAt: Date` at the infrastructure
 * boundary so Application use-cases never parse raw ISO strings.
 */
export type ResendAudienceSummary = {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
};
