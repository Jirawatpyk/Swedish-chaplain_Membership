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
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { toast } from 'sonner';
import { UserListTable, type UserListTableProps } from '@/components/auth/user-list-table';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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
} as const;

const ACTIVE_USER = {
  id: 'u-active-1',
  email: 'active@example.com',
  role: 'member',
  status: 'active',
  displayName: 'Active User',
  invitationExpiresAt: null,
} as const;

const DISABLED_USER = {
  id: 'u-disabled-1',
  email: 'disabled@example.com',
  role: 'member',
  status: 'disabled',
  displayName: 'Disabled User',
  invitationExpiresAt: null,
} as const;

// Fixed "now" (Task 2's server-now-hydration fix): UserListTable no longer
// reads `new Date()` internally — the value is computed once on the server
// and threaded down as a prop. Tests pass a fixed instant so the
// expiry-label assertions below are deterministic regardless of wall clock.
const FIXED_NOW = new Date('2026-07-18T00:00:00Z');

function renderTable(
  users: Users,
  currentUserRole: 'admin' | 'manager' | 'member' = 'admin',
  now: Date = FIXED_NOW,
) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <UserListTable
        users={users}
        currentUserId="current-viewer"
        currentUserRole={currentUserRole}
        now={now}
      />
    </NextIntlClientProvider>,
  );
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

describe('UserListTable — resend + revoke invitation actions', () => {
  it('shows Resend invitation + Revoke on a pending row for an admin viewer', () => {
    renderTable([PENDING_USER]);
    expect(screen.getByRole('button', { name: 'Resend invitation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
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

  it('does NOT show Resend/Revoke for a non-admin viewer, even on a pending row', () => {
    renderTable([PENDING_USER], 'manager');
    expect(screen.queryByRole('button', { name: 'Resend invitation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  it('clicking Revoke opens the confirm dialog and does NOT post immediately', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    } as Response);
    renderTable([PENDING_USER]);

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

    expect(screen.getByText(en.admin.users.confirm.revoke.title)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('confirming Revoke posts to revoke-invite, toasts success, and refreshes', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    } as Response);
    renderTable([PENDING_USER]);

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
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

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
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

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
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

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: en.admin.users.confirm.revoke.confirm }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(en.admin.users.toast.revokeError));
    // The row must not stay stuck busy: the Revoke trigger button is
    // clickable again (no lingering `disabled` from a swallowed throw).
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Revoke' })).not.toBeDisabled(),
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
    expect(label).toHaveClass('text-destructive');
    expect(label).not.toHaveClass('text-muted-foreground');
  });

  it('minor fix: a not-yet-expired "Expires in N days" label keeps the muted tone', () => {
    const invitationExpiresAt = new Date(FIXED_NOW.getTime() + 3 * MS_PER_DAY - 60_000);
    renderTable([{ ...PENDING_USER, invitationExpiresAt }]);

    const label = screen.getByText('Expires in 3 days');
    expect(label).toHaveClass('text-muted-foreground');
    expect(label).not.toHaveClass('text-destructive');
  });
});

describe('UserListTable — table landmark aria-label (minor fix)', () => {
  it('names the scroll-region landmark from the page title instead of the hardcoded "Data table" fallback', () => {
    renderTable([PENDING_USER]);
    expect(screen.getByRole('region', { name: en.admin.users.title })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Data table' })).not.toBeInTheDocument();
  });
});
