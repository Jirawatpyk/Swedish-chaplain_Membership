'use client';

import type { ReactElement, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { PanelLeftCloseIcon, PanelLeftOpenIcon, SettingsIcon } from 'lucide-react';
import { Badge, SideNav, type NavItem as AuraNavItem } from '@jirawatpyk/aura-react';

import {
  applyNavBadges,
  filterNavConfig,
  findActivePattern,
  isNavGroup,
  staffNavConfig,
  type NavBadgeCounts,
  type NavVisibilityFlags,
  type RenderedNavConfig,
  type RenderedNavGroup,
  type RenderedNavItem,
} from '@/config/nav';
import { AURA_FOCUS_RING } from '@/components/shell/aura-classes';
import { BrandMark } from '@/components/shell/brand-mark';
import { SIDEBAR_COOKIE, SIDEBAR_COOKIE_MAX_AGE } from '@/components/layout/sidebar-cookie';
import { cn } from '@/lib/utils';

/**
 * Spec 122 US1 (T103) — the staff navigation on AURA `SideNav`, laid out as
 * the `Admin-members` board: brand + "Staff" badge on top, titled sections,
 * Settings folded into one group, the collapse toggle at the bottom.
 *
 * Nothing about WHICH entries show changes (FR-011): the server layout still
 * resolves permissions, feature flags and badge counts, and this file only
 * maps the filtered config onto AURA's `NavItem`s.
 */


/**
 * Sections shown as ONE collapsible group rather than a titled list — the
 * board's Settings entry. The group opens by itself on any of its routes.
 */
const GROUPED_SECTIONS: Readonly<Record<string, ReactElement>> = {
  'nav.staff.sections.settings': <SettingsIcon aria-hidden />,
};

type Translate = ReturnType<typeof useTranslations>;

function itemId(item: RenderedNavItem): string {
  return item.href;
}

/**
 * The count stays INSIDE the link so it is part of its accessible name
 * ("Change requests 3 pending", F114 US6 B2): the visible number plus an
 * sr-only noun from the item's `badge` declaration. The leading space keeps
 * the name from reading "Change requests3". A count with no declaration, or a
 * count of 0, renders nothing.
 */
function badgeNode(item: RenderedNavItem, t: Translate): ReactNode {
  const count = item.badgeCount;
  if (item.badge === undefined || typeof count !== 'number' || count <= 0) return undefined;
  return (
    <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--aura-status-progress-bg)] px-1.5 text-[11px] font-semibold tabular-nums text-[var(--aura-status-progress-fg)]">
      {' '}
      {count}
      <span className="sr-only"> {t(item.badge.labelKey, { count })}</span>
    </span>
  );
}

function toAuraItem(item: RenderedNavItem, t: Translate): AuraNavItem {
  return {
    id: itemId(item),
    label: t(item.titleKey),
    icon: <item.icon aria-hidden />,
    href: item.linkHref ?? item.href,
    badge: badgeNode(item, t),
  };
}

function toAuraEntry(entry: RenderedNavItem | RenderedNavGroup, t: Translate): AuraNavItem {
  if (!isNavGroup(entry)) return toAuraItem(entry, t);
  // A group with one child is just that link, under the group's icon.
  if (entry.children.length === 1) return toAuraItem({ ...entry.children[0]!, icon: entry.icon }, t);
  return {
    id: `group:${entry.titleKey}`,
    label: t(entry.titleKey),
    icon: <entry.icon aria-hidden />,
    children: entry.children.map((child) => toAuraItem(child, t)),
  };
}

export interface StaffNavSections {
  readonly sections: Array<{ title?: string; items: AuraNavItem[] }>;
  /** The id of the current page's entry: the most specific pattern that matches. */
  readonly value: string | undefined;
}

export function toStaffNavSections(config: RenderedNavConfig, pathname: string, t: Translate): StaffNavSections {
  const sections: StaffNavSections['sections'] = [];
  const patterns = new Map<string, string>();
  for (const section of config.sections) {
    const items = section.items.map((entry) => toAuraEntry(entry, t));
    for (const entry of section.items) {
      for (const leaf of isNavGroup(entry) ? entry.children : [entry]) patterns.set(leaf.activePattern, itemId(leaf));
    }
    const groupIcon = section.titleKey ? GROUPED_SECTIONS[section.titleKey] : undefined;
    if (section.titleKey && groupIcon) {
      sections.push({ items: [{ id: `section:${section.titleKey}`, label: t(section.titleKey), icon: groupIcon, children: items }] });
    } else {
      sections.push({ ...(section.titleKey ? { title: t(section.titleKey) } : {}), items });
    }
  }
  const active = findActivePattern(pathname, [...patterns.keys()]);
  return { sections, value: active === null ? undefined : patterns.get(active) };
}

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
  );
}

function writeSidebarCookie(expanded: boolean) {
  document.cookie = `${SIDEBAR_COOKIE}=${expanded}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}; samesite=lax`;
}

/**
 * The labelled "Collapse sidebar" row at the bottom of the board, in place of
 * AURA's icon-only toggle (the same AURA strings, so it still reads "Expand
 * sidebar" in the rail). It reuses AURA's nav-item styling.
 */
