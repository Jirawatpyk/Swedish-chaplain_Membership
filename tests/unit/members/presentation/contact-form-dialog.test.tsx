/**
 * ContactFormDialog — inline email-taken (audit XF-01).
 *
 * Mirrors the sibling invite-colleague / portal-edit tests: a 409 conflict on
 * ADD must surface inline on #cf-email (aria-invalid + message) with focus, not
 * a toast. Rendered against real en.json with a mocked fetch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ContactFormDialog } from '@/components/members/contact-form-dialog';

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

function openAddDialog() {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ContactFormDialog memberId="m1" mode="add" trigger={<button>Open</button>} />
    </NextIntlClientProvider>,
  );
  fireEvent.click(screen.getByText('Open'));
}

describe('ContactFormDialog — inline email-taken', () => {
  it('surfaces a 409 conflict inline on #cf-email (not a toast)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ error: { code: 'conflict' } }),
      }),
    );
    openAddDialog();

    fireEvent.change(document.querySelector('#cf-first-name')!, {
      target: { value: 'Jane' },
    });
    fireEvent.change(document.querySelector('#cf-last-name')!, {
      target: { value: 'Doe' },
    });
    fireEvent.change(document.querySelector('#cf-email')!, {
      target: { value: 'dup@example.com' },
    });
    fireEvent.submit(document.querySelector('form')!);

    await waitFor(() =>
      expect(document.querySelector('#cf-email')?.getAttribute('aria-invalid')).toBe(
        'true',
      ),
    );
    // Inline error rendered, no toast.
    expect(document.querySelector('#cf-email-error')).not.toBeNull();
    expect(toastError).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
