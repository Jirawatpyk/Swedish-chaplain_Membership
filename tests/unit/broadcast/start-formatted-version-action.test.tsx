// @vitest-environment jsdom
/**
 * F119 T063 UX review — "Start formatted version".
 *
 *   M3  from `submitted` it is the SECONDARY action (Approve is the primary)
 *       and it asks first, without alarm: starting ends the approve-as-
 *       submitted path — the member must approve the formatted version.
 *   H1  a refusal that keeps the confirmation open is said inside it
 *       (`role="alert"`), not by a toast the modal hides from AT.
 *   H2  the trigger turns unavailable while it holds focus, so it is
 *       `aria-disabled` (`focusableWhenDisabled`), never native `disabled`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { toast } from 'sonner';
import enMessages from '@/i18n/messages/en.json';
import {
  StartFormattedVersionAction,
  type StartConfirm,
} from '@/components/broadcast/approval/start-formatted-version-action';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const ID = '11111111-1111-4111-8111-111111111111';
const t = enMessages.admin.broadcasts.approval;

beforeEach(() => {
  vi.useRealTimers();
  vi.mocked(toast.error).mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderStart(confirm: StartConfirm) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <StartFormattedVersionAction broadcastId={ID} confirm={confirm} round={1} />
    </NextIntlClientProvider>,
  );
}
const trigger = () => screen.getByTestId('eblast-start-version');

describe('F119 T063 — Start formatted version (UX review)', () => {
  it('M3: from submitted it is not the primary button, and it asks first — nothing is posted on the click', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    renderStart('leaves_submitted');
    expect(trigger().className).not.toContain('bg-primary');

    fireEvent.click(trigger());
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(t.start.submittedBody);
    expect(fetchMock).not.toHaveBeenCalled();

    const confirm = within(dialog).getByTestId('eblast-start-version-confirm');
    // Non-destructive: nothing is lost that cannot be recovered by the member.
    expect(confirm.className).not.toContain('text-destructive');
    fireEvent.click(confirm);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it('from changes_requested it is the primary action and runs on the click', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    renderStart('none');
    expect(trigger().className).toContain('bg-primary');
    fireEvent.click(trigger());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('H1: a 500 while the void confirmation is open is said inside it, not by a toast', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { code: 'internal_error' } }), { status: 500 })),
    );
    renderStart('voids_approval');
    fireEvent.click(trigger());
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByTestId('eblast-start-version-confirm'));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(t.errors.internal_error);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('H2: while the immediate start runs, the trigger is aria-disabled and keeps focus', async () => {
    let resolve!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => (resolve = r))));
    renderStart('none');
    trigger().focus();
    fireEvent.click(trigger());
    await waitFor(() => expect(trigger()).toHaveAttribute('aria-disabled', 'true'));
    expect(trigger()).not.toHaveAttribute('disabled');
    expect(document.activeElement).toBe(trigger());
    resolve(new Response('{}', { status: 201 }));
  });
});
