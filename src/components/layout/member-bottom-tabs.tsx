'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { isNavItemActive, memberBottomTabItems } from '@/config/nav';
import { cn } from '@/lib/utils';

/**
 * MemberBottomTabs — mobile bottom tab bar (057 redesign, spec §2/§7).
 *
 * Five tabs (Dashboard / Profile / Invoices / Benefits / Account) fixed to the
 * bottom of the viewport on viewports below `lg`; hidden at `lg` and up where
 * the desktop top-nav (`MemberNav`) + avatar Account menu take over.
 *
 * a11y (spec §7):
 *  - unique `<nav aria-label>` landmark
 *  - icon + VISIBLE short text label per tab (not sr-only — review a11y-3);
 *    the FULL label is the link's `aria-label` so AT never gets a truncated name
 *  - `aria-current="page"` on the active tab
 *  - touch targets ≥44px (`min-h/min-w-[44px]` — WCAG 2.5.8)
 *  - `env(safe-area-inset-bottom)` padding for the iPhone home-bar (review a11y-1);
 *    pairs with `viewport-fit=cover` set in the root layout's viewport export
 */
export function MemberBottomTabs() {
  const pathname = usePathname();
  const t = useTranslations();

  return (
    <nav
      aria-label={t('nav.member.bottomTabsAriaLabel')}
      className={cn(
        'fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background lg:hidden',
        'pb-[env(safe-area-inset-bottom)]',
      )}
    >
      <ul className="grid grid-cols-5">
        {memberBottomTabItems.map((item) => {
          const active = isNavItemActive(pathname, item.activePattern);
          const fullLabel = t(item.titleKey);
          const shortLabel = item.shortTitleKey ? t(item.shortTitleKey) : fullLabel;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-label={fullLabel}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-h-[44px] min-w-[44px] flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-xs font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                  active ? 'text-accent-foreground' : 'text-muted-foreground',
                )}
              >
                <item.icon className="size-5 shrink-0" aria-hidden />
                <span className="max-w-full truncate">{shortLabel}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
