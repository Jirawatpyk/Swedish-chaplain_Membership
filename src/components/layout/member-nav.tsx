'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { isNavGroup, isNavItemActive, memberNavConfig, type NavItem } from '@/config/nav';
import { cn } from '@/lib/utils';

export function MemberNav() {
  const pathname = usePathname();
  const t = useTranslations();

  const items = memberNavConfig.sections
    .flatMap((section) => section.items)
    .filter((item): item is NavItem => !isNavGroup(item));

  return (
    <nav aria-label={t('nav.member.ariaLabel')} className="flex items-center gap-1">
      {items.map((item) => {
        const active = isNavItemActive(pathname, item.activePattern);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-1.5 py-1.5 text-sm font-medium transition-colors sm:px-3',
              'hover:bg-accent hover:text-accent-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              active
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground',
            )}
          >
            <item.icon className="size-4 shrink-0" aria-hidden />
            {/* Hide text labels on mobile (< 640 px) to prevent the
                horizontal nav from overflowing a 320 px viewport.
                WCAG 2.5.3 (Label in Name): the icon receives
                aria-hidden and the Link's accessible name comes from
                the visually-hidden <span> via the sr-only fallback,
                so screen-reader users always hear the label. */}
            <span className="sr-only sm:not-sr-only sm:whitespace-nowrap">
              {t(item.titleKey)}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
