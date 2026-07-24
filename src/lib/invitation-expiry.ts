/**
 * Single source of truth for "has this portal invitation expired?" — shared by
 * the members-directory badge (`derivePortalState`, members domain) and the
 * member detail page's pending-invitation mapping (presentation).
 *
 * It lives in `@/lib` (framework-free) rather than in `members/domain` on
 * purpose: the presentation-layer detail page must call it, and presentation may
 * not import a module's `domain/` directly (Clean Architecture, Principle III).
 * Having ONE implementation is the drift guard the two surfaces would otherwise
 * need a cross-copy test to enforce — there is nothing to drift.
 *
 * Boundary: an invitation whose `expiresAt` is exactly `now` counts as EXPIRED
 * (`<=`). Both call sites depend on this being identical; do not change the
 * comparison here without re-checking both.
 */
export function isInvitationExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime();
}
