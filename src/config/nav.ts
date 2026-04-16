import type { LucideIcon } from 'lucide-react';
import type { Role } from '@/modules/auth';
import {
  LayoutDashboardIcon,
  FileTextIcon,
  UsersIcon,
  SettingsIcon,
  DollarSignIcon,
  UserCircleIcon,
  BuildingIcon,
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
}

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
          titleKey: 'nav.staff.plans',
          icon: FileTextIcon,
          href: '/admin/plans',
          activePattern: '/admin/plans',
        },
        {
          titleKey: 'nav.staff.members',
          icon: BuildingIcon,
          href: '/admin/members',
          activePattern: '/admin/members',
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
      titleKey: 'nav.staff.sections.settings',
      items: [
        {
          titleKey: 'nav.staff.settings',
          icon: SettingsIcon,
          activePattern: '/admin/settings',
          children: [
            {
              titleKey: 'nav.staff.settingsFees',
              icon: DollarSignIcon,
              href: '/admin/settings/fees',
              activePattern: '/admin/settings/fees',
            },
          ],
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
