/**
 * 088 FR-028/FR-032 — PaymentForm post-fetch `formError` surface.
 *
 * Recording a payment MINTS the §87 `RC` receipt tax-document number in-tx and
 * cannot be rolled back client-side, so a pay FAILURE is a compliance-adjacent
 * UX guarantee, not incidental styling: it must render INLINE in a focused
 * role="alert" the admin cannot miss — never a transient toast.
 *
 * `record-payment-error-routing.ts` (the pure classifier) is unit-tested
 * separately; this file covers the RENDER half that nothing else exercised —
 * that the routed result actually reaches the DOM through the `InlineAlert`
 * migration:
 *   - concurrent (409 `invalid_status`) → neutral tone + "already paid —
 *     refresh" copy + a working refresh button wired to `router.refresh()`;
 *   - failure (typed code)              → destructive tone + interpolated
 *     `errors.codeFallback` copy + focus moved onto the alert;
 *   - failure (no/unparseable code)     → the generic `errors.unknown` copy.
 *
 * Rendered against the REAL en.json so a missing/renamed key surfaces as
 * MISSING_MESSAGE rather than silently passing. Mirrors the harness in
 * `void-confirm-dialog.test.tsx` (next-intl provider + next/navigation mock +
 * `vi.stubGlobal('fetch', …)`). Assertions go through `data-testid` so they
 * stay primitive-agnostic across the Alert → InlineAlert migration.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { PaymentForm } from '@/app/(staff)/admin/invoices/_components/payment-form';
import { WithMoneyDialogFooter } from '../../../../helpers/money-dialog-footer-harness';
import { RECORD_PAYMENT_FOOTER } from '@/app/(staff)/admin/invoices/_components/record-payment-dialog';

const refreshMock = vi.fn();
const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock, replace: vi.fn() }),
}));
const { toastSuccess, toastWarning } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastWarning: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: { success: toastSuccess, error: vi.fn(), warning: toastWarning } }));

// useTransition / async-transition interactions need real timers
// (tests/setup.ts installs fakes).
beforeEach(() => {
  vi.useRealTimers();
  refreshMock.mockClear();
  pushMock.mockClear();
});

const INVOICE_ID = '11111111-1111-4111-8111-111111111111';
const DOC_NUMBER = 'SC-2026-000048';
// Fixed far-future dates: the default payment date (= todayIso) sits inside the
// [issueDate, todayIso] clamp, so the date gate passes and the fetch fires.
const ISSUE_DATE = '2030-03-14';
const TODAY_ISO = '2030-03-15';

function renderForm(onSuccess?: () => void, onRefreshClose?: () => void) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <WithMoneyDialogFooter config={RECORD_PAYMENT_FOOTER}>
        {(wire) => (
          <PaymentForm
            invoiceId={INVOICE_ID}
            documentNumber={DOC_NUMBER}
            issueDate={ISSUE_DATE}
            todayIso={TODAY_ISO}
            {...(onSuccess ? { onSuccess } : {})}
            {...(onRefreshClose ? { onRefreshClose } : {})}
            {...wire}
          />
        )}
      </WithMoneyDialogFooter>
    </NextIntlClientProvider>,
  );
}

/** The method/reference/notes fields default or are optional; only the date
 * gate stands between a click and the POST, and the default date is valid. */
function submitPayment() {
  const submit = screen.getByRole('button', { name: 'Record payment' });
  expect(submit).toBeEnabled();
  fireEvent.click(submit);
}

/** Reject `res` shape the component reads: `res.json().error.code`. */
function rejectingFetch(code: string | undefined) {
  return vi.fn(async (_url: string, _init: RequestInit) => ({
    ok: false,
    json: async () => (code ? { error: { code } } : {}),
  }));
}

