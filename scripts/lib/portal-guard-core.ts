/**
 * 059-membership-suspension Task 7 — pure helpers for the `check:portal-guard`
 * CI gate, shared by `scripts/check-portal-guard.ts` (CLI) and
 * `tests/unit/scripts/check-portal-guard.test.ts`.
 *
 * ── WHY THIS GATE EXISTS ──────────────────────────────────────────────────
 * Task 3 built `checkPortalAccess` (`src/lib/lapsed-portal-scope.ts`) — the
 * two-policy resolver that blocks a `terminated` member from every portal
 * route except a narrow allowlist, and blocks a `suspended` member from a
 * short denylist. It had ZERO production callers until Task 7 wired it into:
 *   - `requireMemberContext` (`src/lib/member-context.ts`) — the ALWAYS-ON
 *     API-layer chokepoint. Every `/api/portal/**` route that resolves its
 *     member via this helper gets `checkPortalAccess` enforcement for free.
 *   - `enforcePortalPageAccess` (`src/lib/portal-page-access.ts`) — the
 *     SSR-load page chokepoint, called once from
 *     `src/app/(member)/portal/layout.tsx` (Next.js always renders the
 *     layout above its children, so ONE call site covers every page —
 *     no per-page.tsx scan is needed).
 *
 * Wiring the two chokepoints closes today's gap, but nothing stops a FUTURE
 * `/api/portal/**` route from being added without ever calling
 * `requireMemberContext` (e.g. copy-pasting an older route's inline
 * `getCurrentSession()` pattern). This script scans every route file and
 * fails CI the moment that happens — unless the route is on the
 * `EXEMPT_ROUTES` allowlist below, which requires a documented reason.
 */

export const CHOKEPOINT_SYMBOL = 'requireMemberContext';
export const PAGE_CHOKEPOINT_SYMBOL = 'enforcePortalPageAccess';

export interface ExemptRoute {
  /** POSIX-style path relative to the repo root, e.g. 'src/app/api/portal/x/route.ts'. */
  readonly path: string;
  readonly reason: string;
}

/**
 * Routes NOT covered by `requireMemberContext`. Every entry must carry an
 * accurate, specific reason — a route that simply forgot to wire the gate
 * must NEVER be added here, because that is exactly the regression this
 * script exists to catch.
 *
 * The first 3 entries are LEGITIMATE architectural exemptions (verified by
 * reading each route's actual auth mechanism at Task 7 time, 2026-07-14):
 * pre-session public-token redemption, and GDPR/PDPA data-subject rights
 * that must survive membership termination.
 *
 * The last 3 entries are a DOCUMENTED, TRACKED GAP — NOT exempt by design.
 * All three use the exact same session + `findByLinkedUserId` pattern that
 * `requireMemberContext` formalises, but were never routed through it, so a
 * terminated/suspended member can currently still reach them. Retrofitting
 * them safely requires touching their existing response-shape contracts and
 * their test doubles, which is outside Task 7's assigned file scope
 * (`src/lib/member-context.ts`, `(member)/portal/layout.tsx`,
 * `scripts/check-portal-guard.ts` + its test). Flagged in
 * `.superpowers/sdd/progress.md` "Minor findings" for a fast-follow task
 * (candidate: Task 11 "coverage-threshold restore + full gate") — do NOT
 * silently reclassify these as legitimate without actually wiring the gate.
 */
export const EXEMPT_ROUTES: readonly ExemptRoute[] = [
  {
    path: 'src/app/api/portal/renewal/redeem-link/route.ts',
    reason:
      'PUBLIC pre-session route by design (F8 Phase 5 R1v2 step 9) — the ' +
      'HMAC renewal-link token IS the proof of authorisation; there is no ' +
      'session yet for requireMemberContext to resolve a member from.',
  },
  {
    path: 'src/app/api/portal/account/data-export/route.ts',
    reason:
      'GDPR Art. 20 / PDPA §30 data-portability REQUEST must stay reachable ' +
      'regardless of membership status — mirrors the page-level allowlist ' +
      'rationale for /portal/account in src/lib/lapsed-portal-scope.ts.',
  },
  {
    path: 'src/app/api/portal/account/data-export/[jobId]/download/route.ts',
    reason:
      'Same GDPR/PDPA unconditional-access rationale as the sibling ' +
      'data-export request route — a member must be able to download an ' +
      'already-queued export even after their membership terminates.',
  },
  {
    path: 'src/app/api/portal/timeline/route.ts',
    reason:
      'GAP (tracked, NOT exempt-by-design): resolves the member via ' +
      'requireSession + findByLinkedUserId — the same pattern ' +
      'requireMemberContext formalises — but does not call it. Not yet ' +
      'gated by checkPortalAccess. See progress.md Minor findings.',
  },
  {
    path: 'src/app/api/portal/directory/route.ts',
    reason:
      'GAP (tracked, NOT exempt-by-design): resolves the member via ' +
      'getCurrentSession + findByLinkedUserId but does not call ' +
      'requireMemberContext. Not yet gated by checkPortalAccess. See ' +
      'progress.md Minor findings.',
  },
  {
    path: 'src/app/api/portal/directory/logo/route.ts',
    reason:
      'GAP (tracked, NOT exempt-by-design): same own-session resolution ' +
      'pattern as directory/route.ts, does not call requireMemberContext. ' +
      'Not yet gated by checkPortalAccess. See progress.md Minor findings.',
  },
];

/**
 * Pure scan: given a map of repo-relative route path → file source, returns
 * the paths that reference neither `chokepointSymbol` nor appear in
 * `exemptRoutes`, sorted lexicographically for stable output.
 */
export function findRoutesMissingChokepoint(
  routeSources: ReadonlyMap<string, string>,
  exemptRoutes: readonly ExemptRoute[] = EXEMPT_ROUTES,
  chokepointSymbol: string = CHOKEPOINT_SYMBOL,
): string[] {
  const exemptPaths = new Set(exemptRoutes.map((r) => r.path));
  const offenses: string[] = [];
  for (const [path, source] of routeSources) {
    if (exemptPaths.has(path)) continue;
    if (!source.includes(chokepointSymbol)) offenses.push(path);
  }
  return offenses.sort();
}

/** Pure check: does the layout source reference the page chokepoint symbol? */
export function layoutHasPageChokepoint(
  layoutSource: string,
  symbol: string = PAGE_CHOKEPOINT_SYMBOL,
): boolean {
  return layoutSource.includes(symbol);
}
