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
