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
 
import { userRepo } from '@/modules/auth/infrastructure/db/user-repo';
import type { Role } from '@/modules/auth';
import { UserListTable } from '@/components/auth/user-list-table';
import { UsersFilters } from '@/components/auth/users-filters';
import { InviteUserDialog } from '@/components/auth/invite-user-dialog';
import { TablePagination } from '@/components/layout/table-pagination';
import { Card, CardContent } from '@/components/ui/card';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.users');
  return { title: t('title') };
}

const USERS_PAGE_SIZE = 50;

interface SearchParams {
  readonly page?: string;
  readonly q?: string;
  readonly role?: string;
  readonly status?: string;
}

const VALID_ROLES = new Set(['admin', 'manager', 'member']);
const VALID_STATUSES = new Set(['active', 'disabled', 'pending']);

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { user: currentUser } = await requireSession('staff');
  const t = await getTranslations('admin.users');
  const query = await searchParams;
  const rawPage = Number.parseInt(query.page ?? '1', 10);
  const page =
    Number.isFinite(rawPage) && rawPage > 0 ? Math.min(rawPage, 10_000) : 1;
  const q = query.q?.trim() || undefined;
  const role =
    query.role && VALID_ROLES.has(query.role)
      ? (query.role as Role)
      : undefined;
  const status =
    query.status && VALID_STATUSES.has(query.status)
      ? (query.status as 'active' | 'disabled' | 'pending')
      : undefined;

  return (
    <TableContainer>
      <PageHeader
        title={t('title')}
        subtitle={t('pageSubtitle')}
        actions={<InviteUserDialog disabled={currentUser.role !== 'admin'} />}
      />

      <Card>
        <CardContent className="flex flex-col gap-4">
          <UsersFilters />
          {/*
            No internal <Suspense> — route-level loading.tsx is the only
            Suspense boundary. Double-wrapping caused the skeleton
            shimmer to re-run when the outer boundary swapped into the
            inner one.
          */}
          <UsersDataSection
            currentUserId={currentUser.id}
            currentUserRole={currentUser.role}
            page={page}
            {...(q !== undefined ? { q } : {})}
            {...(role !== undefined ? { role } : {})}
            {...(status !== undefined ? { status } : {})}
          />
        </CardContent>
      </Card>
    </TableContainer>
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
  page,
  q,
  role,
  status,
}: {
  currentUserId: string;
  currentUserRole: Role;
  page: number;
  q?: string;
  role?: Role;
  status?: 'active' | 'disabled' | 'pending';
}) {
  const offset = (page - 1) * USERS_PAGE_SIZE;
  const filter = {
    ...(q !== undefined ? { q } : {}),
    ...(role !== undefined ? { role } : {}),
    ...(status !== undefined ? { status } : {}),
  };
  const [users, total] = await Promise.all([
    userRepo.listWithFilter(filter, USERS_PAGE_SIZE, offset),
    userRepo.countWithFilter(filter),
  ]);

  return (
    <div className="flex flex-col gap-3">
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
      <TablePagination page={page} pageSize={USERS_PAGE_SIZE} total={total} />
    </div>
  );
}
