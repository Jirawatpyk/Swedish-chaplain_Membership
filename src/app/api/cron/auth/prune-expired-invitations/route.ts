/**
 * Staff Invitation Lifecycle Task 7 — Vercel Cron route for Task 6's
 * `pruneExpiredInvitations` use case.
 *
 * Deletes long-dead `pending` invited users (no invitation still live
 * relative to the grace cutoff — see `prune-expired-invitations.ts` header
 * for the RA-4 two-token guard) so their email frees up for a fresh invite.
 * Structure mirrors `src/app/api/cron/renewals/prune-consumed-tokens/route.ts`
 * (Bearer gate, READ_ONLY_MODE short-circuit, GET=POST alias).
 *
 * Auth: Bearer via `CRON_SECRET` through `gateCronBearerOrRespond` — adds
 * rate-limit + `cron_bearer_auth_rejected` audit emit on the 401 path.
 *
 * READ_ONLY_MODE: short-circuits to 200 + skipped. REQUIRED (not optional
 * defence-in-depth) here — the F1 write-freeze proxy carve-out only catches
 * state-changing verbs on `/api/**`; native Vercel Cron fires this route
 * with GET, which the proxy does NOT treat as a write, yet this handler
 * DELETEs `users` rows. Returns 200 (not 503) so cron-job.org / Vercel
 * Cron does not retry-storm during a maintenance window.
 *
 * No feature kill-switch: invitation pruning is core F1 auth hygiene, not
 * a flagged feature — unlike the F6/F7/F8 coordinators this route has no
 * `env.features.*` gate to check.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { gateCronBearerOrRespond } from '@/lib/cron-auth';
import { uuidv7 } from '@/lib/request-id';
import { pruneExpiredInvitations } from '@/modules/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Vercel-native Cron invokes each scheduled path with a GET; the Bearer-
// gated logic lives in POST. Alias GET → POST so one handler serves both
// native Vercel Cron (GET) and a manual/legacy Bearer-authenticated POST
// trigger. POST is hoisted, so the forward ref is safe.
export const GET = POST;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ROUTE = '/api/cron/auth/prune-expired-invitations';

  const gateResponse = await gateCronBearerOrRespond(request, { route: ROUTE });
  if (gateResponse) {
    return gateResponse;
  }

  // READ_ONLY_MODE short-circuit — REQUIRED here (see header comment):
  // GET is not caught by the proxy write-freeze, and this handler DELETEs
  // rows. 200 (not 503) so the cron does not retry-storm.
  if (env.flags.readOnlyMode) {
    return NextResponse.json(
      { skipped: true, reason: 'read_only_mode' },
      { status: 200 },
    );
  }

  const requestId = uuidv7();
  const startedAt = Date.now();

  try {
    // The 30-day grace policy lives in `pruneExpiredInvitations`
    // (DEFAULT_GRACE_DAYS) — single source of truth, so `graceDays` is
    // intentionally omitted here rather than duplicated.
    const result = await pruneExpiredInvitations({
      now: new Date(),
      requestId,
    });
    if (!result.ok) {
      // Unreachable in practice — `pruneExpiredInvitations` returns
      // `Result<Success, never>` (best-effort maintenance sweep, no
      // declared error variant). Guard kept only to satisfy the
      // discriminated-union narrowing before `.value` access below.
      logger.error({ requestId, route: ROUTE }, 'cron.auth.prune_expired_invitations.unexpected_error_result');
      return NextResponse.json(
        { error: { code: 'server_error' } },
        { status: 500 },
      );
    }

    logger.info(
      {
        requestId,
        route: ROUTE,
        prunedCount: result.value.prunedCount,
        durationMs: Date.now() - startedAt,
      },
      'cron.auth.prune_expired_invitations.complete',
    );
    return NextResponse.json({ prunedCount: result.value.prunedCount });
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e : new Error(String(e)),
        requestId,
        route: ROUTE,
      },
      'cron.auth.prune_expired_invitations.unexpected_error',
    );
    return NextResponse.json(
      { error: { code: 'server_error' } },
      { status: 500 },
    );
  }
}
