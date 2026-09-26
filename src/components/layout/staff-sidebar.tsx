'use client';

import { useTranslations } from 'next-intl';

import {
  staffNavConfig,
  applyNavBadges,
  filterNavConfig,
  type NavBadgeCounts,
  type NavVisibilityFlags,
} from '@/config/nav';
import { NavEntry } from '@/components/layout/nav-item';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarRail,
} from '@/components/ui/sidebar';
import { SidebarToggle } from '@/components/shell/sidebar-toggle';
import { BrandMark } from '@/components/shell/brand-mark';

interface StaffSidebarProps {
  readonly tenantName: string;
    /**
   * Optional visibility flags from the server layout. Items with a
   * `visibilityFlag` are filtered OUT unless their flag is `true`.
   * Defaults to the empty map — items without a flag are always shown.
   */
  readonly navVisibilityFlags?: NavVisibilityFlags;
  /**
   * 016 T063 — hrefs this viewer may open, resolved by `staffNavAllowedHrefs`
   * in the server layout. Required: this component cannot evaluate permissions
   * itself (no `env`, no `canPerform` in a client bundle), and `filterNavConfig`
   * fails CLOSED, so omitting it renders an empty sidebar rather than leaking.
   */
  readonly allowedHrefs: readonly string[];
  /**
   * F114 US6 (FR-033) — live counts keyed by {@link BadgeableNavHref},
   * resolved in the server layout (`readPendingChangeRequestsForNav`).
   * Applied AFTER filtering, so an item this viewer cannot see (or a flag-off
   * item) never carries a count; and only onto items that DECLARE a `badge`,
   * so a count can never render as a bare unannounced number (B2).
   * Omitted / 0 → no badge.
   */
  readonly navBadgeCounts?: NavBadgeCounts;
}

export function StaffSidebar({
  tenantName,
  navVisibilityFlags = {},
  allowedHrefs,
  navBadgeCounts,
}: StaffSidebarProps) {
  const t = useTranslations();
  const visible = filterNavConfig(staffNavConfig, navVisibilityFlags, new Set(allowedHrefs));
  const filtered = navBadgeCounts ? applyNavBadges(visible, navBadgeCounts) : visible;

  return (
    <Sidebar
      collapsible="icon"
      role="navigation"
      aria-label={t('nav.staff.ariaLabel')}
    >
      <SidebarHeader className="border-b border-sidebar-border py-3 px-2">
        <div className="flex items-center gap-2">
          {/* TSCC crown mark. Decorative — the adjacent wordmark names the
              brand. The always-on white chip keeps the artwork's flag blue
              (#20419A) visible on a dark rail (dark theme; the rail was navy
              before spec 122). */}
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white p-0.5">
            <BrandMark variant="mark" className="size-7" />
          </span>
          <span className="truncate text-sm font-semibold group-data-[collapsible=icon]:hidden">
            {tenantName}
          </span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        {filtered.sections.map((section, idx) => (
          <SidebarGroup key={section.titleKey ?? `section-${idx}`}>
            {section.titleKey && (
              <SidebarGroupLabel>{t(section.titleKey)}</SidebarGroupLabel>
            )}
            <SidebarMenu>
              {section.items.map((item) => (
                <NavEntry key={item.titleKey} item={item} />
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <SidebarToggle />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
