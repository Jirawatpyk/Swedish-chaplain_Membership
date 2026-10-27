// @vitest-environment jsdom
/**
 * Spec 122 US12d-3 (T1272) — review round 1 on the member compose form:
 * - focus after confirming lands on Submit (it was natively disabled while
 *   sending, so AURA's restore failed and focus fell to <body>);
 * - a refusal sent from the phone's Preview tab brings the Write tab back
 *   before focusing the field (a hidden panel cannot take focus);
 * - the summary never states an allowance the card no longer shows, and says
 *   so plainly when none is left;
 * - the phone bar says why Submit is off when the audience is refused;
 * - Send options can go back to "as soon as it's approved" in one press.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

const bp = vi.hoisted(() => ({ current: 'lg' as 'base' | 'lg' }));
vi.mock('@jirawatpyk/aura-react', async (orig) => ({
  ...(await orig<typeof import('@jirawatpyk/aura-react')>()),
  useBreakpoint: () => bp.current,
}));
const count = vi.hoisted(() => ({
  current: { status: 'ready', count: 128, ceiling: 500, exceeds: false } as Record<string, unknown>,
}));
vi.mock('@/components/broadcast/recipient-count', async (orig) => ({
  ...(await orig<typeof import('@/components/broadcast/recipient-count')>()),
  useRecipientCount: () => count.current,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('@/components/broadcast/preview-pane', () => ({
  PreviewPane: () => <section aria-label="Email preview" />,
}));
vi.mock('@/components/shell/tiptap-loader', () => ({
  loadTiptapEditor: () =>
    function TiptapStub(props: { initialHtml: string; onChange: (html: string) => void }): React.ReactElement {
      return (
        <textarea
          aria-label="Message body"
          defaultValue={props.initialHtml}
          onChange={(e) => props.onChange(e.target.value)}
        />
      );
    },
}));

const { ComposeForm } = await import('@/components/broadcast/compose-form');
const { RecipientCountLine } = await import('@/components/broadcast/recipient-count');
const c = enMessages.portal.broadcasts.compose;
const QUOTA = { quotaYear: 2026, used: 3, reserved: 0, remaining: 3, cap: 6, planName: null };

type Reply = { status: number; body: unknown };
let submitReply: Reply;
let quotaReply: Reply;
let fetchMock: ReturnType<typeof vi.fn>;

function respond({ status, body }: Reply) {
  return { ok: status < 400, status, headers: new Headers(), json: async () => body };
}

function renderForm(): void {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ComposeForm
        audienceCeiling={500}
        audienceMode="primary_only"
        initialSubject="Nordic Leadership Breakfast"
        initialBodyHtml="<p>Seats are limited.</p>"
        initialQuota={QUOTA}
      />
    </NextIntlClientProvider>,
  );
}

const visibleSubmit = (): HTMLElement => screen.getByRole('button', { name: c.button.submit });

async function confirmSubmit(): Promise<void> {
  const user = userEvent.setup();
  await user.click(visibleSubmit());
  const dialog = await screen.findByRole('alertdialog');
  await user.click(within(dialog).getByRole('button', { name: c.button.submit }));
}

beforeEach(() => {
  vi.useRealTimers();
  bp.current = 'lg';
  count.current = { status: 'ready', count: 128, ceiling: 500, exceeds: false };
  submitReply = { status: 200, body: { broadcastId: 'b-1' } };
  quotaReply = { status: 200, body: QUOTA };
  fetchMock = vi.fn(async (input: unknown) =>
    respond(String(input).includes('/api/broadcasts/submit') ? submitReply : quotaReply),
  );
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('focus after the summary', () => {
  it('a refusal with no field of its own leaves focus on Submit, not on the page', async () => {
    submitReply = { status: 500, body: { error: { code: 'internal_error', message: 'x' } } };
    renderForm();
    await confirmSubmit();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(visibleSubmit()));
  });

  it('on a phone, a subject refusal sent from the Preview tab opens Write and focuses the subject', async () => {
    bp.current = 'base';
    submitReply = { status: 400, body: { error: { code: 'broadcast_subject_too_long', message: 'x' } } };
    renderForm();
    await userEvent.setup().click(screen.getByRole('tab', { name: c.views.preview }));
    await confirmSubmit();
    await waitFor(() => expect(screen.getByRole('tab', { name: c.views.write })).toHaveAttribute('aria-selected', 'true'));
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById('broadcast-subject')));
  });
});

describe('the allowance the summary states', () => {
  it('says nothing about the allowance when the quota could not be loaded', async () => {
    quotaReply = { status: 500, body: {} };
    renderForm();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/broadcasts/quota', expect.anything()));
    await userEvent.setup().click(visibleSubmit());
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).queryByText(c.confirm.allowance)).toBeNull();
  });

  it('says plainly when none is left', async () => {
    quotaReply = { status: 200, body: { ...QUOTA, used: 6, remaining: 0 } };
    renderForm();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/broadcasts/quota', expect.anything()));
    await userEvent.setup().click(visibleSubmit());
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent("You have no E-Blasts left for 2026, so this can't be submitted");
    expect(dialog).not.toHaveTextContent('Uses 1 of your 0');
  });
});

describe('the phone bar', () => {
  it('says the audience is refused instead of a plain count', () => {
    bp.current = 'base';
    count.current = { status: 'ready', count: 1240, ceiling: 500, exceeds: true };
    renderForm();
    const bar = screen.getByRole('region', { name: c.views.actions });
    expect(bar).toHaveTextContent(c.views.blocked);
    expect(bar).not.toHaveTextContent('1,240 recipients');
  });
});

describe('Send options', () => {
  it('one press goes back to "as soon as it\'s approved"', async () => {
    renderForm();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: new RegExp(c.fields.sendOptions) }));
    fireEvent.change(screen.getByLabelText(new RegExp(c.fields.schedulePicker)), {
      target: { value: '2099-11-03T09:30' },
    });
    await user.click(screen.getByRole('button', { name: c.fields.scheduleClear }));
    expect(screen.getByLabelText(new RegExp(c.fields.schedulePicker))).toHaveValue('');
    expect(screen.getByRole('button', { name: new RegExp(c.fields.sendOptions) })).toHaveTextContent(
      c.confirm.sendingNow,
    );
  });
});

describe('review round 2', () => {
  it('with none left, the summary\'s Submit is off as well', async () => {
    quotaReply = { status: 200, body: { ...QUOTA, used: 6, remaining: 0 } };
    renderForm();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/broadcasts/quota', expect.anything()));
    await userEvent.setup().click(visibleSubmit());
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('button', { name: c.button.submit })).toBeDisabled();
  });

  it('a refusal with nothing to focus leaves the Preview tab open', async () => {
    bp.current = 'base';
    submitReply = { status: 500, body: { error: { code: 'internal_error', message: 'x' } } };
    renderForm();
    await userEvent.setup().click(screen.getByRole('tab', { name: c.views.preview }));
    await confirmSubmit();
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/submit'))).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole('tab', { name: c.views.preview })).toHaveAttribute('aria-selected', 'true');
  });

  it('who the recipients are is said while the count is still coming', () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <RecipientCountLine state={{ status: 'loading' } as never} note="not Acme's own contacts" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent("Counting recipients… · not Acme's own contacts");
  });

  it('clearing the schedule keeps focus in Send options', async () => {
    renderForm();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: new RegExp(c.fields.sendOptions) }));
    fireEvent.change(screen.getByLabelText(new RegExp(c.fields.schedulePicker)), {
      target: { value: '2099-11-03T09:30' },
    });
    await user.click(screen.getByRole('button', { name: c.fields.scheduleClear }));
    expect(document.activeElement).toBe(screen.getByLabelText(new RegExp(c.fields.schedulePicker)));
  });
});
