/**
 * Spec 122 US2 T207 — ChangePasswordForm on AURA: password fields whose
 * show/hide toggles announce their state, the strength bar describing the new
 * password until an error replaces it, the error summary after a failed submit
 * and a wrong current password surfaced on its own field. Rendered against the
 * REAL en.json.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { ChangePasswordForm } from '@/components/auth/change-password-form';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderForm() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ChangePasswordForm />
    </NextIntlClientProvider>,
  );
}

function type(container: HTMLElement, id: string, value: string) {
  fireEvent.change(container.querySelector(`#${id}`)!, { target: { value } });
}

describe('ChangePasswordForm on AURA (spec 122 US2)', () => {
  it('uses three AURA password fields whose show/hide toggles announce their state', () => {
    const { container } = renderForm();
    for (const id of ['current-password', 'new-password', 'confirm-password']) {
      expect(container.querySelector(`#${id}`)?.closest('.aura-field')).not.toBeNull();
    }
    const toggles = screen.getAllByRole('button', { name: 'Show password' });
    expect(toggles).toHaveLength(3);
    expect(toggles[0]).toHaveAttribute('aria-pressed', 'false');
  });

  it('describes the new password by its strength bar until an error replaces it', async () => {
    const { container } = renderForm();
    const field = container.querySelector('#new-password')!;
    expect(field.getAttribute('aria-describedby')).toContain('new-password-strength');

    type(container, 'current-password', 'old password here');
    type(container, 'new-password', 'short');
    fireEvent.submit(container.querySelector('form')!);

    await screen.findByText((_t, node) => node?.id === 'new-password-error');
    expect(field.getAttribute('aria-describedby')).not.toContain('new-password-strength');
  });

  it('lists every field problem in a focused summary after a failed submit', async () => {
    const { container } = renderForm();
    fireEvent.submit(container.querySelector('form')!);

    const summary = await screen.findByRole('alert', { name: /fix \d+ fields/i });
    await waitFor(() => expect(summary).toHaveFocus());
    expect(within(summary).getAllByRole('link').length).toBeGreaterThanOrEqual(2);
  });

  it('puts a wrong current password on its own field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'wrong-current-password' }), { status: 400 }),
      ),
    );
    const { container } = renderForm();
    type(container, 'current-password', 'not my password');
    type(container, 'new-password', 'correct horse battery staple');
    type(container, 'confirm-password', 'correct horse battery staple');
    fireEvent.submit(container.querySelector('form')!);

    const error = await screen.findByText(en.auth.changePassword.errors.wrongCurrent, {
      selector: '#current-password-error, #current-password-error *',
    });
    expect(error).toBeInTheDocument();
    expect(container.querySelector('#current-password')).toHaveAttribute('aria-invalid', 'true');
    // The summary lists it and takes focus (the form no longer calls setFocus).
    const summary = await screen.findByRole('alert', { name: /fix 1 field/i });
    await waitFor(() => expect(summary).toHaveFocus());
    expect(within(summary).getByRole('link', { name: en.auth.changePassword.errors.wrongCurrent })).toBeInTheDocument();
  });

  it('submits through an AURA primary button', () => {
    renderForm();
    const submit = screen.getByRole('button', { name: en.auth.changePassword.submit });
    expect(submit).toHaveClass('aura-btn');
    expect(submit).toHaveAttribute('type', 'submit');
  });
});
