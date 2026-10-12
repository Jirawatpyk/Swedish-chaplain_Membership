/**
 * Spec 122 US10a (T1007) — what the `/admin/users` card holds: the filters
 * (with the count of every match across pages), the list and the pagination.
 * Shared by the page and the preview harness so the preview shows exactly
 * what the page renders.
 */
import {
  UserListTable,
  type UserAdminCapabilities,
  type UserListTableProps,
} from '@/components/auth/user-list-table';
import { UsersFilters } from '@/components/auth/users-filters';
import { TablePagination } from '@/components/layout/table-pagination';

export interface UsersListBodyProps {
  readonly users: UserListTableProps['users'];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly currentUserId: string;
  readonly capabilities: UserAdminCapabilities;
  /** Computed once on the server — see `UserListTableProps.now`. */
  readonly now: Date;
}

export function UsersListBody({ users, total, page, pageSize, currentUserId, capabilities, now }: UsersListBodyProps) {
  return (
    <div className="flex flex-col gap-[var(--aura-space-4)]">
      <UsersFilters resultCount={total} />
      <UserListTable users={users} currentUserId={currentUserId} capabilities={capabilities} now={now} />
      <TablePagination page={page} pageSize={pageSize} total={total} />
    </div>
  );
}
