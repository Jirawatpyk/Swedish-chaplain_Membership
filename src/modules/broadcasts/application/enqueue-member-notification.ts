/**
 * Verify-fix R4 (Simplify-#2, 2026-05-02) — extracted from the 3
 * near-identical `enqueue*Notification` helpers in approve/reject/
 * cancel-broadcast.ts (~35 lines × 3 = ~105 lines duplicate). All 3
 * shared the same shape skeleton (lookup → enqueue → log on failure)
 * and differed only in `templateKey` + 1-2 payload fields.
 *
 * Discriminated-union variant preserves the per-template payload shape
 * exactly (no payload field can leak across notification types). The
 * shared log-event prefix + retained `templateKey` in the structured
 * fields keeps grep-friendliness for ops dashboards.
 *
 * Best-effort: failures are logged + swallowed (mirrors the F4 outbox
 * + dispatch use-case pattern). Caller is responsible for in-tx
 * placement so the outbox INSERT commits atomically with the audit.
 */
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';
import type { Broadcast } from '../domain/broadcast';
import type { EmailTransactionalPort } from './ports/email-transactional-port';
import type { Locale } from '@/i18n/config';

export type BroadcastMemberNotificationVariant =
  | { readonly templateKey: 'broadcast_approved'; readonly scheduledForIso: string }
  | { readonly templateKey: 'broadcast_rejected'; readonly rejectionReason: string }
  | {
      readonly templateKey: 'broadcast_cancelled';
      readonly cancellationReason: string | null;
    };

export interface EnqueueBroadcastMemberNotificationArgs {
  readonly tenant: TenantContext;
  readonly emailTransactional: EmailTransactionalPort;
  readonly broadcast: Broadcast;
  readonly variant: BroadcastMemberNotificationVariant;
  readonly locale: Locale;
  readonly tx: unknown;
}

export async function enqueueBroadcastMemberNotification(
  args: EnqueueBroadcastMemberNotificationArgs,
): Promise<void> {
  const { tenant, emailTransactional, broadcast, variant, locale, tx } = args;
  if (broadcast.replyToEmail.length === 0) return;

  // Build per-template payload via discriminated union — TS narrows
  // `variant` so each branch sees exactly the fields it needs.
  let extraPayload: Record<string, unknown>;
  switch (variant.templateKey) {
    case 'broadcast_approved':
      extraPayload = { scheduledForIso: variant.scheduledForIso };
      break;
    case 'broadcast_rejected':
      extraPayload = { rejectionReason: variant.rejectionReason };
      break;
    case 'broadcast_cancelled':
      extraPayload = { cancellationReason: variant.cancellationReason };
      break;
  }

  try {
    await emailTransactional.sendMemberEmail(
      tenant,
      {
        to: broadcast.replyToEmail,
        subject: broadcast.subject,
        templateKey: variant.templateKey,
        payload: {
          broadcastId: broadcast.broadcastId,
          broadcastSubject: broadcast.subject,
          memberDisplayName: broadcast.fromName,
          ...extraPayload,
        },
        locale,
      },
      tx,
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId: tenant.slug,
        broadcastId: broadcast.broadcastId as string,
        templateKey: variant.templateKey,
      },
      'broadcasts.member_notification.enqueue_failed',
    );
  }
}
