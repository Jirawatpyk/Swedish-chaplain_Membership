'use client';

import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { AppShell } from '@jirawatpyk/aura-react';

import { BreadcrumbNav } from '@/components/layout/breadcrumb-nav';
import { BreadcrumbProvider } from '@/components/layout/breadcrumb-provider';
import { StaffNav, type StaffNavProps } from '@/components/layout/staff-nav';
import { StaffTopBar, type StaffTopBarProps } from '@/components/layout/staff-top-bar';

/**
 * Spec 122 US1 — the staff frame: AURA `AppShell` with the staff `SideNav`
 * (fixed from 1024px, AURA's drawer below) and the top bar. The server layout
 * keeps every read (session, permissions, flags, badge counts, the rail
 * cookie) and hands this component plain props, because the nav config holds
 * icon functions that cannot cross the RSC boundary.
 *
 * `<main id="main-content">` is AppShell's own, so the root skip link still
 * lands on the page content.
 */
export interface StaffShellProps {
  readonly nav: Omit<StaffNavProps, 'onChange' | 'className' | 'collapsed' | 'collapsible'>;
  readonly user: StaffTopBarProps['user'];
  readonly topBarExtras?: ReactNode;
  readonly children: ReactNode;
}

export function StaffShell({ nav, user, topBarExtras, children }: StaffShellProps) {
  const t = useTranslations('nav.staff');
  const shellRef = useRef<HTMLDivElement>(null);

  // AppShell's <main> takes no tabIndex (AURA handoff #59), and the page
  // code focuses #main-content when the row it acted on leaves the list
  // (the user list, the change-request banner, the E-Blast bulk bar…).
  // `.focus()` is a no-op on a plain <main>, so give it the -1 the legacy
  // layout had.
  useLayoutEffect(() => {
    shellRef.current?.querySelector('main#main-content')?.setAttribute('tabindex', '-1');
  }, []);

  return (
    <BreadcrumbProvider>
      <AppShell
        ref={shellRef}
        className="chamber-shell"
        mainId="main-content"
        navLabel={t('ariaLabel')}
        nav={<StaffNav {...nav} />}
        header={<StaffTopBar tenantName={nav.tenantName} user={user} extras={topBarExtras} />}
      >
        {/* Below 1024px the bar has no room for the trail; it stays above the page. */}
        <div className="lg:hidden">
          <BreadcrumbNav />
        </div>
        {children}
      </AppShell>
    </BreadcrumbProvider>
  );
}
