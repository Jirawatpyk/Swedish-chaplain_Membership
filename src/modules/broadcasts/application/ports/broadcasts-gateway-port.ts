/**
 * T028 — `BroadcastsGatewayPort` Application port (F7).
 *
 * Abstraction over the **Resend Broadcasts API** (separate Resend
 * product from F1+F4 transactional Resend). Hides SDK shape behind
 * narrowed envelopes per Constitution Principle III + OWASP A06
 * sanitiser-boundary discipline.
 *
 * Workflow per broadcast (FR-020 + US2 send-now path):
 *   1. `createAudience(name)` — fresh audience per broadcast (MVP);
 *      F7.1 may switch to persistent-per-segment for cost optimisation
 *   2. `addContactsToAudience(audienceId, contacts)` — paginated if
 *      recipients > 100 (Resend per-call limit)
 *   3. `createBroadcast(input)` — registers the broadcast resource
 *   4. `sendBroadcast(broadcastId, idempotencyKey)` — fires the dispatch
 *
 * Reconciliation path (T161 R2-NEW-3 — 24h stuck-`sending` recovery):
 *   - `retrieveBroadcast(broadcastId)` returns `{status}` allowing the
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
  readonly htmlBody: string;
  readonly fromName: string;
  readonly fromEmail: string;
  readonly replyToEmail: string;
  readonly broadcastNameForResendDashboard: string;
}

export interface RetrievedBroadcastResource {
  readonly id: string;
  readonly status: 'queued' | 'sending' | 'sent' | 'cancelled';
  readonly sentAt: string | null;
}

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
   * reconciliation job (T161). Returns `null` if the resource is
   * missing on Resend (emits `broadcast_resend_resource_missing`
   * downstream).
   */
  retrieveBroadcast(
    broadcastId: string,
  ): Promise<RetrievedBroadcastResource | null>;

  /**
   * Round-4 IMP-5 — count contacts present in a Resend audience. Used
   * by the dispatch worker on idempotency-replay paths to verify the
   * prior attempt's `addContactsToAudience` populated all expected
   * recipients. A mismatch surfaces as
   * `broadcast_resend_audience_drift` audit emission so ops can
   * investigate partial-delivery before the broadcast ships.
   *
   * Returns `null` if the audience itself is missing (404).
   */
  getAudienceContactCount(
    audienceId: string,
  ): Promise<number | null>;
}
