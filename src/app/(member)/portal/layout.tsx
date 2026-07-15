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
      {/* 063 UX — navy brand chrome matching the admin sidebar's Swedish-flag
          field. `bg-sidebar` (navy #10487A) + `text-sidebar-foreground` (white
          9:1) cascades white to every currentColor child (BrandMark, ghost
          control buttons, tenant wordmark); the 4px `--sidebar-flag` (#FECC02)
          bottom edge is the flag stripe (decorative — no text sits on it, so
          flag yellow never enters a contrast pairing). MemberNav carries its
          own sidebar-token variants for the same reason.
          `[--ring:var(--sidebar-ring)]` locally re-points the focus-ring token
          to the gold sidebar ring: the default `--ring` is navy (identical to
          `--sidebar`), so the shared ghost control buttons (ThemeToggle /
          LocaleSwitcher / UserMenu) would otherwise draw a navy-on-navy —
          invisible — focus indicator here (WCAG 2.4.7 / 1.4.11). Scoped to the
          header so the rest of the portal keeps its normal ring. */}
      <header className="flex h-[var(--top-bar-height)] items-center border-b-4 border-b-[color:var(--sidebar-flag)] bg-sidebar text-sidebar-foreground [--ring:var(--sidebar-ring)] px-[var(--page-padding-x)] gap-2">
        {/*
         * Mobile-first header layout (WCAG 2.1 1.4.4 reflow fix).
         *
         * Grid: left column takes whatever space is available after
         * the fixed-width right column. `min-w-0` on the left cell AND
         * on the brand Link lets the wordmark shrink/truncate so long
         * tenant names never force horizontal scroll at 320 px while
         * still showing IN FULL whenever there is room.
         *
         * The right column (LocaleSwitcher + ThemeToggle + UserMenu) is
         * always-visible at every width — 063 made ThemeToggle the sole
         * theme control (removed from the UserMenu dropdown), so it can
         * no longer be hidden on mobile the way it used to be.
         */}
        <div className="mx-auto grid w-full max-w-[var(--layout-max-width-detail)] grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
          <div className="flex min-w-0 items-center gap-2 sm:gap-4">
            <Link
              href="/portal"
              className="flex min-w-0 items-center gap-2"
            >
              {/* Brand: Interlocking Link mark + tenant wordmark. The mark is
                  decorative — the adjacent text names the portal. The Link is
                  `min-w-0` (shrinkable) + the wordmark `truncate`s, so the name
                  shows in FULL whenever there is room and only ellipsises on
                  the narrowest phones — no fixed `max-w` cap that clipped it
                  prematurely (063 fix). */}
              <BrandMark variant="mark" className="size-6 shrink-0" />
              <span className="text-body font-semibold tracking-tight truncate">
                {process.env.NEXT_PUBLIC_TENANT_NAME ?? 'SweCham'} · {tPortal('member')}
              </span>
            </Link>
            <MemberNav />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* LocaleSwitcher + ThemeToggle are BOTH always-visible at every
                width. 063 removed the Light/Dark/System items from the
                UserMenu dropdown (they duplicated this toggle), so this toggle
                is now the ONLY theme control — hiding it on mobile (the old
                `hidden sm:contents`) would leave a member with NO way to
                switch theme. */}
            <LocaleSwitcher persistToAccount />
            <ThemeToggle />
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
