'use client';

/**
 * UserListTable — client component rendering the admin users table
 * (T135 companion). Handles the row-level actions (disable / enable /
 * change-role) via fetch() calls to the admin API routes, with
 * confirmation dialogs for destructive actions.
 *
 * Keeps the parent server component free of 'use client' noise.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  BanIcon,
  CircleCheckIcon,
  RefreshCwIcon,
  UserPlusIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';

type Role = 'admin' | 'manager' | 'member';
type Status = 'pending' | 'active' | 'disabled';

interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly role: Role;
  readonly status: Status;
  readonly displayName: string | null;
}

export interface UserListTableProps {
  readonly users: readonly UserRow[];
  readonly currentUserId: string;
  readonly currentUserRole: Role;
}

type PendingAction =
  | { readonly kind: 'disable'; readonly user: UserRow }
  | { readonly kind: 'enable'; readonly user: UserRow }
  | null;

const statusVariant: Record<Status, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  active: 'default',
  pending: 'secondary',
  disabled: 'outline',
};

const roleVariant: Record<Role, 'default' | 'secondary' | 'outline'> = {
  admin: 'default',
  manager: 'secondary',
  member: 'outline',
};

export function UserListTable({
  users,
  currentUserId,
  currentUserRole,
}: UserListTableProps) {
  const t = useTranslations('admin.users');
  const tErrors = useTranslations('errors');
  const router = useRouter();
  const [pending, setPending] = useState<PendingAction>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const isAdmin = currentUserRole === 'admin';

  async function runAction(
    url: string,
    method: 'POST' | 'PATCH',
    body?: object,
  ): Promise<boolean> {
    const init: RequestInit = { method };
    if (body) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const response = await fetch(url, init);
    if (!response.ok) {
      const err = (await response.json().catch(() => ({}))) as { error?: string };
      toast.error(err.error ?? tErrors('generic'));
      return false;
    }
    return true;
  }

  async function handleDisable(user: UserRow) {
    setBusyId(user.id);
    const ok = await runAction(`/api/auth/users/${user.id}/disable`, 'POST');
    setBusyId(null);
    if (ok) {
      toast.success(t('toast.disabled', { email: user.email }));
      router.refresh();
    }
  }

  async function handleEnable(user: UserRow) {
    setBusyId(user.id);
    const ok = await runAction(`/api/auth/users/${user.id}/enable`, 'POST');
    setBusyId(null);
    if (ok) {
      toast.success(t('toast.enabled', { email: user.email }));
      router.refresh();
    }
  }

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="pb-2 pr-4 font-medium">{t('columns.email')}</th>
              <th className="pb-2 pr-4 font-medium">{t('columns.name')}</th>
              <th className="pb-2 pr-4 font-medium">{t('columns.role')}</th>
              <th className="pb-2 pr-4 font-medium">{t('columns.status')}</th>
              <th className="pb-2 pr-4 font-medium text-right">{t('columns.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const isSelf = user.id === currentUserId;
              const canDisable = isAdmin && !isSelf && user.status === 'active';
              const canEnable = isAdmin && user.status === 'disabled';
              const busy = busyId === user.id;
              return (
                <tr key={user.id} className="border-b last:border-none">
                  <td className="py-3 pr-4">{user.email}</td>
                  <td className="py-3 pr-4 text-muted-foreground">
                    {user.displayName ?? '—'}
                  </td>
                  <td className="py-3 pr-4">
                    <Badge variant={roleVariant[user.role]}>{user.role}</Badge>
                  </td>
                  <td className="py-3 pr-4">
                    <Badge variant={statusVariant[user.status]}>{user.status}</Badge>
                  </td>
                  <td className="py-3 pr-4">
                    <div className="flex items-center justify-end gap-2">
                      {canDisable ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => setPending({ kind: 'disable', user })}
                        >
                          <BanIcon className="size-4" aria-hidden />
                          {t('actions.disable')}
                        </Button>
                      ) : null}
                      {canEnable ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => setPending({ kind: 'enable', user })}
                        >
                          <CircleCheckIcon className="size-4" aria-hidden />
                          {t('actions.enable')}
                        </Button>
                      ) : null}
                      {!canDisable && !canEnable ? (
                        <span className="text-xs text-muted-foreground">
                          {isSelf ? t('actions.self') : '—'}
                        </span>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
            {users.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-6 text-center text-muted-foreground">
                  {t('empty')}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="mt-6 flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          <RefreshCwIcon className="mr-1 inline size-3" aria-hidden />
          {t('refreshHint')}
        </p>
        <Button variant="outline" size="sm" disabled={!isAdmin}>
          <UserPlusIcon className="size-4" aria-hidden />
          {t('actions.invite')}
        </Button>
      </div>

      <ConfirmationDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={pending?.kind === 'disable' ? t('confirm.disable.title') : t('confirm.enable.title')}
        description={
          pending?.kind === 'disable'
            ? t('confirm.disable.description', { email: pending.user.email })
            : pending?.kind === 'enable'
              ? t('confirm.enable.description', { email: pending.user.email })
              : ''
        }
        confirmLabel={
          pending?.kind === 'disable'
            ? t('actions.disable')
            : t('actions.enable')
        }
        cancelLabel={t('confirm.cancel')}
        destructive={pending?.kind === 'disable'}
        onConfirm={async () => {
          if (pending?.kind === 'disable') await handleDisable(pending.user);
          else if (pending?.kind === 'enable') await handleEnable(pending.user);
        }}
      />
    </>
  );
}
