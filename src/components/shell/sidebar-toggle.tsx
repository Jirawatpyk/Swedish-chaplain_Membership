'use client';

import { PanelLeftCloseIcon, PanelLeftOpenIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useSidebar } from '@/components/ui/sidebar';
import { SidebarMenuButton, SidebarMenuItem, SidebarMenu } from '@/components/ui/sidebar';

export function SidebarToggle() {
  const { state, toggleSidebar } = useSidebar();
  const t = useTranslations();
  const isExpanded = state === 'expanded';

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          onClick={toggleSidebar}
          tooltip={isExpanded ? t('nav.staff.collapse') : t('nav.staff.expand')}
          aria-expanded={isExpanded}
        >
          {isExpanded ? (
            <PanelLeftCloseIcon className="size-5" aria-hidden />
          ) : (
            <PanelLeftOpenIcon className="size-5" aria-hidden />
          )}
          <span className="truncate">
            {isExpanded ? t('nav.staff.collapse') : t('nav.staff.expand')}
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
