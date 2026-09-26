/**
 * Spec 122 US2 T205 — invitation acceptance on AURA (`Auth-invite`,
 * `Auth-expired` boards): AURA fields with the invited email read-only, the
 * strength bar describing the password until an error replaces it, the error
 * summary after a failed submit, and the dead-invitation state as a focused
 * danger alert that says who can send a new one. Rendered against real en.json.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { InviteRedeemForm } from '@/components/auth/invite-redeem-form';

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
      <InviteRedeemForm token="tok" email="sofia.ek@example.test" />
    </NextIntlClientProvider>,
  );
}

function type(container: HTMLElement, id: string, value: string) {
  fireEvent.change(container.querySelector(`#${id}`)!, { target: { value } });
}

describe('InviteRedeemForm on AURA (spec 122 US2)', () => {
  it('shows the invited email read-only in an AURA field and focuses the name', async () => {
    const { container } = renderForm();
    const email = screen.getByLabelText('Email');
    expect(email.closest('.aura-field')).not.toBeNull();
    expect(email).toHaveValue('sofia.ek@example.test');
    expect(email).toHaveAttribute('readonly');
    expect(container.querySelector('#display-name')?.closest('.aura-field')).not.toBeNull();
    await waitFor(() => expect(container.querySelector('#display-name')).toHaveFocus());
  });

  it('uses AURA password fields whose show/hide toggles announce their state', () => {
    renderForm();
    const toggles = screen.getAllByRole('button', { name: 'Show password' });
    expect(toggles).toHaveLength(2);
    expect(toggles[0]).toHaveAttribute('aria-pressed', 'false');
  });

  it('describes the password by its strength bar until an error replaces it', async () => {
    const { container } = renderForm();
    const field = container.querySelector('#password')!;
    expect(field.getAttribute('aria-describedby')).toContain('password-strength');

    type(container, 'display-name', 'Sofia Ek');
    type(container, 'password', 'short');
    fireEvent.submit(container.querySelector('form')!);

    await screen.findByText((_t, node) => node?.id === 'password-error');
    expect(field.getAttribute('aria-describedby')).toContain('password-error');
    expect(field.getAttribute('aria-describedby')).not.toContain('password-strength');
  });

  it('lists every field problem in a focused summary after a failed submit', async () => {
    const { container } = renderForm();
    fireEvent.submit(container.querySelector('form')!);

    const summary = await screen.findByRole('alert', { name: /fix \d+ fields/i });
    await waitFor(() => expect(summary).toHaveFocus());
    expect(within(summary).getAllByRole('link').length).toBeGreaterThanOrEqual(2);
  });

  it('swaps the form for a focused danger alert saying who can send a new invitation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'link-invalid' }), { status: 410 })),
    );
    const { container } = renderForm();
    type(container, 'display-name', 'Sofia Ek');
    type(container, 'password', 'correct horse battery staple');
    type(container, 'confirm-password', 'correct horse battery staple');
    fireEvent.submit(container.querySelector('form')!);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveClass('aura-alert', 'aura-alert--danger');
    expect(alert).toHaveTextContent('This invitation has expired.');
    expect(alert).toHaveTextContent('Contact an administrator to request a new invitation.');
    await waitFor(() => expect(alert.closest('[tabindex="-1"]')).toHaveFocus());
    expect(container.querySelector('form')).toBeNull();
  });

  it('submits through an AURA primary button', () => {
    renderForm();
    const submit = screen.getByRole('button', { name: 'Activate account' });
    expect(submit).toHaveClass('aura-btn');
    expect(submit).toHaveAttribute('type', 'submit');
  });
});
