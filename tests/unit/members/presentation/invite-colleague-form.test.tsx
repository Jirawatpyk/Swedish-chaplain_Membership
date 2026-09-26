/**
 * InviteColleagueForm — focus-on-mount + inline email-taken (audit XF-04/XF-01).
 *
 * The form must auto-focus the first field on mount and surface a server
 * email_taken rejection inline on the email field (+ focus) rather than only a
 * toast. Rendered against real en.json with a mocked fetch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { InviteColleagueForm } from '@/components/members/invite-colleague-form';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
const toastError = vi.fn();
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a), info: vi.fn() },
}));

beforeEach(() => {
  vi.useRealTimers();
  toastError.mockClear();
});

function renderForm() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <InviteColleagueForm />
    </NextIntlClientProvider>,
  );
}

describe('InviteColleagueForm', () => {
  it('auto-focuses the first field on mount', async () => {
    const { container } = renderForm();
    await waitFor(() =>
      expect(document.activeElement).toBe(container.querySelector('#first_name')),
    );
  });

  it('surfaces a server email_taken rejection inline on the email field, not a toast', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'email_taken' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderForm();
    fireEvent.change(container.querySelector('#first_name')!, {
      target: { value: 'Jane' },
    });
    fireEvent.change(container.querySelector('#last_name')!, {
      target: { value: 'Doe' },
    });
    fireEvent.change(container.querySelector('#email')!, {
      target: { value: 'dup@example.com' },
    });
    fireEvent.submit(container.querySelector('form')!);

    // Inline error <p> appears + aria-invalid set; no toast.
    await screen.findByText((_t, node) => node?.id === 'email-error');
    expect(container.querySelector('#email')?.getAttribute('aria-invalid')).toBe(
      'true',
    );
    expect(toastError).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('shows the neutral invite_unavailable message inline — never "already registered"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ error: { code: 'invite_unavailable' } }),
      }),
    );

    const { container } = renderForm();
    fireEvent.change(container.querySelector('#first_name')!, { target: { value: 'Jane' } });
    fireEvent.change(container.querySelector('#last_name')!, { target: { value: 'Doe' } });
    fireEvent.change(container.querySelector('#email')!, { target: { value: 'x@other.example' } });
    fireEvent.submit(container.querySelector('form')!);

    const msg = await screen.findByText((_t, node) => node?.id === 'email-error');
    expect(msg.textContent).toBe(enMessages.portal.invite.inviteUnavailable);
    expect(msg.textContent).not.toMatch(/registered|already/i);
    expect(toastError).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

describe('InviteColleagueForm on AURA (spec 122 US3)', () => {
  it('uses AURA fields (an email keyboard for the address) and an AURA select, with Send in an ActionBar that says when changes are unsaved', () => {
    const { container } = renderForm();
    for (const id of ['first_name', 'last_name', 'email', 'role_title']) {
      expect(container.querySelector(`#${id}`)?.closest('.aura-field')).not.toBeNull();
    }
    const email = container.querySelector('#email')!;
    expect(email).toHaveAttribute('type', 'email');
    expect(email).toHaveAttribute('inputmode', 'email');
    expect(email).toHaveAttribute('autocomplete', 'email');
    expect(container.querySelector('select[name="preferred_language"]')?.closest('.aura-field')).not.toBeNull();
    const bar = screen.getByRole('region', { name: 'Actions' });
    expect(bar).toContainElement(screen.getByRole('button', { name: enMessages.portal.invite.sendButton }));
    const status = bar.querySelector('[role="status"]')!;
    expect(status.textContent).toBe('');
    fireEvent.change(container.querySelector('#first_name')!, { target: { value: 'Jane' } });
    expect(status.textContent).toBe(enMessages.common.unsavedStatus);
  });

  it('sends the language picked in the AURA select', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    const { container } = renderForm();
    fireEvent.change(container.querySelector('#first_name')!, { target: { value: 'Jane' } });
    fireEvent.change(container.querySelector('#last_name')!, { target: { value: 'Doe' } });
    fireEvent.change(container.querySelector('#email')!, { target: { value: 'jane@acme.example' } });
    // AURA's list sits over the real <select>, which `register` still drives
    fireEvent.change(container.querySelector('select[name="preferred_language"]')!, {
      target: { value: 'sv' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.preferred_language).toBe('sv');
    vi.unstubAllGlobals();
  });

  it('lists a failed submit in a focused error summary', async () => {
    const { container } = renderForm();
    fireEvent.submit(container.querySelector('form')!);
    const summary = await screen.findByRole('alert', { name: /fix 3 fields/i });
    await waitFor(() => expect(summary).toHaveFocus());
  });
});
