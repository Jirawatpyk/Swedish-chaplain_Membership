/**
 * T106 — Email-transactional bridge adapter (F7 US2).
 *
 * Concrete `EmailTransactionalPort` impl. Enqueues member/admin
 * notification emails into the F1+F4 `notifications_outbox` table.
 * The existing F4 cron dispatcher (`/api/cron/outbox-dispatch/route.ts`)
 * picks them up and renders the template based on `notification_type`.
 *
 * F7 notification types (added by Migration 0073):
 *   - broadcast_dispatch_pending     — internal cron-trigger row (NOT
 *                                       a member-facing email)
 *   - broadcast_approved_notification
 *   - broadcast_rejected_notification
 *   - broadcast_cancelled_notification
 *
 * `templateKey` discriminator in the application-port input maps to
 * one of the 3 member-facing notification types. Admin notifications
 * (sendAdminNotification) reuse the same outbox but route to admin
 * email addresses (looked up from F1+F2 tenant settings — admin
 * notification path is stubbed with a logger warning so route handlers
 * can still call it without crashing; full admin-email lookup lands
 * with the F7 admin-rendering branch in the F4 cron dispatcher).
 *
 * Tx semantics (mirrors F4 outbox adapter):
 *   - non-null tx → INSERT participates in caller's mutation tx
 *   - null tx → standalone INSERT on `db` (auto-commit), used for
 *     read-path notifications outside a financial tx
 */
import { sql } from 'drizzle-orm';
import { db, type TenantTx } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';
import type {
  EmailTransactionalPort,
  SendEmailInput,
} from '../application/ports/email-transactional-port';

/**
 * F7 notification_type values supported by this adapter. MUST stay in
 * sync with the Postgres `notification_type` enum (migrations 0073 +
 * 0079). Drift is caught by
 * `tests/integration/broadcasts/notification-type-parity.test.ts`
 * which compares this union against `pg_enum` rows on live Neon.
 */
export type F7NotificationType =
  | 'broadcast_approved_notification'
  | 'broadcast_rejected_notification'
  | 'broadcast_cancelled_notification'
  | 'broadcast_delivered_notification';

export const F7_NOTIFICATION_TYPES: ReadonlyArray<F7NotificationType> = [
  'broadcast_approved_notification',
  'broadcast_rejected_notification',
  'broadcast_cancelled_notification',
  'broadcast_delivered_notification',
];

/** Resolve the F7 notification_type from the templateKey discriminator. */
function resolveNotificationType(templateKey: string): F7NotificationType {
  switch (templateKey) {
    case 'broadcast_approved':
      return 'broadcast_approved_notification';
    case 'broadcast_rejected':
      return 'broadcast_rejected_notification';
    case 'broadcast_cancelled':
      return 'broadcast_cancelled_notification';
    case 'broadcast_delivered':
      // FR-028 / AS3 — summary email enqueued at sending → sent transition
      // (both webhook-driven completion + 24h reconciliation paths).
      return 'broadcast_delivered_notification';
    default:
      throw new Error(
        `email-transactional-bridge: unknown templateKey "${templateKey}" — must be one of broadcast_{approved,rejected,cancelled,delivered}`,
      );
  }
}

/**
 * Enqueue a notification row into `notifications_outbox`. Mirrors the
 * F4 adapter's INSERT-on-tenant-tx pattern.
 */
async function enqueueOutboxRow(
  tx: TenantTx | null,
  tenantId: string,
  notificationType: F7NotificationType,
  toEmail: string,
  locale: 'en' | 'th' | 'sv',
  contextData: Record<string, unknown>,
): Promise<void> {
  const target = (tx as TenantTx | null) ?? db;
  await target.execute(sql`
    INSERT INTO notifications_outbox
      (tenant_id, notification_type, to_email, locale, context_data, status, attempts, next_retry_at)
    VALUES
      (${tenantId},
       ${notificationType}::notification_type,
       ${toEmail},
       ${locale},
       ${JSON.stringify(contextData)}::jsonb,
       'pending'::outbox_status,
       0,
       now())
  `);
}

export const emailTransactionalBridge: EmailTransactionalPort = {
  async sendAdminNotification(
    tenantCtx: TenantContext,
    input: SendEmailInput,
  ): Promise<void> {
    // Member-facing path is shipped; admin notifications need the F2
    // tenant-admin-email lookup which is stubbed for now. Log + no-op
    // so route handlers can still call this without crashing.
    logger.info(
      {
        tenantId: tenantCtx.slug,
        templateKey: input.templateKey,
        toHash: input.to.slice(0, 6),
        locale: input.locale,
      },
      'broadcasts.admin_notification.deferred',
    );
  },

  async sendMemberEmail(
    tenantCtx: TenantContext,
    input: SendEmailInput,
  ): Promise<void> {
    const notificationType = resolveNotificationType(input.templateKey);
    // payload travels into context_data so the F4 cron dispatcher can
    // render the right template at send time. The dispatcher needs a
    // per-templateKey rendering branch — until that branch lands the
    // dispatcher falls back to its existing F4 path and surfaces a
    // "rendering failed" log so missing templates are observable.
    const contextData: Record<string, unknown> = {
      event_type: input.templateKey,
      subject: input.subject,
      ...input.payload,
    };
    await enqueueOutboxRow(
      null,
      tenantCtx.slug,
      notificationType,
      input.to,
      input.locale,
      contextData,
    );
    logger.info(
      {
        tenantId: tenantCtx.slug,
        notificationType,
        toHash: input.to.slice(0, 6),
        locale: input.locale,
      },
      'broadcasts.member_notification.enqueued',
    );
  },
};
