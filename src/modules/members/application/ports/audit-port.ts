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
  | 'member_portal_invite_queued';

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
