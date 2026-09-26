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
  /**
   * Renders a plan-year segment (`/admin/plans/<year>/…`) for display, e.g.
   * the Buddhist-Era year on Thai. The segment's `href` stays CE. Omitted →
   * the year shows as it appears in the URL.
   */
  formatYear?: (year: number) => string;
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
  formatYear,
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
    //
    // F6 (round-6 verify-fix 2026-05-13) — `/admin/settings/integrations/
    // <source>` lives UNDER `settings` (not directly under `admin` —
    // the original round-5 entry under the `admin` parent never matched
    // because the real semantic parent of `integrations` in the
    // configured URL is `settings`, not `admin`). Walking up from
    // `eventcreate` finds `integrations`; walking up from `integrations`
    // finds `settings` — so the rule MUST key `integrations` under the
    // `settings` parent. Without this, clicking the `Integrations`
    // breadcrumb segment fell through to a real link at
    // `/admin/settings/integrations` which has no `page.tsx` → 404.
    ['settings', new Set(['renewals', 'integrations'])],
    // F6 — `/admin/events/<id>/registrations/<id>/erase` is a deep route
    // whose only `page.tsx` lives at the `erase` leaf. Neither
    // `/admin/events/<id>/registrations` nor
    // `/admin/events/<id>/registrations/<id>` has an index page, so both
    // intermediate crumbs would 404 (and the prefetch logs a console
    // error). `registrations` is the structural opener; the UUID
    // `registrationId` beneath it is handled by the subtree cascade below.
    ['events', new Set(['registrations'])],
    // COMP-1 (incident 2026-07-18) — `/admin/compliance/erasure-log`: the
    // `compliance` level has no content page (only a redirect-index to its
    // single child, `src/app/(staff)/admin/compliance/page.tsx`). Its semantic
    // parent IS `admin` (it sits directly under `/admin/`, unlike `integrations`
    // which lives under `settings`). Marking it non-route renders the crumb as
    // non-clickable plain text so its `<Link>` prefetch never hits the
    // `/admin/compliance` 404 that aborted client-side soft-nav to the leaf
    // (the redirect page fixed the route; this stops the prefetch entirely).
    // 108 PR-D — `/admin/marketing/audience`: `marketing` has no page of its
    // own (the only page is the `audience` leaf), same shape as `compliance`.
    ['admin', new Set(['compliance', 'marketing'])],
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

  // A dynamic id segment (UUID) under a structural opener has no own
  // page.tsx — it can't be enumerated in NON_ROUTE_BY_PARENT by name, so
  // it inherits non-route status here.
  const isDynamicId = (s: string | undefined): boolean =>
    s !== undefined &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

  // Scoped subtree cascade. A non-leaf segment is non-route when it is a
  // direct NON_ROUTE_BY_PARENT match, OR it is a DYNAMIC id sitting inside
  // a structural subtree opened by an earlier match — e.g.
  // `events/<id>/registrations/<id>/erase`: `registrations` matches
  // directly and the UUID `registrationId` cascades. A NAMED non-leaf
  // segment is NOT auto-downgraded: it may be a real nested route, so it
  // ends the structural run and must opt in explicitly via
  // NON_ROUTE_BY_PARENT. The leaf (isCurrent) is the real route and renders
  // as BreadcrumbPage regardless. The cascade can only DOWNGRADE a crumb to
  // plain text — it never produces a clickable bad link.
  // A dynamic id whose own level has no page.tsx, keyed by the resource it
  // sits under: `/admin/broadcasts/templates/<id>/edit` — the only page under
  // `templates/[id]` is `edit/`, so a link to `templates/<id>` 404s. Every
  // other dynamic id (members, invoices, events, …) has a detail page and
  // stays linkable.
  const NON_ROUTE_DYNAMIC_CHILD_OF: ReadonlySet<string> = new Set(['templates']);

  const nonRouteFlags: boolean[] = new Array(rawParts.length).fill(false);
  let inStructuralSubtree = false;
  for (let i = 0; i < lastIndex; i++) {
    if (
      isDynamicId(decodedParts[i]) &&
      NON_ROUTE_DYNAMIC_CHILD_OF.has(decodedParts[i - 1] ?? '')
    ) {
      nonRouteFlags[i] = true;
    } else if (isNonRouteSegment(i)) {
      inStructuralSubtree = true;
      nonRouteFlags[i] = true;
    } else if (inStructuralSubtree && isDynamicId(decodedParts[i])) {
      nonRouteFlags[i] = true;
    } else {
      // A named, potentially-routable segment closes the structural run.
      inStructuralSubtree = false;
    }
  }

  return rawParts
    .map((rawSegment, index) => {
      const decoded = decodedParts[index] ?? rawSegment;
      let href: string;
      let isLinkable = true;
      if (isPlansYear(index)) {
        href = `/admin/plans?year=${decoded}`;
      } else if (nonRouteFlags[index]) {
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
        label:
          formatYear && isPlansYear(index)
            ? formatYear(Number(decoded))
            : (dynamicLabels.get(decoded) ?? staticLabels[decoded] ?? decoded),
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
  // F7.1a US2 — `/admin/settings/broadcasts` breadcrumb
  // segment. The URL slug `broadcasts` is shared with the top-level
  // /admin/broadcasts queue page (which doesn't render breadcrumbs
  // because it's only 1 level deep). The label override here lets
  // the centralised-settings page render "Settings / Broadcasts"
  // correctly.
  broadcasts: 'broadcasts',
  // F119 T028 — `/admin/settings/broadcasts/brand`. Without a label the trail
  // renders the raw slug, which reads as an untranslated Latin word on the TH
  // and SV surfaces (the `erasure-log` incident, 2026-07-18).
  brand: 'brand',
  // F7.1a US7 — `/admin/broadcasts/templates` breadcrumb segment +
  // `new` + `edit` verb-overrides for /templates/new and /templates/
  // [id]/edit. The `new`/`edit` keys also re-use the resource-aware
  // CONTEXTUAL_VERBS map below so templates can have "New Template"
  // instead of generic "New".
  templates: 'templates',
  // F6 — `/admin/integrations/eventcreate` breadcrumb segments.
  // `integrations` is an organisational segment (no page.tsx at that
  // level — handled by NON_ROUTE_BY_PARENT above so
  // the segment renders non-clickable). `eventcreate` is the wizard
  // page itself (clickable / current page).
  integrations: 'integrations',
  eventcreate: 'eventcreate',
  // COMP-1 — `/admin/compliance/erasure-log` breadcrumb segments. `compliance`
  // is an organisational section whose only page is a redirect to its single
  // child (handled by NON_ROUTE_BY_PARENT above so the segment
  // renders non-clickable). `erasure-log` is the DPO evidence log itself (the
  // current page). Without these labels the trail showed raw slugs
  // "compliance / erasure-log" (incident 2026-07-18, PR #223 follow-up).
  compliance: 'compliance',
  'erasure-log': 'erasureLog',
  // 108 PR-D — `/admin/marketing/audience`. `marketing` is an organisational
  // segment with no page of its own (NON_ROUTE_BY_PARENT under `admin`
  // above, like `compliance`); `audience` is the page itself.
  marketing: 'marketing',
  audience: 'audience',
  // `/admin/events/**` and `/admin/change-requests/<id>` are 2+ deep, so the
  // trail renders — these section roots showed as raw slugs before.
  events: 'events',
  'change-requests': 'changeRequests',
} as const;

// Verb and sub-page segments resolve by parent resource. The outer key is the
// parent segment; the inner key is the verb / sub-page slug; the value is the
// `breadcrumb.*` i18n key. The parent is the nearest ancestor that is NOT a
// dynamic id, so `/admin/members/<id>/edit` resolves under `members` (the
// UUID between them used to hide the mapping and the crumb read "edit").
const CONTEXTUAL_VERBS: Record<string, Record<string, string>> = {
  plans: { new: 'newPlan', edit: 'editPlan', clone: 'clonePlan' },
  members: {
    new: 'newMember',
    edit: 'editMember',
    benefits: 'memberBenefits',
    timeline: 'memberTimeline',
  },
  invoices: { new: 'newInvoice', registers: 'taxRegisters' },
  'credit-notes': { new: 'newCreditNote' },
  templates: { new: 'newTemplate', edit: 'editTemplate' },
  broadcasts: { new: 'proxySubmit' },
  events: {
    import: 'eventImport',
    erasure: 'eventErasure',
    registrations: 'eventRegistrations',
  },
  import: { history: 'importHistory' },
  registrations: { erase: 'eraseRegistration' },
  renewals: { tasks: 'escalationTasks', 'tier-upgrades': 'tierUpgrades' },
  settings: { 'member-changes': 'memberChanges' },
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
  broadcasts: 'broadcastDetail',
  'change-requests': 'changeRequestDetail',
  events: 'eventDetail',
  registrations: 'registrationDetail',
  // Fallback until the editor page registers the template's name.
  templates: 'templateDetail',
};

// A path segment that stands for a record rather than a resource: a UUID, or
// the plan-year in `/admin/plans/<year>/<planId>`.
const isDynamicSegment = (segment: string): boolean =>
  UUID_RE.test(segment) || /^\d{4}$/.test(segment);

/**
 * Resolve the `breadcrumb.*` label for every segment the current path can
 * show. `t` looks up a key under the `breadcrumb` namespace and may throw
 * for a missing key (the segment then falls back to its raw slug).
 */
export function buildBreadcrumbStaticLabels(
  t: (key: string) => string,
  pathname: string,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};

  // 1. Non-contextual base segments.
  for (const [segment, key] of Object.entries(STATIC_LABEL_KEYS)) {
    try {
      result[segment] = t(key);
    } catch (err) {
      if (process.env.NODE_ENV === 'development') {
        console.warn(`[breadcrumb] missing i18n key: breadcrumb.${key}`, err);
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
    let resource = parent;
    for (let j = i - 1; j > 0 && isDynamicSegment(resource); j--) {
      resource = parts[j - 1]!;
    }

    const verbKey = CONTEXTUAL_VERBS[resource]?.[segment];
    if (verbKey) {
      try {
        result[segment] = t(verbKey);
      } catch {
        /* fallthrough to default */
      }
      continue;
    }

    if (UUID_RE.test(segment)) {
      const detailKey = DETAIL_LABEL_KEYS_BY_PARENT[parent];
      if (detailKey) {
        try {
          result[segment] = t(detailKey);
        } catch {
          /* fallthrough */
        }
      }
    }
  }

  return result;
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
