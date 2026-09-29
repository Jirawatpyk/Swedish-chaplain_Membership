'use client';

import Link from 'next/link';
import { ArrowLeftIcon, ChevronRightIcon } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { formatCalendarYear } from '@/lib/format-date-localised';

import {
  backLinkTarget,
  buildBreadcrumbStaticLabels,
  parseBreadcrumbPath,
  type BreadcrumbSegment,
} from '@/components/layout/breadcrumb-path';
import { useBreadcrumbLabelMap } from '@/components/layout/breadcrumb-provider';
import { AURA_FOCUS_RING } from '@/components/shell/aura-classes';
import { cn } from '@/lib/utils';

/**
 * Spec 122 — the trail as the staff boards draw it, in the top bar from
 * 1024px: every page has one (the leading `admin` / `portal` segment is
 * dropped per the SaaS-convention filter in `parseBreadcrumbPath`), so a
 * top-level page shows itself as the current crumb and `/admin` shows
 * "Dashboard". Below 1024px the boards replace the trail with a "← Parent"
 * link above the page (`BreadcrumbBackLink`).
 */
function useBreadcrumbSegments(pathnameOverride: string | undefined): BreadcrumbSegment[] {
  const routerPath = usePathname() ?? '/';
  const pathname = pathnameOverride ?? routerPath;
  const dynamicLabels = useBreadcrumbLabelMap();
  const tBreadcrumb = useTranslations('breadcrumb');
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
  if (segments.length === 0 && pathname.replace(/\/+$/, '') === '/admin') {
    return [{ href: '/admin', segment: 'dashboard', label: tBreadcrumb('dashboard'), isCurrent: true, isLinkable: true }];
  }
  return segments;
}

/** The pathname props let the preview harness show a board's trail; pages leave them unset. */
export function BreadcrumbNav({ pathname }: { readonly pathname?: string | undefined } = {}) {
  const tLayout = useTranslations('layout');
  const segments = useBreadcrumbSegments(pathname);
  if (segments.length === 0) return null;

  // AURA's breadcrumb markup (`aura-crumbs`), drawn here rather than with
  // AURA `Breadcrumb` for the organisational segments and the data-slots the
  // e2e breadcrumb spec selects on.
  // AURA's crumb classes on our own trail, not AURA's `Breadcrumb`: the trail
  // collapses on narrow widths and each item carries its e2e data-slot (#58).
  // A stand-in until AURA #94 (Breadcrumb collapse + per-item attributes).
  return (
    <nav aria-label={tLayout('breadcrumbAriaLabel')} data-slot="breadcrumb" className="aura-crumbs">
      {/* Keys compose `href` + `idx` because a non-route segment
          (NON_ROUTE_SEGMENTS in breadcrumb-path.ts) rewrites its href to the
          parent path, duplicating it. */}
      <ol data-slot="breadcrumb-list" className="flex">
        {segments.map((seg, idx) => (
          <Crumb key={`${idx}:${seg.href}`} segment={seg} isLast={idx === segments.length - 1} />
        ))}
      </ol>
    </nav>
  );
}

/**
 * Below 1024px: "← Members" above the page, as the phone boards draw it
 * (13px, accent, a 44px target). Nothing on a top-level page.
 */
export function BreadcrumbBackLink({ pathname }: { readonly pathname?: string | undefined } = {}) {
  const target = backLinkTarget(useBreadcrumbSegments(pathname));
  if (!target) return null;
  return (
    <div className="px-[var(--page-padding-x)] pt-[calc(var(--page-padding-y)-6px)] mb-[calc(8px-var(--page-padding-y))]">
      <Link
        href={target.href}
        data-slot="breadcrumb-back"
        className={cn(
          'inline-flex min-h-11 items-center gap-1.5 aura-text-label rounded-[var(--aura-radius-sm)] text-[var(--aura-fg-accent)] no-underline hover:underline',
          AURA_FOCUS_RING,
        )}
      >
        <ArrowLeftIcon className="size-4 shrink-0" aria-hidden />
        {target.label}
      </Link>
    </div>
  );
}

// AURA's crumb element classes: a stand-in until AURA #94.
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