function RailToggle({ collapsed, onToggle }: { readonly collapsed: boolean; readonly onToggle: () => void }) {
  const t = useTranslations('nav.staff');
  const label = collapsed ? t('expand') : t('collapse');
  const Icon = collapsed ? PanelLeftOpenIcon : PanelLeftCloseIcon;
  return (
    <button type="button" className="aura-nav__item w-full" aria-label={label} onClick={onToggle}>
      <span className="aura-icon" aria-hidden>
        <Icon className="size-4" />
      </span>
      {collapsed ? null : <span className="aura-nav__label">{label}</span>}
    </button>
  );
}

function StaffBrand({ tenantName, collapsed }: { readonly tenantName: string; readonly collapsed: boolean }) {
  const t = useTranslations('shell.portalLabel');
  return (
    // Wraps: where the portal badge is long (SV "Personal", TH) it drops to a
    // second line rather than cutting the wordmark to "SweC…" in the 240px nav.
    <div className="flex flex-wrap items-center justify-between gap-x-1.5 gap-y-1">
      <Link
        href="/admin"
        className={cn(
          'flex min-h-11 min-w-0 items-center gap-2 rounded-[var(--aura-radius-md)] text-[var(--aura-fg-primary)] no-underline',
          AURA_FOCUS_RING,
        )}
      >
        {/* The mark sits on a white tile in both themes so the flag blue keeps its contrast. */}
        <span className="flex size-10 shrink-0 items-center justify-center rounded-[var(--aura-radius-md)] border border-[var(--aura-border-default)] bg-white p-[5px]">
          <BrandMark variant="mark" className="size-full" />
        </span>
        {collapsed ? (
          <span className="sr-only">{tenantName}</span>
        ) : (
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate font-[family-name:var(--font-display)] text-xl leading-none font-semibold tracking-[-0.01em]">
              {tenantName}
            </span>
            {/* AURA's signal dot beside the wordmark, as on the boards (decorative). */}
            <span className="size-2 shrink-0 rounded-full bg-[var(--aura-accent-dot)]" aria-hidden />
          </span>
        )}
      </Link>
      {collapsed ? null : (
        <Badge variant="outline" className="ms-auto">
          {t('staff')}
        </Badge>
      )}
    </div>
  );
}

export interface StaffNavProps {
  readonly tenantName: string;
  /** hrefs this viewer may open, from `staffNavAllowedHrefs` in the server layout. Fails closed when empty. */
  readonly allowedHrefs: readonly string[];
  readonly navVisibilityFlags?: NavVisibilityFlags;
  readonly navBadgeCounts?: NavBadgeCounts;
  /** The rail state read from the `sidebar_state` cookie on the server (no layout shift on load). */
  readonly defaultCollapsed?: boolean;
  /** The page to mark current; defaults to the router's pathname (the preview harness sets it). */
  readonly currentPath?: string;
  // Set by AURA `AppShell` when it clones this nav into its phone drawer.
  readonly onChange?: (id: string) => void;
  readonly className?: string;
  readonly collapsed?: boolean;
  readonly collapsible?: boolean;
}

export function StaffNav({
  tenantName,
  allowedHrefs,
  navVisibilityFlags = {},
  navBadgeCounts,
  defaultCollapsed = false,
  currentPath,
  onChange,
  className,
  collapsed: forcedCollapsed,
  collapsible = true,
}: StaffNavProps) {
  const t = useTranslations();
  const routerPath = usePathname();
  const pathname = currentPath ?? routerPath;
  const [railCollapsed, setRailCollapsed] = useState(defaultCollapsed);
  // AppShell's drawer passes `collapsed={false}` + `collapsible={false}`: the
  // drawer is always full width and must not rewrite the desktop choice.
  const collapsed = forcedCollapsed ?? railCollapsed;

  const visible = filterNavConfig(staffNavConfig, navVisibilityFlags, new Set(allowedHrefs));
  const rendered = navBadgeCounts ? applyNavBadges(visible, navBadgeCounts) : visible;
  const { sections, value } = toStaffNavSections(rendered, pathname, t);

  const setCollapsed = (next: boolean) => {
    setRailCollapsed(next);
    writeSidebarCookie(!next);
  };

  // ⌘B / Ctrl+B toggles the rail, as the legacy sidebar did — except while
  // typing, where it is the editor's Bold.
  useEffect(() => {
    if (!collapsible) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'b') return;
      if (isEditable(event.target)) return;
      event.preventDefault();
      setRailCollapsed((prev) => {
        writeSidebarCookie(prev);
        return !prev;
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [collapsible]);

  return (
    <SideNav
      label={t('nav.staff.ariaLabel')}
      sections={sections}
      value={value}
      linkComponent={Link}
      header={<StaffBrand tenantName={tenantName} collapsed={collapsed} />}
      footer={collapsible ? <RailToggle collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} /> : undefined}
      collapsed={collapsed}
      // A group clicked in the rail asks to expand it (AURA calls this with `false`).
      onCollapsedChange={setCollapsed}
      {...(onChange ? { onChange } : {})}
      // `staff-nav` reaches the drawer copy too, which AURA portals out of the shell.
      className={className ? `staff-nav ${className}` : 'staff-nav'}
    />
  );
}
