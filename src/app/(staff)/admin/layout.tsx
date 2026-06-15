import type { ReactNode } from 'react';
import { Suspense } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { IdleWarningDialog } from '@/components/auth/idle-warning-dialog';
import { CommandPaletteRoot } from '@/components/shell/command-palette-root';
import { OutboxHealthBadge } from '@/components/shell/outbox-health-badge';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { UserMenu } from '@/components/shell/user-menu';
import { BreadcrumbNav } from '@/components/layout/breadcrumb-nav';
import { BreadcrumbProvider } from '@/components/layout/breadcrumb-provider';
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

        {/* TODO: resolve tenant name from session context when F10 ships (MTA+STD) */}
        <StaffSidebar
          tenantName={process.env.NEXT_PUBLIC_TENANT_NAME ?? 'SweCham'}
          role={user.role}
        />

        <SidebarInset>
          <header className="flex h-[var(--top-bar-height)] shrink-0 items-center gap-2 border-b border-border bg-background px-[var(--page-padding-x)]">
            {/* Hamburger trigger — visible on mobile only (md:hidden is built into SidebarTrigger) */}
            <SidebarTrigger className="-ml-1 md:hidden" />
            <div className="flex flex-1 items-center justify-end gap-2">
              <Suspense fallback={null}>
                <OutboxHealthBadge />
              </Suspense>
              <ThemeToggle />
              <UserMenu
                displayName={user.displayName}
                email={user.email}
                role={user.role}
              />
            </div>
          </header>
          <BreadcrumbProvider>
            <BreadcrumbNav />
            <main className="flex-1" id="main-content" tabIndex={-1}>
              {children}
            </main>
          </BreadcrumbProvider>
        </SidebarInset>

        {/* T165 — Idle warning modal fires at 29 min of inactivity. */}
        <IdleWarningDialog portal="staff" />
        {/* T156 — Command palette (⌘K / Ctrl+K) mounted once for all /admin/** routes. */}
        <CommandPaletteRoot />
      </TooltipProvider>
    </SidebarProvider>
  );
}
