/**
 * Safe `returnTo` URL handling for the sign-in flow (T171, spec AS5).
 *
 * An attacker can craft a link like
 * `https://swecham.se/admin/sign-in?returnTo=https://evil.example/steal`
 * and, if the sign-in page trusts the query parameter blindly, send
 * the victim to the malicious site AFTER they successfully sign in.
 * This is the classic **open redirect** vulnerability (OWASP A03).
 *
 * `safeReturnTo(candidate, portal)` normalises the raw value and
 * returns a trusted path or `null` if the candidate fails any check:
 *
 *   - MUST be a string (reject arrays, nulls, objects)
 *   - MUST start with '/' (reject absolute + protocol-relative URLs)
 *   - MUST NOT start with '//' (protocol-relative → cross-origin)
 *   - MUST NOT contain '://' anywhere (belt & suspenders)
 *   - MUST NOT be a sign-in or public auth page (reject redirect loop)
 *   - MUST match the portal: staff→`/admin/...`, member→`/portal/...`
 *   - MUST NOT exceed 512 characters (prevents pathological tokens
 *     embedded in the URL)
 *
 * Returns the normalised path string (safe to pass to `router.push`)
 * or `null` when no valid destination is provided.
 *
 * Pure function — no framework imports — so it can be called from
 * both server components and client forms.
 */

import { portalHomePath, portalSignInPath } from './portal-paths';
import type { Portal } from '@/modules/auth/domain/role';

// Re-export so existing call sites that import `Portal` from this
// file don't need updating. The canonical definition lives in
// Domain (`@/modules/auth/domain/role`).
export type { Portal };

const MAX_RETURN_TO_LENGTH = 512;

/**
 * Query keys Stripe appends to `return_url` after a 3DS redirect. Nothing
 * reads them, and the client secret must not travel into `returnTo` — the
 * invoice page also removes them from the address bar on load.
 */
export const STRIPE_RETURN_PARAMS = [
  'payment_intent',
  'payment_intent_client_secret',
  'redirect_status',
] as const;

/** `path` without the Stripe redirect keys; any other query key is kept. */
function withoutStripeReturnParams(path: string): string {
  const queryIndex = path.indexOf('?');
  if (queryIndex < 0) return path;
  const params = new URLSearchParams(path.slice(queryIndex + 1));
  if (!STRIPE_RETURN_PARAMS.some((key) => params.has(key))) return path;
  for (const key of STRIPE_RETURN_PARAMS) params.delete(key);
  const query = params.toString();
  return query ? `${path.slice(0, queryIndex)}?${query}` : path.slice(0, queryIndex);
}
const FORBIDDEN_PREFIXES = [
  '/admin/sign-in',
  '/portal/sign-in',
  '/forgot-password',
  '/reset-password',
  '/invite',
  '/api/',
];

export function safeReturnTo(candidate: unknown, portal: Portal): string | null {
  if (typeof candidate !== 'string') return null;
  if (candidate.length === 0 || candidate.length > MAX_RETURN_TO_LENGTH) return null;
  if (!candidate.startsWith('/')) return null;
  if (candidate.startsWith('//')) return null;
  if (candidate.includes('://')) return null;
  // Defensive: reject backslash and CRLF injection
  if (candidate.includes('\\') || candidate.includes('\n') || candidate.includes('\r')) {
    return null;
  }

  // Strip any fragment — it doesn't affect routing but pollutes logs
  const hashIndex = candidate.indexOf('#');
  const withoutHash = hashIndex >= 0 ? candidate.slice(0, hashIndex) : candidate;

  // Split into pathname + query so forbidden-prefix and portal-boundary
  // checks ignore the query string. We still return the path + query
  // together so deep links like `/admin/users?page=2` survive the round
  // trip intact.
  const queryIndex = withoutHash.indexOf('?');
  const pathname = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;

  // Reject any path that points back at the auth flow
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return null;
    }
  }

  // Portal boundary — staff returnTo must start with /admin,
  // member returnTo must start with /portal
  const requiredPrefix = portalHomePath(portal);
  if (pathname !== requiredPrefix && !pathname.startsWith(`${requiredPrefix}/`)) {
    return null;
  }

  return withoutHash;
}

/**
 * Why the sign-in page is shown, when a client sign-out sends the user there
 * (`?reason=`). The sign-in pages allow-list these and show the message on
 * the card: `idle` — signed out for inactivity; `session-ended` — the
 * session was already gone (another tab, revoked, past its absolute cap).
 */
export type SignInReason = 'idle' | 'session-ended';

/**
 * Build a sign-in URL with the `returnTo` query param if the caller
 * supplies a current path worth preserving. Used by `requireSession`
 * (src/lib/auth-session.ts) to redirect an unauthenticated visitor
 * while remembering where they were trying to go, and by the idle
 * warning, which adds the `reason`. An unsafe path drops `returnTo`
 * but keeps the reason. Stripe's redirect keys are removed first.
 */
export function buildSignInUrl(
  portal: Portal,
  fromPath: string | null,
  reason?: SignInReason,
): string {
  const params: string[] = [];
  const safe = fromPath ? safeReturnTo(withoutStripeReturnParams(fromPath), portal) : null;
  if (safe) params.push(`returnTo=${encodeURIComponent(safe)}`);
  if (reason) params.push(`reason=${reason}`);
  const base = portalSignInPath(portal);
  return params.length > 0 ? `${base}?${params.join('&')}` : base;
}
