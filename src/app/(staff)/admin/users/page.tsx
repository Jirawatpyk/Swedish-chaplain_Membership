/**
 * Admin users list page (T135) at URL `/admin/users`.
 *
 * Server component with **Suspense streaming** (F4 best-practice upgrade):
 * the page shell — `<PageHeader>`, `<Card>` chrome — renders instantly
 * off the fast `requireSession` + `getTranslations` calls, while the
 * table body (which depends on a 50-row DB fetch + count) streams in
 * behind a `<TableSkeleton>` fallback. Zero CLS because the skeleton
 * row count and column widths match the real table grid.
 *
 * RBAC: action enablement inside `<UserListTable>` is gated by the
 * admin role via the staff-shell auth guard (requireSession); the API
 * route layer re-validates via `requireRole`.
 *
 * Pagination: capped at 50 per page; proper paginated query surface is
 * a documented F9 follow-up.
 */
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { requireSession } from '@/lib/auth-session';
// Admin user list page (server component) reads directly from the
// repo. An Application-layer `listUsers` use case would be a
// near-identical passthrough and add no behaviour; this read is
// admin-gated by the route guard in layout.tsx. F9 polish may add
// a paginated query surface — until then this escape hatch is the
// documented path.
// eslint-disable-next-line no-restricted-imports
import { userRepo } from '@/modules/auth/infrastructure/db/user-repo';
import type { Role } from '@/modules/auth';
import { UserListTable } from '@/components/auth/user-list-table';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ContentContainer } from '@/components/layout/content-container';
import { PageHeader } from '@/components/layout/page-header';

export async function generateMetadata(): Promise<Metadata> {
  return { title: 'Users · SweCham' };
}

export default async function AdminUsersPage() {
  const { user: currentUser } = await requireSession('staff');
  const t = await getTranslations('admin.users');

  return (
    <ContentContainer>
      <PageHeader
        title={t('title')}
        subtitle={t('pageSubtitle')}
        actions={
          <Badge variant="secondary">
            {t('viewingAs', { role: currentUser.role })}
          </Badge>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>{t('listHeading')}</CardTitle>
          <CardDescription>{t('listDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {/*
            No internal <Suspense> — route-level loading.tsx is the only
            Suspense boundary. Double-wrapping caused the skeleton
            shimmer to re-run when the outer boundary swapped into the
            inner one.
          */}
          <UsersDataSection
            currentUserId={currentUser.id}
            currentUserRole={currentUser.role}
          />
        </CardContent>
      </Card>
    </ContentContainer>
  );
}

/**
 * Async data section — awaited directly at the JSX site. The
 * route-level `loading.tsx` is the sole Suspense boundary, so this
 * component does NOT need its own `<Suspense>` wrapper (double-wrapping
 * produced a visible two-pass shimmer during navigation). Fetches run
 * in parallel via `Promise.all` to keep the data tier off the critical
 * path.
 */
async function UsersDataSection({
  currentUserId,
  currentUserRole,
}: {
  currentUserId: string;
  currentUserRole: Role;
}) {
  const [users, total] = await Promise.all([
    userRepo.list(50, 0),
    userRepo.countAll(),
  ]);
  const t = await getTranslations('admin.users');

  return (
    <div className="flex flex-col gap-3">
      <p className="text-caption text-muted-foreground">
        {t('subtitle', { total })}
      </p>
      <UserListTable
        users={users.map((u) => ({
          id: u.id,
          email: u.email,
          role: u.role,
          status: u.status,
          displayName: u.displayName,
        }))}
        currentUserId={currentUserId}
        currentUserRole={currentUserRole}
      />
    </div>
  );
}
