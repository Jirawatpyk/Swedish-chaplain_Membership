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
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, type TenantTx } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';

/**
 * SHA-256 truncated to 12 hex chars of the lowercased recipient email
 * for log redaction (review PR #19 security follow-up). The previous
 * `input.to.slice(0, 6)` was a 6-char plaintext prefix — borderline PII
 * for a small-tenant deployment (~131 members) where prefixes like
 * `j.doe@` directly identify a member. SHA-256 is one-way at all preimage
 * spaces; truncating to 12 hex chars keeps the log compact while
 * preserving cross-event correlation (same email → same prefix).
 */
function recipientLogHash(rawEmail: string): string {
  return createHash('sha256')
    .update(rawEmail.toLowerCase(), 'utf8')
    .digest('hex')
    .slice(0, 12);
}
import type {
  EmailTransactionalPort,
  SendEmailInput,
} from '../application/ports/email-transactional-port';

/**
 * Runtime guard for `TenantTx` (review ERR-H-R3-1, round 3). The port
 * signature accepts `unknown | null` (Constitution Principle III — port
 * cannot import Drizzle types) so callers in any layer can pass any
 * value. Without this guard a truthy non-tx handle would silently
 * route through the type-cast fallback and execute the outbox INSERT
 * on a wrong connection, breaking the AS3 atomicity guarantee.
 *
 * Duck-types on the existence of `.execute(sql)` — Drizzle's tx and the
 * shared `db` both expose this method, but a plain object / number /
 * string would fail the check and hit the explicit throw below.
 */
function assertTenantTxOrNull(tx: unknown | null): TenantTx | null {
  if (tx === null || tx === undefined) return null;
  if (
    typeof tx === 'object' &&
    tx !== null &&
    typeof (tx as { execute?: unknown }).execute === 'function'
  ) {
    return tx as TenantTx;
  }
  throw new TypeError(
    'EmailTransactionalPort.sendMemberEmail: `tx` must be a TenantTx (from broadcastsRepo.withTx) or null. Received a value that does not expose .execute().',
  );
}

/**
 * F7 notification_type values supported by this adapter. MUST stay in
 * sync with the Postgres `notification_type` enum (migrations 0073 +
 * 0079). Drift is caught by
 * `tests/integration/broadcasts/notification-type-parity.test.ts`
 * which compares this list against `pg_enum` rows on live Neon.
 *
 * Single source of truth (review TYPES suggestion #2): the array is
 * the canonical list and the union is derived from it via
 * `(typeof F7_NOTIFICATION_TYPES)[number]`. This eliminates the
 * array-vs-union drift dimension that `as const satisfies` would still
 * leave open. Mirrors the `F7_AUDIT_EVENT_TYPES` pattern in audit-port.ts.
 */
export const F7_NOTIFICATION_TYPES = [
  'broadcast_approved_notification',
  'broadcast_rejected_notification',
  'broadcast_cancelled_notification',
  'broadcast_delivered_notification',
  'broadcast_failed_to_dispatch_notification',
] as const;

export type F7NotificationType = (typeof F7_NOTIFICATION_TYPES)[number];

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
    case 'broadcast_failed_to_dispatch':
      // FR-021 / AS2 — transactional email enqueued when the cron
      // dispatcher exhausts the 1-hour retry budget (Slice D) AND on any
      // permanent dispatch failure (Resend 4xx, audience-empty after
      // suppression, resource-missing). Quota reservation stays held;
      // member can re-trigger or re-schedule manually.
      return 'broadcast_failed_to_dispatch_notification';
    default:
      throw new Error(
        `email-transactional-bridge: unknown templateKey "${templateKey}" — must be one of broadcast_{approved,rejected,cancelled,delivered,failed_to_dispatch}`,
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
        toHash: recipientLogHash(input.to),
        locale: input.locale,
      },
      'broadcasts.admin_notification.deferred',
    );
  },

  async sendMemberEmail(
    tenantCtx: TenantContext,
    input: SendEmailInput,
    tx: unknown | null,
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
    // Review ERR-C1: thread caller's tx (when inside a broadcastsRepo
    // tx scope) so the outbox INSERT commits atomically with the
    // broadcast_sent audit + status transition. AS3 invariant: every
    // sending → sent transition MUST produce a summary email enqueue.
    // Review ERR-H-R3-1 (round 3): runtime duck-type guard converts
    // the port's `unknown | null` opacity into a verified TenantTx
    // (or null), throwing on truthy non-tx handles instead of silently
    // executing on the wrong connection.
    const verifiedTx = assertTenantTxOrNull(tx);
    await enqueueOutboxRow(
      verifiedTx,
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
        toHash: recipientLogHash(input.to),
        locale: input.locale,
      },
      'broadcasts.member_notification.enqueued',
    );
  },
};
