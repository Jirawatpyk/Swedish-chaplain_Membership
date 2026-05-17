/**
 * POST /api/auth/heartbeat (T164, contracts/auth-api.md § 11).
 *
 * Refreshes `sessions.last_seen_at` without any other side effect —
 * fuels the "Stay signed in" button on the idle-warning dialog
 * (FR-022, ux-standards § 8.2). Does NOT extend the absolute 12-hour
 * cap.
 *
 * Clean Architecture note (verify gate 2026-04-10): this route
 * handler previously reached into `sessionRepo` and `rateLimiter`
 * directly, duplicating what a use case should do. Both side effects
 * now live in `heartbeat()` inside the Application layer; the route
 * handler's only job is HTTP (session presence check, status codes,
 * `Retry-After` header, log line).
 *
 * Audit: **none**. Heartbeats are routine (one per idle cycle per
 * active tab) and would flood the append-only log. Spec § US7
 * explicitly exempts idle/absolute timeout expirations from the
 * audit trail, and routine heartbeats share that rationale.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getCurrentSession } from '@/lib/auth-session';
import { logger } from '@/lib/logger';
import { hashId } from '@/lib/log-id';
import { requestIdFromHeaders } from '@/lib/request-id';
import { heartbeat } from '@/modules/auth';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);

  // Wrap the whole body in try/catch so an infra throw (Neon blip
  // during session lookup, Upstash blip during rate-limit check)
  // produces a structured 500 JSON response with a `requestId` for
  // log correlation — matching the pattern used by
  // `requireAdminContext` in the other auth routes. Without this,
  // the idle-warning dialog's client-side fetch would receive a raw
  // Next.js 500 HTML body and its `response.json()` parse would
  // throw instead of gracefully degrading to "couldn't extend,
  // sign out soon".
  try {
    const current = await getCurrentSession();
    if (!current) {
      return NextResponse.json({ error: 'no-session' }, { status: 401 });
    }

    const result = await heartbeat({
      sessionId: current.session.id,
      requestId,
    });

    if (!result.ok) {
      // Never log raw session IDs (observability.md § 3, CLAUDE.md § Secrets).
      // `sessionIdHash` gives the same correlation power without the PII.
      logger.warn(
        { requestId, sessionIdHash: hashId(current.session.id) },
        'heartbeat.rate-limited',
      );
      return NextResponse.json(
        { error: 'rate-limited' },
        {
          status: 429,
          headers: {
            'Retry-After': String(result.error.retryAfterSeconds),
          },
        },
      );
    }

    return NextResponse.json(
      { ok: true, lastSeenAt: result.value.lastSeenAt.toISOString() },
      { status: 200 },
    );
  } catch (error) {
    // M1 (Round 3) — include requestId in body for client-side log
    // correlation. Pre-fix the body was bare 'server-error' and the
    // idle-warning dialog had no handle to surface to user-reports.
    logger.error({ err: error, requestId }, 'heartbeat.infra-error');
    return NextResponse.json(
      { error: 'server-error', requestId },
      { status: 500 },
    );
  }
}
