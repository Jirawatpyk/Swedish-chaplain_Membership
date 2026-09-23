/**
 * F119 portal live walk U29 — a disabled "Submit for review" names its reason.
 *
 * Measured live 2026-09-22 with a body typed and the subject empty: the button
 * is inert and the page produces NO `role="alert"`, NO `role="status"`, no
 * toast and no mark on the subject field, so a keyboard or SR member hears
 * "Submit for review, button, dimmed" and has no route to the reason
 * (WCAG 3.3.2). This is the THIRD instance of a class already closed twice —
 * U6 on the editor toolbar and U17 on Brand settings, whose shape this copies:
 * `aria-describedby` → the VISIBLE element that states the reason, and nothing
 * at all once the control is enabled.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ComposeForm } from '@/components/broadcast/compose-form';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const countState = vi.hoisted(() => ({
  current: { status: 'idle' } as Record<string, unknown>,
}));
vi.mock('@/components/broadcast/recipient-count', async () => {
  const actual = await vi.importActual<
    typeof import('@/components/broadcast/recipient-count')
  >('@/components/broadcast/recipient-count');
  return { ...actual, useRecipientCount: () => countState.current };
});
vi.mock('@/components/broadcast/preview-pane', () => ({
  PreviewPane: () => <section aria-label="Preview" />,
}));

vi.mock('@/components/ui/tiptap-loader', () => ({
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

function renderForm(): void {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ComposeForm audienceCeiling={5000} audienceMode="primary_only" />
    </NextIntlClientProvider>,
  );
}

const submitButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: 'Submit for review' }) as HTMLButtonElement;

/** The text a screen reader would read out as the button's description. */
function describedText(): string {
  const ids = submitButton().getAttribute('aria-describedby');
  if (ids === null || ids === '') return '';
  return ids
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
    .trim();
}

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
  countState.current = { status: 'idle' };
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('U29 — a disabled Submit is described by the reason it is disabled', () => {
  it('the measured case: body typed, subject empty', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText('Message body'), '<p>Body</p>');

    expect(submitButton()).toBeDisabled();
    expect(submitButton()).toHaveAttribute('aria-describedby');
    expect(describedText().length).toBeGreaterThan(0);
    expect(describedText()).toMatch(/subject/i);
  });

  it('when Submit is enabled it is described by nothing — no phantom reason', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText('Message body'), '<p>Body</p>');
    await user.type(screen.getByLabelText('Subject'), 'A subject');

    await waitFor(() => expect(submitButton()).toBeEnabled());
    expect(submitButton()).not.toHaveAttribute('aria-describedby');
  });

  it('a measured count refusal points at the count line already on the page', async () => {
    countState.current = {
      status: 'ready',
      count: 0,
      ceiling: 500,
      exceeds: false,
      droppedByPreference: 0,
    };
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText('Message body'), '<p>Body</p>');
    await user.type(screen.getByLabelText('Subject'), 'A subject');

    expect(submitButton()).toBeDisabled();
    expect(describedText()).toMatch(/no eligible recipients/i);
  });
});
