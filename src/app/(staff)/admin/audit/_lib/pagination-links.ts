/**
 * Pure derivation of the audit-log viewer's bidirectional-keyset nav links.
 *
 * Extracted from the server component so the URL-building (which cursor/dir goes
 * on which link, when each shows) is unit-testable without rendering the page or
 * mocking the session/env. The page passes the active filters + the current URL
 * cursor + the use-case's prev/next cursors; this returns the three hrefs.
 */
export interface AuditPaginationLinks {
  /** Cursor-less first (newest) page — always a valid href. */
  readonly firstHref: string;
  /** Previous (newer) page, or null when there is no newer page. */
  readonly prevHref: string | null;
  /** Next (older) page, or null when this is the oldest page. */
  readonly nextHref: string | null;
  /** Whether to render the "Latest" link (true iff not already on the first page). */
  readonly showFirst: boolean;
}

export function buildAuditPaginationLinks(args: {
  readonly basePath: string;
  /** The active filters (event type / actor / target / from / to) — never the cursor. */
  readonly filterParams: URLSearchParams;
  /** The cursor from the CURRENT URL ('' when on the first page). */
  readonly cursor: string;
  readonly prevCursor: string | null;
  readonly nextCursor: string | null;
}): AuditPaginationLinks {
  const { basePath, filterParams, cursor, prevCursor, nextCursor } = args;
  const hrefWith = (extra: Record<string, string>): string => {
    const p = new URLSearchParams(filterParams);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    const q = p.toString();
    return `${basePath}${q ? `?${q}` : ''}`;
  };
  return {
    firstHref: hrefWith({}),
    // "Latest" escapes to the newest page from anywhere we arrived via a cursor.
    showFirst: cursor !== '',
    // `dir=prev` is the URL spelling of the domain's `direction: 'backward'`
    // (newer rows); the page maps prev→backward before calling the use-case.
    prevHref: prevCursor !== null ? hrefWith({ cursor: prevCursor, dir: 'prev' }) : null,
    // Next (older) is the default direction, so no `dir` param is needed.
    nextHref: nextCursor !== null ? hrefWith({ cursor: nextCursor }) : null,
  };
}
