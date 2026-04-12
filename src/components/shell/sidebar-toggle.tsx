'use client';

import { PanelLeftCloseIcon, PanelLeftOpenIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  useSidebar,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenu,
} from '@/components/ui/sidebar';

export function SidebarToggle() {
  const { state, toggleSidebar } = useSidebar();
  const t = useTranslations();
  const isExpanded = state === 'expanded';
  const label = isExpanded ? t('nav.staff.collapse') : t('nav.staff.expand');
  const Icon = isExpanded ? PanelLeftCloseIcon : PanelLeftOpenIcon;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          onClick={toggleSidebar}
          tooltip={label}
          aria-label={label}
        >
          <Icon className="size-5" aria-hidden />
          <span className="truncate">{label}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
