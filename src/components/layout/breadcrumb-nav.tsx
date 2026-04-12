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
  parseBreadcrumbPath,
  truncateForMobile,
  type BreadcrumbSegment,
} from '@/components/layout/breadcrumb-path';
import { useBreadcrumbLabelMap } from '@/components/layout/breadcrumb-provider';

/**
 * Breadcrumbs render only when the route has 3+ segments. Top-level
 * pages (/admin, /admin/users, /admin/plans) rely on sidebar active
 * state + h1 instead — breadcrumbs would be redundant there.
 */
const MIN_DEPTH = 3;

export function BreadcrumbNav() {
  const pathname = usePathname() ?? '/';
  const dynamicLabels = useBreadcrumbLabelMap();
  const tBreadcrumb = useTranslations('breadcrumb');
  const tLayout = useTranslations('layout');

  const staticLabels = buildStaticLabels(tBreadcrumb);
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
      <BreadcrumbList className="hidden sm:flex">
        {segments.map((seg, idx) => (
          <BreadcrumbFragment
            key={seg.href}
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
            key={seg.href}
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
        {isLast ? (
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

// URL segment → i18n key under `breadcrumb.*`. Segments equal to their key
// are spelled out for grep-ability rather than synthesised.
const STATIC_LABEL_KEYS = {
  admin: 'admin',
  dashboard: 'dashboard',
  users: 'users',
  plans: 'plans',
  settings: 'settings',
  fees: 'fees',
  account: 'account',
  new: 'newPlan',
  clone: 'clonePlan',
  edit: 'editPlan',
} as const;

function buildStaticLabels(
  t: ReturnType<typeof useTranslations<'breadcrumb'>>,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [segment, key] of Object.entries(STATIC_LABEL_KEYS)) {
    try {
      result[segment] = t(key as Parameters<typeof t>[0]);
    } catch (err) {
      // Missing TH/SV labels would otherwise silently fall back to the raw URL
      // slug on screen. Surface in dev so translators catch gaps before prod.
      if (process.env.NODE_ENV === 'development') {
        console.warn(`[BreadcrumbNav] missing i18n key: breadcrumb.${key}`, err);
      }
    }
  }
  return result;
}
