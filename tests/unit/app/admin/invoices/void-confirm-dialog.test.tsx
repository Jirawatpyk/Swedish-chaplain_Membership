/**
 * 088 FR-032 — VoidConfirmDialog post-fetch `formError` surface.
 *
 * Voiding RETIRES the invoice's §87 sequential tax-document number (terminal,
 * irreversible-in-effect), so a void FAILURE is a compliance-adjacent UX
 * guarantee, not incidental styling: it must render INLINE in a focused
 * role="alert" that the admin cannot miss — never a transient toast.
 *
 * `void-error-routing.ts` (the pure classifier) is unit-tested separately; this
 * file covers the RENDER half that nothing else exercised — that the routed
 * result actually reaches the DOM through the `InlineAlert` migration:
 *   - concurrent (409 `invalid_status`) → neutral tone + "already voided —
 *     refresh" copy + a working refresh button wired to `router.refresh()`;
 *   - failure (typed code)              → destructive tone + interpolated
 *     `errors.codeFallback` copy + focus moved onto the alert;
 *   - failure (no/unparseable code)     → the generic `errors.unknown` copy.
 *
 * Rendered against the REAL en.json so a missing/renamed key surfaces as
 * MISSING_MESSAGE rather than silently passing. Mirrors the harness in
 * `issue-invoice-form.test.tsx` (next-intl provider + next/navigation mock +
 * `vi.stubGlobal('fetch', …)`); unlike the issue form this component is a
 * route-level form, not an <AlertDialog> child, so it renders bare.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { toast } from 'sonner';
import enMessages from '@/i18n/messages/en.json';
import { VoidConfirmDialog } from '@/app/(staff)/admin/invoices/[invoiceId]/void/_components/void-confirm-dialog';

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

const DOC_NUMBER = 'SC-2026-0042';
const INVOICE_ID = 'inv-1';
const DETAIL_ROUTE = `/admin/invoices/${INVOICE_ID}`;
/**
 * Deliberately whitespace-padded: the component sends `reason.trim()`, so a
 * padded source value is what makes the body assertion in `expectVoidRequest`
 * actually exercise the trim rather than pass by coincidence.
 */
const VOID_REASON = '  Issued against the wrong member.  ';

function renderDialog() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <VoidConfirmDialog invoiceId={INVOICE_ID} documentNumber={DOC_NUMBER} />
    </NextIntlClientProvider>,
  );
}

/**
 * Drive the two submit gates: a non-empty reason AND the typed document number.
 * The typed-phrase compare is locale-aware case-INSENSITIVE, so type it
 * lowercase to prove that arm stays intact alongside the error-surface work.
 */
function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText('Reason'), {
    target: { value: VOID_REASON },
  });
  fireEvent.change(screen.getByLabelText(/to confirm/i), {
    target: { value: DOC_NUMBER.toLowerCase() },
  });
  const submit = screen.getByRole('button', { name: /^Void invoice$/ });
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

/**
 * Pin the WIRE SHAPE of the void POST, not just that "a" fetch happened.
 * Void retires a §87 sequential tax-document number — a mutation that is
 * terminal and irreversible-in-effect — and this file is its first-ever test,
 * so the URL, verb, and body are contract surface: a wrong route or a dropped
 * `voidReason` would leave the audit trail without the admin's justification
 * while still retiring the number. `voidReason` is asserted TRIMMED because
 * that is what lands in the audit record and on the re-stamped VOID PDF.
 */
function expectVoidRequest(calls: unknown[][]) {
  expect(calls).toHaveLength(1);
  const [url, init] = (calls[0] ?? []) as [url: string, init: RequestInit];
  expect(url).toBe(`/api/invoices/${INVOICE_ID}/void`);
  expect(init.method).toBe('POST');
  expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
  expect(JSON.parse(String(init.body))).toEqual({
    voidReason: VOID_REASON.trim(),
  });
}

