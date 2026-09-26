import { notFound } from 'next/navigation';

import { TableContainer } from '@/components/layout';
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
  searchParams: Promise<{ rail?: string }>;
}) {
  if (!process.env.ALLOW_TEST_ROUTES) notFound();
  const { rail } = await searchParams;

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
