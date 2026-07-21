/**
 * Application port — Audit log writer for F3 events.
 *
 * Reuses the F1+F2 `audit_log` table via an adapter. Use cases pass
 * narrow event descriptors — the adapter fills in `actor_user_id`,
 * `tenant_id`, and `timestamp` from the TenantContext + infrastructure.
 *
 * Payloads conform to data-model.md § 4. The union below is the single
 * source of truth for F3 event names — CLAUDE.md's "23 F3 event types"
 * count predates the US3.b email-change flow (which added `…_sent`,
 * `…_consumed`, `…_reverted`, `email_verification_resent`,
 * `email_dispatch_failed`, `…_notification_sent_to_old_address`,
 * `user_sessions_revoked`) and the F2-carry-over `plan_bundle_changed`.
 * The union is intentionally open to growth; consumers MUST use the
 * `assertNeverAuditEvent` helper in exhaustive switches so a forgotten
 * case is a compile-time error rather than silent data-loss.
 */
import type { TenantTx } from '@/lib/db';
import type { Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { RepoError } from './member-repo';

export type F3AuditEventType =
  | 'member_created'
  | 'member_updated'
  | 'member_plan_changed'
  // F8 Phase 2 Wave C T029b (migration 0095) — fires alongside
  // `member_plan_changed` when an admin MANUALLY mutates a member's
  // plan via the change-plan use-case. Auto-applied paths (F4
  // renewal-invoice applying a scheduled plan change in Phase 5+)
  // emit ONLY `member_plan_changed`, NOT this event. F8 supersede
  // listener (Phase 5+ T184) consumes only this specific event.
  | 'member_plan_manually_changed'
  // Plan-change → billing remediation (Package A, migration 0259). Forensic
  // record of the BILLING consequence when a member's live `members.plan_id`
  // diverges from a renewal cycle's frozen plan. Members-owned (this union),
  // but the `seed_fallback_plan_unresolvable` + `tier_upgrade_target_unresolvable`
  // variants are emitted from the F8 renewals seams (create-next-cycle-on-paid +
  // resolve-unlinked renewalComplete for the former; the tier-upgrade apply for
  // the latter) via a narrow renewals-owned audit port — renewals cannot import
  // the members AuditPort (Clean Architecture, Principle III), so its adapter
  // writes this shared pgEnum value to `audit_log` directly. `effect` is a free
  // JSONB payload string (no DB CHECK), so the union is authoritative here as
  // documentation only. The members change-plan operation emits the other
  // variants (a later package). 5y retention (F3 default — NOT a tax-document
  // event).
  //
  // Payload (English keys per repo convention):
  //   {
  //     member_id, old_plan_id, new_plan_id,
  //     cycle_id: string | null,
  //     effect: 'applied_to_open_cycle'
  //           | 'deferred_invoice_already_issued'
  //           | 'deferred_term_length_change'
  //           | 'deferred_immediate_not_enabled'
  //           | 'no_open_cycle'
  //           | 'seed_fallback_plan_unresolvable'     // <- emitted in Package A (seed seams)
  //           | 'tier_upgrade_target_unresolvable',   // <- emitted by the F8 tier-upgrade apply skip
  //     old_price_thb: string | null, new_price_thb: string | null,
  //     effective_from: string | null,
  //     blocking_invoice_id: string | null,
  //     blocking_source: 'linked' | 'member_scoped' | null,
  //   }
  | 'member_plan_change_billing_effect'
  | 'member_primary_contact_changed'
  | 'member_status_changed'
  | 'member_archived'
  | 'member_undeleted'
  | 'contact_created'
  | 'contact_updated'
  | 'contact_removed'
  | 'member_self_updated'
  | 'member_self_update_forbidden'
  | 'member_cross_tenant_probe'
  | 'plan_bundle_changed'
  | 'member_contact_email_changed'
  | 'user_sessions_revoked'
  | 'email_verification_sent'
  | 'email_verification_consumed'
  | 'email_change_notification_sent_to_old_address'
  | 'member_email_change_reverted'
  | 'email_verification_resent'
  | 'email_dispatch_failed'
  | 'invitation_bounced'
  | 'bulk_action_rate_limit_exceeded'
  | 'member_portal_invite_queued'
  | 'contact_linked_to_user'
  // R4 verify-fix Types-#6 (2026-05-02) — preferred_locale write path.
  | 'member_preferred_locale_changed'
  // 055-member-number (migration 0210) — emitted by createMember
  // immediately after the allocation INSERT returns. Payload:
  // { member_number: number }. 5y retention (F3 default).
  // See design doc §9 audit wiring.
  | 'member_number_assigned'
  // COMP-1 Member Erasure (migration 0221). 5y retention (F3 default).
  // `member_erasure_requested` is emitted durably BEFORE destructive work;
  // `member_erased` is the completion proof emitted ONLY after every cascade
  // reports complete. Neither payload may carry erased PII (append-only log).
  | 'member_erasure_requested'
  | 'member_erased'
  // COMP-1 US3-C (migration 0228) — best-effort sub-processor erasure
  // propagation. Payload: { member_id, reason, resend_outcome,
  // resend_contacts_removed_count, resend_contacts_failed_count,
  // stripe_outcome } — ids + outcomes ONLY, never erased PII. 5y retention.
  | 'subprocessor_erasure_propagated';

// F7 cross-module event types (`broadcast_member_dispatch_resumed` +
// `member_acknowledged_broadcasts_terms`) are NOT in this union —
// emission is the responsibility of F7's own audit-port + adapter
// (Phase 3+). F3 use-cases for setMemberHalt + markBroadcastsAcknowledged
// mutate the flag column only; F7's caller emits the audit. This keeps
// the DB-level `audit_event_type` enum consistent (no F7-specific values
// in F3's adapter writes) and the F7 → F3 dependency direction clean
// per Constitution Principle III.

/**
 * Exhaustiveness guard for switch statements over `F3AuditEventType`.
 * The compiler infers `never` at the `default:` branch only when every
 * member of the union has been handled; pass the event through this
 * helper to surface forgotten cases at build time. Throws at runtime
 * so unexpected production payloads are loud rather than silent.
 */
export function assertNeverAuditEvent(event: never): never {
  throw new Error(
    `Unhandled F3 audit event type: ${JSON.stringify(event)}`,
  );
}

export type F3AuditEvent = {
  readonly type: F3AuditEventType;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly summary: string;
  readonly payload: Record<string, unknown>;
  /**
   * Optional top-level `audit_log.target_user_id` column. Used by the
   * email-change flow (change / revert / resend-verification) so tests
   * + operators can filter by target without scanning the JSON payload.
   * When omitted, the column stays null.
   */
  readonly targetUserId?: string;
};

export interface AuditPort {
  record(
    ctx: TenantContext,
    event: F3AuditEvent,
  ): Promise<Result<undefined, RepoError>>;

  /** Record inside an existing transaction — for atomic persist+audit. */
  recordInTx(
    tx: TenantTx,
    ctx: TenantContext,
    event: F3AuditEvent,
  ): Promise<Result<undefined, RepoError>>;
}
