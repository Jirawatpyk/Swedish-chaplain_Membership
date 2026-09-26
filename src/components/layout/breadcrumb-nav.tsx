'use client';

import Link from 'next/link';
import { ChevronRightIcon } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { formatCalendarYear } from '@/lib/format-date-localised';

import {
  buildBreadcrumbStaticLabels,
  parseBreadcrumbPath,
  truncateForMobile,
  type BreadcrumbSegment,
} from '@/components/layout/breadcrumb-path';
import { useBreadcrumbLabelMap } from '@/components/layout/breadcrumb-provider';
import { cn } from '@/lib/utils';

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

/**
 * Spec 122 US1 — `bar` sits in the AURA top bar (from 1024px, no padding);
 * `page` is the old in-page row, kept below 1024px where the bar has no room.
 */
export function BreadcrumbNav({ placement = 'page' }: { readonly placement?: 'bar' | 'page' } = {}) {
  const pathname = usePathname() ?? '/';
  const dynamicLabels = useBreadcrumbLabelMap();
  const tBreadcrumb = useTranslations('breadcrumb');
  const tLayout = useTranslations('layout');
  const locale = useLocale();

  const staticLabels = buildBreadcrumbStaticLabels(
    (key) => tBreadcrumb(key as Parameters<typeof tBreadcrumb>[0]),
    pathname,
  );
  const segments = parseBreadcrumbPath({
    pathname,
    staticLabels,
    dynamicLabels,
    // Plan-year crumb reads in the viewer's calendar (TH 2569); href stays CE.
    formatYear: (year) => formatCalendarYear(year, locale),
  });

  if (segments.length < MIN_DEPTH) return null;

  const mobile = truncateForMobile(segments);

  // Spec 122 US1 — AURA's breadcrumb markup (`aura-crumbs`), drawn here
  // rather than with AURA `Breadcrumb` for the phone trail (parent + current
  // behind a leading ellipsis) and the data-slots the e2e breadcrumb spec
  // selects on.
  return (
    <nav
      aria-label={tLayout('breadcrumbAriaLabel')}
      data-slot="breadcrumb"
      className={cn(
        'aura-crumbs',
        placement === 'bar' ? undefined : 'px-[var(--page-padding-x)] [padding-block-start:var(--page-padding-y)]',
      )}
    >
      {/* Desktop: full trail. Keys compose `href` + `idx` because a
          non-route segment (NON_ROUTE_SEGMENTS in breadcrumb-path.ts)
          rewrites its href to the parent path, duplicating it. */}
      <ol data-slot="breadcrumb-list" className="hidden sm:flex">
        {segments.map((seg, idx) => (
          <Crumb key={`${idx}:${seg.href}`} segment={seg} isLast={idx === segments.length - 1} />
        ))}
      </ol>
      {/* Mobile: parent + current with a leading ellipsis */}
      <ol data-slot="breadcrumb-list" className="flex sm:hidden">
        {mobile.hasEllipsis ? (
          <li data-slot="breadcrumb-item">
            <span data-slot="breadcrumb-ellipsis" aria-hidden className="text-[var(--aura-fg-tertiary)]">
              …
            </span>
            <span className="sr-only">{tLayout('ellipsis')}</span>
            <ChevronRightIcon className="aura-crumbs__sep size-3" aria-hidden />
          </li>
        ) : null}
        {mobile.visible.map((seg, idx) => (
          <Crumb key={`${idx}:${seg.href}`} segment={seg} isLast={idx === mobile.visible.length - 1} />
        ))}
      </ol>
    </nav>
  );
}

function Crumb({ segment, isLast }: { segment: BreadcrumbSegment; isLast: boolean }) {
  return (
    <li data-slot="breadcrumb-item">
      {isLast ? (
        <span aria-current="page" className="aura-crumbs__current">
          {segment.label}
        </span>
      ) : segment.isLinkable ? (
        <Link href={segment.href}>{segment.label}</Link>
      ) : (
        // An organisational segment (NON_ROUTE_BY_PARENT): its href was
        // rewritten to the parent's, so a link would duplicate that one.
        <span className="aura-crumbs__text">{segment.label}</span>
      )}
      {isLast ? null : <ChevronRightIcon className="aura-crumbs__sep size-3" aria-hidden />}
    </li>
  );
}
