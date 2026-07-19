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
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { PaymentForm } from '@/app/(staff)/admin/invoices/_components/payment-form';

const refreshMock = vi.fn();
const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock, replace: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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

function renderForm() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PaymentForm
        invoiceId={INVOICE_ID}
        documentNumber={DOC_NUMBER}
        issueDate={ISSUE_DATE}
        todayIso={TODAY_ISO}
      />
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
      // A stale-write 409 is NOT the admin's error → neutral, not destructive.
      expect(alert).toHaveAttribute('data-tone', 'neutral');
      expect(alert).toHaveAttribute('role', 'alert');
      expect(alert).toHaveTextContent(
        'This invoice was already paid or changed in another session. Refresh to see the latest status and the receipt (RC) number.',
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
    const fetchMock = rejectingFetch('pdf_render_failed');
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderForm();
      submitPayment();

      const alert = await screen.findByTestId('record-payment-error');
      expect(alert).toHaveAttribute('data-tone', 'destructive');
      expect(alert).toHaveTextContent('Error code: pdf_render_failed');
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
      expect(alert).toHaveAttribute('data-tone', 'destructive');
      expect(alert).toHaveTextContent(
        'An unknown error occurred. Please try again.',
      );
      expect(alert).not.toHaveTextContent(/Error code/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
