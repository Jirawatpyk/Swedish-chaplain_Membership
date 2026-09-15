'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronRightIcon } from 'lucide-react';

import { isNavGroup, isNavItemActive, type NavGroup, type NavItem } from '@/config/nav';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from '@/components/ui/sidebar';

// ---------------------------------------------------------------------------
// Flat NavItem renderer
// ---------------------------------------------------------------------------

function NavItemLink({ item }: { readonly item: NavItem }) {
  const pathname = usePathname();
  const t = useTranslations();
  const { isMobile, setOpenMobile } = useSidebar();
  const active = isNavItemActive(pathname, item.activePattern);
  const title = t(item.titleKey);
  const badgeCount = typeof item.badgeCount === 'number' && item.badgeCount > 0 ? item.badgeCount : null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        render={
          <Link
            href={item.href}
            onClick={() => {
              if (isMobile) setOpenMobile(false);
            }}
          />
        }
        isActive={active}
        // The icon rail hides the badge, so the count rides the tooltip there
        // ("Change requests (3)") — the rail still signals (UX L3).
        tooltip={badgeCount !== null ? t('nav.staff.badgeTooltip', { title, count: badgeCount }) : title}
      >
        <item.icon className="size-5 shrink-0" aria-hidden />
        <span className="truncate">{title}</span>
        {/* F114 US6 (FR-033) — server-resolved count INSIDE the link so it is
            part of the accessible name ("Change requests 3 pending"): the
            visible number + an sr-only noun from `badgeLabelKey`. Not
            `SidebarMenuBadge` (a sibling outside the link — never announced
            with it) and no aria-label on a span (axe aria-prohibited-attr).
            Hidden in the icon rail like the primitive's own badge (the
            tooltip carries the count there). The explicit `{' '}` keeps a
            space in the computed name — flex swallows it visually. */}
        {badgeCount !== null ? (
          <>
            {' '}
            <span className="ml-auto flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md bg-sidebar-primary px-1 text-xs font-medium tabular-nums text-sidebar-primary-foreground group-data-[collapsible=icon]:hidden">
              {badgeCount}
              {item.badgeLabelKey ? (
                <span className="sr-only"> {t(item.badgeLabelKey, { count: badgeCount })}</span>
              ) : null}
            </span>
          </>
        ) : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

// ---------------------------------------------------------------------------
// NavGroup renderer (expandable collapsible group)
// ---------------------------------------------------------------------------

function NavGroupCollapsible({ group }: { readonly group: NavGroup }) {
  const pathname = usePathname();
  const t = useTranslations();
  const { isMobile, setOpenMobile } = useSidebar();

  // Auto-expand when any child is active
  const anyChildActive = group.children.some((child) =>
    isNavItemActive(pathname, child.activePattern),
  );
  const groupActive = isNavItemActive(pathname, group.activePattern);

  // Controlled open state — auto-opens when a child route becomes active.
  // Derives from pathname on every render; user can still manually collapse.
  const shouldOpen = anyChildActive || groupActive;
  const [open, setOpen] = useState(shouldOpen);
  // Re-open on client-side navigation without useEffect (sync derived state)
  if (shouldOpen && !open) {
    setOpen(true);
  }

  // Single-child group renders as flat link (uses group icon)
  if (group.children.length === 1) {
    const child = group.children[0]!;
    return <NavItemLink item={{ ...child, icon: group.icon }} />;
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="group/collapsible">
      <SidebarMenuItem>
        <CollapsibleTrigger
          render={
            <SidebarMenuButton
              tooltip={t(group.titleKey)}
              isActive={groupActive && !anyChildActive}
            />
          }
        >
          <group.icon className="size-5 shrink-0" aria-hidden />
          <span className="truncate">{t(group.titleKey)}</span>
          <ChevronRightIcon className="ml-auto size-4 transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {group.children.map((child) => {
              const childActive = isNavItemActive(pathname, child.activePattern);
              return (
                <SidebarMenuSubItem key={child.href}>
                  <SidebarMenuSubButton
                    render={
                      <Link
                        href={child.href}
                        onClick={() => {
                          if (isMobile) setOpenMobile(false);
                        }}
                      />
                    }
                    isActive={childActive}
                  >
                    <child.icon className="size-4 shrink-0" aria-hidden />
                    <span className="truncate">{t(child.titleKey)}</span>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              );
            })}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// Public — renders either NavItem or NavGroup
// ---------------------------------------------------------------------------

export function NavEntry({ item }: { readonly item: NavItem | NavGroup }) {
  if (isNavGroup(item)) {
    return <NavGroupCollapsible group={item} />;
  }
  return <NavItemLink item={item} />;
}
