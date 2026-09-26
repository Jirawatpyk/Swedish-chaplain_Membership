'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { MemberNav } from '@/components/layout/member-nav';
import { BrandMark } from '@/components/shell/brand-mark';
import { LocaleSwitcher } from '@/components/shell/locale-switcher';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { UserMenu, type UserMenuProps } from '@/components/shell/user-menu';

/**
 * Spec 122 US1 (T105) — the member portal header row, as `desktop_header()`
 * on the portal boards: brand (mark tile, display-face wordmark, AURA's
 * signal dot), the pill nav from 1024px, then language, colour scheme and
 * the account menu.
 *
 * The language pill stays on phones although the `Home-mobile` board drops
 * it: members pick the language their emails use there (`persistToAccount`),
 * and the header is its only place. The colour-scheme button stays too — it
 * is the portal's only theme control (063).
 */
export function MemberHeader({
  tenantName,
  user,
  currentPath,
}: {
  readonly tenantName: string;
  readonly user: UserMenuProps;
  /** For the preview harness; pages use the router's pathname. */
  readonly currentPath?: string;
}) {
  const tPortal = useTranslations('shell.portalLabel');
  return (
    <div className="flex h-16 items-center gap-2 px-4 sm:gap-3 md:px-6 lg:h-[72px] lg:px-10">
      <div className="flex min-w-0 flex-1 items-center gap-6">
        <Link href="/portal" className="flex min-w-0 items-center gap-3 text-[var(--aura-fg-primary)] no-underline">
          {/* The mark sits on a white tile in both themes so the flag blue keeps its contrast. */}
          <span className="flex size-10 shrink-0 items-center justify-center rounded-[var(--aura-radius-md)] border border-[var(--aura-border-default)] bg-white p-[5px]">
            <BrandMark variant="mark" className="size-full" />
          </span>
          <span className="truncate font-[family-name:var(--font-display)] text-xl leading-none font-semibold tracking-[-0.01em] lg:text-[22px]">
            {tenantName}
          </span>
          {/* The portal name is read with the brand ("SweCham · Member"). */}
          <span className="sr-only"> · {tPortal('member')}</span>
          <span className="size-2 shrink-0 rounded-full bg-[var(--aura-accent-dot)]" aria-hidden />
        </Link>
        <MemberNav {...(currentPath ? { currentPath } : {})} />
      </div>
      <LocaleSwitcher persistToAccount />
      <ThemeToggle />
      <UserMenu {...user} />
    </div>
  );
}
