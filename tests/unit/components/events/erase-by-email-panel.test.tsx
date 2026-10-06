/**
 * Spec 122 US9b-1 (T924) — the erase-by-email panel on AURA (boards
 * `Admin-events-erasure`, `-erasure-confirm`):
 *
 * - the search is an AURA field (`#erase-by-email-input`, same label) in a
 *   `role="search"` form; submitting writes the same normalised URL;
 * - "Erase all" (`erase-all-by-email-button`) opens an AURA alertdialog whose
 *   Confirm is gated by today's reason rule (no typed phrase);
 * - confirming POSTs the same body and toasts the same summary;
 * - focus lands on the search field when the dialog closes (WCAG 2.4.3 —
 *   the trigger unmounts after the refresh).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: vi.fn(), refresh: nav.refresh }),
  usePathname: () => '/admin/events/erasure',
  useSearchParams: () => new URLSearchParams(),
}));
const toastMock = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));

const { EraseByEmailPanel } = await import('@/components/events/erase-by-email-panel');

const er = en.admin.events.erasure;
const EMAIL = 'ploy.r@gmail.example';

const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function renderPanel(email = EMAIL, matchCount = 3) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <EraseByEmailPanel email={email} matchCount={matchCount} />
    </NextIntlClientProvider>,
  );
}

describe('erase-by-email panel (AURA)', () => {
  it('searches from an AURA field and writes the same normalised URL', () => {
    renderPanel('', 0);
    const input = screen.getByLabelText(er.searchLabel);
    expect(input.id).toBe('erase-by-email-input');
    expect(input.closest('.aura-field')).not.toBeNull();
    expect(input.closest('form')).toHaveAttribute('role', 'search');
    fireEvent.change(input, { target: { value: '  Ploy.R@Gmail.example ' } });
    fireEvent.submit(input.closest('form')!);
    expect(nav.push).toHaveBeenCalledWith('/admin/events/erasure?email=ploy.r%40gmail.example');
    expect(screen.queryByTestId('erase-all-by-email-button')).toBeNull();
  });

  it('gates "Erase all" on the reason and posts the same body, then returns focus to the search', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ erasedCount: 3, alreadyErasedCount: 0, failedCount: 0, truncated: false }),
    } as Response);
    renderPanel();
    fireEvent.click(screen.getByTestId('erase-all-by-email-button'));
    screen.getByRole('alertdialog', { name: er.eraseAllConfirmTitle.replace('{count}', '3') });
    expect(document.querySelector('.aura-dialog')).not.toBeNull();
    const confirm = screen.getByRole('button', { name: er.confirm });
    expect(confirm).toHaveAttribute('aria-disabled', 'true');
    expect(confirm.getAttribute('aria-describedby')).toContain('erase-by-email-reason-hint');
    fireEvent.change(screen.getByLabelText(er.reasonLabel), { target: { value: ' PDPA s.33 request ' } });
    expect(confirm).not.toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(confirm);
    await flush();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/events/erasure',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ email: EMAIL, reasonText: 'PDPA s.33 request' }) }),
    );
    expect(toastMock.success).toHaveBeenCalledWith(er.successTitle, { description: '3 erased, 0 already erased, 0 failed.' });
    expect(nav.refresh).toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText(er.searchLabel));
  });
});
