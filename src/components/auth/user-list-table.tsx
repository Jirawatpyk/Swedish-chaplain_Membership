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
import { BanIcon, CircleCheckIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';

type Role = 'admin' | 'manager' | 'member';
type Status = 'pending' | 'active' | 'disabled';

interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly role: Role;
  readonly status: Status;
  readonly displayName: string | null;
  /**
   * Staff Invitation Lifecycle Task 5 — the LATEST non-consumed
   * invitation's `expires_at` (`UserListRow` projection, user-repo.ts).
   * `null` when there is none — the common case for `active` /
   * `disabled` rows, and the rare edge case of a `pending` row whose
   * invitation was already redeemed/revoked without a re-send.
   */
  readonly invitationExpiresAt: Date | null;
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

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Staff Invitation Lifecycle Task 5 — days remaining until an
 * invitation's `expires_at`, rounded UP so a fraction of a day still
 * reads as "expires in 1 day" rather than "0 days" (TTL is 7 days —
 * see INVITATION_TTL_MS). `0` or negative means already expired.
 */
function daysUntil(expiresAt: Date, now: Date): number {
  return Math.ceil((expiresAt.getTime() - now.getTime()) / MS_PER_DAY);
}

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
      {/* Matches /admin/members table style — uppercase muted header
          + hover feedback. No outer border: the parent <Card> is the
          container. */}
      <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col" className="text-xs uppercase tracking-wide text-muted-foreground">
                {t('columns.email')}
              </TableHead>
              <TableHead scope="col" className="text-xs uppercase tracking-wide text-muted-foreground">
                {t('columns.name')}
              </TableHead>
              <TableHead scope="col" className="text-xs uppercase tracking-wide text-muted-foreground">
                {t('columns.role')}
              </TableHead>
              <TableHead scope="col" className="text-xs uppercase tracking-wide text-muted-foreground">
                {t('columns.status')}
              </TableHead>
              <TableHead scope="col" className="text-right text-xs uppercase tracking-wide text-muted-foreground">
                {t('columns.actions')}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => {
              const isSelf = user.id === currentUserId;
              const canDisable = isAdmin && !isSelf && user.status === 'active';
              const canEnable = isAdmin && user.status === 'disabled';
              const busy = busyId === user.id;
              const invitationExpiryLabel =
                user.status === 'pending' && user.invitationExpiresAt
                  ? daysUntil(user.invitationExpiresAt, new Date()) > 0
                    ? t('invite.expiresIn', {
                        days: daysUntil(user.invitationExpiresAt, new Date()),
                      })
                    : t('invite.expired')
                  : null;
              return (
                <TableRow
                  key={user.id}
                  className="hover:bg-accent/40"
                  // Data attrs for deterministic E2E selectors — the
                  // session-revocation spec (T-05) needs to find a
                  // specific user's id by email without scraping the
                  // visible text.
                  data-user-id={user.id}
                  data-user-email={user.email.toLowerCase()}
                >
                <TableCell>{user.email}</TableCell>
                <TableCell className="text-muted-foreground">
                  {user.displayName ?? '—'}
                </TableCell>
                <TableCell>
                  <Badge variant={roleVariant[user.role]}>
                    {t(`filters.role.${user.role}`)}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Badge variant={statusVariant[user.status]}>
                      {t(`filters.status.${user.status}`)}
                    </Badge>
                    {invitationExpiryLabel ? (
                      <span className="text-xs text-muted-foreground">
                        {invitationExpiryLabel}
                      </span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell>
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
                </TableCell>
              </TableRow>
            );
          })}
            {users.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                  {t('empty')}
                </TableCell>
              </TableRow>
            ) : null}
        </TableBody>
      </Table>

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
