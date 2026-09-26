'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { BottomNav } from '@jirawatpyk/aura-react';

import { findActivePattern, memberBottomTabItems } from '@/config/nav';

/**
 * MemberBottomTabs — the phone tab bar (057 redesign), on AURA `BottomNav`
 * since spec 122 (the `Home-mobile` board).
 *
 * Five tabs (Dashboard / Profile / Invoices / Benefits / Account), hidden from
 * 1024px where the header nav + avatar menu take over. The board draws four;
 * Account stays because it is the phone's only way to the account hub
 * (FR-011: the same entries). AURA gives each tab an icon + visible label,
 * `aria-current="page"`, a 44px target, the home-indicator inset, and a spacer
 * so the page never sits under the bar. The label is the compact
 * `shortTitleKey` where one exists (TH strings in a 320px tab); the full
 * `titleKey` name is read instead when it contains the short one ("Konto" →
 * "Mitt konto"), so what is heard still includes what is seen (WCAG 2.5.3).
 */
export function MemberBottomTabs({ currentPath }: { readonly currentPath?: string } = {}) {
  // `currentPath` is for the preview harness; pages use the router's pathname.
  const routerPath = usePathname();
  const pathname = currentPath ?? routerPath;
  const t = useTranslations();
  const locale = useLocale();
  const active = findActivePattern(
    pathname,
    memberBottomTabItems.map((item) => item.activePattern),
  );

  return (
    <BottomNav
      label={t('nav.member.bottomTabsAriaLabel')}
      linkComponent={Link}
      value={memberBottomTabItems.find((item) => item.activePattern === active)?.href}
      items={memberBottomTabItems.map((item) => {
        const label = t(item.shortTitleKey ?? item.titleKey);
        const full = t(item.titleKey);
        const namesMore =
          full !== label && full.toLocaleLowerCase(locale).includes(label.toLocaleLowerCase(locale));
        return {
          id: item.href,
          label,
          ...(namesMore ? { ariaLabel: full } : {}),
          icon: <item.icon aria-hidden />,
          href: item.href,
        };
      })}
    />
  );
}
