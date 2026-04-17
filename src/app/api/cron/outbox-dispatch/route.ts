/**
 * Outbox dispatcher cron (F3 US3.b.1 / T089).
 *
 * Scheduled via Vercel Cron every 60 seconds:
 *   vercel.json: { "crons": [{ "path": "/api/cron/outbox-dispatch",
 *                               "schedule": "* * * * *" }] }
 *
 * Drains `notifications_outbox` rows in `pending` status whose
 * `next_retry_at <= now()`. For each row it:
 *   1. Re-selects the row with FOR UPDATE SKIP LOCKED inside a fresh
 *      tx — this is the lock scope that prevents duplicate dispatch
 *      across concurrent cron ticks. The outer SELECT is lock-less
 *      and used only to pick candidates; the real lock lives inside
 *      the per-row tx.
 *   2. Builds the email HTML from the appropriate template based on
 *      `notification_type` + `context_data` + `locale`.
 *   3. Calls Resend via the shared `emailSender` (3-retry exponential
 *      backoff INSIDE the send — outer retry budget is the outbox
 *      attempts column).
 *   4. On success → status='sent', sent_message_id = response.id.
 *   5. On transient failure → attempts += 1, next_retry_at pushed
 *      exponentially (60s / 5m / 30m / 3h / 12h per FR-012c), last_error
 *      logged.
 *   6. On attempt == 5 failure or invalid-recipient → status='permanently_failed'
 *      + emit `email_dispatch_failed` audit event (FR-012c).
 *
 * Authentication: gated by the Vercel-provided `CRON_SECRET` env var
 * (Bearer). Dev environments allow unauthenticated manual triggers.
 *
 * Template types supported: `email_verification`, `email_change_revert`,
 * `email_verification_resent`, `member_invitation`. Unknown payloads
 * fall through as permanent failure after MAX_ATTEMPTS with an audit
 * event emission (FR-012c parity for unrenderable rows).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { and, count, eq, lt, lte } from 'drizzle-orm';
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
import { outboxMetrics } from '@/lib/metrics';
import { requestIdFromHeaders } from '@/lib/request-id';
/* eslint-disable no-restricted-imports --
 * Cron dispatcher is operational infrastructure — the same escape
 * hatch /api/cron/lockout-cleanup uses. */
import { emailSender } from '@/modules/auth/infrastructure/email/resend-client';
import { buildEmailVerificationEmail } from '@/modules/members/infrastructure/email/email-verification-email';
import { buildEmailChangeRevertEmail } from '@/modules/members/infrastructure/email/email-change-revert-email';
import type { EmailLocale } from '@/modules/members/infrastructure/email/email-verification-email';
import { buildInvitationEmail } from '@/modules/auth/infrastructure/email/invitation-email';
import { isRole } from '@/modules/auth/domain/role';
/* eslint-enable no-restricted-imports */

// Spec FR-012c: "≥ 5 attempts with exponential backoff 60s / 5m / 30m / 3h / 12h".
const RETRY_BACKOFF_SECONDS = [60, 300, 1_800, 10_800, 43_200] as const;
const MAX_ATTEMPTS = 5;

// Keeps the function within the Vercel 300s default timeout while giving
// comfortable headroom above expected throughput (< 50 emails/day per tenant).
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
 * when the row's notification_type + context_data do not produce a
 * renderable payload; the dispatcher then treats this as a permanent-
 * failure path with an explicit audit event so unrenderable rows do
 * not disappear silently.
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
    case 'member_invitation': {
      const token = typeof ctx.token === 'string' ? ctx.token : '';
      const roleRaw = typeof ctx.role === 'string' ? ctx.role : '';
      if (!token || !roleRaw || !isRole(roleRaw)) return null;
      return buildInvitationEmail({
        toEmail: row.toEmail,
        token,
        role: roleRaw,
        locale,
      });
    }
    default:
      return null;
  }
}

type DispatchOutcome = 'sent' | 'retried' | 'permanent' | 'skipped';

