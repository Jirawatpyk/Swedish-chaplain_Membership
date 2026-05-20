/**
 * T028 — `AuditPort` Application port (F7 MVP) + T031 F7.1a extension.
 *
 * 54 audit event types as a const tuple + discriminated union for
 * compile-time safety on emit sites. Mirror of F4 audit-port pattern,
 * but ALL F7 events default to **5-year retention** (no tax-document
 * overlap; F7 is operational + marketing-consent + privacy events).
 *
 * The retention column on `audit_log` (Constitution v1.4.0 trigger
 * 0063) defaults to 5 unless the emitter sets it explicitly. F7
 * emitters MUST call `f7RetentionFor(eventType)` to be defensive
 * against future spec amendments that promote an F7 event to 10y
 * (none currently).
 *
 * Event taxonomy:
 *   - Draft / submission (US1): 16 events (R6 added `broadcast_subject_empty`)
 *   - Admin review + dispatch + per-recipient delivery (US2+US4): 14 events
 *     (round-4 added `broadcast_resend_audience_drift`; round-5 added
 *     `broadcast_resend_drift_check_unverifiable`; round-6 added
 *     `broadcast_delivery_recorded` to fix audit-trail semantic for
 *     `email.delivered` webhook events — was incorrectly aliased to
 *     `broadcast_send_started`)
 *   - Cross-tenant probes: 2 events
 *   - Phase 3F.11.3 M3 operational-forensic webhook race: 1 event
 *     (`broadcast_webhook_batch_missing` — split from cross-tenant probe)
 *   - Unsubscribe + suppression (US5): 4 events
 *   - Webhook (US4): 1 event
 *   - Plan-expiry edge (US6): 1 event
 *   - Clarifications session 5 (Q14 + Q15): 3 events
 *   - Phase 8 verify-fix R3: 2 events
 *   - F7.1a Phase 2 T031 (US1+US2+US7): 10 events
 *   = 54 total
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */

