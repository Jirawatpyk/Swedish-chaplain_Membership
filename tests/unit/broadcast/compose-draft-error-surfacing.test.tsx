/**
 * F119 portal live walk U28 — the second layer (US6-AS9, FR-048).
 *
 * `onSubmit` maps a server error code to a FIELD through `ERROR_CODE_FIELD`,
 * so the offending control gets `aria-invalid`, an inline `role="alert"` and
 * focus. `onSaveDraft` never consulted that map: a refused draft save toasted
 * and nothing else — measured live 2026-09-22, `aria-invalid: null` on
 * `#broadcast-subject` throughout.
 *
 * The route half of this finding (a correctable refusal answered
 * `invalid_body`, which has no key in any locale, so the toast read "An
 * unexpected error occurred") is pinned in
 * `tests/contract/broadcasts/post-broadcasts-draft.contract.test.ts`.
 *
 * Rendered under `NextIntlClientProvider` with the REAL `en.json` so a dangling
 * `t()` reference fails here rather than shipping a raw key path.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { toast } from '@/lib/toast';
import enMessages from '@/i18n/messages/en.json';
import { ComposeForm } from '@/components/broadcast/compose-form';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/components/broadcast/recipient-count', () => ({
  useRecipientCount: () => ({ status: 'idle' }),
  RecipientCountLine: () => null,
}));
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

const QUOTA = {
  quotaYear: 2026,
  used: 0,
  reserved: 0,
  remaining: 3,
  cap: 3,
  planName: null,
};

/** Quota answers normally; the draft save refuses with `code`. */
function stubFetch(code: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/api/broadcasts/draft')) {
        return {
          ok: false,
          status: 422,
          json: async () => ({ error: { code } }),
        };
      }
      return { ok: true, status: 200, json: async () => QUOTA };
    }),
  );
}

function renderForm(): void {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ComposeForm audienceCeiling={5000} audienceMode="primary_only" />
    </NextIntlClientProvider>,
  );
}

const subjectInput = (): HTMLInputElement =>
  screen.getByLabelText('Subject') as HTMLInputElement;

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
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('U28 — a refused draft save lands on the field, in the member’s words', () => {
  it('surfaces the translated message and marks the subject invalid', async () => {
    stubFetch('broadcast_subject_empty');
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText('Message body'), '<p>Body</p>');
    await user.click(screen.getByRole('button', { name: 'Save as draft' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Subject is required.'),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Subject is required.',
    );
    expect(subjectInput()).toHaveAttribute('aria-invalid', 'true');
    expect(subjectInput()).toHaveFocus();
  });

  it('a code with no locale key still falls back to the generic message', async () => {
    stubFetch('some_code_no_locale_carries');
    const user = userEvent.setup();
    renderForm();

    await user.type(subjectInput(), 'A subject');
    await user.click(screen.getByRole('button', { name: 'Save as draft' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'An unexpected error occurred. Please try again.',
      ),
    );
    expect(subjectInput()).not.toHaveAttribute('aria-invalid');
  });
});
