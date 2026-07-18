/**
 * 088 FR-032 — CreditNoteForm post-fetch `formError` surface.
 *
 * Issuing a credit note (§86/10 ใบลดหนี้) MINTS a NEW sequential §87 tax-document
 * number in-tx and moves the original invoice to credited; once committed it
 * cannot be rolled back client-side, so a credit FAILURE must render INLINE in
 * a focused role="alert" the admin cannot miss — never a transient toast.
 *
 * `credit-note-error-routing.ts` (the pure classifier) is unit-tested
 * separately; this file covers the RENDER half that nothing else exercised —
 * that the routed result actually reaches the DOM through the `InlineAlert`
 * migration:
 *   - concurrent (409 `invalid_status`) → neutral tone + "already credited/voided
 *     — refresh" copy + a working refresh button wired to `router.refresh()`;
 *   - failure (typed code)              → destructive tone + interpolated
 *     `errors.codeFallback` copy + focus moved onto the alert;
 *   - failure (no/unparseable code)     → the generic `errors.unknown` copy.
 *
 * Rendered against the REAL en.json so a missing/renamed key surfaces as
 * MISSING_MESSAGE rather than silently passing. Mirrors the harness in
 * `void-confirm-dialog.test.tsx` (next-intl provider + next/navigation mock +
 * `vi.stubGlobal('fetch', …)`). Assertions go through `data-testid` so they
 * stay primitive-agnostic across the Alert → InlineAlert migration.
 *
 * The form's submit gate is a typed-phrase confirmation ("CREDIT") on top of a
 * valid amount + reason; a PARTIAL credit is used throughout so the F-2
 * membership-effect fieldset never mounts (irrelevant to the error surface).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { CreditNoteForm } from '@/app/(staff)/admin/invoices/[invoiceId]/credit-notes/new/_components/credit-note-form';

const cnMessages = enMessages.admin.creditNotes.new;

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

const INVOICE_ID = 'inv-1';
const DOC_NUMBER = 'SC-2026-000001';
/** 1,070.00 THB remaining (107,000 satang). */
const REMAINING_SATANG = '107000';

function renderForm() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CreditNoteForm
        invoiceId={INVOICE_ID}
        documentNumber={DOC_NUMBER}
        remainingSatang={REMAINING_SATANG}
        currencySymbol="THB"
        invoiceSubject="event"
      />
    </NextIntlClientProvider>,
  );
}

/**
 * Drive the three submit gates: a valid PARTIAL amount, a non-empty reason, and
 * the typed confirmation phrase. Type the phrase lowercase to prove the
 * locale-case-INSENSITIVE compare stays intact alongside the error-surface work.
 */
function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText(cnMessages.amountLabel), {
    target: { value: '500.00' }, // 50,000 satang < 107,000 remaining → partial
  });
  fireEvent.change(screen.getByLabelText(cnMessages.reasonLabel), {
    target: { value: 'duplicate charge' },
  });
  fireEvent.change(
    screen.getByLabelText(new RegExp(cnMessages.confirmCopy.split('{phrase}')[0]!)),
    { target: { value: cnMessages.confirmPhrase.toLowerCase() } },
  );
  const submit = screen.getByRole('button', { name: cnMessages.submit });
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

describe('CreditNoteForm — concurrent 409 inline recovery (FR-032)', () => {
  it('renders the "already credited/voided — refresh" prompt and refreshes on click', async () => {
    const fetchMock = rejectingFetch('invalid_status');
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderForm();
      // No error surface before the POST resolves.
      expect(screen.queryByTestId('credit-note-error')).toBeNull();

      fillAndSubmit();

      const alert = await screen.findByTestId('credit-note-error');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe('/api/credit-notes');
      expect(init.method).toBe('POST');
      // A stale-write 409 is NOT the admin's error → neutral, not destructive.
      expect(alert).toHaveAttribute('data-tone', 'neutral');
      expect(alert).toHaveAttribute('role', 'alert');
      expect(alert).toHaveTextContent(
        'This invoice was already credited or voided in another session. Refresh to see the latest status.',
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

describe('CreditNoteForm — failure branch is focused + destructive (FR-032)', () => {
  it('renders the interpolated codeFallback copy and moves focus onto the alert', async () => {
    const fetchMock = rejectingFetch('overflow');
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderForm();
      fillAndSubmit();

      const alert = await screen.findByTestId('credit-note-error');
      expect(alert).toHaveAttribute('data-tone', 'destructive');
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
      fillAndSubmit();

      const alert = await screen.findByTestId('credit-note-error');
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
