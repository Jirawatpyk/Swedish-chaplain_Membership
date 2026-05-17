/**
 * B-2 — Outbox retention purge (F4 Phase 9 / FR-036 follow-up).
 *
 * GDPR Art. 5(1)(e) storage limitation + PDPA §26 require that
 * personal data not be retained longer than necessary for the purpose
 * of processing. The `notifications_outbox` table accumulates
 * `to_email` + `context_data.document_number` on every sent or
 * permanently_failed row with no native expiry — the dispatch-pipeline
 * purpose is fulfilled the moment Resend accepts (or rejects) the
 * send, so retention beyond 90 days has no lawful basis.
 *
 * This cron DELETEs rows where:
 *   - `status IN ('sent', 'permanently_failed')`  (dispatch is terminal)
 *   - `updated_at < now() - INTERVAL '90 days'`   (purpose exhausted)
 *
 * `pending` rows are NEVER purged — they still represent an active
 * processing intent. Audit evidence of delivery/failure is preserved
 * separately in `audit_log` (legal-obligation retention, not touched
 * by this purge).
 *
 * Schedule: daily at 03:15 Bangkok (20:15 UTC). Configure in Vercel
 * dashboard → Settings → Cron Jobs with path `/api/cron/outbox-purge`
 * and the same `Authorization: Bearer $CRON_SECRET` header the
 * dispatcher uses.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { and, inArray, lt } from 'drizzle-orm';
import { db } from '@/lib/db';
 
import { notificationsOutbox } from '@/modules/auth/infrastructure/db/schema';
 
import { logger } from '@/lib/logger';
import { requestIdFromHeaders } from '@/lib/request-id';
import { verifyCronBearer } from '@/lib/cron-auth';

const RETENTION_DAYS = 90;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);

  const authHeader = request.headers.get('authorization');
  // R7 staff-review MED-S1 fix — switched from string `!==` (timing-
  // unsafe) to `verifyCronBearer` (constant-time) to match F7 cron
  // auth pattern across all cron routes. Closes side-channel risk on
  // CRON_SECRET enumeration.
  if (!verifyCronBearer(authHeader, process.env.CRON_SECRET ?? '')) {
    logger.warn({ requestId }, 'cron.outbox_purge.unauthorized');
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60_000);

  // Single DELETE in one round-trip. Returning minimal columns to get
  // the purged count for the dispatch-summary log without dragging
  // the whole row across the wire.
  const deleted = await db
    .delete(notificationsOutbox)
    .where(
      and(
        inArray(notificationsOutbox.status, ['sent', 'permanently_failed']),
        lt(notificationsOutbox.updatedAt, cutoff),
      ),
    )
    .returning({ id: notificationsOutbox.id });

  logger.info(
    {
      requestId,
      purgedCount: deleted.length,
      retentionDays: RETENTION_DAYS,
      cutoff: cutoff.toISOString(),
    },
    'cron.outbox_purge.completed',
  );

  return NextResponse.json(
    {
      ok: true,
      purged: deleted.length,
      retentionDays: RETENTION_DAYS,
      cutoff: cutoff.toISOString(),
    },
    { status: 200 },
  );
}

