'use client';

import { Fragment } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import {
  buildBreadcrumbStaticLabels,
  parseBreadcrumbPath,
  truncateForMobile,
  type BreadcrumbSegment,
} from '@/components/layout/breadcrumb-path';
import { useBreadcrumbLabelMap } from '@/components/layout/breadcrumb-provider';

/**
 * Breadcrumbs render only when the route has 2+ filtered segments
 * (the leading `admin` / `portal` segment is dropped per the SaaS-
 * convention filter in `parseBreadcrumbPath`). Top-level pages like
 * `/admin/users`, `/admin/plans`, `/admin/members` produce a single
 * filtered segment and rely on sidebar active state + page h1
 * instead — breadcrumbs would be redundant there. The first
 * surface that renders breadcrumbs is a 2-deep route, e.g.
 * `/admin/settings/invoicing` → "Settings / Invoice settings".
 */
const MIN_DEPTH = 2;

export function BreadcrumbNav() {
  const pathname = usePathname() ?? '/';
  const dynamicLabels = useBreadcrumbLabelMap();
  const tBreadcrumb = useTranslations('breadcrumb');
  const tLayout = useTranslations('layout');

  const staticLabels = buildBreadcrumbStaticLabels(
    (key) => tBreadcrumb(key as Parameters<typeof tBreadcrumb>[0]),
    pathname,
  );
  const segments = parseBreadcrumbPath({
    pathname,
    staticLabels,
    dynamicLabels,
  });

  if (segments.length < MIN_DEPTH) return null;

  const mobile = truncateForMobile(segments);

  return (
    <Breadcrumb
      aria-label={tLayout('breadcrumbAriaLabel')}
      className="px-[var(--page-padding-x)] [padding-block-start:var(--page-padding-y)]"
    >
      {/* Desktop: full trail */}
      {/* Key composes `href` + `idx` because non-route segments
        * (NON_ROUTE_SEGMENTS in breadcrumb-path.ts) rewrite their
        * href to the parent path — e.g. `/admin/credit-notes/<id>`
        * has a `credit-notes` segment whose fallback href is
        * `/admin`, which duplicates the `admin` segment's href.
        * React key uniqueness requires disambiguation via position.
        */}
      <BreadcrumbList className="hidden sm:flex">
        {segments.map((seg, idx) => (
          <BreadcrumbFragment
            key={`${idx}:${seg.href}`}
            segment={seg}
            isLast={idx === segments.length - 1}
          />
        ))}
      </BreadcrumbList>
      {/* Mobile: parent + current with leading ellipsis */}
      <BreadcrumbList className="flex sm:hidden">
        {mobile.hasEllipsis ? (
          <>
            <BreadcrumbItem>
              <BreadcrumbEllipsis />
              <span className="sr-only">{tLayout('ellipsis')}</span>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
          </>
        ) : null}
        {mobile.visible.map((seg, idx) => (
          <BreadcrumbFragment
            key={`${idx}:${seg.href}`}
            segment={seg}
            isLast={idx === mobile.visible.length - 1}
          />
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function BreadcrumbFragment({
  segment,
  isLast,
}: {
  segment: BreadcrumbSegment;
  isLast: boolean;
}) {
  return (
    <Fragment>
      <BreadcrumbItem>
        {isLast || !segment.isLinkable ? (
          // Last segment OR organisational non-routable segment
          // (NON_ROUTE_BY_PARENT match — its href was rewritten to
          // the parent's path so making it a link would create two
          // adjacent trail items pointing at the same URL).
          // `BreadcrumbPage` styles it as plain muted text.
          <BreadcrumbPage>{segment.label}</BreadcrumbPage>
        ) : (
          <BreadcrumbLink render={<Link href={segment.href} />}>
            {segment.label}
          </BreadcrumbLink>
        )}
      </BreadcrumbItem>
      {isLast ? null : <BreadcrumbSeparator />}
    </Fragment>
  );
}
