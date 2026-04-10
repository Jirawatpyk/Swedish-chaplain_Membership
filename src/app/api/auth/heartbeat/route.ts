/**
 * POST /api/auth/heartbeat (T164, contracts/auth-api.md § 11).
 *
 * Refreshes `sessions.last_seen_at` without any other side effect —
 * fuels the "Stay signed in" button on the idle-warning dialog (FR-022,
 * ux-standards § 8.2). Does NOT extend the absolute 12-hour cap.
 *
 * Audit: **none**. Heartbeats are routine (one per idle cycle per
 * active tab) and would flood the append-only log. Spec § US7 explicitly
 * exempts idle/absolute timeout expirations from the audit trail, and
 * routine heartbeats share that rationale.
 *
 * Rate limit: 60 per minute per session. A well-behaved client fires at
 * most once per idle cycle (≈ every 29 minutes); 60/min leaves a huge
 * margin while still shutting off a runaway loop.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getCurrentSession } from '@/lib/auth-session';
import { logger } from '@/lib/logger';
import { hashId } from '@/lib/log-id';
import { requestIdFromHeaders } from '@/lib/request-id';
import { rateLimiter } from '@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter';
import { sessionRepo } from '@/modules/auth/infrastructure/db/session-repo';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);

  const current = await getCurrentSession();
  if (!current) {
    return NextResponse.json({ error: 'no-session' }, { status: 401 });
  }

  // 60 per minute per session id. Keyed on the session — not the user —
  // so that a user with multiple tabs gets a per-tab budget and a
  // misbehaving tab cannot starve a well-behaved one.
  const rl = await rateLimiter.check(
    `heartbeat:session:${current.session.id}`,
    60,
    60,
  );
  if (!rl.success) {
    // Never log raw session IDs (observability.md § 3, CLAUDE.md § Secrets).
    // `sessionIdHash` gives the same correlation power without the
    // PII — pino's redact list catches accidental top-level `sessionId`
    // fields too, but defence-in-depth: don't put it in the log object.
    logger.warn(
      { requestId, sessionIdHash: hashId(current.session.id) },
      'heartbeat.rate-limited',
    );
    return NextResponse.json(
      { error: 'rate-limited' },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.max(1, Math.ceil((rl.reset - Date.now()) / 1000))),
        },
      },
    );
  }

  // `getCurrentSession()` already updated `last_seen_at` as part of its
  // sliding-window heartbeat. We re-stamp here with a fresh `now` so the
  // contract's "atomic update" promise holds regardless of how much
  // compute sits between the two calls.
  const now = new Date();
  await sessionRepo.updateLastSeen(current.session.id, now);

  return NextResponse.json(
    { ok: true, lastSeenAt: now.toISOString() },
    { status: 200 },
  );
}
