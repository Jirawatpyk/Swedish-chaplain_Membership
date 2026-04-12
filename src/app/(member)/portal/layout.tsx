import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { IdleWarningDialog } from '@/components/auth/idle-warning-dialog';
import { MemberNav } from '@/components/layout/member-nav';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { UserMenu } from '@/components/shell/user-menu';
import { requireSession } from '@/lib/auth-session';

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
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-4">
            <Link href="/portal" className="text-sm font-semibold tracking-tight">
              SweCham · Member
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
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6" id="main-content">{children}</main>
      {/* T165 — Idle warning modal fires at 29 min of inactivity. */}
      <IdleWarningDialog portal="member" />
    </div>
  );
}
