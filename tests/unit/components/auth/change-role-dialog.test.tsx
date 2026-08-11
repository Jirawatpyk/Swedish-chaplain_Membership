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
