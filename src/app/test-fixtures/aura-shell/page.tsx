import { notFound } from 'next/navigation';

import { DetailContainer, TableContainer } from '@/components/layout';
import { MemberBottomTabs } from '@/components/layout/member-bottom-tabs';
import { MemberHeader } from '@/components/layout/member-header';
import { PageHeader } from '@/components/layout/page-header';
import { StaffShell } from '@/components/layout/staff-shell';
import { flattenNavItems, staffNavConfig } from '@/config/nav';

// Request-time evaluation so the guard runs per request (see button-matrix).
export const dynamic = 'force-dynamic';

/**
 * Spec 122 US1 (T102) — the AURA shells with fixture data, no session and no
 * DB, so they can be screenshot at 390 / 1280 in light and dark and compared
 * with the canvas boards (`Admin-members`, `Admin-members-tablet`,
 * `Admin-members-mobile`, the portal `Main` boards).
 *
 * Reachable only with `ALLOW_TEST_ROUTES=1` (never set on Vercel), exactly
 * like `/test-fixtures/button-matrix`. Every value below is invented.
 */
export default async function AuraShellPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ rail?: string; view?: string }>;
}) {
  if (!process.env.ALLOW_TEST_ROUTES) notFound();
  const { rail, view } = await searchParams;

  if (view === 'member') {
    // The member frame as the portal layout composes it (header, main, tab bar).
    return (
      <div className="chamber-shell flex min-h-screen flex-col">
        <header className="sticky top-0 z-10 border-b border-[var(--aura-border-default)] bg-[var(--aura-bg-surface)]">
          <MemberHeader
            tenantName="SweCham"
            user={{ displayName: 'Anna Lindqvist', email: 'anna@example.com', role: 'member' }}
            currentPath="/portal"
          />
        </header>
        <main className="flex-1" id="main-content" tabIndex={-1}>
          <DetailContainer>
            <PageHeader title="Hi Anna" subtitle="Here's your membership at a glance." />
            <p className="text-body text-muted-foreground">Page content.</p>
          </DetailContainer>
        </main>
        <MemberBottomTabs currentPath="/portal" />
      </div>
    );
  }

  return (
    <StaffShell
      nav={{
        tenantName: 'SweCham',
        allowedHrefs: flattenNavItems(staffNavConfig).map((item) => item.href),
        navVisibilityFlags: { broadcastsEnabled: true, eventsEnabled: true, memberChangeApproval: true },
        navBadgeCounts: { '/admin/change-requests': 3 },
        currentPath: '/admin/members',
        defaultCollapsed: rail === '1',
      }}
      user={{ displayName: 'Malin Berg', email: 'malin.berg@example.com', role: 'admin' }}
    >
      <TableContainer>
        <PageHeader title="Members" subtitle="Member companies + primary contacts" />
        <p className="text-body text-muted-foreground">Page content.</p>
      </TableContainer>
    </StaffShell>
  );
}
