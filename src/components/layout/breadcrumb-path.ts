export type BreadcrumbSegment = {
  href: string;
  segment: string;
  label: string;
  isCurrent: boolean;
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
  // have no corresponding page.tsx (only nested routes). Clicking the
  // breadcrumb link for one returns 404. Rewrite the href back to the
  // closest ancestor that DOES route so the link still goes somewhere
  // useful (typically the parent resource detail).
  //
  // Currently: `credit-notes` under `/admin/invoices/<id>/credit-notes/
  // new` — the `credit-notes` index has no page (only `/new/` exists).
  // Falling back to `/admin/invoices/<id>` takes the admin to the
  // invoice detail where the credit-notes list is inline.
  const NON_ROUTE_SEGMENTS: ReadonlySet<string> = new Set(['credit-notes']);
  const isNonRouteSegment = (idx: number): boolean => {
    if (idx === 0) return false;
    return NON_ROUTE_SEGMENTS.has(decodedParts[idx] ?? '');
  };

  return rawParts.map((rawSegment, index) => {
    const decoded = decodedParts[index] ?? rawSegment;
    let href: string;
    if (isPlansYear(index)) {
      href = `/admin/plans?year=${decoded}`;
    } else if (isNonRouteSegment(index)) {
      // Point at the parent path (drop THIS segment); parent is the
      // last routable ancestor.
      href = '/' + rawParts.slice(0, index).join('/');
    } else {
      href = '/' + rawParts.slice(0, index + 1).join('/');
    }
    return {
      href,
      segment: decoded,
      label: dynamicLabels.get(decoded) ?? staticLabels[decoded] ?? decoded,
      isCurrent: index === lastIndex,
    };
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