describe('VoidConfirmDialog — concurrent 409 inline recovery (FR-032)', () => {
  it('renders the "already voided — refresh" prompt and refreshes on click', async () => {
    const fetchMock = rejectingFetch('invalid_status');
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderDialog();
      // No error surface before the POST resolves.
      expect(screen.queryByTestId('void-invoice-error')).toBeNull();

      fillAndSubmit();

      const alert = await screen.findByTestId('void-invoice-error');
      expectVoidRequest(fetchMock.mock.calls);
      // A stale-write 409 is NOT the admin's error → neutral, not destructive.
      expect(alert).toHaveAttribute('data-tone', 'neutral');
      expect(alert).toHaveAttribute('role', 'alert');
      expect(alert).toHaveTextContent(
        'This invoice was already voided or changed in another session. Refresh to see the latest status.',
      );

      // The recovery affordance is the whole point of the concurrent branch.
      const refreshBtn = screen.getByRole('button', { name: 'Refresh' });
      expect(refreshMock).not.toHaveBeenCalled();
      fireEvent.click(refreshBtn);
      expect(refreshMock).toHaveBeenCalledTimes(1);
      // Recovery must NOT navigate away from the still-open confirm form.
      expect(pushMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('VoidConfirmDialog — failure branch is focused + destructive (FR-032)', () => {
  it('renders the interpolated codeFallback copy and moves focus onto the alert', async () => {
    const fetchMock = rejectingFetch('pdf_render_failed');
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderDialog();
      fillAndSubmit();

      const alert = await screen.findByTestId('void-invoice-error');
      expect(alert).toHaveAttribute('data-tone', 'destructive');
      expect(alert).toHaveTextContent('Error code: pdf_render_failed');
      // The irreversible mutation's failure must not be missable: the
      // component parks focus on the alert (tabIndex={-1} + focus effect).
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
      renderDialog();
      fillAndSubmit();

      const alert = await screen.findByTestId('void-invoice-error');
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

describe('VoidConfirmDialog — success path (positive control)', () => {
  // Every other assertion about navigation in this file is a NEGATIVE
  // (`pushMock` not called on the 409 / failure branches). Those would all stay
  // green if `router.push` were deleted outright, so the suite needs at least
  // one test that proves navigation happens at all — and that it lands on the
  // detail route rather than, say, the directory.
  it('posts the trimmed reason, toasts the document number, and navigates to the detail route', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      json: async () => ({}),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderDialog();
      fillAndSubmit();

      await waitFor(() =>
        expect(pushMock).toHaveBeenCalledWith(DETAIL_ROUTE),
      );
      expectVoidRequest(fetchMock.mock.calls);
      // Success names the retired §87 number so the admin can reconcile the
      // toast against the register — the generic `success` copy would not.
      expect(toast.success).toHaveBeenCalledWith(
        `Invoice ${DOC_NUMBER} voided.`,
      );
      // A success must never leave the FR-032 failure surface behind.
      expect(screen.queryByTestId('void-invoice-error')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('VoidConfirmDialog — CR-6 Esc-to-cancel survives the effect split', () => {
  // The Esc handler is the half of the split that KEPT its `pending` dep, and
  // nothing pinned it: the whole point of re-subscribing on `pending` is the
  // fresh closure behind the `!pending` guard. Without these two tests the
  // guard could be dropped (navigating mid-POST, abandoning an in-flight
  // irreversible mutation and losing its result) with the suite still green.
  it('navigates back to the invoice detail on Escape while idle', () => {
    renderDialog();
    expect(pushMock).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith(DETAIL_ROUTE);
  });

  it('does NOT navigate on Escape while the void POST is in flight', async () => {
    // Never resolves → the transition stays pending for the whole test, which
    // is exactly the window the `!pending` guard exists to cover.
    const fetchMock = vi.fn(
      (_url: string, _init: RequestInit) => new Promise<never>(() => {}),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderDialog();
      fillAndSubmit();

      // Wait for the transition to actually flip pending → the submit button
      // relabels to "Voiding…" and goes aria-busy.
      const submitting = await screen.findByRole('button', {
        name: /Voiding/,
      });
      expect(submitting).toHaveAttribute('aria-busy', 'true');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      fireEvent.keyDown(window, { key: 'Escape' });

      expect(pushMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('VoidConfirmDialog — CR-6 mount focus survives the effect split', () => {
  // The mount-focus and Esc concerns live in SEPARATE effects precisely so the
  // Esc effect's `pending` dependency cannot re-fire `reasonRef.focus()` and
  // steal focus off the FR-032 error alert. This pins the half that must NOT
  // regress in the other direction: focus still starts on the reason field.
  it('focuses the reason textarea on mount', () => {
    renderDialog();
    expect(screen.getByLabelText('Reason')).toHaveFocus();
  });
});

describe('VoidConfirmDialog — submit gating guards the error surface', () => {
  it('keeps submit disabled (and fires NO POST) until reason + document number are both supplied', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderDialog();
      const submit = screen.getByRole('button', { name: /^Void invoice$/ });
      // The click is the point: asserting `not.toHaveBeenCalled()` after only
      // LOOKING at a disabled button is vacuous — it holds even if the gate is
      // cosmetic. Press it at every gated stage and prove no POST escapes.
      expect(submit).toBeDisabled();
      fireEvent.click(submit);
      expect(fetchMock).not.toHaveBeenCalled();

      // Reason alone is not enough.
      fireEvent.change(screen.getByLabelText('Reason'), {
        target: { value: 'Wrong member.' },
      });
      expect(submit).toBeDisabled();
      fireEvent.click(submit);
      expect(fetchMock).not.toHaveBeenCalled();

      // A near-miss document number is not enough either — this is the arm
      // that guards against voiding the WRONG invoice.
      fireEvent.change(screen.getByLabelText(/to confirm/i), {
        target: { value: 'SC-2026-0043' },
      });
      expect(submit).toBeDisabled();
      fireEvent.click(submit);
      expect(fetchMock).not.toHaveBeenCalled();

      fireEvent.change(screen.getByLabelText(/to confirm/i), {
        target: { value: DOC_NUMBER },
      });
      expect(submit).toBeEnabled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.queryByTestId('void-invoice-error')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
