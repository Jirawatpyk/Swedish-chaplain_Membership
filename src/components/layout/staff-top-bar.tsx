'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { SearchIcon } from 'lucide-react';
import { IconButton } from '@jirawatpyk/aura-react';

import { BreadcrumbNav } from '@/components/layout/breadcrumb-nav';
import { openCommandPalette } from '@/components/command-palette/open-event';
import { AURA_FOCUS_RING } from '@/components/shell/aura-classes';
import { BrandMark } from '@/components/shell/brand-mark';
import { LocaleSwitcher } from '@/components/shell/locale-switcher';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { UserMenu, type UserMenuProps } from '@/components/shell/user-menu';
import { cn } from '@/lib/utils';

/**
 * Spec 122 US1 (T104) — the staff top bar, as `topbar()` on the boards:
 * breadcrumb on the left (the brand instead below 1024px, where the nav is
 * behind AppShell's menu button), then the palette search, language, colour
 * scheme and account menu. It renders inside AURA `AppShell`'s sticky bar.
 */
export interface StaffTopBarProps {
  readonly tenantName: string;
  readonly user: UserMenuProps;
  /** Server-rendered extras before the language pill (the outbox health badge). */
  readonly extras?: ReactNode;
}

export function StaffTopBar({ tenantName, user, extras }: StaffTopBarProps) {
  const t = useTranslations('shell.search');

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="hidden min-w-0 lg:block">
          <BreadcrumbNav placement="bar" />
        </div>
        <Link
          href="/admin"
          className="flex min-w-0 items-center gap-2 text-[var(--aura-fg-primary)] no-underline lg:hidden"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--aura-radius-sm)] border border-[var(--aura-border-default)] bg-white p-1">
            <BrandMark variant="mark" className="size-full" />
          </span>
          <span className="truncate font-[family-name:var(--font-display)] text-lg leading-none font-semibold tracking-[-0.01em]">
            {tenantName}
          </span>
        </Link>
      </div>

      <button
        type="button"
        onClick={openCommandPalette}
        aria-label={t('open')}
        aria-keyshortcuts="Meta+K Control+K"
        className={cn(
          'hidden h-9 w-[360px] min-w-0 shrink items-center gap-2 rounded-[var(--aura-radius-md)] border border-[var(--aura-border-control)] bg-[var(--aura-bg-input)] pr-2 pl-3 text-left text-[13px] text-[var(--aura-fg-tertiary)] xl:flex',
          AURA_FOCUS_RING,
        )}
      >
        <SearchIcon className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{t('placeholder')}</span>
        <kbd className="rounded-[var(--aura-radius-xs)] border border-[var(--aura-border-default)] px-1.5 font-mono text-[11px] leading-5 text-[var(--aura-fg-secondary)]">
          ⌘K
        </kbd>
      </button>
      <IconButton
        className="xl:hidden"
        icon={<SearchIcon aria-hidden />}
        label={t('open')}
        size="md"
        onClick={openCommandPalette}
      />

      {extras}
      <LocaleSwitcher />
      <ThemeToggle className="max-sm:hidden" />
      <UserMenu {...user} themeChoicesOnPhone />
    </div>
  );
}