export const F7_AUDIT_EVENT_TYPES = [
  // --- Draft / submission (US1) — 16 events (R7 LOW-S1: was 15 pre-R6) -
  'broadcast_drafted',
  'broadcast_submitted',
  'broadcast_quota_blocked',
  'broadcast_empty_segment_blocked',
  'broadcast_rate_limit_exceeded',
  'broadcast_not_in_plan',
  'broadcast_immutable_after_submit',
  'broadcast_subject_too_long',
  'broadcast_subject_empty', // R6 W-R3 fix — separate from too_long to align audit with Result kind
  'broadcast_body_too_large',
  'broadcast_body_unsafe_html',
  'broadcast_audience_too_large',
  'broadcast_custom_recipient_unknown',
  'broadcast_member_missing_primary_contact_email',
  'member_missing_primary_contact',
  'broadcast_member_halted_pending_review', // R3-NEW-1

  // --- Admin review (US2) + delivery (US4) — 14 events ----------------
  'broadcast_approved',
  'broadcast_rejected',
  'broadcast_cancelled',
  'broadcast_cancel_too_late',
  'broadcast_send_started',
  'broadcast_delivery_recorded',       // US4 — per-recipient delivery confirmation from Resend webhook (was incorrectly aliased to send_started until R6 staff-review fix)
  'broadcast_send_timeout_completed', // US6-deferred (24h stuck-sending reconcile)
  'broadcast_sent',                    // US4-deferred (Resend webhook delivered handler)
  'broadcast_quota_consumed',          // US4-deferred (consumed at sending→sent webhook)
  'broadcast_failed_to_dispatch',
  'broadcast_resend_resource_missing', // R2-NEW-3 — emitted by dispatch worker
  'broadcast_resend_audience_drift',   // F7.1-IMP5 — audience count mismatch on idempotency replay
  'broadcast_resend_drift_check_unverifiable', // R5-S1 — count fetch failed on non-404
  'broadcast_concurrent_action_blocked',

  // --- Cross-tenant probes (Constitution Principle I) — 2 events ----
  'broadcast_cross_member_probe',
  'broadcast_cross_tenant_probe',

  // --- Phase 3F.11.3 M3 (Round 2 closure) — operational-forensic ----
  // `broadcast_webhook_batch_missing` covers the BENIGN Resend webhook
  // race (BYPASSRLS resolves tenant, incrementCounter finds 0 rows
  // because the batch was force-deleted). Separated from the
  // security-forensic `broadcast_cross_tenant_probe` to keep SIEM
  // alerts noise-free. Added via migration 0173.
  'broadcast_webhook_batch_missing',

  // --- Unsubscribe + suppression (US5) — 4 events --------------------
  // All US5-deferred — emit sites land with the public unsubscribe
  // page + suppression-applied state machine in a follow-up phase.
  'broadcast_unsubscribed',                  // US5-deferred
  'broadcast_unsubscribe_token_invalid',     // US5-deferred
  'broadcast_suppression_applied',           // US5-deferred
  'broadcast_complaint_received',            // US4-deferred (webhook complaint event)

  // --- Webhook (US4) — 1 event ---------------------------------------
  'broadcast_webhook_signature_rejected',    // US4-deferred (Resend webhook handler)

  // --- Plan-expiry edge (US6) — 1 event ------------------------------
  'broadcast_sent_with_expired_member_plan', // US6-deferred (cron expiry guard)

  // --- Clarifications session 5 (Q14 + Q15) — 3 events ---------------
  'broadcast_complaint_rate_per_broadcast_breach', // US4-deferred (5% complaint-rate auto-halt webhook handler)
  'broadcast_member_dispatch_resumed',             // Q14 admin clear-halt — emitted
  'member_acknowledged_broadcasts_terms',          // Q15 GDPR Art. 7 — emitted (round-4 CRIT-B)

  // --- Phase 8 verify-fix R3 — 2 events ------------------------------
  // (Errors-C1) — distinguishes pre-`createBroadcast` race (two workers
  // dueled through `createAudience`) from post-send Resend conflict.
  'broadcast_dispatch_idempotency_conflict_pre_send',
  // (Errors-H3) — AS2 contract requires member transactional email on
  // dispatch failure, but member's primary contact email may be NULL
  // (F3 archive cascade / contact deletion). Audit records the missed
  // notification so compliance review has a durable trail.
  'broadcast_dispatch_failure_notif_skipped_no_email',

  // --- F7.1a US1 (Pagination + retry loop) — 4 events ----------------
  // (T031 Phase 2, FR-002 / FR-008a-d). Migration 0167 added these enum
  // values to the DB; this list mirrors the DB enum + data-model § 7
  // taxonomy. All 5y retention via Constitution v1.4.0 trigger.
  'broadcast_dispatched_in_batches',
  'broadcast_retry_initiated',
  'broadcast_retry_completed',
  'broadcast_partial_delivery_accepted',

  // --- F7.1a US2 (Image embedding + allowlist + scan) — 4 events ----
  'broadcast_body_image_source_unsafe',
  'broadcast_image_too_large',
  'broadcast_image_unsafe',
  'broadcast_image_allowlist_updated',

  // --- F7.1a US7 (Template library CRUD) — 4 events -----------------
  'broadcast_template_created',
  'broadcast_template_updated',
  'broadcast_template_deleted',
  // R1.1 (review Round 1 CRIT-4): snapshot moment audit so forensics
  // can answer "who pulled which template into draft X at when". Emitted
  // inside the snapshot use-case's withTx atomically with the body+
  // counter mutations (Constitution I clause 3).
  'broadcast_template_snapshotted',
  // R2.1 M-test-2 (review Round 1 close-out): seed-time skip event for
  // forensic forensics when the migration 0168 ON CONFLICT DO NOTHING
  // path silently drops a starter template row because the tenant
  // pre-seeded a template with the same (name, locale) tuple. Forward-
  // looking emit hook — current migration runs ONCE at first apply
  // (rare conflict surface); a future Application-layer re-seed use-
  // case will be the primary emit caller.
  'broadcast_template_seed_skipped_existing_name',
] as const;

/**
 * Static assertion: count matches the declared 57 (= 43 F7 MVP + 11
 * F7.1a additions per T031 Phase 2 + 1 Phase 3F.11.3 M3 closure
 * `broadcast_webhook_batch_missing` + 1 Phase 4 US2 addition
 * `broadcast_image_unsafe` + 1 R1.1 fix `broadcast_template_snapshotted` +
 * 1 R2.1 M-test-2 `broadcast_template_seed_skipped_existing_name`).
 * Catches drift if a spec amendment adds an event without updating this
 * file. The check lives at type level; if the count is wrong, TypeScript
 * errors here with "Type '58' is not assignable to type '57'" (or similar).
 */
type _AssertF7AuditEventCount = (typeof F7_AUDIT_EVENT_TYPES)['length'] extends 57
  ? true
  : never;
const _assertF7AuditEventCount: _AssertF7AuditEventCount = true;

