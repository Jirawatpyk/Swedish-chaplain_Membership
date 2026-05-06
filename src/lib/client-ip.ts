/**
 * Extract the originating client IP from a Next.js request.
 *
 * Trust model: on Vercel, the platform sets `x-forwarded-for` with the
 * verified client IP as the first comma-separated entry. Self-hosted
 * deployments should run behind a trusted proxy that does the same.
 * The fallback `x-real-ip` handles proxies that don't use XFF. The
 * final `'0.0.0.0'` sentinel is for local tests without any proxy
 * header — rate limiters see it as a single bucket in that mode,
 * which is intentional for dev ergonomics.
 *
 * Previously copy-pasted verbatim into every auth route handler;
 * consolidated here. Used by rate-limit keying and audit `sourceIp`
 * — both places where consistency across routes matters.
 *
 * **K13-7 (SEC-R12-1) — IMPORTANT trust assumption**: this code
 * assumes deployment on Vercel (where the platform load balancer
 * verifies the leftmost `x-forwarded-for` entry). If deployed
 * off-Vercel WITHOUT a trusted upstream proxy that strips and
 * rewrites the XFF header, an attacker can spoof XFF to defeat
 * per-IP rate-limiting (each spoofed IP gets its own bucket). At
 * boot, `assertVercelDeploymentForTrustedXff()` warns when the
 * `VERCEL` env var is missing in production — operators running
 * off-Vercel must (a) understand the spoofing risk, (b) wire a
 * trusted proxy, and (c) suppress the warning by setting
 * `TRUSTED_REVERSE_PROXY=true`.
 */
import type { NextRequest } from 'next/server';

export function getClientIp(request: NextRequest): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.headers.get('x-real-ip') ?? '0.0.0.0';
}

/**
 * Boot-time diagnostic: warn loudly when deployed in production
 * without a trusted XFF source. Called from `instrumentation.ts` (or
 * equivalent boot path) so the message lands in Vercel logs / log
 * drains as a single distinguished line per cold-start. Does NOT
 * abort the boot — failing closed would block legitimate self-hosted
 * deployments behind their own trusted proxies.
 *
 * Called once per cold-start. The `TRUSTED_REVERSE_PROXY` opt-out is
 * honoured for off-Vercel operators who have configured their own
 * trusted proxy and don't need the warning.
 */
export function assertVercelDeploymentForTrustedXff(): void {
  if (typeof process === 'undefined') return;
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) return;
  const isVercel = !!process.env.VERCEL;
  const trustedProxy = process.env.TRUSTED_REVERSE_PROXY === 'true';
  if (!isVercel && !trustedProxy) {
    // Use console.warn (not pino logger) — this fires before the
    // logger is fully configured and we want the message to surface
    // in any log sink including stderr capture.
    console.warn(
      '[SEC-R12-1] Production boot without VERCEL=1 or TRUSTED_REVERSE_PROXY=true: x-forwarded-for trust model is not enforceable. Per-IP rate-limit buckets may be spoofed by attackers. See src/lib/client-ip.ts trust-model docstring.',
    );
  }
}
