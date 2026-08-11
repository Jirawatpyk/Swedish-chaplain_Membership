/**
 * ChangeRoleDialog (016 PR 3, US1) — the staff-role picker.
 *
 * Covers the parts robustly testable in jsdom: the confirm gate (disabled until
 * a DIFFERENT role is picked), the POST payload on confirm, and the localised
 * inline error for the last-administrator refusal (US1-AS4 / CHK052 — MUST read
 * as guidance, never a raw code or an unhandled 500). The full keyboard/focus
 * walk lives in the E2E persona specs (T045/T046).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { toast } from 'sonner';
import { ChangeRoleDialog } from '@/components/auth/change-role-dialog';

// Base UI's Radio pointer handling references the global `PointerEvent`, which
// jsdom does not define — a bare `fireEvent.click` on a radio otherwise throws
// `ReferenceError: PointerEvent is not defined`. A minimal MouseEvent-backed
// polyfill is enough to let the click reach `onValueChange` (this is why the
// full picker interaction normally lives in E2E, not jsdom).
if (typeof globalThis.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, params: MouseEventInit = {}) {
      super(type, params);
    }
  }
  globalThis.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const ADMIN_USER = { id: 'u-admin-1', email: 'admin@example.com', role: 'admin' } as const;
const MANAGER_USER = { id: 'u-manager-1', email: 'manager@example.com', role: 'manager' } as const;

function renderDialog(onOpenChange = vi.fn(), onChanged = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ChangeRoleDialog user={ADMIN_USER} open onOpenChange={onOpenChange} onChanged={onChanged} />
    </NextIntlClientProvider>,
  );
  return { onOpenChange, onChanged };
}

beforeEach(() => {
  vi.useRealTimers();
  (toast.success as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useFakeTimers();
});

describe('ChangeRoleDialog', () => {
  it('disables confirm until a DIFFERENT role is chosen (current is pre-selected)', () => {
    renderDialog();
    // 'admin' is the current role and starts selected → no change yet.
    expect(screen.getByRole('button', { name: en.admin.users.changeRole.confirm })).toBeDisabled();
  });

  it('marks the current role with a "Current" badge', () => {
    renderDialog();
    expect(screen.getByText(en.admin.users.changeRole.current)).toBeInTheDocument();
  });

  it('POSTs the picked role to the change-role route on confirm', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    } as Response);
    const { onChanged, onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole('radio', { name: en.admin.users.filters.role.manager }));
    fireEvent.click(screen.getByRole('button', { name: en.admin.users.changeRole.confirm }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith('/api/auth/users/u-admin-1/role', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newRole: 'manager' }),
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(onChanged).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows the localized last-administrator refusal inline, never the raw code (CHK052)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'last-admin-protection' }),
    } as unknown as Response);
    const { onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole('radio', { name: en.admin.users.filters.role.manager }));
    fireEvent.click(screen.getByRole('button', { name: en.admin.users.changeRole.confirm }));

    await waitFor(() =>
      expect(
        screen.getByText(en.admin.users.changeRole.errors['last-admin-protection']),
      ).toBeInTheDocument(),
    );
    // Raw code never surfaces, and the dialog stays open for a retry.
    expect(screen.queryByText('last-admin-protection')).not.toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  // The Cancel/ESC close path + its finalFocus (016 UX review C1) is verified in
  // the E2E persona spec (tests/e2e/rbac-super-admin-persona) — Base UI's
  // AlertDialogCancel does not round-trip onOpenChange under jsdom+fireEvent, so
  // a unit assertion there would test the harness, not the component.

  /**
   * 016 PR-3 review, Important #4 — cross-row state leak.
   *
   * The parent mounts ONE dialog unconditionally and RETAINS the last user
   * through the close (that is what makes Base UI run its close cycle and fire
   * `finalFocus` — review C1). Consequence: `useState(initialSelected)` runs
   * once per page load, so the per-open reset effect is the ONLY thing that
   * re-pristines the picker for the next row.
   *
   * Without it: open row A (admin) → pick Super Admin → close → open row B
   * (manager) → `selected` is still 'super_admin', `unchanged` is false, and
   * Confirm is ENABLED AND PRE-ARMED on a role the operator never chose for B.
   * One click promotes the wrong user to the highest privilege in the system.
   *
   * Every other test in this file mounts fresh with one fixed user, so that
   * mutant survives them all — this is the only test that drives the reuse.
   */
  it('re-pristines when reopened for a DIFFERENT row — no armed selection carries over', () => {
    const { rerender } = render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ChangeRoleDialog user={ADMIN_USER} open onOpenChange={vi.fn()} onChanged={vi.fn()} />
      </NextIntlClientProvider>,
    );

    // Row A: arm a promotion to Super Admin.
    fireEvent.click(screen.getByRole('radio', { name: en.admin.users.filters.role.super_admin }));
    expect(screen.getByRole('button', { name: en.admin.users.changeRole.confirm })).toBeEnabled();

    // Close, then reopen for a DIFFERENT user (the parent keeps one instance).
    rerender(
      <NextIntlClientProvider locale="en" messages={en}>
        <ChangeRoleDialog
          user={ADMIN_USER}
          open={false}
          onOpenChange={vi.fn()}
          onChanged={vi.fn()}
        />
      </NextIntlClientProvider>,
    );
    rerender(
      <NextIntlClientProvider locale="en" messages={en}>
        <ChangeRoleDialog user={MANAGER_USER} open onOpenChange={vi.fn()} onChanged={vi.fn()} />
      </NextIntlClientProvider>,
    );

    // Row B opens pristine: its OWN role is current, so nothing is armed.
    expect(
      screen.getByRole('button', { name: en.admin.users.changeRole.confirm }),
      'reopening for another row must not inherit the previous row’s selection',
    ).toBeDisabled();
    expect(screen.getByText(en.admin.users.changeRole.current)).toBeInTheDocument();
  });

  it('clears a previous row’s inline error when reopened', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'last-admin-protection' }),
    } as unknown as Response);
    const { rerender } = render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ChangeRoleDialog user={ADMIN_USER} open onOpenChange={vi.fn()} onChanged={vi.fn()} />
      </NextIntlClientProvider>,
    );

    fireEvent.click(screen.getByRole('radio', { name: en.admin.users.filters.role.manager }));
    fireEvent.click(screen.getByRole('button', { name: en.admin.users.changeRole.confirm }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    rerender(
      <NextIntlClientProvider locale="en" messages={en}>
        <ChangeRoleDialog
          user={ADMIN_USER}
          open={false}
          onOpenChange={vi.fn()}
          onChanged={vi.fn()}
        />
      </NextIntlClientProvider>,
    );
    rerender(
      <NextIntlClientProvider locale="en" messages={en}>
        <ChangeRoleDialog user={MANAGER_USER} open onOpenChange={vi.fn()} onChanged={vi.fn()} />
      </NextIntlClientProvider>,
    );

    // Row B must not inherit row A's refusal notice.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('tolerates a null user while closed (parent retains the last user through the close)', () => {
    // The unconditional-mount pattern renders this with user=null before the
    // first row is picked; it must not throw. open=false → no visible content.
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ChangeRoleDialog user={null} open={false} onOpenChange={vi.fn()} onChanged={vi.fn()} />
      </NextIntlClientProvider>,
    );
    // Nothing rendered (closed) and no crash.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('falls back to a generic localized error on an unknown failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'server-error' }),
    } as unknown as Response);
    renderDialog();

    fireEvent.click(screen.getByRole('radio', { name: en.admin.users.filters.role.manager }));
    fireEvent.click(screen.getByRole('button', { name: en.admin.users.changeRole.confirm }));

    await waitFor(() =>
      expect(screen.getByText(en.admin.users.changeRole.errors.generic)).toBeInTheDocument(),
    );
  });
});