export type F7AuditEventType = (typeof F7_AUDIT_EVENT_TYPES)[number];

/**
 * Retention-year mapping for F7 audit events (data-model § 6).
 *
 * All F7 events default to **5y** — F7 has NO tax-document touchpoint.
 * Member-acknowledged broadcasts terms (Q15) is GDPR Art. 7
 * "demonstrable consent" evidence; 5y retention covers the audit
 * window. Suppression rows (`marketing_unsubscribes`) are retained
 * INDEFINITELY at the row level — that's a separate data-retention
 * policy, not an audit-log retention.
 */
export const F7_AUDIT_RETENTION_YEARS: Record<F7AuditEventType, 5> =
  Object.fromEntries(
    F7_AUDIT_EVENT_TYPES.map((eventType) => [eventType, 5 as const]),
  ) as Record<F7AuditEventType, 5>;

/** Single-source helper — call at every F7 emit site. */
export function f7RetentionFor(eventType: F7AuditEventType): 5 {
  return F7_AUDIT_RETENTION_YEARS[eventType];
}

/**
 * T185 (Phase 9) — predicate for the F9 audit-viewer surface to filter
 * F7 events from the cross-feature `audit_log` table. F9 SHOULD call
 * this via the public barrel (`@/modules/broadcasts`) instead of
 * re-declaring the event-type list, so future F7 catalogue amendments
 * automatically flow through to F9 with zero code change. Pure
 * predicate — no DB access, no port shape, no Application port.
 */
export function isF7AuditEventType(
  eventType: string,
): eventType is F7AuditEventType {
  return (F7_AUDIT_EVENT_TYPES as readonly string[]).includes(eventType);
}

/**
 * Round 5 review type-design — per-event payload shapes for the
 * highest-leverage F7 audit events. The full DU (all 43 event types)
 * is deliberately NOT enforced through the port signature because it
 * would require simultaneous rewrite of ~50 emit sites + ~70 test
 * fixtures, and the carve-outs needed for trace-replay test fixtures
 * would weaken the type guarantee anyway.
 *
 * Instead we ship a STRUCTURAL contract (this mapped type) that
 * dashboards / runbooks / future typed-emit helpers can reference —
 * covering the 8 most security-critical events whose payload shape is
 * load-bearing for cross-tenant / GDPR / quota forensics. Other events
 * keep the wide `Record<string, unknown>` shape and rely on emit-site
 * tests as the authoritative payload contract (per CLAUDE.md
 * test-first principle).
 *
 * If a new event needs typed-payload enforcement, add it to this map
 * AND a `F7AuditPayloadFor<E>` derivation in the typed-emit helper
 * (`emitTyped` below).
 */
export interface F7AuditPayloadShapes {
  readonly broadcast_submitted: {
    readonly broadcastId: string;
    readonly actorRole: 'member_self_service' | 'admin_proxy';
    readonly segmentType: string;
    readonly estimatedRecipientCount: number;
    // R1.1 M-code-2: FR-022 analytics field — null when draft began
    // Blank, populated when draft was started from a template via T102.
    readonly startedFromTemplateId: string | null;
  };
  readonly broadcast_cancelled: {
    readonly broadcastId: string;
    readonly actorKind: 'member' | 'admin' | 'system';
    readonly actorRole: 'member_self_service' | 'admin_proxy' | 'system';
    readonly cancellationReason: string | null;
    readonly cancelledAt: string;
  };
  readonly broadcast_unsubscribed: {
    readonly recipientEmailHashed: string;
    readonly broadcastId: string | null;
    readonly tokenHash: string;
  };
  readonly broadcast_suppression_applied: {
    readonly recipientEmailHashed: string;
    readonly source: 'webhook_bounce' | 'webhook_complaint' | 'public_unsubscribe';
  };
  readonly broadcast_quota_consumed: {
    readonly broadcastId: string;
    readonly quotaYearConsumed: number;
    readonly recipientCount: number;
  };
  readonly broadcast_cross_tenant_probe: {
    readonly probedTenantId: string;
    // R1.1 H-code-4: one of probedBroadcastId | probedTemplateId is set,
    // discriminated by resourceKind. Older emit sites pre-R1.1 omit
    // resourceKind (treated as 'broadcast' default for back-compat).
    readonly probedBroadcastId?: string;
    readonly probedTemplateId?: string;
    readonly resourceKind?: 'broadcast' | 'template';
  };
  readonly broadcast_cross_member_probe: {
    readonly probedMemberId: string;
    readonly probedBroadcastId: string;
  };
  readonly broadcast_webhook_batch_missing: {
    readonly broadcastId: string;
    readonly batchManifestId: string;
    readonly batchIndex: number;
    readonly resendEventId: string;
    readonly resendEventType: string;
  };
  // R1.1 CRIT-4: snapshot-moment forensic audit. Emitted inside the
  // snapshot use-case's withTx so audit row + body mutation + counter
  // increment co-commit (Constitution I clause 3 atomicity).
  readonly broadcast_template_snapshotted: {
    readonly broadcastId: string;
    readonly templateId: string;
    readonly templateNameSnapshot: string;
    readonly memberId: string;
  };
  // R2.1 M-test-2 — seed-time conflict between a starter template's
  // (name, locale) and a tenant-pre-existing template with the same
  // tuple. ON CONFLICT DO NOTHING in migration 0168 silently dropped
  // the starter row; this audit row makes the skip forensically
  // visible.
  readonly broadcast_template_seed_skipped_existing_name: {
    readonly tenantId: string;
    readonly attemptedName: string;
    readonly locale: 'en' | 'th' | 'sv';
    readonly source: 'starter_seed' | 'admin_reseed';
  };
  readonly broadcast_webhook_signature_rejected: {
    readonly reason:
      | 'feature_disabled'
      | 'body_too_large'
      | 'missing_header'
      | 'bad_signature';
  };
}

