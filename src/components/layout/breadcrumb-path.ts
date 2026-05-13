export type BreadcrumbSegment = {
  href: string;
  segment: string;
  label: string;
  isCurrent: boolean;
  /**
   * `false` when this segment exists in the URL but has no own
   * page.tsx (NON_ROUTE_BY_PARENT match) — its `href` was rewritten
   * to the parent's path, so rendering it as a clickable link would
   * point at the same href as the previous segment in the trail.
   * UI should render it as plain text (or a disabled muted label)
   * to signal "this is an organisational segment, not a navigation
   * target". Defaults to `true` for routable segments.
   */
  isLinkable: boolean;
};

export type ParseBreadcrumbOptions = {
  pathname: string;
  staticLabels: Readonly<Record<string, string>>;
  dynamicLabels: ReadonlyMap<string, string>;
};

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}


export function parseBreadcrumbPath({
  pathname,
  staticLabels,
  dynamicLabels,
}: ParseBreadcrumbOptions): BreadcrumbSegment[] {
  // Defensive strip: Next.js's `usePathname()` never includes the query
  // string, but a caller passing `window.location.pathname` directly
  // could — we split on `?` so a stray query chunk never corrupts the
  // final segment's label lookup.
  //
  // Raw segments drive `href` reconstruction so the URL we link back to
  // is bit-identical to the one Next.js routed here with (preserving any
  // percent-encoding). Decoded segments drive label lookup + display so
  // `admin/plans/%E0%B8%AB` matches the dynamic-label key `ห` and shows
  // the human-readable glyph in the breadcrumb trail.
  const cleanPath = pathname.split('?')[0] ?? pathname;
  const rawParts = cleanPath.split('/').filter((p) => p.length > 0);
  if (rawParts.length === 0) return [];

  const decodedParts = rawParts.map(safeDecode);
  const lastIndex = rawParts.length - 1;

  // Detect plan-year segments: /admin/plans/<year>/<planId> — the year
  // segment has no corresponding route page (plans list is at
  // /admin/plans?year=<year>), so we rewrite its href to a query param.
  const isPlansYear = (idx: number): boolean => {
    if (idx < 2) return false;
    const parent = decodedParts[idx - 1];
    const segment = decodedParts[idx];
    return parent === 'plans' && /^\d{4}$/.test(segment ?? '');
  };

  // Route-group pseudo-segments: URL pieces that exist in the path but
  // have no corresponding page.tsx at THAT specific location (only
  // nested routes). Clicking the breadcrumb link for one would return
  // 404. Rewrite the href back to the closest ancestor that DOES route
  // so the link still goes somewhere useful.
  //
  // Context-aware: we key each non-route segment by its REQUIRED
  // parent. `credit-notes` under `/admin/invoices/<id>/credit-notes/new`
  // has no index page (only `/new/` exists) — so that occurrence points
  // back to `/admin/invoices/<id>`. But `/admin/credit-notes` IS a real
  // page (the standalone directory), so `credit-notes` with parent
  // `admin` must NOT be rewritten — doing so was the cause of the bug
  // where clicking the Credit Notes breadcrumb on a detail page bounced
  // admins to `/admin` dashboard.
  const NON_ROUTE_BY_PARENT: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ['invoices', new Set(['credit-notes'])],
    // F8 — `/admin/settings/renewals/<setting>` has no index page at the
    // `renewals` level (only nested setting pages like `schedules/`).
    // Clicking the "renewals" breadcrumb segment should bounce back to
    // the Settings index, not 404. See `src/app/(staff)/admin/settings/
    // page.tsx` for the index page itself.
    ['settings', new Set(['renewals'])],
    // F6 — `/admin/integrations/<source>` has no index page at the
    // `integrations` level (only nested integration pages like
    // `eventcreate/`). Clicking the "integrations" breadcrumb segment
    // would 404 — rewrite href to `/admin` so it bounces back to the
    // dashboard, AND mark the segment non-linkable so the rendered
    // text appears as a plain organisational marker.
    ['admin', new Set(['integrations'])],
  ]);
  const isNonRouteSegment = (idx: number): boolean => {
    if (idx === 0) return false;
    const segment = decodedParts[idx];
    if (!segment) return false;
    // Find the nearest non-UUID ancestor as the semantic parent. We
    // skip dynamic id segments so `/invoices/<uuid>/credit-notes/new`
    // resolves the rule under the real parent `invoices`, not `<uuid>`.
    let parent: string | undefined;
    for (let i = idx - 1; i >= 0; i--) {
      const candidate = decodedParts[i];
      if (candidate && !/^[0-9a-f-]{8,}$/i.test(candidate)) {
        parent = candidate;
        break;
      }
    }
    if (!parent) return false;
    return NON_ROUTE_BY_PARENT.get(parent)?.has(segment) ?? false;
  };

  return rawParts
    .map((rawSegment, index) => {
      const decoded = decodedParts[index] ?? rawSegment;
      let href: string;
      let isLinkable = true;
      if (isPlansYear(index)) {
        href = `/admin/plans?year=${decoded}`;
      } else if (isNonRouteSegment(index)) {
        // Point at the parent path (drop THIS segment); parent is the
        // last routable ancestor. Mark as non-linkable so the UI
        // renders this as plain text — clicking would otherwise
        // bounce silently to the parent path which is the same href
        // the previous trail item already points at (smell — two
        // adjacent breadcrumb items resolving to the same URL).
        href = '/' + rawParts.slice(0, index).join('/');
        isLinkable = false;
      } else {
        href = '/' + rawParts.slice(0, index + 1).join('/');
      }
      return {
        href,
        segment: decoded,
        label: dynamicLabels.get(decoded) ?? staticLabels[decoded] ?? decoded,
        isCurrent: index === lastIndex,
        isLinkable,
      };
    })
    // Drop the leading portal-root segment (`admin` / `portal`). The
    // staff/member shell already indicates which portal the user is
    // in (sidebar branding + role badge in the user menu) so the
    // breadcrumb segment is redundant. Aligns with the SaaS
    // convention (Stripe, Linear, GitHub, Notion all skip the
    // workspace/dashboard prefix from their breadcrumb trails).
    //
    // Hrefs for the surviving segments still include `/admin/` /
    // `/portal/` because they were built from `rawParts` BEFORE this
    // filter — only the visible label is dropped.
    .filter((seg, idx) => {
      if (idx === 0 && (seg.segment === 'admin' || seg.segment === 'portal')) {
        return false;
      }
      return true;
    });
}

export type TruncatedBreadcrumb = {
  visible: BreadcrumbSegment[];
  hasEllipsis: boolean;
};

export function truncateForMobile(
  segments: BreadcrumbSegment[],
): TruncatedBreadcrumb {
  if (segments.length <= 2) {
    return { visible: segments, hasEllipsis: false };
  }
  return {
    visible: segments.slice(-2),
    hasEllipsis: true,
  };
}
