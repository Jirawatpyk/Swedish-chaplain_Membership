// @vitest-environment jsdom
/**
 * PR #392 review C1 — the F119 staff approval controls under the READ_ONLY_MODE
 * write freeze.
 *
 * While the freeze is on, the proxy answers every write 503 with a FLAT
 * `{ error: 'read-only-mode' }`. These controls read only the NESTED
 * `error.code`, found nothing, and said "Something went wrong. Please try
 * again." — advice that cannot work until the freeze lifts. Each now says the
 * system is read-only (main #390's `useReadOnlyToast` warning).
 *
 * PR #392 review D4/D5 — a control whose dialog STAYS open says it inside the
 * dialog ONLY: the whole warning (title AND "nothing was changed"), in the
 * warning tone, focused. A toast there sat behind the modal, hidden from AT,
 * and said the same thing twice. Where no dialog stays open, the toast is the
 * one channel.
 *
 * Table-driven like `read-only-member-surfaces.test.tsx`: the defect and the
 * fix have the same shape at every site. The workspace's save and send are
 * pinned in `formatted-version-workspace.test.tsx` (its editor doubles live
 * there).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { toast } from 'sonner';
import en from '@/i18n/messages/en.json';
import { ScheduleConfirmAction } from '@/components/broadcast/approval/schedule-confirm-dialog';
import { StartFormattedVersionAction } from '@/components/broadcast/approval/start-formatted-version-action';
import { TestCopyButton } from '@/components/broadcast/approval/test-copy-button';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const ID = '11111111-1111-4111-8111-111111111111';

/** `src/proxy.ts` `build503`, verbatim. */
function readOnly503(): Response {
  return new Response(
    JSON.stringify({
      error: 'read-only-mode',
      message: 'The system is currently in read-only mode for maintenance.',
      retryAfterSeconds: 300,
      supportUrl: '/admin/support',
    }),
    { status: 503, headers: { 'content-type': 'application/json', 'Retry-After': '300' } },
  );
}

interface Surface {
  readonly name: string;
  readonly ui: () => React.ReactElement;
  readonly act: () => Promise<void>;
  /** `dialog` — a dialog stays open over the refusal and is the ONE channel; `toast` — nothing stays open. */
  readonly channel: 'dialog' | 'toast';
}

const SURFACES: readonly Surface[] = [
  {
    name: 'schedule confirmation',
    ui: () => (
      <ScheduleConfirmAction
        broadcastId={ID}
        status="member_approved"
        proposedSendAt={new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()}
        scheduledFor={null}
      />
    ),
    act: async () => {
      fireEvent.click(screen.getByTestId('schedule-confirm-trigger'));
      await screen.findByRole('alertdialog');
      fireEvent.click(screen.getByTestId('schedule-confirm-submit'));
    },
    channel: 'dialog',
  },
  {
    name: 'start a formatted version (asks first)',
    ui: () => <StartFormattedVersionAction broadcastId={ID} confirm="voids_approval" round={1} />,
    act: async () => {
      fireEvent.click(screen.getByTestId('eblast-start-version'));
      fireEvent.click(await screen.findByTestId('eblast-start-version-confirm'));
    },
    channel: 'dialog',
  },
  {
    name: 'start a formatted version (immediate)',
    ui: () => <StartFormattedVersionAction broadcastId={ID} confirm="none" round={1} />,
    act: async () => {
      fireEvent.click(screen.getByTestId('eblast-start-version'));
    },
    channel: 'toast',
  },
  {
    name: 'send a test copy',
    ui: () => <TestCopyButton broadcastId={ID} versionId="v1" subject="Subject" bodyHtml="<p>x</p>" />,
    act: async () => {
      fireEvent.click(screen.getByTestId('eblast-test-copy'));
    },
    channel: 'toast',
  },
];

beforeAll(() => {
  if (typeof globalThis.PointerEvent === 'undefined') {
    // @ts-expect-error — minimal polyfill for jsdom (Base UI dispatches these)
    globalThis.PointerEvent = class PointerEvent extends MouseEvent {
      readonly pointerId: number;
      constructor(t: string, params?: PointerEventInit) {
        super(t, params);
        this.pointerId = params?.pointerId ?? 0;
      }
    };
  }
});

beforeEach(() => {
  vi.useRealTimers();
  vi.stubGlobal('fetch', vi.fn(async () => readOnly503()));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('an F119 staff approval write refused by the read-only proxy', () => {
  it.each(SURFACES)('$name says the system is read-only, never the generic error', async (s) => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        {s.ui()}
      </NextIntlClientProvider>,
    );
    await s.act();

    if (s.channel === 'dialog') {
      const dialog = screen.getByRole('alertdialog');
      const alert = await within(dialog).findByRole('alert');
      expect(alert).toHaveTextContent(en.errors.readOnlyMode);
      expect(alert).toHaveTextContent(en.errors.readOnlyNothingChanged);
      expect(alert).toHaveAttribute('data-tone', 'warning');
      await waitFor(() => expect(alert).toHaveFocus());
      expect(toast.warning, 'the dialog is the one channel — a toast would sit behind the modal').not.toHaveBeenCalled();
    } else {
      await waitFor(() =>
        expect(toast.warning).toHaveBeenCalledWith(en.errors.readOnlyMode, {
          description: en.errors.readOnlyNothingChanged,
        }),
      );
    }
    expect(toast.error, 'a freeze is not a failure a retry now can fix').not.toHaveBeenCalled();
    expect(screen.queryByText(en.admin.broadcasts.approval.errors.generic)).toBeNull();
  });
});
