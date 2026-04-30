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
 * email addresses (looked up from F1+F2 tenant settings — deferred
 * to Wave 4 polish; Wave 2 stubs admin notification with a logger
 * warning so route handlers can still call it without crashing).
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

type F7NotificationType =
  | 'broadcast_approved_notification'
  | 'broadcast_rejected_notification'
  | 'broadcast_cancelled_notification';

/** Resolve the F7 notification_type from the templateKey discriminator. */
function resolveNotificationType(templateKey: string): F7NotificationType {
  switch (templateKey) {
    case 'broadcast_approved':
      return 'broadcast_approved_notification';
    case 'broadcast_rejected':
      return 'broadcast_rejected_notification';
    case 'broadcast_cancelled':
      return 'broadcast_cancelled_notification';
    default:
      throw new Error(
        `email-transactional-bridge: unknown templateKey "${templateKey}" — must be one of broadcast_{approved,rejected,cancelled}`,
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
    // Wave 2 ships member-facing path; admin notifications need the F2
    // tenant-admin-email lookup (deferred to Wave 4 polish per plan).
    // Log + no-op so route handlers can still call this without crashing.
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
    // render the right template at send time. The dispatcher will need
    // a per-templateKey rendering branch (Wave 4 polish — for Wave 2
    // we land the enqueue path; the dispatcher renders via its existing
    // F4 fallback if the F7 branch is missing, surfacing a "rendering
    // failed" log so we know to land the templates).
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
