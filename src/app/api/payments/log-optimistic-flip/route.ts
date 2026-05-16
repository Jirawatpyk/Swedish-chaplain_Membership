/**
 * R5 round-7 (2026-04-26) — POST /api/payments/log-optimistic-flip.
 *
 * 🟡 M3 (software-engineer review) — telemetry hook for the
 * optimistic-UI overlay. The PaySheet settled effect fires this
 * fire-and-forget POST when it dispatches `swecham:invoice-paid`,
 * so ops can correlate client-side optimistic flips against the
 * subsequent `payment_intent.succeeded` webhook arrival in our
 * structured logs:
 *
 *   1. `client_optimistic_flip` — emitted here, T+0 from user's
 *      perspective.
 *   2. `payment_intent.succeeded` (audit + log) — emitted by the
 *      webhook handler, typically T+3..5s.
 *
 * A dropped/disputed webhook surfaces as a `client_optimistic_flip`
 * with no matching webhook event in the same correlation window;
 * an alerting rule on that pair-mismatch flags ops before the
 * client-side 15-second auto-revert kicks in.
 *
 * Best-effort by design:
 *   - No DB write (a pino log is sufficient for ops correlation).
 *   - `keepalive: true` on the client so the request survives a
 *     navigation away from the invoice page.
 *   - 204 No Content on success — no body needed by the caller.
 *   - Rate-limited per (tenant, user) to prevent log spam.
 *
 * Auth: member session required. Forged `invoiceId` values only
 * pollute the log stream — they cannot grant access or change
 * state, so the route does NOT re-validate ownership.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { requireMemberContext } from '@/lib/member-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { rateLimiter } from '@/lib/auth-deps';
import { logger } from '@/lib/logger';
import { hashId } from '@/lib/log-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  invoiceId: z.string().uuid(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const correlationId = requestIdFromHeaders(request.headers) ?? crypto.randomUUID();
  const noContent = (status: number) =>
    new NextResponse(null, {
      status,
      headers: { 'X-Correlation-Id': correlationId },
    });

  let memberCtx: Awaited<ReturnType<typeof requireMemberContext>>;
  try {
    memberCtx = await requireMemberContext(request);
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    if (code === 'forbidden_role' || code === 'unauthorized' || code === 'no-session') {
      return noContent(401);
    }
    // Unexpected throw from requireMemberContext (DB outage,
    // misconfigured env, etc.) — log so ops doesn't see a silent
    // 500 spike. Pattern matches `/api/payments/initiate` route.
    // F5R3 CR-2 (2026-05-16) — H-4 PCI/PDPA hygiene: log error
    // class only (e.constructor.name). Drizzle/Postgres errors carry
    // SQL fragments, table names, and partial parameter bindings in
    // .message — replicates the pattern enforced across all other F5
    // catch sites (drizzle-payments-audit:94, stripe webhook:148, etc.).
    logger.error(
      {
        err: e instanceof Error ? e.constructor.name : 'unknown',
        correlationId,
      },
      'payments.log_optimistic_flip.member_context_throw',
    );
    return noContent(500);
  }
  if (memberCtx && 'response' in memberCtx && memberCtx.response) {
    return memberCtx.response;
  }
  if (!memberCtx || 'response' in memberCtx) {
    logger.error(
      { correlationId },
      'payments.log_optimistic_flip.member_context_unreachable',
    );
    return noContent(500);
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const actorUserId = memberCtx.current.user.id;

  // 30 / 60s is plenty for legitimate optimistic flips (≤1 per
  // payment) and absorbs StrictMode double-mounts in dev. Excess
  // returns 204 silently — fire-and-forget client has nothing to
  // recover.
  const rl = await rateLimiter.check(
    `payments.log_optimistic_flip:${tenantCtx.slug}:${actorUserId}`,
    30,
    60,
  );
  if (!rl.success) {
    return noContent(204);
  }

  let parsedBody: { invoiceId: string };
  try {
    const json = await request.json();
    parsedBody = bodySchema.parse(json);
  } catch {
    return noContent(400);
  }

  // F5R1-E5 — hash the invoiceId before logging. The route documents
  // that it does not validate ownership (forged ids only pollute the
  // log stream — they cannot grant access or change state). Pre-fix
  // the raw invoiceId went into pino, so an attacker could spray
  // forged ids to contaminate forensic queries (SRE searches
  // "client_optimistic_flip for invoice X" would return false
  // positives from any member). Hashing preserves the SRE workflow
  // (the legitimate client computes the same hash via lib/log-id)
  // while denying attackers chosen-input control over the log stream.
  logger.info(
    {
      event: 'client_optimistic_flip',
      tenantId: tenantCtx.slug,
      invoiceIdHash: hashId(parsedBody.invoiceId),
      userIdHash: hashId(actorUserId),
      correlationId,
    },
    'Member optimistically flipped invoice to paid client-side',
  );

  return noContent(204);
}
