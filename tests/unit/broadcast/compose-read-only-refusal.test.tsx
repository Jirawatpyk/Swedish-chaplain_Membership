// @vitest-environment jsdom
/**
 * Portal error states #1 — a read-only 503 on compose submit.
 *
 * While `READ_ONLY_MODE=true`, `src/proxy.ts` (`build503`) answers the submit
 * with a FLAT `{ error: 'read-only-mode' }` and `Retry-After: 300`. The form
 * read `responseBody.error?.code`, found nothing on a string, and toasted
 * "An unexpected error occurred" — advice that cannot work until the freeze
 * lifts. The approved copy (AURA canvas "Compose — read-only, hit on submit")
 * says what happened, that nothing was spent, and when to try again.
 *
 * Rendered under the REAL `en.json` so a dangling key fails here.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { toast } from 'sonner';
import enMessages from '@/i18n/messages/en.json';
import { ComposeForm } from '@/components/broadcast/compose-form';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('sonner', () => ({
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

const QUOTA = { quotaYear: 2026, used: 0, reserved: 0, remaining: 3, cap: 3, planName: null };

/** The proxy's read-only answer — flat `error`, optional `Retry-After`. */
function stubReadOnlySubmit(retryAfter: string | null): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      if (String(input).includes('/api/broadcasts/submit') || String(input).includes('/api/broadcasts/draft')) {
        return {
          ok: false,
          status: 503,
          headers: new Headers(retryAfter === null ? {} : { 'Retry-After': retryAfter }),
          json: async () => ({
            error: 'read-only-mode',
            message: 'The system is currently in read-only mode for maintenance.',
            retryAfterSeconds: 300,
            supportUrl: '/admin/support',
          }),
        };
      }
      return { ok: true, status: 200, headers: new Headers(), json: async () => QUOTA };
    }),
  );
}

async function composeAndSubmit(): Promise<void> {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ComposeForm
        audienceCeiling={5000}
        audienceMode="primary_only"
        initialSubject="Spring mixer"
        initialBodyHtml="<p>See you there</p>"
      />
    </NextIntlClientProvider>,
  );
  await userEvent.setup().click(screen.getByRole('button', { name: /submit/i }));
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
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('compose submit refused by the read-only proxy', () => {
  it('shows the read-only alert with the Retry-After minutes, focused, and no toast', async () => {
    stubReadOnlySubmit('300');
    await composeAndSubmit();

    const alert = await screen.findByTestId('compose-read-only-alert');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveAttribute('data-tone', 'warning');
    expect(alert).toHaveTextContent(
      'Not submitted — the system is in read-only mode for maintenance.',
    );
    expect(alert).toHaveTextContent('Nothing was sent and no E-Blast slot was used.');
    expect(alert).toHaveTextContent('try again in about 5 minutes.');
    await waitFor(() => expect(alert).toHaveFocus());
    expect(toast.error, 'the alert IS the message — a toast would say it twice').not.toHaveBeenCalled();
  });

  it('says "shortly" when the response carries no Retry-After', async () => {
    stubReadOnlySubmit(null);
    await composeAndSubmit();

    const alert = await screen.findByTestId('compose-read-only-alert');
    expect(alert).toHaveTextContent('keep it open and try again shortly.');
  });

  it('keeps the typed message on the page', async () => {
    stubReadOnlySubmit('300');
    await composeAndSubmit();

    await screen.findByTestId('compose-read-only-alert');
    expect(screen.getByLabelText('Subject')).toHaveValue('Spring mixer');
    expect(screen.getByLabelText('Message body')).toHaveValue('<p>See you there</p>');
  });
});

describe('compose draft save refused by the read-only proxy', () => {
  it('shows the draft variant of the alert — nothing about an E-Blast slot — focused, no toast', async () => {
    stubReadOnlySubmit('300');
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ComposeForm
          audienceCeiling={5000}
          audienceMode="primary_only"
          initialSubject="Spring mixer"
          initialBodyHtml="<p>See you there</p>"
        />
      </NextIntlClientProvider>,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save as draft' }));

    const alert = await screen.findByTestId('compose-read-only-alert');
    expect(alert).toHaveTextContent(enMessages.portal.broadcasts.compose.readOnly.draftTitle);
    expect(alert).toHaveTextContent('try again in about 5 minutes.');
    expect(alert).not.toHaveTextContent('E-Blast slot');
    await waitFor(() => expect(alert).toHaveFocus());
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Subject')).toHaveValue('Spring mixer');
  });
});
