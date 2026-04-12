import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { IdleWarningDialog } from '@/components/auth/idle-warning-dialog';
import { CommandPaletteRoot } from '@/components/shell/command-palette-root';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { UserMenu } from '@/components/shell/user-menu';
import { StaffSidebar } from '@/components/layout/staff-sidebar';
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { requireSession } from '@/lib/auth-session';

/**
 * Staff shell layout (T075 / T016).
 *
 * Auth guard via `requireSession('staff')` — redirects to
 * `/admin/sign-in` if there is no valid session, or if the session
 * belongs to a non-staff role. Renders sidebar navigation with
 * collapsible sidebar + header with UserMenu + ThemeToggle.
 */
export default async function StaffLayout({ children }: { children: ReactNode }) {
  const { user } = await requireSession('staff');

  // RBAC guard at the layout level — members redirected to their portal.
  if (user.role === 'member') {
    const { redirect } = await import('next/navigation');
    redirect('/portal');
  }

  // Read sidebar cookie for SSR (prevents hydration CLS per FR-003).
  const cookieStore = await cookies();
  const sidebarCookie = cookieStore.get('sidebar_state');
  const defaultOpen = sidebarCookie ? sidebarCookie.value === 'true' : true;

  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <TooltipProvider>
        {/*
          T157 — Preconnect hint so the first ⌘K open can kick off the
          `/api/plans/search` fetch without paying a fresh DNS + TLS
          round-trip. React 19 hoists this <link> into <head>.
        */}
        <link rel="preconnect" href="/" crossOrigin="anonymous" />

        <StaffSidebar tenantName="SweCham" />

        <SidebarInset>
          <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-4">
            {/* Hamburger trigger — visible on mobile only (md:hidden is built into SidebarTrigger) */}
            <SidebarTrigger className="-ml-1 md:hidden" />
            <div className="flex flex-1 items-center justify-end gap-2">
              <ThemeToggle />
              <UserMenu
                displayName={user.displayName}
                email={user.email}
                role={user.role}
              />
            </div>
          </header>
          <main className="flex-1 px-4 py-6" id="main-content">
            {children}
          </main>
        </SidebarInset>

        {/* T165 — Idle warning modal fires at 29 min of inactivity. */}
        <IdleWarningDialog portal="staff" />
        {/* T156 — Command palette (⌘K / Ctrl+K) mounted once for all /admin/** routes. */}
        <CommandPaletteRoot />
      </TooltipProvider>
    </SidebarProvider>
  );
}
