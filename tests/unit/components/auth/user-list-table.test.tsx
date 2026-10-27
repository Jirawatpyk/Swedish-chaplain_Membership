// tests/unit/components/auth/user-list-table.test.tsx
//
// Staff Invitation Lifecycle Task 8 — Resend + Revoke row actions on the
// admin Users table. Covers:
//  (a) a pending row (admin viewer) shows "Resend invitation" + "Revoke"
//  (b) active/disabled rows do NOT show either action
//  (c) a non-admin viewer (manager) never sees either action, even on a
//      pending row
//  (d) clicking Revoke opens the confirm dialog WITHOUT posting immediately
//  (e) Resend fires directly (no confirm dialog): success / 429 / other-error
//      branches
//  (f) confirming Revoke posts to revoke-invite and toasts success
//  (g) final-review nit: non-429 resend/revoke failures toast a localized
//      generic message, never the raw backend error code
//  (h) final-review nit: pending-row "Expires in N days" / "Invitation
//      expired" label renders from the real en.json ICU plural

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { toast } from '@/lib/toast';
import { UserListTable, type UserListTableProps } from '@/components/auth/user-list-table';
import { erasedUserEmail } from '@/modules/auth/domain/erased-user-email';

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const refreshSpy = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshSpy }) }));

type Users = UserListTableProps['users'];

const PENDING_USER = {
  id: 'u-pending-1',
  email: 'pending@example.com',
  role: 'member',
  status: 'pending',
  displayName: null,
  invitationExpiresAt: null,
  isErased: false,
} as const;

const ACTIVE_USER = {
  id: 'u-active-1',
  email: 'active@example.com',
  role: 'member',
  status: 'active',
  displayName: 'Active User',
  invitationExpiresAt: null,
  isErased: false,
} as const;

const DISABLED_USER = {
  id: 'u-disabled-1',
  email: 'disabled@example.com',
  role: 'member',
  status: 'disabled',
  displayName: 'Disabled User',
  invitationExpiresAt: null,
  isErased: false,
} as const;

// A STAFF row — the only rows the change-role picker offers (016 PR 3).
const ADMIN_USER = {
  id: 'u-admin-1',
  email: 'admin@example.com',
  role: 'admin',
  status: 'active',
  displayName: 'Admin User',
  invitationExpiresAt: null,
  isErased: false,
} as const;

// Fixed "now" (Task 2's server-now-hydration fix): UserListTable no longer
// reads `new Date()` internally — the value is computed once on the server
// and threaded down as a prop. Tests pass a fixed instant so the
// expiry-label assertions below are deterministic regardless of wall clock.
const FIXED_NOW = new Date('2026-07-18T00:00:00Z');

// 016 PR 3 — affordances are permission booleans threaded from the server, not
// a client `role === 'admin'` literal. Default both true (the post-cutover
// super_admin, and the pre-cutover admin on the OFF leg); tests that exercise a
// narrower viewer pass explicit booleans (e.g. a plain admin on the ON leg has
// canManageAccounts=true but canManageStaffRoles=false).
interface RenderOpts {
  readonly canManageAccounts?: boolean;
  readonly canManageStaffRoles?: boolean;
  readonly now?: Date;
}

function renderTable(users: Users, opts: RenderOpts = {}) {
  const {
    canManageAccounts = true,
    canManageStaffRoles = true,
    now = FIXED_NOW,
  } = opts;
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <UserListTable
        users={users}
        currentUserId="current-viewer"
        capabilities={{
          manageAccounts: canManageAccounts,
          manageStaffRoles: canManageStaffRoles,
        }}
        now={now}
      />
    </NextIntlClientProvider>,
  );
}

/** A row's other actions sit in its ⋯ menu, on desktop as on phones (spec 122 US10a, after R42). */
async function pickFromMenu(email: string, item: string): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: `More actions for ${email}` }));
  const el = await screen.findByRole('menuitem', { name: item });
  fireEvent.click(el);
  return el;
}

