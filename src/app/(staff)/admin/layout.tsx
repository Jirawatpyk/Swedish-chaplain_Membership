import type { ReactNode } from 'react';
import { Suspense } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { IdleWarningDialog } from '@/components/auth/idle-warning-dialog';
import { CommandPaletteRoot } from '@/components/shell/command-palette-root';
import { LocaleSwitcher } from '@/components/shell/locale-switcher';
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
import { env } from '@/lib/env';
import { staffNavAllowedHrefs } from '@/lib/nav-permissions';
import { readPendingChangeRequestsForNav } from '@/lib/pending-change-requests';
import { readEblastWaitingCountForNav } from '@/lib/eblast-waiting-count';
import { resolveTenantFromHeaders } from '@/lib/tenant-context';

/**
 * Staff shell layout (T075 / T016).
 *
 * Auth guard via `requireSession('staff')` — redirects to
 * `/admin/sign-in` if there is no valid session, or if the session
 * belongs to a non-staff role. Renders sidebar navigation with
 * collapsible sidebar + header with LocaleSwitcher + ThemeToggle + UserMenu.
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

  // F114 US6 (FR-033) — the change-request nav badge. Resolved HERE (the
  // sidebar is a client component: no `env`, no `canPerform`, no repo) and
  // passed across the RSC boundary as a plain href→count map. The helper
  // answers `hidden` without a query when the platform flag is OFF (FR-039)
  // or the viewer lacks `members.read`, and `unavailable` on a fault — both
  // render no badge, with one log line on the fault. One indexed count/min
  // query per render (research R12); no cache layer.
  //
  // NO `<Suspense>` here (PR-3 review, reliability R-H1): the count is not a
  // subtree this layout renders — it feeds `navBadgeCounts`, a prop of the
  // client `<StaffSidebar>`, and the nav config it belongs to carries Lucide
  // icon FUNCTIONS that cannot cross the RSC boundary, so the map must be
  // complete before the sidebar element is created. The read is TIME-BOXED
  // instead (`readPendingChangeRequestsForNav`, 1,500 ms): this layout renders
  // on EVERY `/admin/**` page and `src/lib/db.ts` bounds a pooled query at
  // `statement_timeout 5s` + `connect_timeout 3`, so an unbounded badge read
  // could add ~8 s to every staff page's TTFB for a number in the sidebar.
  const tenant = resolveTenantFromHeaders(await headers());
  // F119 T132 (FR-023) — the E-Blasts waiting on marketing, the same shape and
  // the same deadline as the change-request badge, read in parallel with it so
  // the two bounded reads cost one deadline, not two.
  const [pendingChanges, eblastWaiting] = await Promise.all([
    readPendingChangeRequestsForNav(tenant, user.role),
    readEblastWaitingCountForNav(tenant, user.role),
  ]);

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
          // 016 T063 — the sidebar is filtered by PERMISSION, resolved here
          // because a client component can read neither `env` nor `canPerform`.
          // Only the resulting hrefs cross the RSC boundary; the config itself
          // cannot (every item carries a LucideIcon, i.e. a function).
          allowedHrefs={staffNavAllowedHrefs(user.role)}
          // 016 — drop the Broadcasts/Events nav items when their feature
          // kill-switch is OFF, so the sidebar never shows a link that would
          // 503 (F7 proxy) / 404 (F6 `notFound()`) on click. Resolved here in
          // the server layout (the sidebar is a client component + can't read
          // `env`). Mirrors the same flags the proxy + pages already check.
          navVisibilityFlags={{
            broadcastsEnabled: env.features.f7Broadcasts,
            eventsEnabled: env.features.f6EventCreate,
            memberChangeApproval: env.features.memberChangeApproval,
            // #400 U2 — `ok` is exactly R18's "flag on, or a row in the
            // round" (the read answers `hidden`/flag_off otherwise). A failed
            // or timed-out read cannot show the round is visible, so the
            // Broadcasts link falls back to the plain queue.
            eblastApprovalRoundVisible: eblastWaiting.kind === 'ok',
          }}
          navBadgeCounts={{
            // `hidden` and `unavailable` are both "no badge" here — a count we
            // do not have is never rendered as a zero the nav would hide anyway.
            '/admin/change-requests': pendingChanges.kind === 'ok' ? pendingChanges.summary.count : 0,
            '/admin/broadcasts': eblastWaiting.kind === 'ok' ? eblastWaiting.count : 0,
          }}
        />

        <SidebarInset>
          <header className="flex h-[var(--top-bar-height)] shrink-0 items-center gap-2 border-b border-border bg-background px-[var(--page-padding-x)]">
            {/* Hamburger trigger — visible on mobile only (md:hidden is built into SidebarTrigger) */}
            <SidebarTrigger className="-ml-1 md:hidden" />
            <div className="flex flex-1 items-center justify-end gap-2">
              <Suspense fallback={null}>
                <OutboxHealthBadge />
              </Suspense>
              <LocaleSwitcher />
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
