/**
 * Lockout cleanup cron (T160, spec US7, FR-013 cleanup path).
 *
 * Scheduled via Vercel Cron (or equivalent) — e.g. every 15 minutes:
 *   vercel.json: { "crons": [{ "path": "/api/cron/lockout-cleanup",
 *                               "schedule": "*\/15 * * * *" }] }
 *
 * Scans for users whose `locked_until` timestamp is in the past,
 * clears the lockout fields (`locked_until = null`,
 * `failed_sign_in_count = 0`), and emits one `lockout_cleared` audit
 * event per cleared user.
 *
 * Authentication: the endpoint is gated by the Vercel-provided
 * `CRON_SECRET` env var (Bearer token in the Authorization header).
 * In dev, we allow unauthenticated calls (logged with a warning) so
 * operators can trigger it manually via curl.
 *
 * Idempotent: running the cron twice in a row is safe — the second
 * run finds no rows to clear and emits zero audit events.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { db } from '@/lib/db';
import { users } from '@/modules/auth/infrastructure/db/schema';
import { auditRepo } from '@/modules/auth/infrastructure/db/audit-repo';
import { asUserId } from '@/modules/auth/domain/branded';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { requestIdFromHeaders } from '@/lib/request-id';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);

  // Vercel Cron attaches Bearer CRON_SECRET; accept that OR, in dev,
  // accept unauthenticated calls so the operator can trigger manually.
  const authHeader = request.headers.get('authorization');
  const expected = process.env.CRON_SECRET;
  if (expected) {
    if (authHeader !== `Bearer ${expected}`) {
      logger.warn({ requestId }, 'cron.lockout_cleanup.unauthorized');
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  } else if (!env.isDevelopment) {
    logger.error({ requestId }, 'cron.lockout_cleanup.no_secret_configured');
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const now = new Date();

  // Find users whose lock has expired
  const expired = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        isNotNull(users.lockedUntil),
        lte(users.lockedUntil, now),
      ),
    );

  if (expired.length === 0) {
    logger.info({ requestId, cleared: 0 }, 'cron.lockout_cleanup.noop');
    return NextResponse.json({ ok: true, cleared: 0 }, { status: 200 });
  }

  // Clear the lockout fields + emit one audit event per user.
  // Each row is cleared + audited independently so a mid-run DB
  // error leaves the partial progress intact (re-running the cron
  // picks up where we left off).
  let cleared = 0;
  for (const row of expired) {
    try {
      await db
        .update(users)
        .set({ lockedUntil: null, failedSignInCount: 0 })
        .where(eq(users.id, row.id));

      await auditRepo.append({
        eventType: 'lockout_cleared',
        actorUserId: 'system:cron',
        targetUserId: asUserId(row.id),
        sourceIp: null,
        summary: 'lockout expired, cleared by cron',
        requestId,
      });
      cleared += 1;
    } catch (error) {
      logger.error(
        { requestId, err: error, userId: row.id },
        'cron.lockout_cleanup.row_failed',
      );
      // Continue with remaining rows — idempotent retry will catch this
    }
  }

  logger.info({ requestId, cleared }, 'cron.lockout_cleanup.done');
  return NextResponse.json({ ok: true, cleared }, { status: 200 });
}

// POST mirror so the endpoint also responds to POST (Vercel Cron
// uses GET by default, but some schedulers use POST).
export const POST = GET;
