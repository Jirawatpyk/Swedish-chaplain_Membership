'use client';

import { useTranslations } from 'next-intl';

import {
  staffNavConfig,
  filterNavConfig,
  type NavVisibilityFlags,
} from '@/config/nav';
import type { Role } from '@/modules/auth';
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
   * Current actor role. Items with a `roles` allow-list are hidden unless
   * the role is in it — manager never sees admin-only Settings entries
   * (Broadcast Settings, EventCreate integration) that 404 server-side.
   */
  readonly role: Role;
  /**
   * Optional visibility flags from the server layout. Items with a
   * `visibilityFlag` are filtered OUT unless their flag is `true`.
   * Defaults to the empty map — items without a flag are always shown.
   */
  readonly navVisibilityFlags?: NavVisibilityFlags;
}

export function StaffSidebar({
  tenantName,
  role,
  navVisibilityFlags = {},
}: StaffSidebarProps) {
  const t = useTranslations();
  const filtered = filterNavConfig(staffNavConfig, navVisibilityFlags, role);

  return (
    <Sidebar collapsible="icon" role="navigation" aria-label={t('nav.staff.ariaLabel')}>
      <SidebarHeader className="border-b border-sidebar-border py-3 px-2">
        <div className="flex items-center gap-2">
          {/* Official Interlocking Link mark. Decorative — the adjacent
              wordmark names the brand. Reverses navy→white in dark mode via
              currentColor; gold ring pinned to the --brand-accent token. */}
          <BrandMark variant="mark" className="size-8 shrink-0" />
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