describe('PaymentForm — concurrent 409 inline recovery (FR-032)', () => {
  it('renders the "already paid — refresh" prompt and refreshes on click', async () => {
    const fetchMock = rejectingFetch('invalid_status');
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderForm();
      // No error surface before the POST resolves.
      expect(screen.queryByTestId('record-payment-error')).toBeNull();

      submitPayment();

      const alert = await screen.findByTestId('record-payment-error');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe(`/api/invoices/${INVOICE_ID}/pay`);
      expect(init.method).toBe('POST');
      // A stale-write 409 is NOT the admin's error → info, not danger.
      expect(alert).toHaveClass('aura-alert--info');
      expect(alert).toHaveAttribute('role', 'alert');
      expect(alert).toHaveTextContent(
        enMessages.admin.invoices.pay.errors.concurrent,
      );
      // #59 — a same-session retry lands here too: no "another session".
      expect(alert).not.toHaveTextContent(/another session/);
      expect(alert).toHaveTextContent(
        'This invoice has already been paid or changed. Refresh to see its status and the receipt (RC) number.',
      );

      // The recovery affordance is the whole point of the concurrent branch.
      const refreshBtn = screen.getByRole('button', { name: 'Refresh' });
      expect(refreshMock).not.toHaveBeenCalled();
      fireEvent.click(refreshBtn);
      expect(refreshMock).toHaveBeenCalledTimes(1);
      // Recovery must NOT navigate away from the still-open form.
      expect(pushMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('PaymentForm — failure branch is focused + destructive (FR-032)', () => {
  it('renders the interpolated codeFallback copy and moves focus onto the alert', async () => {
    // `overflow` keeps the raw-code fallback; pdf_render_failed /
    // blob_upload_failed read as `errors.temporary` (#62(2), below).
    const fetchMock = rejectingFetch('overflow');
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderForm();
      submitPayment();

      const alert = await screen.findByTestId('record-payment-error');
      expect(alert).toHaveClass('aura-alert--danger');
      expect(alert).toHaveTextContent('Error code: overflow');
      // The irreversible §87-mint failure must not be missable: the component
      // parks focus on the alert (tabIndex={-1} + focus effect).
      expect(alert).toHaveAttribute('tabindex', '-1');
      await waitFor(() => expect(alert).toHaveFocus());
      // Failure keeps the form open so the admin can retry — no navigation.
      expect(pushMock).not.toHaveBeenCalled();
      // No refresh affordance on this branch (that is concurrent-only).
      expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back to the generic unknown copy when the body carries no error code', async () => {
    // A non-JSON error page (HTML 502) → `.json()` rejects → `catch(() => ({}))`
    // → undefined code → `errors.unknown`, NOT a raw "Error code: undefined".
    const fetchMock = vi.fn(async () => ({
      ok: false,
      json: async () => {
        throw new Error('Unexpected token < in JSON');
      },
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderForm();
      submitPayment();

      const alert = await screen.findByTestId('record-payment-error');
      expect(alert).toHaveClass('aura-alert--danger');
      expect(alert).toHaveTextContent(
        'An unknown error occurred. Please try again.',
      );
      expect(alert).not.toHaveTextContent(/Error code/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/**
 * Spec 122 US8 (T804) — the request is byte-identical after the AURA swap:
 * the same URL, method, header and JSON body, with blank optional fields
 * left out (never sent as "").
 */
describe('PaymentForm — the POST is unchanged on AURA (T804)', () => {
  function okFetch() {
    return vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      json: async () => ({ receipt_document_number_raw: 'RC-2030-000001', email_dispatch: 'sent' }),
    }));
  }

  it('defaults: bank transfer, today, no reference or notes', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderForm();
      submitPayment();
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(`/api/invoices/${INVOICE_ID}/pay`);
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(init.body).toBe(JSON.stringify({ paymentMethod: 'bank_transfer', paymentDate: TODAY_ISO }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('every field filled: method, trimmed reference and notes, the chosen date', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderForm();
      // AURA's select names a combobox button and keeps a hidden native
      // <select> (`#method-select`) that carries the value and onChange.
      fireEvent.change(document.getElementById('method-select') as HTMLSelectElement, {
        target: { value: 'cheque' },
      });
      fireEvent.change(screen.getByLabelText('Reference'), { target: { value: '  CHQ-77  ' } });
      fireEvent.change(screen.getByLabelText(/Payment date/), { target: { value: ISSUE_DATE } });
      fireEvent.change(screen.getByLabelText('Notes'), { target: { value: ' paid at the gala ' } });
      submitPayment();
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(init.body).toBe(
        JSON.stringify({
          paymentMethod: 'cheque',
          paymentReference: 'CHQ-77',
          paymentNotes: 'paid at the gala',
          paymentDate: ISSUE_DATE,
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the method is an AURA select with the four methods in order', () => {
    renderForm();
    expect(screen.getByRole('combobox', { name: 'Payment method' }).closest('.aura-select')).not.toBeNull();
    const select = document.getElementById('method-select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['bank_transfer', 'cheque', 'cash', 'other']);
  });
});

describe('PaymentForm — the connection drops (#48)', () => {
  function droppingFetch() {
    return vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
  }

  it('shows an inline warning, stays open, and a retry replays the recorded payment', async () => {
    // First POST: no response. Retry: the server replays the committed
    // payment (200) — nothing new is recorded.
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ receipt_document_number_raw: 'RC-2030-000009', email_dispatch: 'sent' }),
      });
    vi.stubGlobal('fetch', fetchMock);
    const onSuccess = vi.fn();
    toastSuccess.mockClear();
    try {
      renderForm(onSuccess);
      submitPayment();

      const alert = await screen.findByTestId('record-payment-error');
      expect(alert).toHaveClass('aura-alert--warning');
      expect(alert).toHaveTextContent(enMessages.admin.invoices.pay.errors.unconfirmed);
      await waitFor(() => expect(alert).toHaveFocus());
      expect(onSuccess).not.toHaveBeenCalled();

      await waitFor(() => expect(screen.getByRole('button', { name: 'Record payment' })).toBeEnabled());
      submitPayment();
      await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(toastSuccess.mock.calls[0]?.[0]).toContain('RC-2030-000009');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('Refresh closes the dialog for a refresh (not as a success), then refreshes the page', async () => {
    vi.stubGlobal('fetch', droppingFetch());
    const onSuccess = vi.fn();
    const onRefreshClose = vi.fn();
    try {
      renderForm(onSuccess, onRefreshClose);
      submitPayment();
      await screen.findByTestId('record-payment-error');
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      expect(onRefreshClose).toHaveBeenCalledTimes(1);
      expect(onSuccess).not.toHaveBeenCalled();
      expect(refreshMock).toHaveBeenCalledTimes(1);
      expect(onRefreshClose.mock.invocationCallOrder[0]!).toBeLessThan(refreshMock.mock.invocationCallOrder[0]!);
      expect(pushMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('Refresh while still offline keeps the warning open, then closes and refreshes once online', async () => {
    vi.stubGlobal('fetch', droppingFetch());
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const onRefreshClose = vi.fn();
    try {
      renderForm(undefined, onRefreshClose);
      submitPayment();
      await screen.findByTestId('record-payment-error');
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      expect(onRefreshClose).not.toHaveBeenCalled();
      expect(refreshMock).not.toHaveBeenCalled();
      const waiting = screen.getByRole('button', {
        name: enMessages.admin.invoices.pay.errors.waitingForConnection,
      });
      expect(waiting).toHaveAttribute('aria-disabled', 'true');
      expect(
        screen
          .getAllByRole('status')
          .some((el) => el.textContent === enMessages.admin.invoices.pay.errors.waitingForConnection),
      ).toBe(true);
      window.dispatchEvent(new Event('online'));
      expect(onRefreshClose).toHaveBeenCalledTimes(1);
      expect(refreshMock).toHaveBeenCalledTimes(1);
    } finally {
      onLine.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

describe('PaymentForm — an unknown outcome is not a failure (#57, #58, #59)', () => {
  function respond(status: number, body: unknown, json = true) {
    return vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: status < 400,
      status,
      json: async () => {
        if (!json) throw new Error('Unexpected token < in JSON');
        return body;
      },
    }));
  }

  it('a 504 with an HTML body shows the unconfirmed warning, tone warning', async () => {
    vi.stubGlobal('fetch', respond(504, null, false));
    try {
      renderForm();
      submitPayment();
      const alert = await screen.findByTestId('record-payment-error');
      expect(alert).toHaveTextContent(enMessages.admin.invoices.pay.errors.unconfirmed);
      expect(alert).toHaveAttribute('data-tone', 'warning');
      // A 504 is not a dropped connection: the copy names no cause.
      expect(alert).not.toHaveTextContent(/connection/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a 500 internal_error shows the unconfirmed warning', async () => {
    vi.stubGlobal('fetch', respond(500, { error: { code: 'internal_error' } }));
    try {
      renderForm();
      submitPayment();
      const alert = await screen.findByTestId('record-payment-error');
      expect(alert).toHaveTextContent(enMessages.admin.invoices.pay.errors.unconfirmed);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a 500 with a flat body (no route code) is unconfirmed, not "Error code"', async () => {
    vi.stubGlobal('fetch', respond(500, { error: 'server-error' }));
    try {
      renderForm();
      submitPayment();
      const alert = await screen.findByTestId('record-payment-error');
      expect(alert).toHaveTextContent(enMessages.admin.invoices.pay.errors.unconfirmed);
      expect(alert).not.toHaveTextContent(/Error code/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a named 5xx the route rolled back (pdf_render_failed) stays a failure', async () => {
    vi.stubGlobal('fetch', respond(500, { error: { code: 'pdf_render_failed' } }));
    try {
      renderForm();
      submitPayment();
      const alert = await screen.findByTestId('record-payment-error');
      expect(alert).toHaveAttribute('data-tone', 'destructive');
      expect(alert).not.toHaveTextContent(enMessages.admin.invoices.pay.errors.unconfirmed);
      // #62(2) — the rolled-back render failure says so, never a raw code.
      expect(alert).toHaveTextContent(enMessages.admin.invoices.pay.errors.temporary);
      expect(alert).not.toHaveTextContent('pdf_render_failed');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the READ_ONLY_MODE 503 (nothing written) is the read-only message, not unconfirmed', async () => {
    vi.stubGlobal('fetch', respond(503, { error: 'read-only-mode' }));
    try {
      renderForm();
      submitPayment();
      const alert = await screen.findByTestId('record-payment-error');
      expect(alert).toHaveTextContent(enMessages.errors.readOnlyMode);
      expect(alert).toHaveTextContent(enMessages.errors.readOnlyNothingChanged);
      expect(alert).not.toHaveTextContent(enMessages.admin.invoices.pay.errors.unconfirmed);
      // Nothing is wrong and nothing was written: a warning, said once, inline.
      expect(alert).toHaveAttribute('data-tone', 'warning');
      expect(toastWarning).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the POST carries a timeout signal, and a timeout reads as unconfirmed', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderForm();
      submitPayment();
      const alert = await screen.findByTestId('record-payment-error');
      expect(alert).toHaveTextContent(enMessages.admin.invoices.pay.errors.unconfirmed);
      const [, init] = fetchMock.mock.calls[0]!;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a replayed 200 with no RC number still says nothing new was recorded', async () => {
    vi.stubGlobal('fetch', respond(200, { receipt_document_number_raw: null, email_dispatch: 'sent', replayed: true }));
    const onSuccess = vi.fn();
    toastSuccess.mockClear();
    toastWarning.mockClear();
    try {
      renderForm(onSuccess);
      submitPayment();
      await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
      expect(toastSuccess).not.toHaveBeenCalled();
      expect(toastWarning.mock.calls[0]?.[0]).toBe(enMessages.admin.invoices.pay.alreadyPaidNoNumber);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('after 10 s with no answer, a status line says it is still working', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    try {
      renderForm();
      submitPayment();
      const still = enMessages.admin.invoices.pay.errors.stillWorking;
      const hasStill = () => screen.queryAllByRole('status').some((el) => el.textContent === still);
      await act(async () => {
        vi.advanceTimersByTime(9_000);
      });
      expect(hasStill()).toBe(false);
      await act(async () => {
        vi.advanceTimersByTime(1_500);
      });
      expect(hasStill()).toBe(true);
      // Sighted admins see it too, not only screen readers.
      const line = screen.queryAllByRole('status').find((el) => el.textContent === still)!;
      expect(line).not.toHaveClass('sr-only');
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('a replayed 200 says the invoice was already paid, with its RC number', async () => {
    vi.stubGlobal(
      'fetch',
      respond(200, { receipt_document_number_raw: 'RC-2030-000011', email_dispatch: 'sent', replayed: true }),
    );
    const onSuccess = vi.fn();
    toastSuccess.mockClear();
    toastWarning.mockClear();
    try {
      renderForm(onSuccess);
      submitPayment();
      await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
      // The server checked only that the invoice is paid, not that it was this
      // payment: a warning that says nothing new was recorded, kept on screen.
      expect(toastSuccess).not.toHaveBeenCalled();
      expect(toastWarning.mock.calls[0]?.[0]).toBe(
        enMessages.admin.invoices.pay.alreadyPaid.replace('{number}', 'RC-2030-000011'),
      );
      expect(toastWarning.mock.calls[0]?.[1]).toMatchObject({ duration: Infinity });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// R124 — the #48 / #61 status row sits in the form's flex stack. Idle it must
// take no space (it used to hold min-h-5, so the stack showed gap + 20 px +
// gap; 68 px on the credit-note page), yet stay mounted so a later
// "waiting" or "still working" line is announced.
describe('PaymentForm — the idle status row takes no space (R124)', () => {
  it('is mounted and empty, and cancels the gap before it', () => {
    const { container } = renderForm();
    const row = container.querySelector('div[role="status"][aria-live="polite"]:not(.sr-only)');
    expect(row).not.toBeNull();
    expect(row!.childNodes).toHaveLength(0);
    expect(row!.className).not.toMatch(/\bmin-h-5\b/);
    // The pull-up must equal the stack's own gap, or the form shows a
    // leftover sliver (or overlaps) where the row sits.
    const pullUp = /\bempty:-mt-(\S+)/.exec(row!.className)?.[1];
    expect(pullUp).toBeDefined();
    expect(row!.parentElement!.className.split(/\s+/)).toContain(`gap-${pullUp}`);
  });
});
