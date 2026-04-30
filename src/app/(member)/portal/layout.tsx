import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { IdleWarningDialog } from '@/components/auth/idle-warning-dialog';
import { MemberNav } from '@/components/layout/member-nav';
import { MemberCommandPaletteRoot } from '@/components/shell/member-command-palette-root';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { UserMenu } from '@/components/shell/user-menu';
import { requireSession } from '@/lib/auth-session';
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
 * UserMenu + ThemeToggle.
 */
export default async function MemberLayout({ children }: { children: ReactNode }) {
  const { user } = await requireSession('member');

  // Cross-portal guard: staff landed on a member route by accident.
  if (user.role === 'admin' || user.role === 'manager') {
    redirect('/admin');
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-[var(--top-bar-height)] items-center border-b border-border bg-background px-[var(--page-padding-x)] gap-2">
        <div className="mx-auto w-full max-w-[var(--layout-max-width-detail)] flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Link href="/portal" className="text-body font-semibold tracking-tight">
              {process.env.NEXT_PUBLIC_TENANT_NAME ?? 'SweCham'} · Member
            </Link>
            <MemberNav />
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <UserMenu
              displayName={user.displayName}
              email={user.email}
              role={user.role}
            />
          </div>
        </div>
      </header>
      <main className="flex-1" id="main-content">
        {/* F7 Q15 — GDPR Art. 7 demonstrable consent banner.
            Server component returns null when ineligible (member already
            acknowledged, plan has no eblast quota, or feature flag off). */}
        <MarketingAcknowledgementBanner />
        {children}
      </main>
      {/* T165 — Idle warning modal fires at 29 min of inactivity. */}
      <IdleWarningDialog portal="member" />
      {/* T086 — ⌘K member command palette (Pay-invoice shortcut). */}
      <MemberCommandPaletteRoot />
    </div>
  );
}
