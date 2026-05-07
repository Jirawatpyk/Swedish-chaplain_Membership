/**
 * Round 2 review-fix S-6 — client-side error beacon.
 *
 * Receives `navigator.sendBeacon()` POSTs from authenticated client
 * components when a user-visible failure occurs (e.g. F8
 * `renewal-confirm-flow` rejecting with an unmapped error code). Round
 * 1 logged the raw code only via `console.warn` in the user's browser
 * — support had no correlation handle. This endpoint receives the
 * payload and writes a structured pino log with `errorId` so SRE +
 * support can grep on real-world failures.
 *
 * **Round 3 review-fix (R3-S4)** — log severity is intentionally
 * `logger.warn`, NOT `logger.error`: each report is a *forwarded*
 * client-side warning, not a novel server-side exception. The
 * underlying server error (if any) was already logged at the originating
 * route's correct level — duplicating it as `error` here would cause
 * Sentry-style integrations to file a second issue per occurrence.
 * Alerts attach to **log-search metrics** keyed on
 * `errorId='CLIENT.ERROR_REPORT'` + `tag` (Vercel observability /
 * Datadog logs), not to a Sentry breadcrumb upgrade. If a future
 * integration pages on `logger.error` per occurrence, downgrade by
 * filtering on `errorId` rather than upgrading the level here.
 *
 * **Auth model**: requires a valid session cookie (lifted via the
 * standard auth helper). Anonymous beacons are rejected with 401 to
 * keep this endpoint from becoming an unauthenticated abuse vector.
 *
 * **Rate-limit**: 30 reports / minute per session via Upstash sliding
 * window. The limit is generous enough that an honest client can
 * spam (legitimate `console.warn` noise) without being blocked, but
 * tight enough to bound a misbehaving client.
 *
 * **No PII / no secrets**: the request body schema accepts a small
 * envelope only — `tag`, `code`, optional `status`, `path`. Free-text
 * fields are clipped to 200 chars at zod and the body is rejected if
 * larger than 1 KiB.
 *
 * **Response**: 204 No Content on success (consistent with
 * sendBeacon's fire-and-forget contract — the client can't block on
 * this endpoint's response anyway).
 *
 * Out of scope for this wave: wiring more than the renewal-confirm
 * flow. The other 5 client `console.warn` callsites (broadcasts,
 * pay-sheet, optimistic-paid, etc.) migrate opportunistically as
 * touched.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { logger } from '@/lib/logger';
import { rateLimiter } from '@/lib/auth-deps';
import { getCurrentSession } from '@/lib/auth-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 1024;

const reportSchema = z.object({
  /** Short tag identifying the surface (e.g. `renewal-confirm`). */
  tag: z.string().min(1).max(64),
  /** Backend error code OR `network_error` / `http_<status>` synthetic. */
  code: z.string().min(1).max(120),
  /** HTTP status when applicable. */
  status: z.number().int().min(100).max(599).optional(),
  /** Page route at the time of the report (no query string). */
  path: z.string().min(1).max(200).optional(),
  /** Optional client-side message (clipped). */
  message: z.string().max(200).optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Read body with byte cap to bound abuse cost. sendBeacon payloads
  // are typically < 200 bytes; > 1 KiB is suspicious.
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: { code: 'body_too_large' } },
      { status: 413 },
    );
  }

  // Auth: must be a valid session. Anonymous beacons rejected.
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json(
      { error: { code: 'unauthenticated' } },
      { status: 401 },
    );
  }

  // Rate-limit by session user. 30/min is plenty for legitimate
  // client error noise; spam beyond that drops with 429.
  const rl = await rateLimiter.check(
    `client-error:${session.user.id}`,
    30,
    60,
  );
  if (!rl.success) {
    return NextResponse.json(
      { error: { code: 'rate_limited' } },
      { status: 429 },
    );
  }

  // Parse JSON body — empty / malformed → 400.
  let body: unknown;
  try {
    body = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    return NextResponse.json(
      { error: { code: 'invalid_json' } },
      { status: 400 },
    );
  }
  const parsed = reportSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'invalid_input',
          message: parsed.error.issues[0]?.message ?? 'invalid input',
        },
      },
      { status: 400 },
    );
  }

  // Structured log for SRE / support correlation. errorId fixed so
  // alerts can attach to the metric counter (future wave) or the
  // pino log itself.
  logger.warn(
    {
      errorId: 'CLIENT.ERROR_REPORT',
      tag: parsed.data.tag,
      code: parsed.data.code,
      status: parsed.data.status ?? null,
      path: parsed.data.path ?? null,
      message: parsed.data.message ?? null,
      // F1 cross-tenant users — user.id is the only stable correlation
      // handle on the session. Tenant scope (when known) is implicit
      // in the route path when present.
      userId: session.user.id,
    },
    '[client-error] beacon received',
  );

  return new NextResponse(null, { status: 204 });
}
