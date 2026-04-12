'use client';

import { useTranslations } from 'next-intl';

import { staffNavConfig } from '@/config/nav';
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

interface StaffSidebarProps {
  readonly tenantName: string;
}

export function StaffSidebar({ tenantName }: StaffSidebarProps) {
  const t = useTranslations();

  return (
    <Sidebar collapsible="icon" role="navigation" aria-label={t('nav.staff.ariaLabel')}>
      <SidebarHeader className="border-b border-sidebar-border py-3 px-2">
        <div className="flex items-center gap-2">
          <div
            className="flex size-8 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground text-sm font-bold"
            aria-hidden
          >
            {tenantName.charAt(0).toUpperCase()}
          </div>
          <span className="truncate text-sm font-semibold group-data-[collapsible=icon]:hidden">
            {tenantName}
          </span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        {staffNavConfig.sections.map((section, idx) => (
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