/**
 * Mapped type — `F7AuditPayloadFor<'broadcast_submitted'>` resolves to
 * the per-event payload shape, defaulting to the wide
 * `Record<string, unknown>` for events not yet in `F7AuditPayloadShapes`.
 */
export type F7AuditPayloadFor<E extends F7AuditEventType> =
  E extends keyof F7AuditPayloadShapes
    ? F7AuditPayloadShapes[E]
    : Record<string, unknown>;

/**
 * F7 audit event payload contract. F7 emit sites populate `payload`
 * with event-specific fields per data-model.md § 6 (e.g.,
 * `broadcast_submitted` carries `broadcastId`, `segmentType`,
 * `estimatedRecipientCount`, etc.).
 *
 * The structural payload contract is `F7AuditPayloadShapes` /
 * `F7AuditPayloadFor<E>` above (Round 5 type-design). The port keeps
 * the wide `Record<string, unknown>` payload field for back-compat
 * with the ~50 untyped emit sites; new emit sites SHOULD migrate to
 * the typed helper once a per-event entry is added to
 * `F7AuditPayloadShapes`.
 */
export interface F7AuditEvent {
  readonly eventType: F7AuditEventType;
  readonly actorUserId: string;
  readonly summary: string;
  readonly payload: Record<string, unknown>;
}

export interface AuditEmitInput extends F7AuditEvent {
  /**
   * Tenant slug. `null` is permitted ONLY for pre-tenant audit paths
   * where the route has not (or cannot) bind a tenant context — e.g.
   * the public unsubscribe page on a malformed token, or the Resend
   * webhook handler on a signature-reject before the audience-id
   * lookup runs. The `audit_log.tenant_id` column is nullable for this
   * exact reason. Mutation paths MUST always pass a non-null slug —
   * the runtime adapter (`f7AuditAdapter`) asserts this invariant when
   * `tx !== null` (a mutation tx + null tenant is a programmer error).
   */
  readonly tenantId: string | null;
  readonly requestId: string | null;
}

/**
 * Audit emitter interface.
 *
 * `tx` semantics (mirrors F4 + F5):
 *   - **Mutation path**: pass the Drizzle tx handle. Audit row lands
 *     in the same transaction (Constitution Principle I clause 3
 *     atomicity). The adapter asserts `tenantId !== null` when a
 *     non-null tx is passed (mutation tx + null tenant = programmer
 *     error; the row would land in the wrong RLS slice).
 *   - **Read-path probe** (cross-tenant-probe audits): pass `null`.
 *     Adapter writes on auto-commit; probe loss is best-effort.
 *
 * Note: function-overload signatures encoding the (tx, tenantId)
 * invariant at compile time were considered but rejected because
 * vitest's `vi.fn()` mock typings collide with overloaded interface
 * signatures across ~12 test files. Runtime assertion in the adapter
 * provides equivalent fail-fast behaviour without the test churn.
 */
export interface AuditPort {
  emit(tx: unknown, event: AuditEmitInput): Promise<void>;
}
