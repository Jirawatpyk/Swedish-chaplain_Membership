/**
 * Spec 122 US9b-1 (T922) — the per-attendee erase dialog on AURA
 * `Dialog role="alertdialog"` with an AURA `Textarea` reason (board
 * `Admin-event-erase`). No typed phrase: the reason gate is today's
 * (Clarifications 2026-10-06, US9b start).
 *
 * - `erase-pii-button-{rid}` opens an AURA alertdialog titled for the attendee;
 * - Confirm stays disabled until the trimmed reason is 1–500 characters;
 * - confirming POSTs the same body to the same route and keeps the toast
 *   branches (success with the quota counts, already erased, 409, error);
 * - the dialog cannot be dismissed while the request is in flight.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: nav.refresh }),
  usePathname: () => '/admin/events/e1',
  useSearchParams: () => new URLSearchParams(),
}));
const toastMock = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));

const { ErasePiiDialog } = await import('@/components/events/erase-pii-dialog');

const e = en.admin.events.detail.erase;
const EVENT = '00000000-0000-4000-8000-000000000001';
const REG = '00000000-0000-4000-8000-0000000000aa';
const NAME = 'Ploy Rattanakul';

const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response);

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function openDialog() {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ErasePiiDialog eventId={EVENT} registrationId={REG} attendeeName={NAME} />
    </NextIntlClientProvider>,
  );
  fireEvent.click(screen.getByTestId(`erase-pii-button-${REG}`));
  const dialog = screen.getByRole('alertdialog', { name: e.confirmTitle.replace('{attendeeName}', NAME) });
  const reason = screen.getByLabelText(e.reasonLabel) as HTMLTextAreaElement;
  const confirm = screen.getByRole('button', { name: e.confirm });
  return { dialog, reason, confirm };
}

describe('erase PII dialog (AURA alertdialog)', () => {
  it('opens an AURA alertdialog and gates Confirm on a 1–500 character reason', () => {
    const { dialog, reason, confirm } = openDialog();
    expect(dialog).toBeInTheDocument();
    expect(document.querySelector('.aura-dialog')).not.toBeNull();
    expect(reason.id).toBe(`erase-reason-${REG}`);
    expect(reason.maxLength).toBe(500);
    expect(confirm).toBeDisabled();
    fireEvent.change(reason, { target: { value: '   ' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(reason, { target: { value: 'GDPR Art. 17 request' } });
    expect(confirm).toBeEnabled();
  });

  it('posts the trimmed reason to the same route, toasts the quota credit-back and refreshes', async () => {
    fetchMock.mockReturnValue(json({ alreadyErased: false, quotaReversals: { partnership: 1, cultural: 0 } }));
    const { reason, confirm } = openDialog();
    fireEvent.change(reason, { target: { value: '  GDPR Art. 17 request  ' } });
    fireEvent.click(confirm);
    await flush();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/admin/events/${EVENT}/registrations/${REG}/erase`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ reasonText: 'GDPR Art. 17 request' }) }),
    );
    expect(toastMock.success).toHaveBeenCalledWith(e.successTitle, {
      description: 'Quota credit-back: 1 partnership, 0 cultural.',
    });
    expect(nav.refresh).toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('keeps the already-erased and 409 toast branches', async () => {
    fetchMock.mockReturnValueOnce(json({ alreadyErased: true, quotaReversals: { partnership: 0, cultural: 0 } }));
    const first = openDialog();
    fireEvent.change(first.reason, { target: { value: 'duplicate' } });
    fireEvent.click(first.confirm);
    await flush();
    expect(toastMock.info).toHaveBeenCalledWith(e.alreadyErasedTitle, { description: e.alreadyErasedDescription });

    fetchMock.mockReturnValueOnce(json({ title: 'event_path_mismatch' }, 409));
    fireEvent.click(screen.getByTestId(`erase-pii-button-${REG}`));
    fireEvent.change(screen.getByLabelText(e.reasonLabel), { target: { value: 'stale' } });
    fireEvent.click(screen.getByRole('button', { name: e.confirm }));
    await flush();
    expect(toastMock.error).toHaveBeenCalledWith(e.pathMismatchTitle, { description: e.pathMismatchDescription });
  });

  it('cannot be dismissed while the request is in flight', async () => {
    let resolve: (r: Response) => void = () => {};
    fetchMock.mockReturnValue(new Promise<Response>((r) => { resolve = r; }));
    const { dialog, reason, confirm } = openDialog();
    fireEvent.change(reason, { target: { value: 'GDPR Art. 17 request' } });
    fireEvent.click(confirm);
    await flush();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await flush();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    resolve({ ok: true, status: 200, json: () => Promise.resolve({ alreadyErased: false, quotaReversals: { partnership: 0, cultural: 0 } }) } as Response);
    await flush();
  });
});
