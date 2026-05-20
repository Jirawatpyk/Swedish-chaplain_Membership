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

  const staticLabels = buildStaticLabels(tBreadcrumb, pathname);
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

// URL segment → i18n key under `breadcrumb.*`. Non-contextual segments go
// here; verbs like `new` / `edit` / `clone` resolve contextually below
// because their human label depends on the parent resource.
const STATIC_LABEL_KEYS = {
  admin: 'admin',
  dashboard: 'dashboard',
  users: 'users',
  plans: 'plans',
  members: 'members',
  settings: 'settings',
  fees: 'fees',
  account: 'account',
  invoices: 'invoices',
  'credit-notes': 'credit-notes',
  void: 'void',
  pay: 'pay',
  // F8 — `/admin/settings/renewals/schedules` breadcrumb segments.
  // Renewals + schedules need labels so the trail reads as
  // "Admin / Settings / Renewals / Reminder schedules" not as raw URL
  // slugs.
  renewals: 'renewals',
  schedules: 'schedules',
  // F4 — `/admin/settings/invoicing` breadcrumb segment. The URL slug
  // is `invoicing` (gerund) not `invoices` (plural noun), so it
  // doesn't collide with the standalone `/admin/invoices` list page's
  // own `invoices` label above. Pre-existing gap from F4 ship —
  // closed in F6 Phase 5 verify-fix together with the new
  // `integrations`/`eventcreate` segments.
  invoicing: 'invoicing',
  // F7.1a US2 (2026-05-21) — `/admin/settings/broadcasts` breadcrumb
  // segment. The URL slug `broadcasts` is shared with the top-level
  // /admin/broadcasts queue page (which doesn't render breadcrumbs
  // because it's only 1 level deep). The label override here lets
  // the centralised-settings page render "Settings / Broadcasts"
  // correctly.
  broadcasts: 'broadcasts',
  // F6 — `/admin/integrations/eventcreate` breadcrumb segments.
  // `integrations` is an organisational segment (no page.tsx at that
  // level — handled by NON_ROUTE_BY_PARENT in breadcrumb-path.ts so
  // the segment renders non-clickable). `eventcreate` is the wizard
  // page itself (clickable / current page).
  integrations: 'integrations',
  eventcreate: 'eventcreate',
} as const;

// Verb segments resolve by parent resource. The outer key is the parent
// segment (e.g. `/admin/<parent>/<verb>`); the inner key is the verb; the
// value is the `breadcrumb.*` i18n key.
const CONTEXTUAL_VERBS: Record<string, Record<string, string>> = {
  plans: { new: 'newPlan', edit: 'editPlan', clone: 'clonePlan' },
  members: { new: 'newMember' },
  invoices: { new: 'newInvoice' },
  'credit-notes': { new: 'newCreditNote' },
};

// Match a UUID v4 (32 hex with dashes). When we hit a UUID segment
// underneath a known parent resource, we show the parent's "detail" label
// rather than the raw ID — a server-side resolver for the real name
// (company, plan, etc.) is the future upgrade path.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DETAIL_LABEL_KEYS_BY_PARENT: Record<string, string> = {
  members: 'memberDetail',
  invoices: 'invoiceDetail',
};

function buildStaticLabels(
  t: ReturnType<typeof useTranslations<'breadcrumb'>>,
  pathname: string,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};

  // 1. Non-contextual base segments.
  for (const [segment, key] of Object.entries(STATIC_LABEL_KEYS)) {
    try {
      result[segment] = t(key as Parameters<typeof t>[0]);
    } catch (err) {
      if (process.env.NODE_ENV === 'development') {
        console.warn(`[BreadcrumbNav] missing i18n key: breadcrumb.${key}`, err);
      }
    }
  }

  // 2. Verb overrides + UUID-detail overrides — scan current path.
  //    For each segment, if its parent is known and the segment matches a
  //    verb or UUID pattern, override `result[segment]` with the contextual
  //    label. Because the override is keyed by the decoded segment itself,
  //    parseBreadcrumbPath picks it up without further changes.
  const parts = pathname.split('?')[0]!.split('/').filter((p) => p.length > 0);
  for (let i = 1; i < parts.length; i++) {
    const segment = parts[i]!;
    const parent = parts[i - 1]!;

    const verbKey = CONTEXTUAL_VERBS[parent]?.[segment];
    if (verbKey) {
      try {
        result[segment] = t(verbKey as Parameters<typeof t>[0]);
      } catch {
        /* fallthrough to default */
      }
      continue;
    }

    if (UUID_RE.test(segment)) {
      const detailKey = DETAIL_LABEL_KEYS_BY_PARENT[parent];
      if (detailKey) {
        try {
          result[segment] = t(detailKey as Parameters<typeof t>[0]);
        } catch {
          /* fallthrough */
        }
      }
    }
  }

  return result;
}
