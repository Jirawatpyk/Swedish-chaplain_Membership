'use client';

import Link from 'next/link';
import { ArrowLeftIcon } from 'lucide-react';
import { Breadcrumb } from '@jirawatpyk/aura-react';
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

  // AURA's `Breadcrumb` (#94, 5.15): each item's `<li>` carries the e2e
  // `data-slot` through `itemProps`, and an organisational segment (its href
  // rewritten to the parent's) has no href, so AURA draws it as text. The
  // wrapper carries the list slot, as AURA's `<ol>` takes no attributes. The
  // trail shows from 1024px only, so it never needs AURA's collapse.
  return (
    <div data-slot="breadcrumb-list">
      <Breadcrumb
        label={tLayout('breadcrumbAriaLabel')}
        linkComponent={Link}
        items={segments.map((seg, idx) => ({
          label: seg.label,
          ...(idx < segments.length - 1 && seg.isLinkable ? { href: seg.href } : {}),
          itemProps: { 'data-slot': 'breadcrumb-item' },
        }))}
      />
    </div>
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
