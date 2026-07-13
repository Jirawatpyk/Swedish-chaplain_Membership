import type { ReactNode } from 'react';
import type { Viewport } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { IdleWarningDialog } from '@/components/auth/idle-warning-dialog';
import { MemberNav } from '@/components/layout/member-nav';
import { MemberBottomTabs } from '@/components/layout/member-bottom-tabs';
import { LocaleSwitcher } from '@/components/shell/locale-switcher';
import { MemberCommandPaletteRoot } from '@/components/shell/member-command-palette-root';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { UserMenu } from '@/components/shell/user-menu';
import { BrandMark } from '@/components/shell/brand-mark';
import { requireSession } from '@/lib/auth-session';
import { enforcePortalPageAccess } from '@/lib/portal-page-access';
import { MarketingAcknowledgementBanner } from './_components/marketing-acknowledgement-banner';

/**
 * Member shell layout (T144 / T024).
 *
 * Auth guard via `requireSession('member')` — redirects to
 * `/portal/sign-in` if there is no valid session. If a staff role
 * (admin/manager) somehow lands on `/portal/*`, we bounce them to
 * their own portal. Members stay.
 *
 * Renders the persistent header with horizontal MemberNav +
 * LocaleSwitcher + UserMenu + ThemeToggle.
 */

/**
 * `viewport-fit=cover` is scoped to the member portal only (NOT the root
 * layout — 057 review F3). It lets content extend under the iPhone home-bar
 * so the fixed member bottom-tab bar's `env(safe-area-inset-bottom)` padding
 * has room to push the tabs above the home indicator. Next.js resolves the
 * viewport per-segment, so admin/auth surfaces keep the default (no `cover`)
 * and their fixed-bottom UI (e.g. bulk-action-bar) keeps its safe-area inset.
 */
export const viewport: Viewport = {
  viewportFit: 'cover',
};

export default async function MemberLayout({ children }: { children: ReactNode }) {
  const session = await requireSession('member');
  const { user } = session;

  // Cross-portal guard: staff landed on a member route by accident.
  if (user.role === 'admin' || user.role === 'manager') {
    redirect('/admin');
  }

  // Task 7 (059-membership-suspension) — SSR-load defense-in-depth for the
  // terminated/suspended portal-scope gate. Runs AFTER the cross-portal
  // guard above (a staff account has no linked member). Next.js 16 does
  // NOT re-run this layout on client-side navigation between sibling
  // portal routes, so this only catches SSR load / refresh / direct nav —
  // the real, always-on enforcement is `requireMemberContext`
  // (`src/lib/member-context.ts`), which every `/api/portal/**` route
  // calls on every request. See `enforcePortalPageAccess` docstring.
  await enforcePortalPageAccess(session);

  const tPortal = await getTranslations('shell.portalLabel');

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-[var(--top-bar-height)] items-center border-b border-border bg-background px-[var(--page-padding-x)] gap-2">
        {/*
         * Mobile-first header layout (WCAG 2.1 1.4.4 reflow fix).
         *
         * Grid: left column takes whatever space is available after
         * the fixed-width right column. `min-w-0` on the left cell
         * lets content shrink below its intrinsic width so long
         * tenant names + icon nav never force horizontal scroll at
         * 320 px.
         *
         * Desktop (≥ 640 px): right column expands to include the
         * ThemeToggle (via `sm:contents` on its wrapper); the grid
         * max-width is capped at the detail layout token.
         *
         * LocaleSwitcher sits in the same right column but OUTSIDE the
         * `sm:contents` wrapper, so it stays always-visible at every
         * width — locale has no OS-level fallback the way color scheme
         * does for a hidden ThemeToggle.
         */}
        <div className="mx-auto grid w-full max-w-[var(--layout-max-width-detail)] grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
          <div className="flex min-w-0 items-center gap-2 sm:gap-4">
            <Link
              href="/portal"
              className="flex shrink-0 items-center gap-2"
            >
              {/* Brand: Interlocking Link mark + tenant wordmark. The mark is
                  decorative — the adjacent text names the portal. */}
              <BrandMark variant="mark" className="size-6 shrink-0" />
              <span className="text-body font-semibold tracking-tight max-w-[6rem] truncate sm:max-w-none">
                {process.env.NEXT_PUBLIC_TENANT_NAME ?? 'SweCham'} · {tPortal('member')}
              </span>
            </Link>
            <MemberNav />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* LocaleSwitcher is ALWAYS visible (even on mobile): unlike
                theme, locale has no OS fallback and no UserMenu entry, so a
                hidden switcher would strand a member in a language they can't
                read. ThemeToggle stays hidden < 640px (OS prefers-color-scheme
                is the mobile fallback). */}
            <LocaleSwitcher persistToAccount />
            <span className="hidden sm:contents">
              <ThemeToggle />
            </span>
            <UserMenu
              displayName={user.displayName}
              email={user.email}
              role={user.role}
            />
          </div>
        </div>
      </header>
      <main
        className="flex-1 pb-[calc(var(--bottom-tab-height)+env(safe-area-inset-bottom))] lg:pb-0"
        id="main-content"
        tabIndex={-1}
      >
        {/* F7 Q15 — GDPR Art. 7 demonstrable consent banner.
            Server component returns null when ineligible (member already
            acknowledged, plan has no eblast quota, or feature flag off). */}
        <MarketingAcknowledgementBanner />
        {children}
      </main>
      {/* 057 — mobile bottom tab bar (hidden ≥ lg). Fixed; <main> reserves
          equivalent padding-bottom above so it never obscures content. */}
      <MemberBottomTabs />
      {/* T165 — Idle warning modal fires at 29 min of inactivity. */}
      <IdleWarningDialog portal="member" />
      {/* T086 — ⌘K member command palette (Pay-invoice shortcut). */}
      <MemberCommandPaletteRoot />
    </div>
  );
}
