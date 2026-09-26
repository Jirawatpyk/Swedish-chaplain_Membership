/**
 * Spec 122 US2 T204 — the reset-password form on AURA (`Auth-reset`,
 * `Auth-expired` boards): AURA password fields with an announced show/hide
 * toggle, the strength bar describing the new password until an error
 * replaces it, the error summary after a failed submit, and the dead-link
 * state as a danger alert that takes focus. Rendered against real en.json.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { ResetPasswordForm } from '@/components/auth/reset-password-form';

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
      <ResetPasswordForm token="tok" />
    </NextIntlClientProvider>,
  );
}

function type(container: HTMLElement, id: string, value: string) {
  fireEvent.change(container.querySelector(`#${id}`)!, { target: { value } });
}

describe('ResetPasswordForm on AURA (spec 122 US2)', () => {
  it('uses AURA password fields whose show/hide toggles announce their state', () => {
    const { container } = renderForm();
    expect(container.querySelector('#new-password')?.closest('.aura-field')).not.toBeNull();
    expect(container.querySelector('#confirm-password')?.closest('.aura-field')).not.toBeNull();
    const toggles = screen.getAllByRole('button', { name: 'Show password' });
    expect(toggles).toHaveLength(2);
    expect(toggles[0]).toHaveAttribute('aria-pressed', 'false');
  });

  it('describes the new password by its strength bar until an error replaces it', async () => {
    const { container } = renderForm();
    const field = container.querySelector('#new-password')!;
    expect(field.getAttribute('aria-describedby')).toContain('new-password-strength');

    type(container, 'new-password', 'short');
    fireEvent.submit(container.querySelector('form')!);

    await screen.findByText((_t, node) => node?.id === 'new-password-error');
    expect(field.getAttribute('aria-describedby')).toContain('new-password-error');
    expect(field.getAttribute('aria-describedby')).not.toContain('new-password-strength');
    expect(field).toHaveAttribute('aria-invalid', 'true');
  });

  it('lists every field problem in a focused summary after a failed submit', async () => {
    const { container } = renderForm();
    type(container, 'new-password', 'correct horse battery staple');
    type(container, 'confirm-password', 'something else entirely');
    fireEvent.submit(container.querySelector('form')!);

    const summary = await screen.findByRole('alert', { name: /fix 1 field/i });
    await waitFor(() => expect(summary).toHaveFocus());
    expect(within(summary).getByRole('link', { name: 'Passwords must match' })).toBeInTheDocument();
    expect(container.querySelector('#confirm-password')).toHaveAttribute('aria-invalid', 'true');
  });

  it('swaps the form for a focused danger alert with a new-link path when the link is dead', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'link-invalid' }), { status: 410 })),
    );
    const { container } = renderForm();
    type(container, 'new-password', 'correct horse battery staple');
    type(container, 'confirm-password', 'correct horse battery staple');
    fireEvent.submit(container.querySelector('form')!);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveClass('aura-alert', 'aura-alert--danger');
    expect(alert).toHaveTextContent('This reset link has expired.');
    expect(within(alert).getByRole('link', { name: 'Request a new link' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
    await waitFor(() => expect(alert.closest('[tabindex="-1"]')).toHaveFocus());
    expect(container.querySelector('form')).toBeNull();
  });

  it('submits through an AURA primary button', () => {
    renderForm();
    const submit = screen.getByRole('button', { name: 'Update password' });
    expect(submit).toHaveClass('aura-btn');
    expect(submit).toHaveAttribute('type', 'submit');
  });
});
