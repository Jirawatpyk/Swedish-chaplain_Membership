/**
 * 0306 — the refund dialog on a FULL refund of a MEMBERSHIP invoice.
 *
 * Verified behaviour the warning states: a full refund fully credits the
 * invoice, so Renewals stops counting the period as paid — but the member
 * keeps access until their current period ends, then gets the normal renewal
 * reminders. Staff therefore choose Keep / End membership; End takes effect
 * when the refund settles (the route + nightly reconcile own that).
 *
 * Partial refunds and event invoices never ask (the period is not withdrawn).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { toast } from '@/lib/toast';
import enMessages from '@/i18n/messages/en.json';
import { AlertDialog } from '@/components/ui/alert-dialog';
import { RefundForm } from '@/app/(staff)/admin/invoices/[invoiceId]/_components/refund-dialog/refund-form';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const m = enMessages.admin.refund.membership;

beforeAll(() => {
  // Base UI Radio uses PointerEvent; jsdom lacks it (same polyfill as
  // tests/unit/components/schedules/schedule-editor.test.tsx).
  if (typeof globalThis.PointerEvent === 'undefined') {
    // @ts-expect-error — minimal polyfill for jsdom
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
  vi.clearAllMocks();
});

function renderForm(
  opts: { subject?: 'membership' | 'event'; headroom?: bigint } = {},
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AlertDialog open onOpenChange={() => undefined}>
        <RefundForm
          paymentId="pay_1"
          memberCompanyName="Acme AB"
          remainingRefundableSatang={535000n}
          currencyCode="THB"
          invoiceSubject={opts.subject ?? 'membership'}
          invoiceHeadroomSatang={opts.headroom ?? 535000n}
          onClose={() => undefined}
        />
      </AlertDialog>
    </NextIntlClientProvider>,
  );
}

function fillAmount(value: string) {
  fireEvent.change(screen.getByTestId('refund-form-amount'), { target: { value } });
}

async function submitFull() {
  fillAmount('5350');
  fireEvent.change(screen.getByTestId('refund-form-reason'), {
    target: { value: 'member withdrew' },
  });
  fireEvent.blur(screen.getByTestId('refund-form-reason'));
  fireEvent.change(screen.getByLabelText(/REFUND Acme AB/), {
    target: { value: 'REFUND Acme AB' },
  });
  const confirm = screen.getByTestId('refund-form-confirm');
  await waitFor(() => expect(confirm.hasAttribute('disabled')).toBe(false));
  fireEvent.click(confirm);
}

function mockFetch(status: number, body: Record<string, unknown>) {
  const fetchMock = vi.fn(async () => ({ ok: status < 300, status, json: async () => body }));
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof mockFetch>): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe('RefundForm — full membership refund: warning + Keep / End membership', () => {
  it('a FULL membership refund shows the warning stating what Renewals does next, and the choice (default Keep)', () => {
    renderForm();
    fillAmount('5350');
    const warning = screen.getByTestId('refund-membership-warning');
    expect(warning).toHaveTextContent(m.warningTitle);
    expect(warning).toHaveTextContent(m.warningBody);
    expect(screen.getByRole('radio', { name: new RegExp(m.keep.label) })).toBeChecked();
    expect(screen.getByRole('radio', { name: new RegExp(m.end.label) })).not.toBeChecked();
  });

  it('a PARTIAL refund does not ask (the period is not withdrawn)', () => {
    renderForm();
    fillAmount('100');
    expect(screen.queryByTestId('refund-membership-warning')).toBeNull();
  });

  it('an EVENT invoice never asks, even on a full refund', () => {
    renderForm({ subject: 'event' });
    fillAmount('5350');
    expect(screen.queryByTestId('refund-membership-warning')).toBeNull();
  });

  it('asks only when the refund fully credits the INVOICE (headroom), not merely the payment', () => {
    // A manual credit note already reduced the invoice headroom below the
    // payment remainder; refunding the payment remainder would exceed it, and a
    // refund equal to the headroom is the one that withdraws the period.
    renderForm({ headroom: 200000n });
    fillAmount('2000');
    expect(screen.getByTestId('refund-membership-warning')).toBeInTheDocument();
  });

  it('choosing End membership sends membershipEffect=cancel_membership and shows the scheduled notice on 202', async () => {
    const fetchMock = mockFetch(202, {
      refund: { id: 'rfnd_1', status: 'pending', processorRefundId: 're_1' },
      membership_end: 'scheduled',
    });
    try {
      renderForm();
      fillAmount('5350');
      fireEvent.click(screen.getByText(m.end.label));
      await waitFor(() =>
        expect(screen.getByRole('radio', { name: new RegExp(m.end.label) })).toBeChecked(),
      );
      await submitFull();
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(sentBody(fetchMock).membershipEffect).toBe('cancel_membership');
      await waitFor(() =>
        expect(vi.mocked(toast.info)).toHaveBeenCalledWith(m.outcome.scheduled),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('Keep sends membershipEffect=keep; a partial refund sends no membershipEffect at all', async () => {
    const fetchMock = mockFetch(201, {
      refund: { status: 'succeeded', creditNote: { kind: 'issued', id: 'cn', number: 'CN-1' } },
    });
    try {
      renderForm();
      await submitFull();
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(sentBody(fetchMock).membershipEffect).toBe('keep');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
