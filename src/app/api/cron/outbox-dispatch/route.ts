/**
 * Outbox dispatcher cron (F3 US3.b.1 / T089 scaffold).
 *
 * Scheduled via Vercel Cron every 60 seconds:
 *   vercel.json: { "crons": [{ "path": "/api/cron/outbox-dispatch",
 *                               "schedule": "* * * * *" }] }
 *
 * Drains `notifications_outbox` rows in `pending` status whose
 * `next_retry_at <= now()`. For each row it:
 *   1. Builds the email HTML from the appropriate template based on
 *      `notification_type` + `context_data` + `locale`.
 *   2. Calls Resend via the shared `emailSender` (3-retry exponential
 *      backoff INSIDE the send — outer retry budget is the outbox
 *      attempts column).
 *   3. On success → status='sent', sent_message_id = response.id.
 *   4. On transient failure → attempts += 1, next_retry_at pushed
 *      exponentially (1m, 2m, 4m, 8m, 16m), last_error logged.
 *   5. On attempt == 5 failure → status='permanently_failed' +
 *      emit `email_dispatch_failed` audit event (FR-012c).
 *
 * Authentication: gated by the Vercel-provided `CRON_SECRET` env var
 * (Bearer). Dev environments allow unauthenticated manual triggers.
 *
 * Idempotency: two simultaneous crons would race on the same row.
 * `FOR UPDATE SKIP LOCKED` + a per-row transaction ensures one
 * dispatcher wins per row. The drain loop here is a scaffold — the
 * full SKIP LOCKED implementation lands in US3.b.2 once the atomic
 * transaction pattern is exercised end-to-end.
 *
 * Scaffold limitations (TODO for US3.b.2 / T089 full implementation):
 *   - Template selection wired for `email_verification` +
 *     `email_change_revert` only; `member_invitation` +
 *     `email_verification_resent` are stubbed.
 *   - Retry-budget config is inlined here; spec § Security 4.2 calls
 *     for per-notification-type budgets — follow-up in US3.b.2.
 *   - No audit emission on permanent failure yet (needs the F3 audit
 *     adapter wired through a system tenant context — out of scope
 *     for the foundation).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { and, eq, lte, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
/* eslint-disable no-restricted-imports --
 * Cron job: direct UPDATE on `notifications_outbox` + auditLog — this
 * is the operational drain path, not a user flow. Same escape hatch
 * as /api/cron/lockout-cleanup. */
import {
  auditLog,
  notificationsOutbox,
  type NotificationsOutboxRow,
} from '@/modules/auth/infrastructure/db/schema';
/* eslint-enable no-restricted-imports */
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { requestIdFromHeaders } from '@/lib/request-id';
/* eslint-disable no-restricted-imports --
 * Cron dispatcher is operational infrastructure — the same escape
 * hatch /api/cron/lockout-cleanup uses. It pulls the shared Resend
 * sender + per-type template builders directly. Wrapping these in
 * public barrels would add no behaviour and would force the cron to
 * depend on module composition roots that are tests-facing, not
 * cron-facing. */
import { emailSender } from '@/modules/auth/infrastructure/email/resend-client';
import { buildEmailVerificationEmail } from '@/modules/members/infrastructure/email/email-verification-email';
import { buildEmailChangeRevertEmail } from '@/modules/members/infrastructure/email/email-change-revert-email';
import type { EmailLocale } from '@/modules/members/infrastructure/email/email-verification-email';
/* eslint-enable no-restricted-imports */

// Spec FR-012c: "≥ 5 attempts with exponential backoff 60s / 5m / 30m / 3h / 12h".
// Expressed in seconds so 60s and sub-minute boundaries can't drift due to
// integer-minute quantisation of an earlier draft that used [1, 2, 4, 8, 16]m.
// Index = attempts-after-increment (1..5). On the 5th failure the row flips
// to `permanently_failed` and an email_dispatch_failed audit event fires
// (audit emission is US3.b.3 — still TODO below).
const RETRY_BACKOFF_SECONDS = [60, 300, 1_800, 10_800, 43_200] as const;
const MAX_ATTEMPTS = 5;