/**
 * Process one outbox row inside its own db.transaction(). Re-selects
 * the row with FOR UPDATE SKIP LOCKED so only one cron tick ever sends
 * a given row, even when Vercel Cron overlaps ticks at high load.
 *
 * Returns 'skipped' when another tick already claimed the row.
 */
async function dispatchOne(
  rowId: string,
  requestId: string,
): Promise<DispatchOutcome> {
  return db.transaction(async (tx) => {
    // Re-select inside the tx with the lock. If another tick holds
    // the lock OR the row is no longer pending, return 'skipped'.
    const [row] = await tx
      .select()
      .from(notificationsOutbox)
      .where(
        and(
          eq(notificationsOutbox.id, rowId),
          eq(notificationsOutbox.status, 'pending'),
        ),
      )
      .for('update', { skipLocked: true })
      .limit(1);

    if (!row) return 'skipped';

    const payload = buildPayload(row);
    const now = new Date();

    if (!payload) {
      const nextAttempt = row.attempts + 1;
      const isPermanent = nextAttempt >= MAX_ATTEMPTS;

      if (isPermanent) {
        await tx
          .update(notificationsOutbox)
          .set({
            attempts: nextAttempt,
            status: 'permanently_failed' as const,
            lastError: 'no_template_handler',
            updatedAt: now,
          })
          .where(eq(notificationsOutbox.id, row.id));

        // S1 — audit emission parity with send-failure permanent path.
        // Emitted inside the tx so it commits atomically with the status
        // flip. `auditLog.tenantId` is nullable (schema.ts:256) — for
        // cross-tenant platform rows (F1 invitation flow with
        // tenant_id=null) we still insert the audit row with tenantId
        // null so compliance evidence lives in the append-only table
        // rather than only in pino logs.
        await tx.insert(auditLog).values({
          eventType: 'email_dispatch_failed',
          actorUserId: 'system:cron',
          summary: `outbox row ${row.id} permanently failed (no_template_handler) after ${nextAttempt} attempts`,
          requestId,
          tenantId: row.tenantId,
          payload: {
            outbox_row_id: row.id,
            notification_type: row.notificationType,
            attempts: nextAttempt,
            reason: 'no_template_handler',
          },
        });
        outboxMetrics.permanentFailure(row.notificationType);
        return 'permanent';
      }

      // Same exponential schedule as the send-failure path (FR-012c):
      // 60s / 5m / 30m / 3h / 12h. Keeps retry cadence uniform across
      // transient-template and transient-send failures.
      const noTplBackoffSeconds =
        RETRY_BACKOFF_SECONDS[
          Math.min(nextAttempt - 1, RETRY_BACKOFF_SECONDS.length - 1)
        ]!;
      await tx
        .update(notificationsOutbox)
        .set({
          attempts: nextAttempt,
          nextRetryAt: new Date(now.getTime() + noTplBackoffSeconds * 1000),
          lastError: 'no_template_handler',
          updatedAt: now,
        })
        .where(eq(notificationsOutbox.id, row.id));
      return 'retried';
    }

    // NOTE: Resend send happens INSIDE the tx. The tx holds a row-level
    // lock until commit — two concurrent ticks cannot both send the
    // same row. The tradeoff is that the tx stays open for the duration
    // of the HTTP call to Resend (typically < 2 s). At our current
    // throughput (< 50 emails/day) this is acceptable; if it becomes a
    // bottleneck we can switch to a claim+release pattern where the tx
    // only claims the row and the send happens outside.
    const result = await emailSender.send({
      to: row.toEmail,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
    });

    if (result.ok) {
      await tx
        .update(notificationsOutbox)
        .set({
          status: 'sent',
          sentMessageId: result.value.messageId,
          updatedAt: new Date(),
        })
        .where(eq(notificationsOutbox.id, row.id));
      return 'sent';
    }

    const nextAttempt = row.attempts + 1;
    const isPermanent =
      nextAttempt >= MAX_ATTEMPTS || result.error.code === 'invalid-recipient';

    if (isPermanent) {
      await tx
        .update(notificationsOutbox)
        .set({
          status: 'permanently_failed',
          attempts: nextAttempt,
          lastError: result.error.message,
          updatedAt: new Date(),
        })
        .where(eq(notificationsOutbox.id, row.id));

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

      // S1 — always insert audit inside tx (tenantId nullable in schema).
      // Cross-tenant platform rows (F1 invitation, tenant_id=null) now
      // land in auditLog for compliance parity with tenant-scoped rows.
      await tx.insert(auditLog).values({
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
      outboxMetrics.permanentFailure(row.notificationType);
      return 'permanent';
    }

    const backoffSeconds =
      RETRY_BACKOFF_SECONDS[
        Math.min(nextAttempt - 1, RETRY_BACKOFF_SECONDS.length - 1)
      ]!;
    const nextRetryAt = new Date(now.getTime() + backoffSeconds * 1000);

    await tx
      .update(notificationsOutbox)
      .set({
        attempts: nextAttempt,
        nextRetryAt,
        lastError: result.error.message,
        updatedAt: new Date(),
      })
      .where(eq(notificationsOutbox.id, row.id));

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
    return 'retried';
  });
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
  } else {
    // S3 — loud warning so an accidental dev-mode deploy is immediately
    // visible in aggregated logs. Dev-mode + missing CRON_SECRET means
    // any unauthenticated caller can drain the outbox.
    logger.warn(
      { requestId },
      'cron.outbox_dispatch.dev_mode_unauthenticated_drain',
    );
  }

  const now = new Date();

  // Lock-less candidate pick. Real per-row lock happens inside dispatchOne.
  const ready = await db
    .select({ id: notificationsOutbox.id })
    .from(notificationsOutbox)
    .where(
      and(
        eq(notificationsOutbox.status, 'pending'),
        lte(notificationsOutbox.nextRetryAt, now),
      ),
    )
    .limit(BATCH_SIZE);

  if (ready.length === 0) {
    return NextResponse.json({ ok: true, dispatched: 0 }, { status: 200 });
  }

  let sent = 0;
  let retried = 0;
  let permanent = 0;
  let skipped = 0;

  for (const { id } of ready) {
    try {
      const outcome = await dispatchOne(id, requestId);
      if (outcome === 'sent') sent += 1;
      else if (outcome === 'retried') retried += 1;
      else if (outcome === 'permanent') permanent += 1;
      else skipped += 1;
    } catch (txError) {
      // Tx failed (connection loss, deadlock). Row stays pending and a
      // future tick will retry via the normal SKIP LOCKED path.
      logger.error(
        { requestId, outboxRowId: id, err: txError },
        'cron.outbox_dispatch.tx_failed',
      );
    }
  }

  // Level 2 — stuck-rows check: pending rows whose next_retry_at is > 30 min
  // overdue indicate the cron has been down or lost CRON_SECRET. Alert
  // threshold: any non-zero rate sustained for 5 minutes.
  const stuckThreshold = new Date(Date.now() - 30 * 60_000);
  const [stuckResult] = await db
    .select({ stuckCount: count() })
    .from(notificationsOutbox)
    .where(
      and(
        eq(notificationsOutbox.status, 'pending'),
        lt(notificationsOutbox.nextRetryAt, stuckThreshold),
      ),
    );
  const stuckCount = stuckResult?.stuckCount ?? 0;
  if (stuckCount > 0) {
    outboxMetrics.stuckRows(stuckCount);
    logger.error(
      { requestId, stuckCount },
      'cron.outbox_dispatch.stuck_rows_detected',
    );
  }

  logger.info(
    { requestId, inspected: ready.length, sent, retried, permanent, skipped },
    'cron.outbox_dispatch.done',
  );
  return NextResponse.json(
    { ok: true, inspected: ready.length, sent, retried, permanent, skipped },
    { status: 200 },
  );
}

// POST mirror so alternative schedulers that use POST also work.
export const POST = GET;
