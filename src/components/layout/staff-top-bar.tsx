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
  /** The page the trail names; defaults to the router's pathname (the preview harness sets it). */
  readonly currentPath?: string | undefined;
}

export function StaffTopBar({ tenantName, user, extras, currentPath }: StaffTopBarProps) {
  const t = useTranslations('shell.search');

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-3">
      {/* A size container: when the row is crowded (a phone with the outbox
          alert showing) the wordmark leaves the view rather than being cut to
          "SweCh…"; the link keeps it as its name. */}
      <div className="@container flex min-w-0 flex-1 items-center gap-3">
        <div className="hidden min-w-0 lg:block">
          <BreadcrumbNav pathname={currentPath} />
        </div>
        <Link
          href="/admin"
          className={cn('flex min-h-11 min-w-0 items-center gap-2 rounded-[var(--aura-radius-sm)] text-[var(--aura-fg-primary)] no-underline sm:gap-3 lg:hidden', AURA_FOCUS_RING)}
        >
          {/* The phone boards' 32px tile; the tablet board draws the desktop brand (40px tile, 20px wordmark, signal dot). */}
          <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--aura-radius-sm)] border border-[var(--aura-border-default)] bg-white p-1 sm:size-10 sm:rounded-[var(--aura-radius-md)] sm:p-[5px]">
            <BrandMark variant="mark" className="size-full" />
          </span>
          <span className="truncate font-[family-name:var(--font-display)] text-lg leading-none font-semibold tracking-[-0.01em] sm:text-xl @max-[8rem]:sr-only">
            {tenantName}
          </span>
          <span className="hidden size-2 shrink-0 rounded-full bg-[var(--aura-accent-dot)] sm:block" aria-hidden />
        </Link>
      </div>

      <button
        type="button"
        onClick={openCommandPalette}
        // strict-aria-ignore-next-line — key names, not text (ARIA spec syntax)
        aria-keyshortcuts="Meta+K Control+K"
        className={cn(
          'hidden h-9 pointer-coarse:h-11 w-[360px] min-w-0 shrink items-center gap-2 rounded-[var(--aura-radius-md)] border border-[var(--aura-border-control)] bg-[var(--aura-bg-input)] pr-2 pl-3 text-left text-[var(--aura-fg-tertiary)] xl:flex',
          AURA_FOCUS_RING,
        )}
      >
        <SearchIcon className="size-4 shrink-0" aria-hidden />
        {/* The name is the visible text + what the button does (WCAG 2.5.3).
            AURA's type class goes on the text, not the <button>: preflight's
            `font: inherit` on buttons outranks AURA's token layer. */}
        <span className="aura-text-table-cell min-w-0 flex-1 truncate">{t('placeholder')}</span>
        <span className="sr-only"> — {t('open')}</span>
        <kbd aria-hidden className="rounded-[var(--aura-radius-xs)] border border-[var(--aura-border-default)] px-1.5 leading-5 text-[var(--aura-fg-secondary)]">
          {/* inside: preflight sets a <kbd>'s size to 1em over AURA's token layer */}
          <span className="aura-text-pill-label font-mono">⌘K</span>
        </kbd>
      </button>
      <IconButton
        className="max-sm:size-11 xl:hidden"
        icon={<SearchIcon aria-hidden />}
        label={t('open')}
        onClick={openCommandPalette}
      />

      {extras}
      {/* The phone board's 44px pill, tighter so the row fits 390px. */}
      <LocaleSwitcher className="max-sm:h-11 max-sm:gap-1 max-sm:pr-2 max-sm:pl-3" />
      {/* The wrapper, not the button, so the menu's own box leaves the row too. */}
      <span className="contents max-sm:hidden">
        <ThemeToggle />
      </span>
      <UserMenu {...user} themeChoicesOnPhone />
    </div>
  );
}
