'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { findActivePattern, isNavGroup, memberNavConfig, type NavItem } from '@/config/nav';
import { AURA_FOCUS_RING } from '@/components/shell/aura-classes';
import { cn } from '@/lib/utils';

/**
 * MemberNav — the desktop header nav (057 redesign), drawn as the pills of
 * the portal `Main` board since spec 122.
 *
 * Four destinations with VISIBLE labels. The current page carries
 * `aria-current="page"` and AURA's selected pill (tint + accent text + a
 * heavier weight, so it is never colour alone — WCAG 1.4.1). Hidden below
 * 1024px, where the bottom tab bar takes over.
 */
export function MemberNav({ currentPath }: { readonly currentPath?: string } = {}) {
  // `currentPath` is for the preview harness; pages use the router's pathname.
  const routerPath = usePathname();
  const pathname = currentPath ?? routerPath;
  const t = useTranslations();

  const items = memberNavConfig.sections
    .flatMap((section) => section.items)
    .filter((item): item is NavItem => !isNavGroup(item));
  const active = findActivePattern(
    pathname,
    items.map((item) => item.activePattern),
  );

  return (
    <nav aria-label={t('nav.member.ariaLabel')} className="hidden items-center gap-1 lg:flex">
      {items.map((item) => {
        const current = item.activePattern === active;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={current ? 'page' : undefined}
            className={cn(
              'flex h-10 items-center gap-2 rounded-full px-4 pointer-coarse:h-11 text-[13px] font-medium whitespace-nowrap no-underline transition-colors',
              current
                ? 'bg-[var(--aura-bg-selected)] font-semibold text-[var(--aura-fg-accent)]'
                : 'text-[var(--aura-fg-secondary)] hover:bg-[var(--aura-bg-surface-hover)] hover:text-[var(--aura-fg-primary)]',
              AURA_FOCUS_RING,
            )}
          >
            <item.icon className="size-4 shrink-0" aria-hidden />
            {t(item.titleKey)}
          </Link>
        );
      })}
    </nav>
  );
}
