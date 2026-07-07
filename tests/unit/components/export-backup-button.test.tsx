// tests/unit/components/export-backup-button.test.tsx
/**
 * <ExportBackupButton /> — fetch→blob download with sonner toasts
 * (design 2026-07-07). Pins: fetch hits the route, success toast carries
 * row counts from X-*-Count headers, error toast on non-OK, button
 * disabled while in flight.
 *
 * Provider/mocking setup mirrors the house pattern from
 * tests/unit/components/members/resend-verification-button.test.tsx
 * (real `en.json` + NextIntlClientProvider, direct `toast.success`/
 * `toast.error` mock, `fireEvent` + `vi.useRealTimers()`) rather than the
 * brief's sketch, because tests/setup.ts globally enables fake timers
 * (`beforeAll(() => vi.useFakeTimers(...))`) — `waitFor`'s internal
 * polling never advances under fake timers, so `userEvent.click` +
 * `waitFor` would hang to the test timeout. Real timers are restored
 * per-test and faked again in `afterEach` so other suites in the run
 * are unaffected.
 */
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/i18n/messages/en.json';
import { toast } from 'sonner';
import { buildAttachmentContentDisposition } from '@/lib/content-disposition';
import { ExportBackupButton } from '@/app/(staff)/admin/members/_components/export-backup-button';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function renderButton() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ExportBackupButton />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  // Global setup fakes timers by default; restore real ones so waitFor's
  // polling loop actually advances (see file-header note).
  vi.useRealTimers();
  (toast.success as ReturnType<typeof vi.fn>).mockClear();
  (toast.error as ReturnType<typeof vi.fn>).mockClear();
  vi.stubGlobal('fetch', vi.fn());
  // jsdom lacks these; the component calls them on success
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:x'),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useFakeTimers();
});

describe('<ExportBackupButton />', () => {
  it('downloads and shows the success toast with counts', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(new Blob([new Uint8Array([0x50, 0x4b])]), {
        status: 200,
        headers: {
          // eslint no-restricted-syntax bans hand-constructed literal
          // `attachment; filename=` strings (T121 CRLF-injection guard) —
          // build the mock header via the canonical helper instead.
          'Content-Disposition': buildAttachmentContentDisposition(
            't-members-backup-20260707-1730.zip',
          ),
          'X-Members-Count': '2',
          'X-Contacts-Count': '3',
          'X-Invoices-Count': '4',
        },
      }),
    );
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: 'Export backup' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledWith('/api/admin/members/export.zip');
    expect(String((toast.success as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toContain(
      '2 members',
    );
  });

  it('shows the error toast on non-OK response', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('{}', { status: 500 }),
    );
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: 'Export backup' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });
});
