// @vitest-environment jsdom
/**
 * #400 item 7 — the older F7 staff dialogs (approve, reject, clear halt) under
 * the READ_ONLY_MODE write freeze.
 *
 * The proxy answers every write 503 `{ error: 'read-only-mode' }` while the
 * freeze is on. These dialogs predate F119 and read only their own status
 * codes, so the operator saw the generic "something went wrong" — a toast
 * under the open modal, hidden from AT, advising a retry that cannot work until
 * the freeze lifts. Each now does what PR #392 review D4/D5 made the F119
 * approval dialogs do (`approval-staff-read-only.test.tsx`): the dialog STAYS
 * open and says it inside itself — main #390's whole warning (title AND
 * "nothing was changed"), in the warning tone, focused — with no toast under
 * it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { toast } from 'sonner';
import en from '@/i18n/messages/en.json';
import { ApproveDialog } from '@/components/broadcast/admin/approve-dialog';
import { RejectDialog } from '@/components/broadcast/admin/reject-dialog';
import { ClearHaltDialog } from '@/components/broadcast/admin/clear-halt-dialog';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const ID = '11111111-1111-4111-8111-111111111111';
const B = en.admin.broadcasts;
const COMPANY = 'Acme Trading Co';

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
}

const SURFACES: readonly Surface[] = [
  {
    name: 'approve',
    ui: () => <ApproveDialog broadcastId={ID} open onOpenChange={vi.fn()} recipientCount={12} />,
    act: async () => {
      fireEvent.click(await screen.findByRole('button', { name: B.approveDialog.confirm }));
    },
  },
  {
    name: 'reject',
    ui: () => <RejectDialog broadcastId={ID} open onOpenChange={vi.fn()} />,
    act: async () => {
      fireEvent.change(await screen.findByLabelText(new RegExp(B.rejectDialog.reasonLabel, 'i')), {
        target: { value: 'Off-topic for the audience' },
      });
      fireEvent.click(screen.getByRole('button', { name: B.rejectDialog.confirm }));
    },
  },
  {
    name: 'clear halt',
    ui: () => <ClearHaltDialog memberId="22222222-2222-4222-8222-222222222222" memberDisplayName={COMPANY} />,
    act: async () => {
      fireEvent.click(screen.getByRole('button', { name: B.haltBanner.clearAction }));
      const dialog = await screen.findByRole('alertdialog');
      fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: COMPANY } });
      fireEvent.click(within(dialog).getByRole('button', { name: B.clearHaltDialog.confirm }));
    },
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

describe('an F7 staff dialog whose write the read-only proxy refused', () => {
  it.each(SURFACES)('$name stays open and says the system is read-only inside itself — no toast', async (s) => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        {s.ui()}
      </NextIntlClientProvider>,
    );
    await s.act();

    const dialog = screen.getByRole('alertdialog');
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(en.errors.readOnlyMode);
    expect(alert).toHaveTextContent(en.errors.readOnlyNothingChanged);
    expect(alert).toHaveAttribute('data-tone', 'warning');
    await waitFor(() => expect(alert).toHaveFocus());
    expect(toast.error, 'a freeze is not a failure a retry now can fix').not.toHaveBeenCalled();
    expect(toast.warning, 'the dialog is the one channel — a toast would sit behind the modal').not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });
});
