import { env } from './env';

/**
 * CSRF Origin-header allow-list (T041, research.md § 4.1, security.md T-07).
 *
 * `/api/auth/*` Route Handlers do NOT inherit Next.js Server Actions'
 * automatic CSRF protection, so we enforce a hard Origin allow-list on
 * every state-changing POST / PUT / PATCH / DELETE.
 *
 * Algorithm (research.md § 4.1):
 *
 *     IF method NOT IN [POST, PUT, PATCH, DELETE]: pass
 *     IF path DOES NOT match /^\/api\//:           pass
 *     IF Origin header is absent:                  reject
 *     IF Origin NOT IN APP_ALLOWED_ORIGINS:        reject
 *     ELSE:                                        pass
 *
 * Why Origin over double-submit cookie:
 *   - Browsers set Origin automatically; scripts cannot forge it cross-origin.
 *   - Single point of enforcement (this file + middleware.ts).
 *   - Zero client-side ceremony.
 *
 * Caveat: Safari sometimes sends `Origin: null` on same-origin redirects.
 * That edge case is rejected here — F1 has no flows that cross redirect
 * boundaries during a POST, so it doesn't matter in practice.
 */

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PROTECTED_PATH_PREFIX = '/api/';

export type CsrfDecision =
  | { readonly action: 'pass'; readonly reason: 'method-safe' | 'unprotected-path' | 'origin-allowed' }
  | { readonly action: 'reject'; readonly reason: 'missing-origin' | 'origin-not-allowed' };

export function checkCsrf(method: string, pathname: string, origin: string | null): CsrfDecision {
  const upper = method.toUpperCase();
  if (!STATE_CHANGING_METHODS.has(upper)) {
    return { action: 'pass', reason: 'method-safe' };
  }
  if (!pathname.startsWith(PROTECTED_PATH_PREFIX)) {
    return { action: 'pass', reason: 'unprotected-path' };
  }
  if (!origin) {
    return { action: 'reject', reason: 'missing-origin' };
  }
  if (!env.app.allowedOrigins.includes(origin)) {
    return { action: 'reject', reason: 'origin-not-allowed' };
  }
  return { action: 'pass', reason: 'origin-allowed' };
}
