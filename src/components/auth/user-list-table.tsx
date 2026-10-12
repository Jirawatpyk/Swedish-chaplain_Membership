'use client';

/**
 * UserListTable — client component rendering the admin users table
 * (T135 companion). Handles the row-level actions (disable / enable /
 * change-role) via fetch() calls to the admin API routes, with
 * confirmation dialogs for destructive actions.
 *
 * Keeps the parent server component free of 'use client' noise.
 */
import { useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from '@/lib/toast';
import {
  BanIcon,
  CircleCheckIcon,
  MailIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UserIcon,
} from 'lucide-react';
import {
  Badge,
  Button,
  DropdownMenu,
  IconButton,
  StatusPill,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  useBreakpoint,
  type MenuItem,
} from '@jirawatpyk/aura-react';
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';
import { ChangeRoleDialog, CHANGE_ROLE_OPTIONS } from '@/components/auth/change-role-dialog';
// The deep path (rather than the `@/modules/auth` barrel) matches the
// convention the other client components here follow: `role.ts` is pure Domain
// (no framework imports) and safe in the client bundle, whereas the barrel
// transitively loads Node-only Infrastructure. `Role` is a type. Replaces a
// local 3-role alias that silently diverged from the Domain enum when 016
// widened it (review 016 PR1, ui-1).
import type { Role } from '@/modules/auth/domain/role';

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

/**
 * The viewer's capability map for this surface (016 polish, S-12 — one object
 * instead of two loose booleans threaded through every hop). Computed
 * server-side via `canPerform` and threaded down — NEVER `role === 'admin'`
 * in the client (016 C1-affordance class: that literal flips false the
 * instant Migration C promotes admins to super_admin, silently rendering the
 * whole page read-only for every human).
 */
export interface UserAdminCapabilities {
  /**
   * Member-account lifecycle actions (disable / enable / resend / revoke) —
   * `users.member_accounts`, mirroring the /api/auth/invite step-1 gate.
   */
  readonly manageAccounts: boolean;
  /**
   * Staff-role reassignment — `users.manage`, super-admin-only. Gates the
   * per-row "Change role" trigger.
   */
  readonly manageStaffRoles: boolean;
}

export interface UserListTableProps {
  readonly users: readonly UserRow[];
  readonly currentUserId: string;
  readonly capabilities: UserAdminCapabilities;
  /**
   * "Now" used to compute the "expires in N days" hint — computed ONCE on
   * the server (see AdminUsersPage's `UsersDataSection`) and threaded down
   * as a prop, rather than read client-side. See the `daysUntil` call site
   * below for why.
   */
  readonly now: Date;
}

type PendingAction =
  | { readonly kind: 'disable'; readonly user: UserRow }
  | { readonly kind: 'enable'; readonly user: UserRow }
  | { readonly kind: 'revoke'; readonly user: UserRow }
  | null;

// Spec 122 US10a — board `Admin-users`: status as a pill (Active → ready,
// Pending → progress, Disabled → neutral), role as a badge.
const statusTone = { active: 'ready', pending: 'progress', disabled: 'neutral' } as const satisfies Record<
  Status,
  'ready' | 'progress' | 'neutral'
>;

const roleBadge = {
  super_admin: { tone: 'neutral', variant: 'solid' },
  admin: { tone: 'accent', variant: 'soft' },
  manager: { tone: 'neutral', variant: 'soft' },
  marketing: { tone: 'success', variant: 'soft' },
  member: { tone: 'neutral', variant: 'outline' },
} as const satisfies Record<Role, { tone: 'neutral' | 'accent' | 'success'; variant: 'solid' | 'soft' | 'outline' }>;

// The server renders both layouts (CSS shows one); once on the client only the
// one for this width is mounted, so no action is in the page twice.
const noopSubscribe = () => () => {};
function useIsClient(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

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
  capabilities: { manageAccounts: canManageAccounts, manageStaffRoles: canManageStaffRoles },
  now,
}: UserListTableProps) {
  const t = useTranslations('admin.users');
  const tErrors = useTranslations('errors');
  const router = useRouter();
  const [pending, setPending] = useState<PendingAction>(null);
  const [roleChangeUser, setRoleChangeUser] = useState<UserRow | null>(null);
  const [roleDialogOpen, setRoleDialogOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // `now` is computed once on the server (AdminUsersPage's
  // `UsersDataSection`) and passed down, so SSR and client hydration use
  // the identical value — no day-boundary hydration mismatch on the
  // "expires in N days" hint. Accepted tradeoff: the label doesn't tick
  // over while the page stays open (a fresh value only arrives on the next
  // server render / router.refresh()).

  // Focus-return target shared by every dialog on this page. After a
  // CANCEL the button that opened the dialog is still there, so focus goes
  // back to it — for an action chosen from a phone card's ⋯ menu, to that
  // ⋯ button, since the menu item itself is gone (UX review, US10a). After
  // a CONFIRMED action the row may flip or leave the list under
  // `router.refresh()`, so focus goes to the #main-content landmark (the
  // staff layout's focusable <main>), which always survives (reference:
  // dialog-focus-lost-after-unmount).
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const actedRef = useRef(false);
  const rememberOpener = (el: HTMLElement | null) => {
    returnFocusRef.current = el;
    actedRef.current = false;
  };
  // Before the client mounts, the table and the cards are both in the DOM (CSS
  // shows one), so take the ⋯ that is actually shown.
  const rememberMenuOpener = (userId: string) => {
    const all = Array.from(document.querySelectorAll<HTMLElement>(`[data-more-for="${CSS.escape(userId)}"]`));
    rememberOpener(all.find((el) => el.offsetParent !== null) ?? all[0] ?? null);
  };
  const dialogFinalFocus = () => {
    if (typeof document === 'undefined') return null;
    const opener = returnFocusRef.current;
    if (!actedRef.current && opener?.isConnected) return opener;
    return document.getElementById('main-content');
  };

  async function runAction(
    url: string,
    method: 'POST' | 'PATCH',
    body?: object,
    /**
     * Final-review nit fix: an i18n message key to show on failure INSTEAD
     * of the raw backend error code (e.g. `"not-pending"`), which is not
     * localized and not meant for end users. Only `handleRevoke` passes
     * this — disable/enable keep the pre-existing `err.error ?? generic`
     * fallback unchanged.
     */
    errorToastKey?: string,
  ): Promise<{ readonly ok: boolean; readonly status: number | null }> {
    // UX-1 fix: a network-level `fetch` throw (offline, DNS failure, …)
    // used to propagate out of `runAction` uncaught — the caller's
    // `setBusyId(null)` never ran, so the row stayed permanently
    // disabled with no toast. Wrapping the whole fetch + response
    // handling in try/catch means this helper NEVER throws; every
    // caller's `setBusyId(null)` after `await runAction(...)` is always
    // reached. `status` (null on a network throw) lets callers self-heal
    // a stale row on 404/409 — see handleRevoke below.
    try {
      const init: RequestInit = { method };
      if (body) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
      }
      const response = await fetch(url, init);
      if (!response.ok) {
        if (errorToastKey) {
          toast.error(t(errorToastKey));
        } else {
          const err = (await response.json().catch(() => ({}))) as { error?: string };
          toast.error(err.error ?? tErrors('generic'));
        }
        return { ok: false, status: response.status };
      }
      return { ok: true, status: response.status };
    } catch {
      toast.error(errorToastKey ? t(errorToastKey) : tErrors('generic'));
      return { ok: false, status: null };
    }
  }

  async function handleDisable(user: UserRow) {
    setBusyId(user.id);
    const result = await runAction(`/api/auth/users/${user.id}/disable`, 'POST');
    setBusyId(null);
    if (result.ok) {
      toast.success(t('toast.disabled', { email: user.email }));
      router.refresh();
    }
  }

  async function handleEnable(user: UserRow) {
    setBusyId(user.id);
    const result = await runAction(`/api/auth/users/${user.id}/enable`, 'POST');
    setBusyId(null);
    if (result.ok) {
      toast.success(t('toast.enabled', { email: user.email }));
      router.refresh();
    }
  }

  async function handleRevoke(user: UserRow) {
    setBusyId(user.id);
    const result = await runAction(
      `/api/auth/users/${user.id}/revoke-invite`,
      'POST',
      undefined,
      'toast.revokeError',
    );
    setBusyId(null);
    if (result.ok) {
      toast.success(t('toast.revoked', { email: user.email }));
      router.refresh();
    } else if (result.status === 404 || result.status === 409) {
      // Stale row — another admin/tab already resolved this invitation
      // (revoked / expired / accepted elsewhere). Refresh so the dead
      // buttons disappear instead of staying clickable.
      router.refresh();
    }
  }

  /**
   * Staff Invitation Lifecycle Task 8 — resend is NON-destructive and fires
   * directly (no confirm dialog), unlike disable/enable/revoke. It needs its
   * own status-code handling (rather than the shared `runAction`) because a
   * 429 from the per-target reissue-invite throttle (RA-1) gets a distinct
   * "try later" toast instead of the generic error toast.
   */
  async function handleResend(user: UserRow) {
    setBusyId(user.id);
    try {
      const response = await fetch(`/api/auth/users/${user.id}/reissue-invite`, { method: 'POST' });
      if (response.ok) {
        toast.success(t('toast.resent', { email: user.email }));
        router.refresh();
        return;
      }
      if (response.status === 429) {
        // Minor fix: surface the actual wait when the server sends
        // Retry-After (seconds), rounded UP to whole minutes so "45s"
        // still reads as "about 1 minute" rather than "0 minutes".
        // Falls back to the generic message when the header is absent.
        const retryAfterHeader = response.headers.get('Retry-After');
        const retryAfterSeconds =
          retryAfterHeader && !Number.isNaN(Number(retryAfterHeader))
            ? Number(retryAfterHeader)
            : null;
        if (retryAfterSeconds !== null) {
          const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
          toast.error(t('toast.resendRateLimitedWait', { minutes }));
        } else {
          toast.error(t('toast.resendRateLimited'));
        }
        return;
      }
      if (response.status === 404 || response.status === 409) {
        // Stale row — another admin/tab already resolved this invitation.
        // Refresh so the dead buttons disappear instead of staying
        // clickable.
        router.refresh();
      }
      // Final-review nit fix: a localized generic message instead of the
      // raw backend error code (e.g. "not-pending").
      toast.error(t('toast.resendError'));
    } catch {
      toast.error(t('toast.resendError'));
    } finally {
      setBusyId(null);
    }
  }

  const onPhone = useBreakpoint() === 'base';
  const isClient = useIsClient();
  const showTable = !isClient || !onPhone;
  const showCards = !isClient || onPhone;

  /** What a row offers, from the capabilities and its status (unchanged rules). */
  function rowView(user: UserRow) {
    const isSelf = user.id === currentUserId;
    const canDisable = canManageAccounts && !isSelf && user.status === 'active';
    const canEnable = canManageAccounts && user.status === 'disabled';
    const canManageInvite = canManageAccounts && user.status === 'pending';
    // Staff-role reassignment (users.manage). Never on your own row
    // (self-demotion lockout) and only on rows whose CURRENT role is
    // one the picker offers (all four staff roles, marketing included
    // since PR 4) — that keeps the "Current" badge meaningful and
    // avoids a row opening a picker that cannot show its own role.
    // A member↔staff move is a portal change, out of this picker's
    // scope; `changeRole.memberHint` says so in the dialog.
    const canChangeRole = canManageStaffRoles && !isSelf && CHANGE_ROLE_OPTIONS.includes(user.role);
    const busy = busyId === user.id;
    const daysRemaining = user.invitationExpiresAt ? daysUntil(user.invitationExpiresAt, now) : null;
    // An EXPIRED invite gets the danger tone (not just muted text) so it's
    // scannable at a glance; the wording says it too (WCAG 1.4.1).
    const isExpired = user.status === 'pending' && daysRemaining !== null && daysRemaining <= 0;
    const expiryLabel =
      user.status === 'pending' && daysRemaining !== null
        ? daysRemaining > 0
          ? t('invite.expiresIn', { days: daysRemaining })
          : t('invite.expired')
        : null;
    return { isSelf, canDisable, canEnable, canManageInvite, canChangeRole, busy, isExpired, expiryLabel };
  }

  type View = ReturnType<typeof rowView>;

  const openChangeRole = (user: UserRow) => {
    setRoleChangeUser(user);
    setRoleDialogOpen(true);
  };

  /** One row action, as a button. The text label shows from `xl` (1280px); below it only the icon shows, and the label stays in the name and the tooltip, so the Email column keeps its width on a 1024px screen. */
  function actionButton(
    key: 'changeRole' | 'disable' | 'enable' | 'resend' | 'revoke',
    user: UserRow,
    view: View,
    opts: { readonly full?: boolean } = {},
  ): ReactNode {
    const icon = {
      changeRole: <UserIcon aria-hidden />,
      disable: <BanIcon aria-hidden />,
      enable: <CircleCheckIcon aria-hidden />,
      resend: <MailIcon aria-hidden />,
      revoke: <Trash2Icon aria-hidden />,
    }[key];
    const onClick = {
      changeRole: () => openChangeRole(user),
      disable: () => setPending({ kind: 'disable', user }),
      enable: () => setPending({ kind: 'enable', user }),
      resend: () => void handleResend(user),
      revoke: () => setPending({ kind: 'revoke', user }),
    }[key];
    const label = t(`actions.${key}`);
    const resending = key === 'resend' && view.busy;
    return (
      <Button
        key={key}
        size="sm"
        variant="secondary"
        touchHeight
        icon={icon}
        loading={resending}
        disabled={view.busy && !resending}
        title={label}
        onClick={(event) => {
          rememberOpener(event.currentTarget);
          onClick();
        }}
        className={opts.full ? 'min-w-0 flex-1' : undefined}
      >
        {opts.full ? (
          resending ? t('invite.submitting') : label
        ) : (
          <span className="max-xl:sr-only">{resending ? t('invite.submitting') : label}</span>
        )}
      </Button>
    );
  }

  /**
   * A row's actions, on a phone card and a desktop row alike: one primary
   * action, the rest in a ⋯ menu (destructive ones as danger items). Desktop
   * had the board's inline buttons until R42 showed three of them wrapping at
   * 1280; the maintainer moved it to this pattern (spec 122 US10a).
   */
  function rowActions(user: UserRow, view: View, layout: 'card' | 'row'): ReactNode {
    const primary = view.canChangeRole
      ? 'changeRole'
      : view.canManageInvite
        ? 'resend'
        : view.canEnable
          ? 'enable'
          : null;
    const menu: MenuItem[] = [];
    if (view.canChangeRole && view.canManageInvite) {
      menu.push({ label: t('actions.resend'), onSelect: () => void handleResend(user) });
    }
    // A disabled staff row: Change role is the primary, so Enable goes here
    // (security review — it was otherwise unreachable on a phone).
    if (view.canChangeRole && view.canEnable) {
      menu.push({ label: t('actions.enable'), onSelect: () => { rememberMenuOpener(user.id); setPending({ kind: 'enable', user }); } });
    }
    if (view.canDisable) {
      menu.push({ label: t('actions.disable'), tone: 'danger', onSelect: () => { rememberMenuOpener(user.id); setPending({ kind: 'disable', user }); } });
    }
    if (view.canManageInvite) {
      menu.push({ label: t('actions.revoke'), tone: 'danger', onSelect: () => { rememberMenuOpener(user.id); setPending({ kind: 'revoke', user }); } });
    }
    if (primary === null && menu.length === 0) return null;
    return (
      <div
        className={
          layout === 'card'
            ? 'flex items-center gap-[var(--aura-space-2)] pt-[var(--aura-space-1)]'
            : 'flex flex-nowrap items-center justify-end gap-[var(--aura-space-2)]'
        }
      >
        {primary ? actionButton(primary, user, view, { full: layout === 'card' }) : null}
        {menu.length > 0 ? (
          <DropdownMenu
            label={t('actions.moreFor', { email: user.email })}
            items={menu}
            trigger={
              <IconButton
                icon="ellipsis"
                data-more-for={user.id}
                label={t('actions.moreFor', { email: user.email })}
                touchHeight
                disabled={view.busy}
              />
            }
          />
        ) : layout === 'row' ? (
          // Keeps the ⋯ column: without it, a row with no menu (Enable alone)
          // would put its button where the other rows have their ⋯.
          <span data-menu-slot aria-hidden="true" className="inline-block size-[var(--aura-control-sm)] shrink-0" />
        ) : null}
      </div>
    );
  }

  function roleBadgeFor(user: UserRow): ReactNode {
    const { tone, variant } = roleBadge[user.role];
    return (
      <Badge
        tone={tone}
        variant={variant}
        // super_admin is set apart by its icon as well as its fill, so it is
        // not a colour-only cue (WCAG 1.4.1).
        // rbac-presentation-only-ok: picks a badge icon
        icon={user.role === 'super_admin' ? <ShieldCheckIcon aria-hidden /> : undefined}
      >
        {t(`filters.role.${user.role}`)}
      </Badge>
    );
  }

  function statusPillFor(user: UserRow): ReactNode {
    return (
      <StatusPill tone={statusTone[user.status]} data-tone={statusTone[user.status]}>
        {t(`filters.status.${user.status}`)}
      </StatusPill>
    );
  }

  function expiryFor(view: View): ReactNode {
    return view.expiryLabel ? (
      <span
        className={
          view.isExpired
            ? 'aura-text-caption font-medium text-[var(--aura-fg-danger)]'
            : 'aura-text-caption text-[var(--aura-fg-secondary)]'
        }
      >
        {view.expiryLabel}
      </span>
    ) : null;
  }

  return (
    <>
      {showTable ? (
        // Desktop: the board's table, each row with one primary action and a ⋯ menu. The rows keep
        // data-user-id / data-user-email for the e2e (session-revocation finds
        // a user's id by email). Server-rendered under a phone's width it is
        // hidden by CSS until the client mounts the cards instead.
        <div className={isClient ? undefined : 'max-sm:hidden'}>
          <Table caption={t('title')} captionHidden align="middle" bleed stickyHeader>
            <THead>
              <Tr>
                <Th>{t('columns.email')}</Th>
                <Th>{t('columns.name')}</Th>
                <Th>{t('columns.role')}</Th>
                <Th>{t('columns.status')}</Th>
                <Th align="end">{t('columns.actions')}</Th>
              </Tr>
            </THead>
            <TBody>
              {users.map((user) => {
                const view = rowView(user);
                const none = !view.canDisable && !view.canEnable && !view.canManageInvite && !view.canChangeRole;
                return (
                  <Tr key={user.id} data-user-id={user.id} data-user-email={user.email.toLowerCase()}>
                    <Td>{user.email}</Td>
                    <Td className="whitespace-nowrap">{user.displayName ?? '—'}</Td>
                    <Td>{roleBadgeFor(user)}</Td>
                    <Td>
                      <div className="flex flex-wrap items-center gap-[var(--aura-space-2)]">
                        {statusPillFor(user)}
                        {expiryFor(view)}
                      </div>
                    </Td>
                    <Td align="end">
                      {none ? (
                        <span className="text-[var(--aura-fg-secondary)]">{view.isSelf ? t('actions.self') : '—'}</span>
                      ) : (
                        rowActions(user, view, 'row')
                      )}
                    </Td>
                  </Tr>
                );
              })}
              {users.length === 0 ? (
                <Tr>
                  <Td colSpan={5} className="text-center text-[var(--aura-fg-secondary)]">
                    {t('empty')}
                  </Td>
                </Tr>
              ) : null}
            </TBody>
          </Table>
        </div>
      ) : null}

      {showCards ? (
        // Phone (board `Admin-users-mobile`): a card per user — name and status,
        // email, role and expiry, then one primary action and a ⋯ menu.
        <ul aria-label={t('title')} className={isClient ? 'flex flex-col gap-[var(--aura-space-3)]' : 'flex flex-col gap-[var(--aura-space-3)] sm:hidden'}>
          {users.map((user) => {
            const view = rowView(user);
            return (
              <li
                key={user.id}
                data-user-id={isClient ? user.id : undefined}
                data-user-email={isClient ? user.email.toLowerCase() : undefined}
                className="flex flex-col gap-[var(--aura-space-2)] rounded-[var(--aura-radius-lg)] border border-[var(--aura-border-default)] bg-[var(--aura-bg-surface)] p-[var(--aura-space-4)]"
              >
                <div className="flex items-start justify-between gap-[var(--aura-space-2)]">
                  <span className="aura-text-label min-w-0 [overflow-wrap:anywhere]">{user.displayName ?? user.email}</span>
                  {statusPillFor(user)}
                </div>
                {user.displayName ? (
                  <span className="min-w-0 text-[var(--aura-fg-primary)] [overflow-wrap:anywhere]">{user.email}</span>
                ) : user.status === 'pending' ? (
                  <span className="text-[var(--aura-fg-secondary)]">{t('invite.noNameYet')}</span>
                ) : null}
                <div className="flex flex-wrap items-center gap-[var(--aura-space-2)]">
                  {roleBadgeFor(user)}
                  {view.isSelf ? <span className="text-[var(--aura-fg-secondary)]">{t('actions.self')}</span> : null}
                  {expiryFor(view)}
                </div>
                {rowActions(user, view, 'card')}
              </li>
            );
          })}
          {users.length === 0 ? <li className="text-center text-[var(--aura-fg-secondary)]">{t('empty')}</li> : null}
        </ul>
      ) : null}

      <ConfirmationDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={
          pending?.kind === 'disable'
            ? t('confirm.disable.title')
            : pending?.kind === 'enable'
              ? t('confirm.enable.title')
              : t('confirm.revoke.title')
        }
        description={
          pending?.kind === 'disable'
            ? t('confirm.disable.description', { email: pending.user.email })
            : pending?.kind === 'enable'
              ? t('confirm.enable.description', { email: pending.user.email })
              : pending?.kind === 'revoke'
                ? t('confirm.revoke.description', { email: pending.user.email })
                : ''
        }
        confirmLabel={
          pending?.kind === 'disable'
            ? t('actions.disable')
            : pending?.kind === 'enable'
              ? t('actions.enable')
              : t('confirm.revoke.confirm')
        }
        cancelLabel={t('confirm.cancel')}
        destructive={pending?.kind === 'disable' || pending?.kind === 'revoke'}
        finalFocus={dialogFinalFocus}
        onConfirm={async () => {
          actedRef.current = true;
          if (pending?.kind === 'disable') await handleDisable(pending.user);
          else if (pending?.kind === 'enable') await handleEnable(pending.user);
          else if (pending?.kind === 'revoke') await handleRevoke(pending.user);
        }}
      />

      {/* Mounted UNCONDITIONALLY (like the ConfirmationDialog above), driven by
          `open` alone. Conditionally rendering it would unmount the Base UI Root
          in the same frame the close is requested, so the close cycle — and
          `finalFocus` with it — never runs and focus drops to <body> (016 UX
          review C1 / CHK050). `roleChangeUser` is RETAINED through the close
          animation and only changes when another row opens the picker. */}
      <ChangeRoleDialog
        user={roleChangeUser}
        open={roleDialogOpen}
        onOpenChange={setRoleDialogOpen}
        onChanged={() => {
          actedRef.current = true;
          router.refresh();
        }}
        finalFocus={dialogFinalFocus}
      />
    </>
  );
}
