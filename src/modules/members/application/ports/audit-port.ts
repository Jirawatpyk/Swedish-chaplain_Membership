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
  // F8 Phase 2 T013 — `member_plan_manually_changed` is reserved for
  // Wave C alongside its DB-side `audit_event_type` pgEnum extension
  // (the F3 → drizzle adapter type-checks against the enum literal
  // union; widening F3AuditEventType without the DB enum extension
  // breaks `audit-adapter.ts` typecheck). Wave C will: (1) add the
  // enum value via a migration `ALTER TYPE audit_event_type ADD
  // VALUE 'member_plan_manually_changed'`, (2) extend the Drizzle
  // pgEnum schema, (3) re-add the union member here, (4) emit from
  // `change-plan.ts` alongside `member_plan_changed`. Tasks.md T013
  // marked deferred to Wave C accordingly.
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
  | 'member_preferred_locale_changed';

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
