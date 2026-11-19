/**
 * #97 — a renewals cron coordinator fans out over HTTP:
 * `fetch(\`${APP_BASE_URL}/api/cron/renewals/<x>/<tenant>\`)`. Relay R162
 * fired one on a local :3400 server while `.env.local` pointed
 * `APP_BASE_URL` at production, so every per-tenant run executed on prod and
 * a real renewal reminder went out (docs/retro.md, 2026-11-19).
 *
 * Outside production a coordinator may only fan out to its OWN origin. In
 * production the check is skipped: Vercel Cron calls the deployment host
 * while `APP_BASE_URL` is the custom domain, so the origins differ by design.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

export type FanOutOriginCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly baseOrigin: string; readonly requestOrigin: string };

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function checkFanOutOrigin(args: {
  readonly baseUrl: string;
  readonly requestUrl: string;
  readonly vercelEnv: string | undefined;
}): FanOutOriginCheck {
  if (args.vercelEnv === 'production') return { ok: true };
  const baseOrigin = originOf(args.baseUrl);
  const requestOrigin = originOf(args.requestUrl);
  if (baseOrigin !== null && baseOrigin === requestOrigin) return { ok: true };
  return {
    ok: false,
    baseOrigin: baseOrigin ?? 'invalid',
    requestOrigin: requestOrigin ?? 'invalid',
  };
}

/**
 * Call right before a coordinator's fan-out. Returns the 500 to send when the
 * target is another origin outside production, else `null`. Logs origins
 * only (no path, no secret).
 */
export function refuseCrossOriginFanOut(
  request: NextRequest,
  ctx: { readonly cronKind: string; readonly correlationId: string },
): NextResponse | null {
  const check = checkFanOutOrigin({
    baseUrl: env.app.baseUrl,
    requestUrl: request.url,
    vercelEnv: env.vercelEnv,
  });
  if (check.ok) return null;
  logger.error(
    {
      cronKind: ctx.cronKind,
      baseOrigin: check.baseOrigin,
      requestOrigin: check.requestOrigin,
      correlationId: ctx.correlationId,
    },
    'cron.renewals.coordinator.fan_out_refused',
  );
  return NextResponse.json(
    { error: { code: 'fan_out_origin_mismatch' } },
    { status: 500 },
  );
}