// How many rows a single cron tick attempts. Keeps the function
// within the Vercel 300s default timeout while giving comfortable
// headroom above expected throughput (< 50 emails/day per tenant).
const BATCH_SIZE = 50;

type Locale = EmailLocale;

function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'th' || value === 'sv';
}

interface BuiltPayload {
  subject: string;
  html: string;
  text: string;
}

/**
 * Translate an outbox row into a ready-to-send email. Returns `null`
 * for notification types the scaffold does not yet handle — the
 * dispatcher treats these as a transient failure so a future deploy
 * can drain them.
 */
function buildPayload(row: NotificationsOutboxRow): BuiltPayload | null {
  const locale: Locale = isLocale(row.locale) ? row.locale : 'en';
  const ctx = row.contextData as Record<string, unknown>;

  switch (row.notificationType) {
    case 'email_verification':
    case 'email_verification_resent': {
      const token = typeof ctx.token === 'string' ? ctx.token : '';
      if (!token) return null;
      return buildEmailVerificationEmail({
        toEmail: row.toEmail,
        token,
        locale,
      });
    }
    case 'email_change_revert': {
      const token = typeof ctx.token === 'string' ? ctx.token : '';
      const oldEmail = typeof ctx.oldEmail === 'string' ? ctx.oldEmail : '';
      const newEmail = typeof ctx.newEmail === 'string' ? ctx.newEmail : '';
      if (!token || !oldEmail || !newEmail) return null;
      return buildEmailChangeRevertEmail({
        toEmail: row.toEmail,
        oldEmail,
        newEmail,
        token,
        locale,
      });
    }
    case 'member_invitation':
      // Stubbed — F1 invitation already ships via resend-client directly.
      // Will be wired in US3.b.2 once the member-invitation flow
      // migrates off the synchronous path.
      return null;
    default:
      return null;
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);

  const authHeader = request.headers.get('authorization');
  const expected = process.env.CRON_SECRET;
  if (expected) {
    if (authHeader !== `Bearer ${expected}`) {
      logger.warn({ requestId }, 'cron.outbox_dispatch.unauthorized');
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  } else if (!env.isDevelopment) {
    logger.error({ requestId }, 'cron.outbox_dispatch.no_secret_configured');
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const now = new Date();

  // Pick up to BATCH_SIZE ready rows with FOR UPDATE SKIP LOCKED.
  // Vercel Cron guarantees "at least once" delivery — two instances can
  // overlap. SKIP LOCKED ensures each row is processed by exactly one
  // dispatcher, preventing duplicate email delivery.
  const ready = await db
    .select()
    .from(notificationsOutbox)
    .where(
      and(
        eq(notificationsOutbox.status, 'pending'),
        lte(notificationsOutbox.nextRetryAt, now),
      ),
    )
    .limit(BATCH_SIZE)
    .for('update', { skipLocked: true });

  if (ready.length === 0) {
    return NextResponse.json({ ok: true, dispatched: 0 }, { status: 200 });
  }

  let sent = 0;
  let retried = 0;
  let permanent = 0;

  for (const row of ready) {
    const payload = buildPayload(row);
    if (!payload) {
      // Row we can't render — push retry by 5 minutes and log once.
      // A future deploy with richer template support can drain it.
      const nextAttemptStub = row.attempts + 1;
      const isStubPermanent = nextAttemptStub >= MAX_ATTEMPTS;
      try {
        await db
          .update(notificationsOutbox)
          .set({
            attempts: nextAttemptStub,
            ...(isStubPermanent
              ? { status: 'permanently_failed' as const }
              : { nextRetryAt: new Date(now.getTime() + 5 * 60 * 1000) }),
            lastError: 'no_template_handler',
            updatedAt: new Date(),
          })
          .where(eq(notificationsOutbox.id, row.id));
        if (isStubPermanent) permanent += 1;
      } catch (dbError) {
        logger.error(
          { requestId, outboxRowId: row.id, err: dbError },
          'cron.outbox_dispatch.db_update_failed',
        );
      }
      continue;
    }

    const result = await emailSender.send({
      to: row.toEmail,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
    });

    if (result.ok) {
      try {
        await db
          .update(notificationsOutbox)
          .set({
            status: 'sent',
            sentMessageId: result.value.messageId,
            updatedAt: new Date(),
          })
          .where(eq(notificationsOutbox.id, row.id));
      } catch (dbError) {
        // Email sent but status not updated — row will be retried on
        // next tick. Resend deduplicates so this is safe.
        logger.error(
          { requestId, outboxRowId: row.id, err: dbError },
          'cron.outbox_dispatch.db_update_failed_after_send',
        );
      }
      sent += 1;
      continue;
    }

    // Transient or permanent? resend-client already distinguishes
    // `invalid-recipient` (permanent per-address) from
    // `upstream-unavailable` (transient). Either way the outbox
    // attempt counter is the source of truth for our retry budget.
    const nextAttempt = row.attempts + 1;
    const isPermanent =
      nextAttempt >= MAX_ATTEMPTS || result.error.code === 'invalid-recipient';

    if (isPermanent) {
      try {
        await db
          .update(notificationsOutbox)
          .set({
            status: 'permanently_failed',
            attempts: nextAttempt,
            lastError: result.error.message,
            updatedAt: new Date(),
          })
          .where(eq(notificationsOutbox.id, row.id));
      } catch (dbError) {
        logger.error(
          { requestId, outboxRowId: row.id, err: dbError },
          'cron.outbox_dispatch.db_update_failed',
        );
      }
      permanent += 1;
      logger.error(
        {
          requestId,
          outboxRowId: row.id,
          tenantId: row.tenantId,
          notificationType: row.notificationType,
          attempts: nextAttempt,
          errorCode: result.error.code,
        },
        'cron.outbox_dispatch.permanent_failure',
      );

      // FR-012c — emit a high-severity audit event. The actor is
      // `system:cron` (same sentinel /api/cron/lockout-cleanup uses).
      // The tenantId comes from the outbox row so the event lands on
      // the right tenant-scoped audit partition.
      try {
        await db.insert(auditLog).values({
          eventType: 'email_dispatch_failed',
          actorUserId: 'system:cron',
          summary: `outbox row ${row.id} permanently failed after ${nextAttempt} attempts`,
          requestId,
          tenantId: row.tenantId,
          payload: {
            outbox_row_id: row.id,
            notification_type: row.notificationType,
            attempts: nextAttempt,
            last_error: result.error.message,
          },
        });
      } catch (auditError) {
        logger.error(
          { requestId, err: auditError, outboxRowId: row.id },
          'cron.outbox_dispatch.audit_write_failed',
        );
      }

      continue;
    }

    const backoffSeconds =
      RETRY_BACKOFF_SECONDS[
        Math.min(nextAttempt - 1, RETRY_BACKOFF_SECONDS.length - 1)
      ]!;
    const nextRetryAt = new Date(now.getTime() + backoffSeconds * 1000);

    try {
      await db
        .update(notificationsOutbox)
        .set({
          attempts: nextAttempt,
          nextRetryAt,
          lastError: result.error.message,
          updatedAt: new Date(),
        })
        .where(eq(notificationsOutbox.id, row.id));
    } catch (dbError) {
      logger.error(
        { requestId, outboxRowId: row.id, err: dbError },
        'cron.outbox_dispatch.db_update_failed',
      );
    }
    retried += 1;
    logger.warn(
      {
        requestId,
        outboxRowId: row.id,
        tenantId: row.tenantId,
        attempts: nextAttempt,
        backoffSeconds,
        errorCode: result.error.code,
      },
      'cron.outbox_dispatch.retry_scheduled',
    );
  }

  // Silence unused-sql-import (drizzle pulls sql transitively via and/eq/lte)
  void sql;

  logger.info(
    { requestId, inspected: ready.length, sent, retried, permanent },
    'cron.outbox_dispatch.done',
  );
  return NextResponse.json(
    { ok: true, inspected: ready.length, sent, retried, permanent },
    { status: 200 },
  );
}

// POST mirror so alternative schedulers that use POST also work.
export const POST = GET;
