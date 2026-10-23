/**
 * #240 — the one-shot hand-off that moves focus to the Erased banner after a
 * successful erase (WCAG 2.4.3).
 *
 * The erase dialog's trigger, the header ⋯ menu, unmounts with the refresh
 * that follows a successful erase (an erased member has no actions), so
 * focus would fall to <body>. The banner that replaces it only exists after
 * that refresh, so the dialog leaves a request here and the banner takes it
 * when it mounts. Module state, not storage: `router.refresh()` keeps the JS,
 * and nothing should outlive the tab. The request is for one member, is
 * taken once, and lapses after 60 s: long enough for a slow refresh on a
 * phone, short enough that a refresh that never lands cannot steal focus on
 * a later visit.
 */
const REQUEST_TTL_MS = 60_000;

let pending: { readonly memberId: string; readonly at: number } | null = null;

export function requestErasedBannerFocus(memberId: string): void {
  pending = { memberId, at: Date.now() };
}

/** True once for the member the request names, within 60 s; clears the request. */
export function takeErasedBannerFocus(memberId: string): boolean {
  const request = pending;
  pending = null;
  return request !== null && request.memberId === memberId && Date.now() - request.at <= REQUEST_TTL_MS;
}
