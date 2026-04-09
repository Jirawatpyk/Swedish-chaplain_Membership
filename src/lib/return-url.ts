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

const MAX_RETURN_TO_LENGTH = 512;
const FORBIDDEN_PREFIXES = [
  '/admin/sign-in',
  '/portal/sign-in',
  '/forgot-password',
  '/reset-password',
  '/invite',
  '/api/',
];

export type Portal = 'staff' | 'member';

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
  const requiredPrefix = portal === 'staff' ? '/admin' : '/portal';
  if (pathname !== requiredPrefix && !pathname.startsWith(`${requiredPrefix}/`)) {
    return null;
  }

  return withoutHash;
}

/**
 * Build a sign-in URL with the `returnTo` query param if the caller
 * supplies a current path worth preserving. Used by `requireSession`
 * (src/lib/auth-session.ts) to redirect an unauthenticated visitor
 * while remembering where they were trying to go.
 */
export function buildSignInUrl(portal: Portal, fromPath: string | null): string {
  const base = portal === 'staff' ? '/admin/sign-in' : '/portal/sign-in';
  if (!fromPath) return base;
  const safe = safeReturnTo(fromPath, portal);
  if (!safe) return base;
  return `${base}?returnTo=${encodeURIComponent(safe)}`;
}
