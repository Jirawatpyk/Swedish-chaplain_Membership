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
vi.mock('sonner', () => ({
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
});
