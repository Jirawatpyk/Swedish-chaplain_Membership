/**
 * `<OutreachDialog>` on AURA (spec 122 US7a, T706): an AURA alertdialog with
 * the channel and email-template selects, the optional outcome note with its
 * counter, and the same request body as before (`channel`, `template_id`
 * for email only, a trimmed `outcome_note` when given). A note over the
 * limit is an error on the field and blocks Record outreach.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { OutreachDialog } from '@/app/(staff)/admin/renewals/_components/outreach-dialog';

/** AURA Select keeps a real <select> under its listbox: pick by changing it (US5a precedent). */
function pickNative(label: string, value: string) {
  const native = screen.getByRole('combobox', { name: label }).closest('.aura-select')?.querySelector('select');
  if (!native) throw new Error(`no native select for ${label}`);
  fireEvent.change(native, { target: { value } });
}

function renderDialog() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <OutreachDialog open onOpenChange={vi.fn()} memberId="m-1" memberCompanyName="Acme Co" />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => vi.useRealTimers());

describe('OutreachDialog on AURA', () => {
  it('is an AURA alertdialog with Channel and Email template selects', () => {
    renderDialog();
    const dialog = screen.getByRole('alertdialog', { name: 'Record outreach' });
    expect(dialog).toHaveClass('aura-dialog');
    expect(within(dialog).getByRole('combobox', { name: 'Channel' })).toHaveTextContent('Email');
    expect(within(dialog).getByRole('combobox', { name: 'Email template' })).toHaveTextContent(
      'Event drought re-engagement',
    );
  });

  it('a phone call drops the template and sends channel + trimmed note', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    renderDialog();
    pickNative('Channel', 'phone');
    expect(screen.queryByRole('combobox', { name: 'Email template' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Outcome note (optional)' }), {
      target: { value: '  Called, will renew  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record outreach' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ channel: 'phone', outcome_note: 'Called, will renew' });
    vi.unstubAllGlobals();
  });

  it('a note over 500 characters is a field error and blocks Record outreach', () => {
    renderDialog();
    const note = screen.getByRole('textbox', { name: 'Outcome note (optional)' });
    fireEvent.change(note, { target: { value: 'x'.repeat(501) } });
    expect(note).toHaveAttribute('aria-invalid', 'true');
    expect(note).toHaveAccessibleDescription(/501 \/ 500 characters/);
    expect(screen.getByRole('button', { name: 'Record outreach' })).toBeDisabled();
  });
});
