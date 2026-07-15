'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { isNavGroup, isNavItemActive, memberNavConfig, type NavItem } from '@/config/nav';
import { cn } from '@/lib/utils';

/**
 * MemberNav — desktop top-nav (057 redesign).
 *
 * Four destinations (Dashboard / Profile / Invoices / Benefits) with VISIBLE
 * text labels (no sr-only — review a11y-3). Active item gets `aria-current="page"`
 * for AT + a visual `bg-accent` highlight. Desktop-only: hidden below `lg`,
 * where the mobile bottom-tab bar (`MemberBottomTabs`) takes over.
 */
export function MemberNav() {
  const pathname = usePathname();
  const t = useTranslations();

  const items = memberNavConfig.sections
    .flatMap((section) => section.items)
    .filter((item): item is NavItem => !isNavGroup(item));

  return (
    <nav
      aria-label={t('nav.member.ariaLabel')}
      className="hidden items-center gap-1 lg:flex"
    >
      {items.map((item) => {
        const active = isNavItemActive(pathname, item.activePattern);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              // 063 UX — this nav sits on the navy top bar (bg-sidebar), so it
              // uses the SAME sidebar tokens the admin sidebar nav does: white
              // links, an accent pill (#2B5F92, white 6.7:1) on hover/active,
              // and a gold focus ring visible on navy. Active also goes
              // font-semibold + carries aria-current so it is non-colour-only
              // (WCAG 1.4.1). Never navy-on-navy.
              'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar',
              active && 'bg-sidebar-accent font-semibold text-sidebar-accent-foreground',
            )}
          >
            <item.icon className="size-4 shrink-0" aria-hidden />
            <span className="whitespace-nowrap">{t(item.titleKey)}</span>
          </Link>
        );
      })}
    </nav>
  );
}
