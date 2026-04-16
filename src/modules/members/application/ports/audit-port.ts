/**
 * Application port — Audit log writer for F3 events.
 *
 * Reuses the F1+F2 `audit_log` table via an adapter. Use cases pass
 * narrow event descriptors — the adapter fills in `actor_user_id`,
 * `tenant_id`, and `timestamp` from the TenantContext + infrastructure.
 *
 * Payloads conform to data-model.md § 4 (23 F3 event types).
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
  | 'bulk_action_rate_limit_exceeded';

export type F3AuditEvent = {
  readonly type: F3AuditEventType;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly summary: string;
  readonly payload: Record<string, unknown>;
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