beforeEach(() => {
  vi.useRealTimers();
  refreshSpy.mockClear();
  (toast.success as ReturnType<typeof vi.fn>).mockClear();
  (toast.error as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  cleanup();
  vi.useFakeTimers();
});

describe('UserListTable — layout', () => {
  it('AURA 5.60 (#174): an email breaks only after its @, so a long address never widens the table', () => {
    renderTable([ACTIVE_USER]);
    const cell = screen.getAllByRole('cell').find((td) => td.textContent === 'active@example.com')!;
    expect(cell).not.toHaveClass('is-wrap-anywhere');
    expect(cell.innerHTML).toContain('active@<wbr>example.com');
  });
});

describe('UserListTable — resend + revoke invitation actions', () => {
  it('shows Resend invitation in the row and Revoke as a danger item in its ⋯ menu on a pending row', async () => {
    renderTable([PENDING_USER]);
    expect(screen.getByRole('button', { name: 'Resend invitation' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: `More actions for ${PENDING_USER.email}` }));
    expect(await screen.findByRole('menuitem', { name: 'Revoke' })).toHaveClass('aura-menu__item--danger');
  });

  it('does NOT show Resend/Revoke on an active row', () => {
    renderTable([ACTIVE_USER]);
    expect(screen.queryByRole('button', { name: 'Resend invitation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  it('does NOT show Resend/Revoke on a disabled row', () => {
    renderTable([DISABLED_USER]);
    expect(screen.queryByRole('button', { name: 'Resend invitation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  it('does NOT show Resend/Revoke when the viewer cannot manage accounts, even on a pending row', () => {
    renderTable([PENDING_USER], { canManageAccounts: false, canManageStaffRoles: false });
    expect(screen.queryByRole('button', { name: 'Resend invitation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  it('clicking Revoke opens the confirm dialog and does NOT post immediately', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    } as Response);
    renderTable([PENDING_USER]);

    await pickFromMenu(PENDING_USER.email, 'Revoke');

    expect(screen.getByText(en.admin.users.confirm.revoke.title)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('confirming Revoke posts to revoke-invite, toasts success, and refreshes', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    } as Response);
    renderTable([PENDING_USER]);

    await pickFromMenu(PENDING_USER.email, 'Revoke');
    fireEvent.click(screen.getByRole('button', { name: en.admin.users.confirm.revoke.confirm }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith('/api/auth/users/u-pending-1/revoke-invite', { method: 'POST' }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(refreshSpy).toHaveBeenCalled();
  });

  it('clicking Resend fires directly (no confirm dialog), posts, toasts success, and refreshes', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, email: PENDING_USER.email }),
    } as Response);
    renderTable([PENDING_USER]);

    fireEvent.click(screen.getByRole('button', { name: 'Resend invitation' }));

    // No confirm dialog for the non-destructive resend action.
    expect(screen.queryByText(en.admin.users.confirm.revoke.title)).not.toBeInTheDocument();

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith('/api/auth/users/u-pending-1/reissue-invite', { method: 'POST' }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(refreshSpy).toHaveBeenCalled();
  });

  it('toasts a rate-limit message on 429 from resend without a Retry-After header', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: () => null },
      json: async () => ({ error: 'rate-limited' }),
    } as unknown as Response);
    renderTable([PENDING_USER]);

    fireEvent.click(screen.getByRole('button', { name: 'Resend invitation' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(en.admin.users.toast.resendRateLimited),
    );
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('toasts a wait-aware rate-limit message on 429 from resend WITH a Retry-After header (minor fix)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 429,
      // 125s rounds UP to 3 minutes (Math.ceil(125/60) = 3).
      headers: { get: (name: string) => (name === 'Retry-After' ? '125' : null) },
      json: async () => ({ error: 'rate-limited' }),
    } as unknown as Response);
    renderTable([PENDING_USER]);

    fireEvent.click(screen.getByRole('button', { name: 'Resend invitation' }));

    // `t(key, values)` returns the already-interpolated string — assert
    // against the real ICU-plural output for minutes=3, not the raw key.
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Too many resends — try again in about 3 minutes.',
      ),
    );
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('toasts a generic error on a non-429 resend failure, and self-heals the stale row via refresh (409)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'not-pending' }),
    } as unknown as Response);
    renderTable([PENDING_USER]);

    fireEvent.click(screen.getByRole('button', { name: 'Resend invitation' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    // Post-review UX fix (2026-07-18): a 404/409 means another admin/tab
    // already resolved this invitation — refresh so the dead row updates
    // instead of staying clickable.
    expect(refreshSpy).toHaveBeenCalled();
  });

  it('toasts a localized generic message (not the raw error code) on a non-429 resend failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'not-pending' }),
    } as unknown as Response);
    renderTable([PENDING_USER]);

    fireEvent.click(screen.getByRole('button', { name: 'Resend invitation' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(en.admin.users.toast.resendError),
    );
    expect(toast.error).not.toHaveBeenCalledWith('not-pending');
  });

  it('toasts a localized generic message (not the raw error code) on a revoke failure, and self-heals the stale row via refresh (409)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'not-pending' }),
    } as unknown as Response);
    renderTable([PENDING_USER]);

    await pickFromMenu(PENDING_USER.email, 'Revoke');
    fireEvent.click(screen.getByRole('button', { name: en.admin.users.confirm.revoke.confirm }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(en.admin.users.toast.revokeError),
    );
    expect(toast.error).not.toHaveBeenCalledWith('not-pending');
    // Post-review UX fix (2026-07-18): a 404/409 means another admin/tab
    // already resolved this invitation — refresh so the dead row updates
    // instead of staying clickable.
    expect(refreshSpy).toHaveBeenCalled();
  });

  it('does NOT self-heal via refresh on a non-404/409 revoke failure (e.g. 500)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'server-error' }),
    } as unknown as Response);
    renderTable([PENDING_USER]);

    await pickFromMenu(PENDING_USER.email, 'Revoke');
    fireEvent.click(screen.getByRole('button', { name: en.admin.users.confirm.revoke.confirm }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(en.admin.users.toast.revokeError),
    );
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('a fetch that throws (network error) does NOT strand the row disabled — toasts and re-enables (UX-1)', async () => {
    // Revoke's confirm-dialog label ("Revoke invitation") is distinct from
    // its row-trigger label ("Revoke"), so this exercises `runAction`'s
    // try/catch without a same-text button collision once the dialog opens.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    renderTable([PENDING_USER]);

    await pickFromMenu(PENDING_USER.email, 'Revoke');
    fireEvent.click(screen.getByRole('button', { name: en.admin.users.confirm.revoke.confirm }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(en.admin.users.toast.revokeError));
    // The row must not stay stuck busy: its ⋯ menu button is
    // clickable again (no lingering `disabled` from a swallowed throw).
    await waitFor(() =>
      expect(screen.getByRole('button', { name: `More actions for ${PENDING_USER.email}` })).not.toBeDisabled(),
    );
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});

describe('UserListTable — pending-row invitation expiry label', () => {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  it('shows "Expires in 3 days" for a pending row whose invitation expires ~3 days out', () => {
    // 3 days minus a small buffer relative to the FIXED `now` prop so
    // `daysUntil`'s Math.ceil rounds UP to exactly 3, never 4.
    const invitationExpiresAt = new Date(FIXED_NOW.getTime() + 3 * MS_PER_DAY - 60_000);
    renderTable([{ ...PENDING_USER, invitationExpiresAt }]);

    expect(screen.getByText('Expires in 3 days')).toBeInTheDocument();
  });

  it('shows "Invitation expired" for a pending row whose invitation is already past its expiry', () => {
    const invitationExpiresAt = new Date(FIXED_NOW.getTime() - MS_PER_DAY);
    renderTable([{ ...PENDING_USER, invitationExpiresAt }]);

    expect(screen.getByText('Invitation expired')).toBeInTheDocument();
  });

  it('minor fix: the EXPIRED label carries a destructive tone (not just muted text)', () => {
    const invitationExpiresAt = new Date(FIXED_NOW.getTime() - MS_PER_DAY);
    renderTable([{ ...PENDING_USER, invitationExpiresAt }]);

    const label = screen.getByText('Invitation expired');
    expect(label).toHaveClass('text-[var(--aura-fg-danger)]');
    expect(label).not.toHaveClass('text-[var(--aura-fg-secondary)]');
  });

  it('minor fix: a not-yet-expired "Expires in N days" label keeps the muted tone', () => {
    const invitationExpiresAt = new Date(FIXED_NOW.getTime() + 3 * MS_PER_DAY - 60_000);
    renderTable([{ ...PENDING_USER, invitationExpiresAt }]);

    const label = screen.getByText('Expires in 3 days');
    expect(label).toHaveClass('text-[var(--aura-fg-secondary)]');
    expect(label).not.toHaveClass('text-[var(--aura-fg-danger)]');
  });
});

describe('UserListTable — the table is named (minor fix)', () => {
  it('names the table from the page title instead of a hardcoded "Data table" fallback', () => {
    renderTable([PENDING_USER]);
    expect(screen.getByRole('table', { name: en.admin.users.title })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Data table' })).not.toBeInTheDocument();
  });
});

describe('UserListTable — change-role picker (016 PR 3, US1)', () => {
  it('shows "Change role" on a STAFF row when the viewer can manage staff roles', () => {
    renderTable([ADMIN_USER], { canManageStaffRoles: true });
    expect(screen.getByRole('button', { name: en.admin.users.actions.changeRole })).toBeInTheDocument();
  });

  it('does NOT show "Change role" on a MEMBER row (a portal move, not a staff reassignment)', () => {
    renderTable([ACTIVE_USER], { canManageStaffRoles: true });
    expect(
      screen.queryByRole('button', { name: en.admin.users.actions.changeRole }),
    ).not.toBeInTheDocument();
  });

  it('hides "Change role" for a viewer without users.manage but keeps lifecycle actions (plain admin, ON leg)', async () => {
    renderTable([ADMIN_USER], { canManageAccounts: true, canManageStaffRoles: false });
    // No staff-role reassignment...
    expect(
      screen.queryByRole('button', { name: en.admin.users.actions.changeRole }),
    ).not.toBeInTheDocument();
    // ...but member-account lifecycle (this admin row is active) still shows.
    fireEvent.click(screen.getByRole('button', { name: `More actions for ${ADMIN_USER.email}` }));
    expect(await screen.findByRole('menuitem', { name: en.admin.users.actions.disable })).toBeInTheDocument();
  });

  it('the affordance is permission-driven, not role-literal: canManageAccounts=false hides every lifecycle action even for an admin-role row', () => {
    // The C1-affordance regression guard: pre-016 this was `role === 'admin'`,
    // which flips false after Migration C promotes admins to super_admin. Now
    // it is a server-computed boolean, so a false value hides the actions
    // regardless of what role string the VIEWER happens to hold.
    renderTable([ADMIN_USER], { canManageAccounts: false, canManageStaffRoles: false });
    expect(screen.queryByRole('button', { name: en.admin.users.actions.disable })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^More actions for/ })).toBeNull();
  });

  it('opens the picker with every STAFF role — including marketing (PR 4 reveal)', () => {
    renderTable([ADMIN_USER], { canManageStaffRoles: true });
    fireEvent.click(screen.getByRole('button', { name: en.admin.users.actions.changeRole }));

    for (const label of [
      en.admin.users.filters.role.super_admin,
      en.admin.users.filters.role.admin,
      en.admin.users.filters.role.manager,
      en.admin.users.filters.role.marketing,
    ]) {
      // The row's own role is named "Admin (Current)", as the board does.
      expect(screen.getByRole('radio', { name: new RegExp(`^${label}( \\(Current\\))?$`) })).toBeInTheDocument();
    }
    // `member` stays out: moving between the staff and member portals is a
    // different operation, and the route answers `role-portal-mismatch`.
    expect(
      screen.queryByRole('radio', { name: en.admin.users.filters.role.member }),
    ).not.toBeInTheDocument();
  });

  it('offers Change role on a MARKETING row (it is a staff role like any other)', () => {
    // The trigger is gated on CHANGE_ROLE_OPTIONS.includes(user.role) — before
    // PR 4 a marketing row could not be re-ranked at all, and worse, opening the
    // picker would have shown no "Current" badge because its own role was not an
    // option. Both are fixed by the same widening.
    const MARKETING_USER = {
      id: 'u-marketing-1',
      email: 'marketing@example.com',
      role: 'marketing',
      status: 'active',
      displayName: 'Marketing User',
      invitationExpiresAt: null,
      isErased: false,
    } as const;
    renderTable([MARKETING_USER], { canManageStaffRoles: true });

    fireEvent.click(screen.getByRole('button', { name: en.admin.users.actions.changeRole }));
    expect(screen.getByRole('radio', { name: 'Marketing (Current)' })).toBeChecked();
    expect(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: en.admin.users.changeRole.confirm }),
      'its own role is pre-selected, so nothing is armed on open',
    ).toBeDisabled();
  });
});

// Spec 122 US10a (T1001) — the users list on AURA (board `Admin-users`,
// `-mobile`; Clarifications 2026-10-12). Each row, a desktop table row or a
// phone card, has one primary action and a ⋯ menu, where Disable and Revoke
// are AURA danger items that still ask before posting. (Desktop had the board's
// inline buttons until R42: three of them wrapped at 1280, so the maintainer
// moved desktop to the phone pattern.)
/** The staff layout's focusable landmark, which every page has (the dialogs' fallback). */
function withMainLandmark(): HTMLElement {
  // Real timers: AURA restores focus after its close transition, which a
  // fake clock never reaches (the restore is what these tests measure).
  vi.useRealTimers();
  const main = document.createElement('main');
  main.id = 'main-content';
  main.tabIndex = -1;
  document.body.appendChild(main);
  return main;
}

describe('UserListTable on AURA', () => {
  const MANAGER_USER = {
    id: 'u-manager-1',
    email: 'manager@example.com',
    role: 'manager',
    status: 'active',
    displayName: 'Karin Ek',
    invitationExpiresAt: null,
    isErased: false,
  } as const;

  it('shows status as a pill toned by status', () => {
    renderTable([ACTIVE_USER, PENDING_USER, DISABLED_USER]);
    expect(screen.getByText(en.admin.users.filters.status.active)).toHaveAttribute('data-tone', 'ready');
    expect(screen.getByText(en.admin.users.filters.status.pending)).toHaveAttribute('data-tone', 'progress');
    expect(screen.getByText(en.admin.users.filters.status.disabled)).toHaveAttribute('data-tone', 'neutral');
  });

  it('keeps each row\'s data-user-id / data-user-email for the e2e', () => {
    const { container } = renderTable([ADMIN_USER]);
    expect(container.querySelector('[data-user-email="admin@example.com"]')).toHaveAttribute('data-user-id', 'u-admin-1');
  });

  it('offers Change role in the row and Disable as a danger item in the ⋯ menu', async () => {
    renderTable([MANAGER_USER]);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.admin.users.actions.changeRole })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.admin.users.actions.disable })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: `More actions for ${MANAGER_USER.email}` }));
    expect(await screen.findByRole('menuitem', { name: en.admin.users.actions.disable })).toHaveClass(
      'aura-menu__item--danger',
    );
  });

  it('shows the row button\'s label from 1280px up, and its icon alone below (the name stays)', () => {
    renderTable([MANAGER_USER]);
    const button = screen.getByRole('button', { name: en.admin.users.actions.changeRole });
    expect(within(button).getByText(en.admin.users.actions.changeRole)).toHaveClass('max-xl:sr-only');
    expect(button).toHaveAttribute('title', en.admin.users.actions.changeRole);
  });

  it('lines the ⋯ buttons up at the end of the Actions column, keeping the slot on rows without one', () => {
    const { container } = renderTable([MANAGER_USER, PENDING_USER, DISABLED_USER]);
    expect(screen.getByRole('columnheader', { name: en.admin.users.columns.actions })).toHaveClass('is-end');
    const actions = (id: string) => container.querySelector(`tr[data-user-id="${id}"] td:last-child`)!;
    for (const id of [MANAGER_USER.id, PENDING_USER.id, DISABLED_USER.id]) {
      expect(actions(id)).toHaveClass('is-end');
      expect(actions(id).firstElementChild).toHaveClass('justify-end');
    }
    // Enable alone: an empty, hidden slot where the ⋯ sits on the other rows.
    const slot = actions(DISABLED_USER.id).querySelector('[data-menu-slot]');
    expect(slot).toHaveAttribute('aria-hidden', 'true');
    expect(actions(MANAGER_USER.id).querySelector('[data-menu-slot]')).toBeNull();
  });

  it('keeps Enable reachable on a disabled staff row: Change role in the row, Enable in the ⋯ menu', async () => {
    const disabledStaff = { ...DISABLED_USER, id: 'u-disabled-staff', email: 'off.staff@example.com', role: 'manager' } as const;
    renderTable([disabledStaff]);
    expect(screen.getByRole('button', { name: en.admin.users.actions.changeRole })).toBeInTheDocument();
    await pickFromMenu(disabledStaff.email, en.admin.users.actions.enable);
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
  });

  // 134-s3 — an erased login stays `disabled` in the DB; the row says
  // "Erased" and offers nothing (enableUser refuses it server-side).
  it('an erased row says "Erased" and offers no Enable and no ⋯ menu', () => {
    const erased = { ...DISABLED_USER, id: 'u-erased-1', email: erasedUserEmail('u-erased-1'), displayName: null, isErased: true };
    const { container } = renderTable([erased, DISABLED_USER]);
    const row = container.querySelector<HTMLElement>(`tr[data-user-id="${erased.id}"]`)!;
    expect(within(row).getByText(en.admin.users.filters.status.erased)).toHaveAttribute('data-status', 'erased');
    expect(within(row).queryByText(en.admin.users.filters.status.disabled)).toBeNull();
    expect(within(row).queryByRole('button')).toBeNull();
    // The sentinel is named, never shown as an address.
    expect(within(row).getByText(en.admin.users.erasedAccount)).toBeInTheDocument();
    expect(row).not.toHaveTextContent('erased.invalid');
    // Control: a plain disabled row keeps its Enable action.
    const plain = container.querySelector<HTMLElement>(`tr[data-user-id="${DISABLED_USER.id}"]`)!;
    expect(within(plain).getByRole('button', { name: en.admin.users.actions.enable })).toBeInTheDocument();
  });

  it('an erased STAFF row offers no Change role', () => {
    const erasedStaff = { ...DISABLED_USER, id: 'u-erased-staff', email: erasedUserEmail('u-erased-staff'), role: 'manager', isErased: true } as const;
    renderTable([erasedStaff]);
    expect(screen.queryByRole('button', { name: en.admin.users.actions.changeRole })).toBeNull();
    expect(screen.queryByRole('button', { name: `More actions for ${erasedStaff.email}` })).toBeNull();
  });

  it('shows the status pill and the invitation expiry on one line', () => {
    const expiring = { ...PENDING_USER, invitationExpiresAt: new Date('2026-07-21T00:00:00Z') };
    renderTable([expiring]);
    const expiry = screen.getByText('Expires in 3 days');
    const row = expiry.parentElement!;
    expect(row).toContainElement(screen.getByText(en.admin.users.filters.status.pending));
    expect(row).not.toHaveClass('flex-col');
  });

  it('Cancel on a confirmation from a row\'s ⋯ menu returns focus to that ⋯ button', async () => {
    const main = withMainLandmark();
    renderTable([MANAGER_USER]);
    const more = screen.getByRole('button', { name: `More actions for ${MANAGER_USER.email}` });
    await pickFromMenu(MANAGER_USER.email, en.admin.users.actions.disable);
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: en.admin.users.confirm.cancel }));
    await waitFor(() => expect(document.activeElement).toBe(more));
    main.remove();
    vi.useFakeTimers();
  });

  it('after a confirmed action focus goes to the page landmark (the row may refresh away)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response);
    const main = withMainLandmark();
    renderTable([MANAGER_USER]);
    await pickFromMenu(MANAGER_USER.email, en.admin.users.actions.disable);
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: en.admin.users.actions.disable }));
    await waitFor(() => expect(document.activeElement).toBe(main));
    main.remove();
    vi.useFakeTimers();
  });

  it('Cancel on the change-role picker returns focus to its Change role button', async () => {
    const main = withMainLandmark();
    renderTable([MANAGER_USER]);
    const trigger = screen.getByRole('button', { name: en.admin.users.actions.changeRole });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: en.admin.users.confirm.cancel }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    main.remove();
    vi.useFakeTimers();
  });

  describe('on a phone', () => {
    const width = window.innerWidth;
    beforeEach(() => {
      window.innerWidth = 390;
      window.dispatchEvent(new Event('resize'));
    });
    afterEach(() => {
      window.innerWidth = width;
    });

    it('draws each row as a card in a list named after the page', () => {
      renderTable([MANAGER_USER, PENDING_USER]);
      const list = screen.getByRole('list', { name: en.admin.users.title });
      expect(list.querySelectorAll(':scope > li')).toHaveLength(2);
      expect(screen.queryByRole('table')).toBeNull();
    });

    it('offers Change role as the primary action and Disable as a danger item in the ⋯ menu', async () => {
      renderTable([MANAGER_USER]);
      expect(screen.getByRole('button', { name: en.admin.users.actions.changeRole })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: en.admin.users.actions.disable })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: `More actions for ${MANAGER_USER.email}` }));
      const disable = await screen.findByRole('menuitem', { name: en.admin.users.actions.disable });
      expect(disable).toHaveClass('aura-menu__item--danger');
    });

    it('asks before revoking from the menu', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      renderTable([PENDING_USER]);
      expect(screen.getByRole('button', { name: en.admin.users.actions.resend })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: `More actions for ${PENDING_USER.email}` }));
      fireEvent.click(await screen.findByRole('menuitem', { name: en.admin.users.actions.revoke }));
      expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it('Cancel on a confirmation opened from the ⋯ menu returns focus to that ⋯ button', async () => {
      const main = withMainLandmark();
      renderTable([MANAGER_USER]);
      const more = screen.getByRole('button', { name: `More actions for ${MANAGER_USER.email}` });
      fireEvent.click(more);
      fireEvent.click(await screen.findByRole('menuitem', { name: en.admin.users.actions.disable }));
      const dialog = await screen.findByRole('alertdialog');
      fireEvent.click(within(dialog).getByRole('button', { name: en.admin.users.confirm.cancel }));
      await waitFor(() => expect(document.activeElement).toBe(more));
      main.remove();
      vi.useFakeTimers();
    });

    it('a disabled STAFF row keeps Enable reachable: Change role first, Enable in the ⋯ menu (security review)', async () => {
      const disabledStaff = { ...DISABLED_USER, id: 'u-disabled-staff', email: 'off.staff@example.com', role: 'manager' } as const;
      renderTable([disabledStaff]);
      expect(screen.getByRole('button', { name: en.admin.users.actions.changeRole })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: `More actions for ${disabledStaff.email}` }));
      const enable = await screen.findByRole('menuitem', { name: en.admin.users.actions.enable });
      expect(enable).not.toHaveClass('aura-menu__item--danger');
      fireEvent.click(enable);
      expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    });

    it('a disabled row has Enable alone, and your own row says "That\'s you"', () => {
      renderTable([DISABLED_USER, { ...ADMIN_USER, id: 'current-viewer' }]);
      expect(screen.getByRole('button', { name: en.admin.users.actions.enable })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: `More actions for ${DISABLED_USER.email}` })).toBeNull();
      expect(screen.getByText(en.admin.users.actions.self)).toBeInTheDocument();
    });
  });
});

