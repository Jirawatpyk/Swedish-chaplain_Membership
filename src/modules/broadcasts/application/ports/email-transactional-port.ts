/**
 * T028 — `EmailTransactionalPort` Application port (F7).
 *
 * Transactional Resend client — distinct from F7 Broadcasts API
 * (`BroadcastsGatewayPort`). Reuses F1+F4 transactional surface for
 * member + admin notification emails about broadcasts:
 *   - Admin notification on submit: "Member X submitted a broadcast for review"
 *   - Member notification on approval: "Your broadcast was approved"
 *   - Member notification on rejection: "Your broadcast was rejected — reason: <verbatim>"
 *   - Member notification on cancel-too-late: "Your broadcast couldn't be cancelled"
 *   - Member notification on dispatch failure: "Your broadcast failed to dispatch"
 *
 * NOT used for the broadcast itself (recipient list dispatch goes
 * through `BroadcastsGatewayPort`). NOT used for the public unsubscribe
 * confirmation email (rendered server-side; no email sent — clicking
 * the unsubscribe link IS the confirmation).
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { TenantContext } from '@/modules/tenants';

export interface SendEmailInput {
  readonly to: string;
  readonly subject: string;
  readonly templateKey: string;
  readonly payload: Record<string, unknown>;
  readonly locale: 'en' | 'th' | 'sv';
}

export interface EmailTransactionalPort {
  /**
   * Send a notification to an admin user.
   * Implementation looks up admin email from tenant config + RBAC role.
   */
  sendAdminNotification(
    tenantCtx: TenantContext,
    input: SendEmailInput,
  ): Promise<void>;

  /**
   * Send a notification to the member who originated the broadcast.
   * Implementation uses `members.primary_contact_email` as `to`.
   *
   * `tx` (review ERR-C1) — when caller is inside a `broadcastsRepo.withTx`
   * scope, pass the transaction handle so the outbox INSERT participates
   * in the same atomic write. A tx-scoped enqueue + commit guarantees
   * the AS3 invariant ("every sending → sent transition produces a
   * summary email") cannot be broken by an outbox INSERT failing AFTER
   * the broadcast_sent audit committed. Pass `null` for standalone
   * outbox inserts (read-path notifications, admin-side).
   */
  sendMemberEmail(
    tenantCtx: TenantContext,
    input: SendEmailInput,
    tx: unknown | null,
  ): Promise<void>;
}
