import type { LucideIcon } from 'lucide-react';
import type { Role } from '@/modules/auth';
import {
  LayoutDashboardIcon,
  FileTextIcon,
  UsersIcon,
  UserCircleIcon,
  BuildingIcon,
  ReceiptIcon,
  FileCog2Icon,
  MegaphoneIcon,
  RefreshCwIcon,
  CalendarClockIcon,
  CalendarDaysIcon,
  PlugZapIcon,
  Settings2Icon,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Types (T006)
// ---------------------------------------------------------------------------

/** A single navigation link. */
export interface NavItem {
  readonly titleKey: string;
  readonly icon: LucideIcon;
  readonly href: string;
  /** URL prefix for active-state matching. Use `exact:` prefix for exact match. */
  readonly activePattern: string;
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
  /** URL prefix — group auto-expands when any child matches. */
  readonly activePattern: string;
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

// ---------------------------------------------------------------------------
// Staff navigation (T007)
// ---------------------------------------------------------------------------

export const staffNavConfig: NavConfig = {
  sections: [
    {
      items: [
        {
          titleKey: 'nav.staff.dashboard',
          icon: LayoutDashboardIcon,
          href: '/admin',
          activePattern: 'exact:/admin',
        },
        {
          titleKey: 'nav.staff.members',
          icon: BuildingIcon,
          href: '/admin/members',
          activePattern: '/admin/members',
        },
        {
          titleKey: 'nav.staff.invoices',
          icon: ReceiptIcon,
          href: '/admin/invoices',
          activePattern: '/admin/invoices',
        },
        {
          titleKey: 'nav.staff.broadcasts',
          icon: MegaphoneIcon,
          href: '/admin/broadcasts',
          activePattern: '/admin/broadcasts',
        },
        // F6 Events — surfaces the EventCreate-imported event list +
        // attendee detail. The Phase 4 page shipped without a nav
        // entry; this entry closes that gap so admins can reach the
        // module without typing a direct URL. Manager has read-only
        // access via the same route (FR-035).
        {
          titleKey: 'nav.staff.events',
          icon: CalendarDaysIcon,
          href: '/admin/events',
          activePattern: '/admin/events',
        },
        // F8 Renewals — top-level entry surfacing the renewal pipeline.
        // Sub-routes (tier-upgrades, tasks) live under /admin/renewals/*
        // and use the activePattern prefix-match to keep the parent
        // highlighted; settings/schedules has been relocated to
        // /admin/settings/renewals/schedules and lives in the Settings
        // group below per the centralized-settings IA convention.
        {
          titleKey: 'nav.staff.renewals',
          icon: RefreshCwIcon,
          href: '/admin/renewals',
          activePattern: '/admin/renewals',
        },
        {
          titleKey: 'nav.staff.users',
          icon: UsersIcon,
          href: '/admin/users',
          activePattern: '/admin/users',
        },
      ],
    },
    {
      // R7 consolidation — Fee Configuration removed. VAT + currency
      // + registration fee consolidated into Invoice Settings as the
      // authoritative tenant-wide fiscal-config surface. F8 Renewals
      // re-added Renewal Schedules under the same Settings header.
      // F2 Plans relocated from top-level into Settings per the
      // centralized-settings IA convention (matches the F8 Renewal
      // Schedules relocation rationale): Plans are policy/catalogue
      // config set once per fiscal year (clone-to-year + tier
      // pricing), not daily operational data. URL `/admin/plans`
      // unchanged — only the sidebar entry moved.
      titleKey: 'nav.staff.sections.settings',
      items: [
        {
          titleKey: 'nav.staff.settingsPlans',
          icon: FileTextIcon,
          href: '/admin/plans',
          activePattern: '/admin/plans',
        },
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
        // Lives at `/admin/broadcasts/settings` rather than under
        // `/admin/settings/broadcasts` per the URL hierarchy that
        // shipped in Phase 4 (T075). Surface gated by
        // `isF71aUs2Enabled()` server-side — when the flag is OFF the
        // page returns notFound(); the nav entry stays visible
        // (mirrors F6 EventCreate pattern at lines 187-192 above
        // which does not gate on the kill-switch either). If a
        // future tenant needs to suppress the entry without flag-
        // flipping, extend NavVisibilityFlag with `f71aUs2Images`
        // and thread through the resolver.
        {
          titleKey: 'nav.staff.settingsBroadcasts',
          icon: Settings2Icon,
          href: '/admin/broadcasts/settings',
          activePattern: '/admin/broadcasts/settings',
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
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Member navigation (T008)
// ---------------------------------------------------------------------------

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
        // R7-B3 — US3 member invoice self-service.
        {
          titleKey: 'nav.member.invoices',
          icon: ReceiptIcon,
          href: '/portal/invoices',
          activePattern: '/portal/invoices',
        },
        // F7 — Email Broadcasts (E-Blast) entry point. Lands on the
        // benefits dashboard which shows quota + history + Compose CTA.
        // Members on plans with no E-Blast quota still see the page
        // (with upgrade-explainer treatment) so the link is shown to
        // every member regardless of tier.
        {
          titleKey: 'nav.member.broadcasts',
          icon: MegaphoneIcon,
          href: '/portal/benefits/e-blasts',
          activePattern: '/portal/benefits/e-blasts',
        },
        {
          titleKey: 'nav.member.account',
          icon: UserCircleIcon,
          href: '/portal/account',
          activePattern: '/portal/account',
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Active-state matching utility (T009)
// ---------------------------------------------------------------------------

/** Prefix used for exact-match active patterns (e.g., `exact:/admin`). */
const EXACT_PREFIX = 'exact:' as const;

/**
 * Determine if a nav item is active for the given pathname.
 *
 * Supports two modes:
 * - `exact:/admin` — matches only the exact pathname `/admin`
 * - `/admin/plans` — prefix match (pathname starts with the pattern)
 */
export function isNavItemActive(pathname: string, activePattern: string): boolean {
  if (activePattern.startsWith(EXACT_PREFIX)) {
    return pathname === activePattern.slice(EXACT_PREFIX.length);
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
