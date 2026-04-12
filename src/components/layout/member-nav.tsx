'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { isNavItemActive, memberNavConfig, type NavItem } from '@/config/nav';
import { cn } from '@/lib/utils';

export function MemberNav() {
  const pathname = usePathname();
  const t = useTranslations();

  // Flatten all items from all sections
  const items: readonly NavItem[] = memberNavConfig.sections.flatMap(
    (section) => section.items as readonly NavItem[],
  );

  return (
    <nav aria-label={t('nav.member.ariaLabel')} className="flex items-center gap-1">
      {items.map((item) => {
        const active = isNavItemActive(pathname, item.activePattern);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              'hover:bg-accent hover:text-accent-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              active
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground',
            )}
          >
            <item.icon className="size-4 shrink-0" aria-hidden />
            <span>{t(item.titleKey)}</span>
          </Link>
        );
      })}
    </nav>
  );
}
