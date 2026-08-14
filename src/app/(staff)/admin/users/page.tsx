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
 * RBAC: the page declares `users.manage` via `requirePagePermission`. The
 * old note here claimed the staff-shell auth guard enforced the admin role —
 * it never did: `requireSession('staff')` checks session validity only, so a
 * manager reached this page before 016 (contracts/authorization-surfaces
 * § 1.1, Class A). The API route layer re-validates independently.
 *
 * Pagination: capped at 50 per page; proper paginated query surface is
 * a documented F9 follow-up.
 */
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { canPerform, requirePagePermission } from '@/lib/rbac';
// Admin user list page (server component) reads directly from the
// repo. An Application-layer `listUsers` use case would be a
// near-identical passthrough and add no behaviour; this read is
// admin-gated by the route guard in layout.tsx. F9 polish may add
// a paginated query surface — until then this escape hatch is the
// documented path.
 
import { userRepo } from '@/modules/auth/infrastructure/db/user-repo';
import { ROLES, USER_STATUSES, type Role, type UserStatus } from '@/modules/auth';
import {
  UserListTable,
  type UserAdminCapabilities,
} from '@/components/auth/user-list-table';
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

const VALID_ROLES = new Set<string>(ROLES);
const VALID_STATUSES = new Set<string>(USER_STATUSES);

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { user: currentUser } = await requirePagePermission('users.manage');
  // Affordance decisions are permission-derived on the SERVER and threaded down
  // as one capability map (016 C1-affordance class + polish S-12): a
  // `role === 'admin'` literal in the client would flip false the moment
  // Migration C promotes admins to super_admin, silently rendering the page
  // read-only for every human. Key rationale lives on `UserAdminCapabilities`.
  const capabilities: UserAdminCapabilities = {
    manageAccounts: canPerform(currentUser.role, 'users.member_accounts'),
    manageStaffRoles: canPerform(currentUser.role, 'users.manage'),
  };
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
      ? (query.status as UserStatus)
      : undefined;

  return (
    <TableContainer>
      <PageHeader
        title={t('title')}
        subtitle={t('pageSubtitle')}
        actions={
          // 016 re-review D — the dialog launches POST /api/auth/invite, whose
          // step-1 gate is (users.member_accounts, auth:user write); mirror it
          // so the affordance enables exactly when the API would admit.
          <InviteUserDialog disabled={!capabilities.manageAccounts} />
        }
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
            capabilities={capabilities}
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
  capabilities,
  page,
  q,
  role,
  status,
}: {
  currentUserId: string;
  capabilities: UserAdminCapabilities;
  page: number;
  q?: string;
  role?: Role;
  status?: UserStatus;
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
  // Computed once here (server) and threaded down as a prop so the
  // "expires in N days" hint uses the identical value on SSR + client
  // hydration — see UserListTableProps.now.
  const now = new Date();

  return (
    <div className="flex flex-col gap-3">
      <UserListTable
        users={users.map((u) => ({
          id: u.id,
          email: u.email,
          role: u.role,
          status: u.status,
          displayName: u.displayName,
          invitationExpiresAt: u.invitationExpiresAt,
        }))}
        currentUserId={currentUserId}
        capabilities={capabilities}
        now={now}
      />
      <TablePagination page={page} pageSize={USERS_PAGE_SIZE} total={total} />
    </div>
  );
}
