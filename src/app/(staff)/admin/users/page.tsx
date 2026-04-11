/**
 * Admin users list page (T135) at URL `/admin/users`.
 *
 * Server component — reads the user list directly via `userRepo.list()`
 * and renders a table with inline actions (invite, disable, enable,
 * change role). Each action is gated by the admin role via the
 * staff-shell auth guard (requireSession); the API route layer
 * re-validates via `requireRole`.
 *
 * For F1 MVP the list is server-rendered with no pagination UI
 * (capped at 50 per page); proper pagination is a documented F9
 * follow-up when the admin dashboard expands.
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
import { UserListTable } from '@/components/auth/user-list-table';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export async function generateMetadata(): Promise<Metadata> {
  return { title: 'Users · SweCham' };
}

export default async function AdminUsersPage() {
  const { user: currentUser } = await requireSession('staff');
  const t = await getTranslations('admin.users');

  const users = await userRepo.list(50, 0);
  const total = await userRepo.countAll();

  return (
    <main className="container mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('subtitle', { total })}
          </p>
        </div>
        <Badge variant="secondary">
          {t('viewingAs', { role: currentUser.role })}
        </Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('listHeading')}</CardTitle>
          <CardDescription>{t('listDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <UserListTable
            users={users.map((u) => ({
              id: u.id,
              email: u.email,
              role: u.role,
              status: u.status,
              displayName: u.displayName,
            }))}
            currentUserId={currentUser.id}
            currentUserRole={currentUser.role}
          />
        </CardContent>
      </Card>
    </main>
  );
}
