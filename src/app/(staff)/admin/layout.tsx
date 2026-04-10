import type { ReactNode } from 'react';
import Link from 'next/link';
import { IdleWarningDialog } from '@/components/auth/idle-warning-dialog';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { UserMenu } from '@/components/shell/user-menu';
import { requireSession } from '@/lib/auth-session';

/**
 * Staff shell layout (T075).
 *
 * Auth guard via `requireSession('staff')` — redirects to
 * `/admin/sign-in` if there is no valid session, or if the session
 * belongs to a non-staff role. Renders the persistent header with
 * UserMenu + ThemeToggle.
 */
export default async function StaffLayout({ children }: { children: ReactNode }) {
  const { user } = await requireSession('staff');

  // RBAC guard at the layout level — members redirected to their portal.
  if (user.role === 'member') {
    // requireSession was OK because the session itself is valid; the
    // redirect happens here so the user lands on the right portal.
    const { redirect } = await import('next/navigation');
    redirect('/portal');
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <Link href="/admin" className="text-sm font-semibold tracking-tight">
            SweCham · Staff
          </Link>
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
      <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</div>
      {/* T165 — Idle warning modal fires at 29 min of inactivity. */}
      <IdleWarningDialog portal="staff" />
    </div>
  );
}
