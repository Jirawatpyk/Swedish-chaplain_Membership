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
  const parts = pathname
    .split('/')
    .filter((p) => p.length > 0)
    .map(safeDecode);
  if (parts.length === 0) return [];

  const lastIndex = parts.length - 1;
  return parts.map((segment, index) => ({
    href: '/' + parts.slice(0, index + 1).join('/'),
    segment,
    label: dynamicLabels.get(segment) ?? staticLabels[segment] ?? segment,
    isCurrent: index === lastIndex,
  }));
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
