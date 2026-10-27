// @vitest-environment jsdom
/**
 * Spec 122 US12d-3 (T1265) — Submit opens a confirmation before anything is
 * sent (the maintainer, 26 Oct 2026). The dialog sums up what the member is
 * about to spend an E-Blast on: the subject, the recipients with their count,
 * the allowance it uses (the live quota, not the page's first paint) and when
 * it goes out. Keep editing sends nothing; Submit for review sends the same
 * payload as before.
 *
 * Rendered under the REAL `en.json` so a dangling key fails here.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ComposeForm } from '@/components/broadcast/compose-form';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const READY = { status: 'ready', count: 128, ceiling: 500, exceeds: false } as const;
vi.mock('@/components/broadcast/recipient-count', () => ({
  useRecipientCount: () => READY,
  RecipientCountLine: () => null,
}));
vi.mock('@/components/broadcast/preview-pane', () => ({
  PreviewPane: () => <section aria-label="Preview" />,
}));

vi.mock('@/components/shell/tiptap-loader', () => ({
  loadTiptapEditor: () =>
    function TiptapStub(props: {
      initialHtml: string;
      onChange: (html: string) => void;
    }): React.ReactElement {
      return (
        <textarea
          aria-label="Message body"
          defaultValue={props.initialHtml}
          onChange={(e) => props.onChange(e.target.value)}
        />
      );
    },
}));

const c = enMessages.portal.broadcasts.compose;
const INITIAL_QUOTA = { quotaYear: 2026, used: 3, reserved: 0, remaining: 3, cap: 6, planName: null };
/** The quota the page fetches after first paint: one more is reserved by now. */
const LIVE_QUOTA = { quotaYear: 2026, used: 3, reserved: 1, remaining: 2, cap: 6, planName: null };

let fetchMock: ReturnType<typeof vi.fn>;
const submitCalls = (): unknown[][] =>
  fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/broadcasts/submit'));

function renderForm(subject = 'Nordic Leadership Breakfast', extra: { acknowledgedAt?: string | null } = {}): void {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ComposeForm
        audienceCeiling={500}
        audienceMode="primary_only"
        initialSubject={subject}
        initialBodyHtml="<p>Seats are limited.</p>"
        initialQuota={INITIAL_QUOTA}
        {...extra}
      />
    </NextIntlClientProvider>,
  );
}

const submitButton = (): HTMLElement => screen.getByRole('button', { name: c.button.submit });

beforeAll(() => {
  if (typeof globalThis.PointerEvent === 'undefined') {
    // @ts-expect-error — minimal polyfill for jsdom (Base UI dispatches these)
    globalThis.PointerEvent = class PointerEvent extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, params?: PointerEventInit) {
        super(type, params);
        this.pointerId = params?.pointerId ?? 0;
      }
    };
  }
});

beforeEach(() => {
  vi.useRealTimers();
  fetchMock = vi.fn(async (input: unknown) => {
    if (String(input).includes('/api/broadcasts/submit')) {
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ broadcastId: 'b-1' }) };
    }
    return { ok: true, status: 200, headers: new Headers(), json: async () => LIVE_QUOTA };
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('member compose — Submit asks first (T1265)', () => {
  it('opens the confirmation and sends nothing', async () => {
    renderForm();
    await userEvent.setup().click(submitButton());
    expect(await screen.findByRole('alertdialog', { name: c.confirm.title })).toBeInTheDocument();
    expect(submitCalls()).toHaveLength(0);
  });

  it('sums up the subject, the recipients with their count, the live allowance and the sending', async () => {
    renderForm();
    // The quota card has fetched the live numbers before the member submits.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/broadcasts/quota', expect.anything()));
    await userEvent.setup().click(submitButton());
    const dialog = await screen.findByRole('alertdialog');
    const text = dialog.textContent ?? '';
    expect(text).toContain('Nordic Leadership Breakfast');
    expect(text).toContain('All members · 128 recipients');
    expect(text).toContain("Uses 1 of your 2 remaining E-Blasts for 2026 (reserved until it's sent)");
    expect(text).toContain("As soon as it's approved");
  });

  it('a scheduled send is stated in Bangkok time', async () => {
    renderForm();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: new RegExp(c.fields.sendOptions) }));
    fireEvent.change(screen.getByLabelText(new RegExp(c.fields.schedulePicker)), {
      target: { value: '2099-11-03T09:30' },
    });
    await user.click(submitButton());
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('3 November 2099 at 09:30, Bangkok time');
  });

  it('Keep editing closes it, sends nothing, and gives focus back to Submit', async () => {
    renderForm();
    const user = userEvent.setup();
    await user.click(submitButton());
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: c.confirm.keepEditing }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(submitCalls()).toHaveLength(0);
    await waitFor(() => expect(document.activeElement).toBe(submitButton()));
  });

  it('Submit for review in the dialog sends the same payload as before', async () => {
    renderForm();
    const user = userEvent.setup();
    await user.click(submitButton());
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: c.button.submit }));
    await waitFor(() => expect(submitCalls()).toHaveLength(1));
    const init = submitCalls()[0]![1] as { body: string };
    expect(JSON.parse(init.body)).toMatchObject({
      subject: 'Nordic Leadership Breakfast',
      bodyHtml: '<p>Seats are limited.</p>',
      segment: { kind: 'all_members' },
      scheduledFor: null,
    });
  });

  it('a form that cannot be sent never opens the dialog', async () => {
    renderForm('');
    await userEvent.setup().click(submitButton());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(submitCalls()).toHaveLength(0);
  });
});

// Spec 122 PR C — the sending rules explain; they never gate. With the rules
// open and unacknowledged, Submit still asks and sends as before.
describe('the sending rules do not gate Submit (spec 122 PR C)', () => {
  it('with the rules unacknowledged, Submit opens the summary and confirm sends', async () => {
    renderForm('Nordic Leadership Breakfast', { acknowledgedAt: null });
    expect(screen.getByTestId('compose-sending-rules')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(submitButton());
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: c.button.submit }));
    await waitFor(() => expect(submitCalls()).toHaveLength(1));
  });
});
