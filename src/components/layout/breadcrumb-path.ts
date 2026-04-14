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
  return rawParts.map((rawSegment, index) => {
    const decoded = decodedParts[index] ?? rawSegment;
    return {
      href: '/' + rawParts.slice(0, index + 1).join('/'),
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
