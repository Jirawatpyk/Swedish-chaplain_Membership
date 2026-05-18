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
// Cron job: bulk UPDATE on `users` + per-row audit row. No
// Application use case exists for bulk cleanup — it is a
// maintenance path, not a user flow. Wrapping in a passthrough
// use case would add no behaviour. Documented escape hatch.
 
import { users } from '@/modules/auth/infrastructure/db/schema';
import { auditRepo } from '@/modules/auth/infrastructure/db/audit-repo';
 
import { asUserId } from '@/modules/auth';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { hashId } from '@/lib/log-id';
import { requestIdFromHeaders } from '@/lib/request-id';
import { verifyCronBearer } from '@/lib/cron-auth';

// /code-review (2026-05-19 post-ship) — explicit Node runtime + force-
// dynamic to match the project-wide cron-route convention (precedent:
// PR #22 review for `dispatch-scheduled`). `verifyCronBearer` uses
// `node:crypto.timingSafeEqual` and the route reads
// `process.env.CRON_SECRET` per-request — both rely on the Node
// runtime + dynamic execution. Works today because Vercel App Router
// defaults to Node + Dynamic for route handlers; explicit exports
// defend against future default drift.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);

  // Vercel Cron attaches Bearer CRON_SECRET; accept that OR, in dev,
  // accept unauthenticated calls so the operator can trigger manually.
  const authHeader = request.headers.get('authorization');
  const expected = process.env.CRON_SECRET;
  if (expected) {
    // R7 staff-review MED-S1 fix — timing-safe Bearer compare via
    // `verifyCronBearer` to match F7 cron auth pattern.
    if (!verifyCronBearer(authHeader, expected)) {
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
        { requestId, err: error, userIdHash: hashId(row.id) },
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
//
// R8 staff-review R8-S2 — both verbs go through the same
// `verifyCronBearer(authHeader, expected)` gate at the top of GET.
// CSRF is not a concern because the gate requires the shared
// `CRON_SECRET` in the Authorization header (browsers cannot set
// arbitrary Authorization on cross-origin POSTs without CORS
// preflight, which Vercel does not advertise). Operational risk: a
// misconfigured internal health-check posting with the secret could
// trigger an unintended cleanup — accept as low-severity since the
// cleanup is itself idempotent (only clears expired lockouts).
export const POST = GET;
