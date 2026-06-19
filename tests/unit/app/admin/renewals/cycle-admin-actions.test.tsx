/**
 * DV-5 — `<CycleAdminActions>` visibility-gate tests.
 *
 * The component's key correctness property is its per-status visibility gates:
 * it must NOT offer an action the route would reject (cancel only for
 * upcoming/reminded/awaiting_payment; mark-paid only for upcoming/
 * awaiting_payment; nothing for terminal + pending_admin_reactivation). We
 * assert the gates by rendering the component — the trigger Buttons live
 * OUTSIDE the Base UI Dialog, so checking their presence does NOT open a
 * dialog.
 *
 * Endpoint+body wiring is NOT asserted by opening a dialog here: opening a
 * Base UI Dialog/AlertDialog under jsdom + React 19 `startTransition`
 * deadlocks (the dialog-jsdom-hang memory — confirmed: a click-to-open + fill
 * + confirm flow times out at 30s in this repo). The endpoint shape is pinned
 * two other ways instead:
 *   - `cycle-admin-error-i18n.test.ts` — the error-code lists the component
 *     maps to toasts are kept in lock-step with the route `switch` arms + the
 *     EN i18n keys (the mock-next-intl / parity-only `check:i18n` blind spot).
 *   - the routes themselves (`cancel/route.ts`, `mark-paid-offline/route.ts`)
 *     are pre-existing + independently tested.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { CycleAdminActions } from '@/app/(staff)/admin/renewals/[cycleId]/_components/cycle-admin-actions';
import type { CycleStatus } from '@/modules/renewals';
import enMessages from '@/i18n/messages/en.json';

const refreshMock = vi.fn();
const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock, push: pushMock }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const CYCLE_ID = '11111111-1111-1111-1111-111111111111';

function renderActions(status: CycleStatus) {
  return render(
    <NextIntlClientProvider
      locale="en"
      messages={enMessages as Record<string, unknown>}
    >
      <CycleAdminActions cycleId={CYCLE_ID} status={status} />
    </NextIntlClientProvider>,
  );
}

describe('<CycleAdminActions> — DV-5 visibility gates', () => {
  beforeEach(() => {
    refreshMock.mockReset();
    pushMock.mockReset();
  });
  afterEach(() => cleanup());

  it.each<CycleStatus>(['upcoming', 'awaiting_payment'])(
    'renders BOTH cancel + mark-paid controls for status=%s',
    (status) => {
      renderActions(status);
      expect(
        screen.getByRole('button', { name: 'Cancel cycle' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Mark paid offline' }),
      ).toBeInTheDocument();
    },
  );

  it('renders ONLY the cancel control for status=reminded (not payable)', () => {
    renderActions('reminded');
    expect(
      screen.getByRole('button', { name: 'Cancel cycle' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Mark paid offline' }),
    ).not.toBeInTheDocument();
  });

  it.each<CycleStatus>([
    'completed',
    'lapsed',
    'cancelled',
    'pending_admin_reactivation',
  ])('renders NOTHING for terminal/pending status=%s', (status) => {
    const { container } = renderActions(status);
    expect(
      screen.queryByRole('button', { name: 'Cancel cycle' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Mark paid offline' }),
    ).not.toBeInTheDocument();
    // The component returns null → no DOM at all.
    expect(container).toBeEmptyDOMElement();
  });
});
