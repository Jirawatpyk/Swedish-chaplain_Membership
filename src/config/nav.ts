import type { LucideIcon } from 'lucide-react';
import type { Role } from '@/modules/auth';
import {
  LayoutDashboardIcon,
  FileTextIcon,
  UsersIcon,
  UserCircleIcon,
  BuildingIcon,
  ReceiptIcon,
  FileMinusIcon,
  FileCog2Icon,
  MegaphoneIcon,
  RefreshCwIcon,
  CalendarClockIcon,
  CalendarDaysIcon,
  PlugZapIcon,
  Settings2Icon,
  ScrollTextIcon,
  GiftIcon,
  BookUserIcon,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Types (T006)
// ---------------------------------------------------------------------------

/**
 * Active-state matching pattern. A template-literal union so a typo'd mode
 * prefix or a missing leading slash is a COMPILE error (D1 review finding F2):
 *  - `exact:/path` — exact pathname match
 *  - `any:/a|/b`   — active if the pathname matches any pipe-separated prefix
 *  - `/path`       — prefix match (the default mode)
 * The runtime parser (`isNavItemActive`) is unchanged — this only tightens the
 * authoring surface so an invalid literal can't be written.
 */
export type ActivePattern = `exact:${string}` | `any:${string}` | `/${string}`;

/** A single navigation link. */
export interface NavItem {
  readonly titleKey: string;
  /**
   * Optional shorter i18n key used by the mobile bottom-tab bar where the
   * full `titleKey` label overflows a 320px tab (e.g. TH "สิทธิประโยชน์").
   * The full `titleKey` is still used as the tab's `aria-label`.
   */
  readonly shortTitleKey?: string;
  readonly icon: LucideIcon;
  readonly href: string;
  /** URL pattern for active-state matching (see {@link ActivePattern}). */
  readonly activePattern: ActivePattern;
  /** If set, item is visible only to these roles. Type-only for now — filtering
   *  logic deferred until a role-differentiated nav item exists. */
  readonly roles?: ReadonlyArray<Role>;
  /**
   * If set, the item is rendered ONLY when the named flag is `true` in
   * the runtime visibility-flag map passed to the sidebar. Used by
   * F6 T081 to hide `/admin/integrations/eventcreate` from sidebars
   * of tenants that haven't configured the integration AND haven't
   * received a webhook delivery in 30 days (round-2 R1).
   */
  readonly visibilityFlag?: NavVisibilityFlag;
}

/**
 * Named visibility flags resolved at request time and passed to the
 * sidebar. Keep this union closed so adding a new flag forces explicit
 * registration in the resolver + layout — prevents "ghost" flags that
 * silently default to `false` and hide items unintentionally.
 */
export type NavVisibilityFlag = 'eventcreateConfigured';

export type NavVisibilityFlags = Readonly<
  Partial<Record<NavVisibilityFlag, boolean>>
>;

/** An expandable/collapsible group of NavItems (e.g., Settings → Fees). */
export interface NavGroup {
  readonly titleKey: string;
  readonly icon: LucideIcon;
  /** NavGroup has no href — navigation happens through children. */
  readonly href?: never;
  /** URL pattern — group auto-expands when any child matches (see {@link ActivePattern}). */
  readonly activePattern: ActivePattern;
  readonly children: readonly NavItem[];
  readonly roles?: ReadonlyArray<string>;
}

/** A logical grouping of NavItems and NavGroups with an optional header. */
export interface NavSection {
  /** i18n key for section header. Omit for no header. */
  readonly titleKey?: string;
  readonly items: ReadonlyArray<NavItem | NavGroup>;
}

/** Top-level nav configuration for a portal. */
export interface NavConfig {
  readonly sections: readonly NavSection[];
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

export function isNavGroup(item: NavItem | NavGroup): item is NavGroup {
  return 'children' in item;
}

/**
 * Filter a nav config for the current request. Pure — lives here (not in
 * the client sidebar) so it is unit-testable without rendering React.
 *
 *  - `roles`: an item with a `roles` allow-list is dropped unless the
 *    current `role` is in it (e.g. admin-only Settings entries that the
 *    server gates with `notFound()` for manager — hides the dead link).
 *  - `visibilityFlag`: an item with a flag is dropped unless that flag is
 *    `true` in `flags`.
 *  - NavGroups: a group's own `roles` allow-list is honoured, then its
 *    CHILDREN are recursively filtered with the same item rules. A group
 *    left with no visible children after filtering is dropped (so a future
 *    admin-only child inside a group can't leak to a manager — S17
 *    speckit-review; no live leak today since staff config has no NavGroup).
 *  - Sections left empty after filtering are dropped (no orphan header).
 */
export function filterNavConfig(
  config: NavConfig,
  flags: NavVisibilityFlags,
  role: Role,
): NavConfig {
  function keepNavItem(item: NavItem): boolean {
    if (item.roles && !item.roles.includes(role)) return false;
    if (!item.visibilityFlag) return true;
    return flags[item.visibilityFlag] === true;
  }
  function filterEntry(item: NavItem | NavGroup): NavItem | NavGroup | null {
    if (isNavGroup(item)) {
      // Group-level role gate first, then recurse into children.
      if (item.roles && !item.roles.includes(role)) return null;
      const children = item.children.filter(keepNavItem);
      if (children.length === 0) return null;
      return { ...item, children };
    }
    return keepNavItem(item) ? item : null;
  }
  return {
    sections: config.sections
      .map((section) => ({
        ...section,
        items: section.items
          .map(filterEntry)
          .filter((entry): entry is NavItem | NavGroup => entry !== null),
      }))
      .filter((section) => section.items.length > 0),
  };
}

// ---------------------------------------------------------------------------
// Staff navigation (T007)
// ---------------------------------------------------------------------------

export const staffNavConfig: NavConfig = {
  sections: [
    // Overview — single landing entry, no section header.
    {
      items: [
        {
          titleKey: 'nav.staff.dashboard',
          icon: LayoutDashboardIcon,
          href: '/admin',
          activePattern: 'exact:/admin',
        },
      ],
    },
    // Membership — who the members are + their plan / renewal lifecycle.
    {
      titleKey: 'nav.staff.sections.membership',
      items: [
        {
          titleKey: 'nav.staff.members',
          icon: BuildingIcon,
          href: '/admin/members',
          activePattern: '/admin/members',
        },
        {
          titleKey: 'nav.staff.plans',
          icon: FileTextIcon,
          href: '/admin/plans',
          activePattern: '/admin/plans',
        },
        // F8 Renewals — renewal pipeline. Sub-routes (tier-upgrades, tasks)
        // live under /admin/renewals/* and keep the parent highlighted via
        // the prefix activePattern; renewal-schedule CONFIG lives in Settings.
        {
          titleKey: 'nav.staff.renewals',
          icon: RefreshCwIcon,
          href: '/admin/renewals',
          activePattern: '/admin/renewals',
        },
        // F9 US5 — member directory + E-Book/JSON export. Gated server-side by
        // FEATURE_F9_DASHBOARD (notFound when dark); nav entry stays visible.
        {
          titleKey: 'nav.staff.directory',
          icon: BookUserIcon,
          href: '/admin/directory',
          activePattern: '/admin/directory',
        },
      ],
    },
    // Finance — billing surfaces (invoices + credit notes). Payments live
    // inside the invoice flow; promote here if they ever become top-level.
    {
      titleKey: 'nav.staff.sections.finance',
      items: [
        {
          titleKey: 'nav.staff.invoices',
          icon: ReceiptIcon,
          href: '/admin/invoices',
          activePattern: '/admin/invoices',
        },
        // Credit notes — the standalone list (/admin/credit-notes). Notes
        // raised against a specific invoice live under /admin/invoices/**
        // and keep Invoices highlighted; this entry surfaces the directory
        // that was previously only reachable contextually from an invoice.
        {
          titleKey: 'nav.staff.creditNotes',
          icon: FileMinusIcon,
          href: '/admin/credit-notes',
          activePattern: '/admin/credit-notes',
        },
      ],
    },
    // Engagement — member-facing communications + events.
    {
      titleKey: 'nav.staff.sections.engagement',
      items: [
        {
          titleKey: 'nav.staff.broadcasts',
          icon: MegaphoneIcon,
          href: '/admin/broadcasts',
          activePattern: '/admin/broadcasts',
        },
        // F6 Events — EventCreate-imported event list + attendee detail.
        // Manager has read-only access via the same route (FR-035).
        {
          titleKey: 'nav.staff.events',
          icon: CalendarDaysIcon,
          href: '/admin/events',
          activePattern: '/admin/events',
        },
      ],
    },
    // System — account administration + the audit trail.
    {
      titleKey: 'nav.staff.sections.system',
      items: [
        {
          titleKey: 'nav.staff.users',
          icon: UsersIcon,
          href: '/admin/users',
          activePattern: '/admin/users',
        },
        // F9 US2 — staff audit-log viewer. Admin + manager (member never
        // reaches /admin/*). Gated server-side by FEATURE_F9_DASHBOARD
        // (notFound when dark); the nav entry stays visible.
        {
          titleKey: 'nav.staff.audit',
          icon: ScrollTextIcon,
          href: '/admin/audit',
          activePattern: '/admin/audit',
        },
      ],
    },
    {
      // R7 consolidation — Fee Configuration removed. VAT + currency
      // + registration fee consolidated into Invoice Settings as the
      // authoritative tenant-wide fiscal-config surface. F8 Renewals
      // re-added Renewal Schedules under the same Settings header.
      titleKey: 'nav.staff.sections.settings',
      items: [
        {
          titleKey: 'nav.staff.settingsInvoices',
          icon: FileCog2Icon,
          href: '/admin/settings/invoicing',
          activePattern: '/admin/settings/invoicing',
        },
        {
          titleKey: 'nav.staff.settingsRenewalSchedules',
          icon: CalendarClockIcon,
          href: '/admin/settings/renewals/schedules',
          activePattern: '/admin/settings/renewals',
        },
        // F7.1a US2 — Broadcast settings (image-source allowlist).
        // Relocated 2026-05-21 from `/admin/broadcasts/settings` to
        // `/admin/settings/broadcasts` per the centralised-settings IA
        // convention (matches F8 renewal-schedules + F4 invoice-settings
        // + F6 EventCreate-integration patterns). The auto-derived
        // breadcrumb reads "Settings / Broadcasts" instead of the
        // misleading "Broadcasts / Settings" the old URL produced.
        // Surface gated by `isF71aUs2Enabled()` server-side — when
        // the flag is OFF the page returns notFound(); the nav entry
        // stays visible (mirrors F6 EventCreate pattern at lines
        // 198-208 below which does not gate on the kill-switch either).
        {
          titleKey: 'nav.staff.settingsBroadcasts',
          icon: Settings2Icon,
          href: '/admin/settings/broadcasts',
          activePattern: '/admin/settings/broadcasts',
          // Admin-only ACCESS — the page returns notFound() for manager
          // (role !== 'admin'), unlike Invoice Settings / Renewal Schedules
          // which managers may view read-only. Hide the entry so manager
          // isn't shown a link that 404s.
          roles: ['admin'],
        },
        // F6 EventCreate integration. Spec round-2 R1 noted that the
        // entry "is a navigation-affordance decision" — initially we
        // gated visibility on `tenant_webhook_configs` row existence
        // to avoid cluttering CSV-only tenants. Post-Phase-5
        // shakedown showed first-time admins struggled to discover
        // the setup wizard from the events-list empty-state CTA
        // alone, so the entry now appears whenever the F6 kill-switch
        // is on. CSV-only tenants who want to suppress it can still
        // do so per-instance via the `visibilityFlag` mechanism if
        // we add an explicit opt-out config later. The whole `/admin
        // /integrations/eventcreate` route prefix is gated by kill-
        // switch + admin-role at the route layer (FR-035), so showing
        // the nav entry never leaks the surface to non-admin actors.
        {
          titleKey: 'nav.staff.settingsIntegrationEventcreate',
          icon: PlugZapIcon,
          href: '/admin/settings/integrations/eventcreate',
          activePattern: '/admin/settings/integrations/eventcreate',
          // Admin-only ACCESS (FR-035) — route returns notFound() for
          // manager. Hidden from the manager sidebar via the roles filter.
          roles: ['admin'],
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Member navigation (057 redesign)
// ---------------------------------------------------------------------------

/**
 * Desktop top-nav (≥ lg). Four destinations only — Account is reached via the
 * avatar dropdown (UserMenu), not the top-nav (spec §2/§2a, review M3).
 * Broadcasts/Timeline/Renewal-prefs were de-promoted from the top-nav: their
 * ROUTES are preserved (spec §3 route-preservation) — Broadcasts lives inside
 * the Benefits tab, Timeline on the Dashboard, Renewal-prefs in the Account hub.
 */
export const memberNavConfig: NavConfig = {
  sections: [
    {
      items: [
        {
          titleKey: 'nav.member.dashboard',
          icon: LayoutDashboardIcon,
          href: '/portal',
          activePattern: 'exact:/portal',
        },
        {
          titleKey: 'nav.member.profile',
          icon: BuildingIcon,
          href: '/portal/profile',
          activePattern: '/portal/profile',
        },
        {
          titleKey: 'nav.member.invoices',
          icon: ReceiptIcon,
          href: '/portal/invoices',
          activePattern: '/portal/invoices',
        },
        // Benefits (entitlements + Broadcasts tab). The active matcher must
        // ALSO cover /portal/broadcasts/** so the compose/detail routes keep
        // the Benefits tab highlighted (spec §3/§4.4, review M-2). We express
        // this with a leading "any:" multi-prefix pattern resolved by
        // isNavItemActive below — keeps NavItem.activePattern a single string.
        {
          titleKey: 'nav.member.benefits',
          icon: GiftIcon,
          href: '/portal/benefits',
          activePattern: 'any:/portal/benefits|/portal/broadcasts',
        },
      ],
    },
  ],
};

/**
 * Mobile bottom tab bar (< lg). Five tabs = the four desktop destinations +
 * Account (which is the avatar dropdown on desktop). `shortTitleKey` supplies
 * a compact label so TH strings don't overflow a 320px tab; the full
 * `titleKey` is the tab's accessible name (spec §6/§7, review SG-5).
 */
export const memberBottomTabItems: readonly NavItem[] = [
  {
    titleKey: 'nav.member.dashboard',
    icon: LayoutDashboardIcon,
    href: '/portal',
    activePattern: 'exact:/portal',
  },
  {
    titleKey: 'nav.member.profile',
    icon: BuildingIcon,
    href: '/portal/profile',
    activePattern: '/portal/profile',
  },
  {
    titleKey: 'nav.member.invoices',
    icon: ReceiptIcon,
    href: '/portal/invoices',
    activePattern: '/portal/invoices',
  },
  {
    titleKey: 'nav.member.benefits',
    shortTitleKey: 'nav.member.benefitsShort',
    icon: GiftIcon,
    href: '/portal/benefits',
    activePattern: 'any:/portal/benefits|/portal/broadcasts',
  },
  {
    titleKey: 'nav.member.account',
    shortTitleKey: 'nav.member.accountShort',
    icon: UserCircleIcon,
    href: '/portal/account',
    activePattern: '/portal/account',
  },
];

// ---------------------------------------------------------------------------
// Active-state matching utility (T009)
// ---------------------------------------------------------------------------

/** Prefix used for exact-match active patterns (e.g., `exact:/admin`). */
const EXACT_PREFIX = 'exact:' as const;

/** Prefix used for a pipe-separated OR list of prefix patterns. */
const ANY_PREFIX = 'any:' as const;

/**
 * Determine if a nav item is active for the given pathname.
 *
 * Supports three modes:
 * - `exact:/admin` — matches only the exact pathname `/admin`
 * - `any:/portal/benefits|/portal/broadcasts` — active if the pathname
 *   matches ANY of the pipe-separated prefixes (used so the Benefits tab
 *   stays lit on /portal/broadcasts/** — review M-2)
 * - `/admin/plans` — prefix match (pathname starts with the pattern)
 */
export function isNavItemActive(pathname: string, activePattern: string): boolean {
  if (activePattern.startsWith(EXACT_PREFIX)) {
    return pathname === activePattern.slice(EXACT_PREFIX.length);
  }
  if (activePattern.startsWith(ANY_PREFIX)) {
    return activePattern
      .slice(ANY_PREFIX.length)
      .split('|')
      .some((p) => pathname === p || pathname.startsWith(`${p}/`));
  }
  return pathname === activePattern || pathname.startsWith(`${activePattern}/`);
}

/**
 * Find the deepest matching active pattern from a flat list of patterns.
 * Returns the pattern string or `null` if none match.
 * "Deepest" = longest matching pattern (most specific).
 */
export function findActivePattern(
  pathname: string,
  patterns: readonly string[],
): string | null {
  let best: string | null = null;
  let bestLen = -1;

  for (const pattern of patterns) {
    if (isNavItemActive(pathname, pattern)) {
      // For exact matches, compare by the actual path length (strip "exact:" prefix)
      const len = pattern.startsWith(EXACT_PREFIX) ? pattern.length - EXACT_PREFIX.length : pattern.length;
      if (len > bestLen) {
        best = pattern;
        bestLen = len;
      }
    }
  }
  return best;
}
