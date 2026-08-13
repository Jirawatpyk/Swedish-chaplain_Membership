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

  it('states what each role grants — a bare role name is not an informed choice', () => {
    // The picker used to render role NAMES only, while the invite dialog three
    // clicks away carried the descriptions. Promoting a colleague to super_admin
    // showed nothing about what that adds over admin.
    renderDialog();
    expect(screen.getByText(en.admin.users.roleSummary.super_admin)).toBeInTheDocument();
    expect(screen.getByText(en.admin.users.roleSummary.marketing)).toBeInTheDocument();
  });

  it('explains why `member` is absent instead of looking like a missing option', () => {
    renderDialog();
    expect(screen.getByText(en.admin.users.changeRole.memberHint)).toBeInTheDocument();
  });

  it('warns ONLY when the pick is a promotion to super_admin', async () => {
    // The grant is users.manage + audit.read + invoice settings + GDPR erasure,
    // and the grantee can demote the grantor — it had exactly the same weight
    // as picking `manager`.
    renderDialog();
    const warning = () => screen.queryByTestId('super-admin-promotion-warning');
    expect(warning(), 'nothing picked yet').toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: en.admin.users.filters.role.manager }));
    expect(warning(), 'manager is not a promotion to super_admin').toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: en.admin.users.filters.role.super_admin }));
    await waitFor(() => expect(warning()).toBeInTheDocument());
  });

  it('BLOCKS a super_admin promotion until the phrase is typed exactly', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderDialog();
    fireEvent.click(screen.getByRole('radio', { name: en.admin.users.filters.role.super_admin }));

    const confirm = screen.getByRole('button', { name: en.admin.users.changeRole.confirm });
    await waitFor(() => expect(confirm).toBeDisabled());

    // A near-miss must not pass — this is the whole point of a typed phrase.
    const input = screen.getByLabelText(
      en.admin.users.changeRole.superAdminConfirmCopy.replace(
        '{phrase}',
        en.admin.users.changeRole.superAdminPhrase,
      ),
    );
    fireEvent.change(input, { target: { value: 'PROMOT' } });
    await waitFor(() => expect(confirm).toBeDisabled());
    expect(fetchSpy, 'nothing may be POSTed while the phrase is wrong').not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'promote' } });
    await waitFor(() => expect(confirm).toBeEnabled());
  });

  it('leaves every OTHER role change on a single click', async () => {
    // The gate must be scoped to the promotion. Making all four roles heavier
    // would train operators to type past it.
    renderDialog();
    fireEvent.click(screen.getByRole('radio', { name: en.admin.users.filters.role.manager }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: en.admin.users.changeRole.confirm }),
      ).toBeEnabled(),
    );
  });

  it('keeps focus in the phrase field while typing AFTER a failed attempt', async () => {
    // The inline error is focused when it appears (ux-standards § 6.4). Doing
    // that with an INLINE ref callback re-fires it on every render, because the
    // callback's identity changes each time and React detaches then reattaches
    // it — so each keystroke in the phrase field bounced focus onto the alert
    // and the second character never landed. The two elements coexist on
    // exactly one path: pick super_admin → type the phrase → submit → server
    // refuses, leaving `selected` armed and `errorCode` set.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'last-admin-protection' }),
    } as Response);
    renderDialog();

    const phraseLabel = en.admin.users.changeRole.superAdminConfirmCopy.replace(
      '{phrase}',
      en.admin.users.changeRole.superAdminPhrase,
    );
    fireEvent.click(screen.getByRole('radio', { name: en.admin.users.filters.role.super_admin }));
    const input = screen.getByLabelText(phraseLabel);
    fireEvent.change(input, {
      target: { value: en.admin.users.changeRole.superAdminPhrase },
    });
    fireEvent.click(screen.getByRole('button', { name: en.admin.users.changeRole.confirm }));
    await waitFor(() =>
      expect(screen.getByText(en.admin.users.changeRole.errors['last-admin-protection'])),
    );

    // With the alert on screen, the operator corrects the phrase.
    input.focus();
    fireEvent.change(input, { target: { value: 'PROMOT' } });
    await waitFor(() =>
      expect(
        document.activeElement,
        'typing must not be interrupted by the error alert re-grabbing focus',
      ).toBe(input),
    );
  });

  it('does NOT warn when the row is already a super_admin (no promotion happening)', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ChangeRoleDialog
          user={{ id: 'u-sa', email: 'sa@example.com', role: 'super_admin' }}
          open
          onOpenChange={vi.fn()}
          onChanged={vi.fn()}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByTestId('super-admin-promotion-warning')).toBeNull();
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

    // Row A: fully arm a promotion to Super Admin — pick it AND satisfy the
    // typed-phrase gate, so the dialog is one click from granting the highest
    // privilege in the system. The typed phrase is state too, and state that
    // survived a row change would be worse than a stale radio: it would carry
    // the deliberate friction across to a user the operator never typed it for.
    fireEvent.click(screen.getByRole('radio', { name: en.admin.users.filters.role.super_admin }));
    const phraseInput = screen.getByLabelText(
      en.admin.users.changeRole.superAdminConfirmCopy.replace(
        '{phrase}',
        en.admin.users.changeRole.superAdminPhrase,
      ),
    );
    fireEvent.change(phraseInput, {
      target: { value: en.admin.users.changeRole.superAdminPhrase },
    });
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
    // …and the promotion gate is gone with it, rather than sitting pre-satisfied.
    expect(screen.queryByTestId('super-admin-promotion-warning')).toBeNull();
  });

  it('keeps the typed phrase while the dialog stays open for the SAME row', () => {
    // Arm, then step away to another role, then come back. If `typedPhrase`
    // survived that, the second promotion would be one click — the gate would
    // hold exactly once per dialog instance and then quietly stop working.
    renderDialog();
    const phraseLabel = en.admin.users.changeRole.superAdminConfirmCopy.replace(
      '{phrase}',
      en.admin.users.changeRole.superAdminPhrase,
    );
    fireEvent.click(screen.getByRole('radio', { name: en.admin.users.filters.role.super_admin }));
    fireEvent.change(screen.getByLabelText(phraseLabel), {
      target: { value: en.admin.users.changeRole.superAdminPhrase },
    });
    expect(screen.getByRole('button', { name: en.admin.users.changeRole.confirm })).toBeEnabled();

    fireEvent.click(screen.getByRole('radio', { name: en.admin.users.filters.role.manager }));
    fireEvent.click(screen.getByRole('radio', { name: en.admin.users.filters.role.super_admin }));

    // KNOWN BEHAVIOUR, pinned deliberately: the phrase is kept while the dialog
    // stays open for the SAME row, so a mis-click on another radio does not
    // force a retype. It is cleared on every open (asserted above), which is the
    // boundary that matters — a different user always starts from zero.
    expect(screen.getByRole('button', { name: en.admin.users.changeRole.confirm })).toBeEnabled();
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
