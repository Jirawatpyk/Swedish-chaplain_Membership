/**
 * Portal URL path helpers (pre-R6 rename).
 *
 * Single source of truth for the `'staff' | 'member'` → URL path
 * mapping. Every sign-in redirect, idle-warning redirect, and
 * success-redirect path used to inline the same ternary:
 *
 *     portal === 'staff' ? '/admin/sign-in' : '/portal/sign-in'
 *     portal === 'staff' ? '/admin' : '/portal'
 *
 * Extracted so the R6 folder rename (Swedish chaplain_membership →
 * Swedish chamber_membership tracked in docs/phases-plan.md) can
 * mechanically swap one constant map instead of hunting through six
 * call sites. Also makes it easy to add a new portal (e.g.
 * `'public-directory'`) in F9 without re-auditing redirect logic.
 *
 * Lives in `src/lib/` because these are Presentation-layer URL
 * concerns — Domain `PORTAL_FOR_ROLE` already owns the role→portal
 * mapping; this file owns the portal→path mapping.
 */
import type { Portal } from '@/modules/auth/domain/role';

/**
 * Home route for each portal. Where a signed-in user lands after
 * sign-in / redeem-invite / password-reset success.
 */
export function portalHomePath(portal: Portal): string {
  return portal === 'staff' ? '/admin' : '/portal';
}

/**
 * Public sign-in page for each portal. Used by idle-warning and
 * layout redirects when the session is invalid.
 */
export function portalSignInPath(portal: Portal): string {
  return portal === 'staff' ? '/admin/sign-in' : '/portal/sign-in';
}
