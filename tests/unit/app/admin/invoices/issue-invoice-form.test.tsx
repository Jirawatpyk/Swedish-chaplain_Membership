/**
 * 088 US8 (UX-A) — issue-invoice form (vat_treatment toggle + MFA-cert fields).
 *
 * Rendered against the REAL en.json (a missing key would surface as
 * MISSING_MESSAGE). Spec 122 US8b (T825): the form is on AURA fields and
 * renders its own footer, so it needs no enclosing dialog here; the dialog
 * shell is covered at the end of this file.
 *
 * Covers: membership hides the toggle (+ caption); a non-membership sale shows
 * it; selecting zero-rate progressively reveals the cert fields (aria-live +
 * dynamically-required cert number); a blank cert number blocks submit BEFORE
 * any POST (aria-invalid + role=alert + focus moves to the field); flipping
 * away and back RESETS the cert fields; a < 5,000 THB subtotal warns
 * (non-blocking); a valid zero-rate issue POSTs the vat_treatment + cert.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { IssueInvoiceForm } from '@/app/(staff)/admin/invoices/_components/issue-invoice-form';
import { IssueInvoiceDialog } from '@/app/(staff)/admin/invoices/_components/issue-invoice-dialog';
import { buildIssueTotalsByTreatment } from '@/app/(staff)/admin/invoices/[invoiceId]/_lib/issue-totals-by-treatment';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';

const refreshMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: refreshMock, replace: vi.fn() }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// RHF/transition interactions need real timers (tests/setup.ts installs fakes).
beforeEach(() => {
  vi.useRealTimers();
  refreshMock.mockClear();
});

const BASE_SUMMARY = {
  memberName: 'Embassy of Sweden',
  planDisplayName: 'Expo booth',
  planYear: 2026,
} as const;

// The draft priced per treatment by the same server helper the page uses
// (the issue use case's own `computeIssuePricing`), at the standard 7%.
function priced(lineSumSatang: number, vatInclusive = false) {
  return buildIssueTotalsByTreatment({
    lineSum: Money.fromSatangUnsafe(lineSumSatang),
    vatInclusive,
    standardRate: VatRate.ofUnsafe('0.0700'),
  });
}

function renderForm(
  overrides: Partial<React.ComponentProps<typeof IssueInvoiceForm>> = {},
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <IssueInvoiceForm
        invoiceId="inv-1"
        summary={BASE_SUMMARY}
        taxAtPayment
        isMembership={false}
        buyerIsVatRegistrant={false}
        totalsByTreatment={priced(800_000)}
        onClose={() => undefined}
        {...overrides}
      />
    </NextIntlClientProvider>,
  );
}

describe('IssueInvoiceForm — vat_treatment control gating (FR-023)', () => {
  it('hides the toggle and shows the caption for a membership sale', () => {
    renderForm({ isMembership: true });
    expect(screen.queryByRole('radio')).toBeNull();
    expect(
      screen.getByTestId('vat-treatment-membership-caption'),
    ).toBeInTheDocument();
  });

  it('shows the standard / zero-rate toggle for a non-membership sale', () => {
    renderForm();
    expect(screen.getByRole('radio', { name: /Standard/i })).toBeInTheDocument();
    expect(
      screen.getByRole('radio', { name: /Zero-rated/i }),
    ).toBeInTheDocument();
  });

  it('renders NO toggle when the tax-at-payment flag is off', () => {
    renderForm({ taxAtPayment: false });
    expect(screen.queryByRole('radio')).toBeNull();
    expect(
      screen.queryByTestId('vat-treatment-membership-caption'),
    ).toBeNull();
  });
});

// Board Admin-invoice-issue (parity comment, 3 Oct): the confirm names the
// document and its total, and carries the money-step check icon (§ Button icons).
describe('IssueInvoiceForm — the confirm button', () => {
  it('reads "Issue bill · {total} THB" with the check icon for a membership bill', () => {
    renderForm({ isMembership: true });
    const confirm = screen.getByRole('button', { name: 'Issue bill · 8,560.00 THB' });
    expect(confirm.querySelector('svg.aura-icon')).not.toBeNull();
  });

  it('reads "Issue invoice · {total} THB" when the tax-at-payment flag is off (a §87 invoice)', () => {
    renderForm({ isMembership: true, taxAtPayment: false });
    expect(screen.getByRole('button', { name: 'Issue invoice · 8,560.00 THB' })).toBeInTheDocument();
  });

  it('names no amount when the draft could not be priced (no invoice settings)', () => {
    renderForm({ totalsByTreatment: null });
    expect(screen.getByRole('button', { name: 'Issue bill' })).toBeInTheDocument();
  });
});

// The summary and the confirm show what `issueInvoice` will pin: the chosen
// VAT treatment drives the rate, and a VAT-inclusive draft's total is its line
// sum (VAT carved out), never the line sum × 1.07.
describe('IssueInvoiceForm — the summary matches the issued bill', () => {
  function summaryRow(label: string) {
    return screen.getByText(label, { selector: 'dt' }).nextElementSibling;
  }

  it('standard event fee: 7% on top, and the confirm names that total', () => {
    renderForm({ totalsByTreatment: priced(1_000_000) });
    expect(summaryRow('Subtotal')).toHaveTextContent('10,000.00 THB');
    expect(summaryRow('Total')).toHaveTextContent('10,700.00 THB');
    expect(screen.getByText('(7%)')).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Issue bill · 10,700.00 THB' });
    expect(confirm.querySelector('svg.aura-icon')).not.toBeNull();
  });

  it('zero-rated event fee: VAT 0, total = subtotal, in the summary and the confirm', () => {
    renderForm({ totalsByTreatment: priced(1_000_000) });
    fireEvent.click(screen.getByRole('radio', { name: /Zero-rated/i }));
    expect(screen.getByText('(0%)')).toBeInTheDocument();
    expect(summaryRow('Total')).toHaveTextContent('10,000.00 THB');
    expect(screen.getByRole('button', { name: 'Issue bill · 10,000.00 THB' })).toBeInTheDocument();
    // Flipping back restores the standard figures.
    fireEvent.click(screen.getByRole('radio', { name: /Standard/i }));
    expect(summaryRow('Total')).toHaveTextContent('10,700.00 THB');
  });

  it('VAT-inclusive event draft: total = line sum with the VAT carved out', () => {
    renderForm({
      totalsByTreatment: priced(1_000_000, true),
    });
    expect(summaryRow('Subtotal')).toHaveTextContent('9,345.79 THB');
    expect(screen.getByText('654.21 THB')).toBeInTheDocument();
    expect(summaryRow('Total')).toHaveTextContent('10,000.00 THB');
    expect(screen.getByRole('button', { name: 'Issue bill · 10,000.00 THB' })).toBeInTheDocument();
  });
});

describe('IssueInvoiceForm — progressive disclosure (FR-024 / T061c)', () => {
  it('reveals the cert fields with an aria-live announce + a required cert number', () => {
    renderForm();
    expect(screen.queryByTestId('zero-rate-cert-fields')).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: /Zero-rated/i }));

    expect(screen.getByTestId('zero-rate-cert-fields')).toBeInTheDocument();
    const certNo = screen.getByLabelText(/MFA certificate number/i);
    expect(certNo).toHaveAttribute('aria-required', 'true');

    // aria-live region carries the reveal announcement (T061c).
    const live = screen.getByText(
      'Certificate fields shown — a certificate number is required to issue a zero-rated invoice.',
    );
    expect(live).toHaveAttribute('aria-live', 'polite');
  });
});

describe('IssueInvoiceForm — fail-closed cert validation (FR-024 / T061b)', () => {
  it('blocks submit on a blank cert number: aria-invalid + role=alert + focus, NO POST', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderForm();
      fireEvent.click(screen.getByRole('radio', { name: /Zero-rated/i }));
      // Satisfy the immutable-snapshot typed-phrase gate so the action enables.
      fireEvent.change(screen.getByLabelText(/to confirm/i), {
        target: { value: 'ISSUE' },
      });

      fireEvent.click(screen.getByRole('button', { name: /^Issue bill · [\d,.]+ THB$/ }));

      const certNo = screen.getByLabelText(/MFA certificate number/i);
      expect(certNo).toHaveAttribute('aria-invalid', 'true');
      expect(certNo).toHaveFocus();
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent(
        'Enter the MFA certificate number to issue a zero-rated invoice.',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('IssueInvoiceForm — flip resets cert fields (T061f reset arm)', () => {
  it('clears the cert number when treatment flips zero-rate → standard → zero-rate', () => {
    renderForm();
    fireEvent.click(screen.getByRole('radio', { name: /Zero-rated/i }));
    fireEvent.change(screen.getByLabelText(/MFA certificate number/i), {
      target: { value: 'กต 0404/9999' },
    });
    expect(
      (screen.getByLabelText(/MFA certificate number/i) as HTMLInputElement)
        .value,
    ).toBe('กต 0404/9999');

    fireEvent.click(screen.getByRole('radio', { name: /Standard/i }));
    expect(screen.queryByTestId('zero-rate-cert-fields')).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: /Zero-rated/i }));
    expect(
      (screen.getByLabelText(/MFA certificate number/i) as HTMLInputElement)
        .value,
    ).toBe('');
  });
});

describe('IssueInvoiceForm — low-amount advisory (T061d)', () => {
  it('shows a non-blocking ≥ 5,000 THB warning for a zero-rate sale below the threshold', () => {
    renderForm({ totalsByTreatment: priced(400_000) });
    expect(screen.queryByTestId('zero-rate-low-amount-warning')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Zero-rated/i }));
    const warn = screen.getByTestId('zero-rate-low-amount-warning');
    expect(warn).toHaveAttribute('role', 'status');
    expect(warn).toHaveTextContent(/below 5,000 THB/i);
  });

  it('does NOT warn when the subtotal is at or above the threshold', () => {
    renderForm({ totalsByTreatment: priced(800_000) });
    fireEvent.click(screen.getByRole('radio', { name: /Zero-rated/i }));
    expect(screen.queryByTestId('zero-rate-low-amount-warning')).toBeNull();
  });
});

describe('IssueInvoiceForm — valid zero-rate issue POST', () => {
  it('POSTs vat_treatment + cert number (no scan blob key)', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ bill_document_number_raw: 'SC-2026-0001' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderForm();
      fireEvent.click(screen.getByRole('radio', { name: /Zero-rated/i }));
      fireEvent.change(screen.getByLabelText(/MFA certificate number/i), {
        target: { value: 'กต 0404/1234' },
      });
      fireEvent.change(screen.getByLabelText(/to confirm/i), {
        target: { value: 'ISSUE' },
      });
      fireEvent.click(screen.getByRole('button', { name: /^Issue bill · [\d,.]+ THB$/ }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const [url, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe('/api/invoices/inv-1/issue');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        vatTreatment: 'zero_rated_80_1_5',
        zeroRateCertNo: 'กต 0404/1234',
        // The zero-rated total and VAT the admin confirmed (8,000.00, VAT 0).
        expectedTotalSatang: '800000',
        expectedVatSatang: '0',
      });
      expect('zeroRateCertBlobKey' in body).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sends only the confirmed total for a standard-rate issue', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ bill_document_number_raw: 'SC-2026-0002' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderForm();
      // Leave treatment on the default 'standard'.
      fireEvent.change(screen.getByLabelText(/to confirm/i), {
        target: { value: 'ISSUE' },
      });
      fireEvent.click(screen.getByRole('button', { name: /^Issue bill · [\d,.]+ THB$/ }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const [, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(init.method).toBe('POST');
      // 8,000.00 + 7% — the total the confirm named.
      expect(JSON.parse(init.body as string)).toEqual({
        expectedTotalSatang: '856000',
        expectedVatSatang: '56000',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// 088 UX-B1 (T061e/T061f-form) — cert-scan upload + dirty guard.
// ---------------------------------------------------------------------------

function certPdf(name = 'cert.pdf'): File {
  return new File(['%PDF-1.4 fake'], name, { type: 'application/pdf' });
}

/** fetch router: cert-upload → { blobKey }; issue → { bill_document_number_raw }. */
function makeRoutedFetch() {
  return vi.fn(async (url: string) => {
    if (String(url).includes('zero-rate-cert-upload')) {
      return {
        ok: true,
        json: async () => ({ blobKey: 'invoicing/t/zero-rate-certs/inv-1_9.pdf' }),
      };
    }
    return {
      ok: true,
      json: async () => ({ bill_document_number_raw: 'SC-2026-0007' }),
    };
  });
}

describe('IssueInvoiceForm — cert-scan blob key in POST (UX-B1)', () => {
  it('includes zeroRateCertBlobKey in the issue POST after a scan is uploaded', async () => {
    const fetchMock = makeRoutedFetch();
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderForm();
      fireEvent.click(screen.getByRole('radio', { name: /Zero-rated/i }));

      // Upload a cert scan → the uploader POSTs, then reports the blob key.
      fireEvent.change(screen.getByLabelText(/Choose a certificate scan/i), {
        target: { files: [certPdf()] },
      });
      await waitFor(() =>
        expect(screen.getByTestId('zero-rate-cert-attached')).toBeInTheDocument(),
      );

      fireEvent.change(screen.getByLabelText(/MFA certificate number/i), {
        target: { value: 'กต 0404/1234' },
      });
      fireEvent.change(screen.getByLabelText(/to confirm/i), {
        target: { value: 'ISSUE' },
      });
      fireEvent.click(screen.getByRole('button', { name: /^Issue bill · [\d,.]+ THB$/ }));

      // Find the /issue POST (the cert-upload POST fired first).
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            (c) => String(c[0]).endsWith('/issue'),
          ),
        ).toBe(true),
      );
      const issueCall = fetchMock.mock.calls.find((c) =>
        String(c[0]).endsWith('/issue'),
      ) as unknown as [string, RequestInit];
      const body = JSON.parse(issueCall[1].body as string);
      expect(body.zeroRateCertBlobKey).toBe('invoicing/t/zero-rate-certs/inv-1_9.pdf');
      expect(body.vatTreatment).toBe('zero_rated_80_1_5');
      expect(body.zeroRateCertNo).toBe('กต 0404/1234');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('flipping zero-rate → standard → zero-rate RESETS the attached scan', async () => {
    const fetchMock = makeRoutedFetch();
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderForm();
      fireEvent.click(screen.getByRole('radio', { name: /Zero-rated/i }));
      fireEvent.change(screen.getByLabelText(/Choose a certificate scan/i), {
        target: { files: [certPdf()] },
      });
      await waitFor(() =>
        expect(screen.getByTestId('zero-rate-cert-attached')).toBeInTheDocument(),
      );

      // Flip away then back — the attached scan must NOT carry over.
      fireEvent.click(screen.getByRole('radio', { name: /Standard/i }));
      fireEvent.click(screen.getByRole('radio', { name: /Zero-rated/i }));

      expect(screen.queryByTestId('zero-rate-cert-attached')).toBeNull();
      expect(
        screen.getByRole('button', { name: /Attach certificate scan/i }),
      ).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('IssueInvoiceForm — beforeunload dirty guard (T061f-form)', () => {
  it('registers a beforeunload listener only once the form is dirty (zero-rate)', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    try {
      renderForm();
      // On mount (standard, empty) the form is clean → no guard.
      expect(
        addSpy.mock.calls.some((c) => c[0] === 'beforeunload'),
      ).toBe(false);

      // Selecting zero-rate makes the form dirty → guard attaches.
      fireEvent.click(screen.getByRole('radio', { name: /Zero-rated/i }));
      expect(
        addSpy.mock.calls.some((c) => c[0] === 'beforeunload'),
      ).toBe(true);
    } finally {
      addSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 088 T072a/T072b (FR-036 / SC-011) — target-size guard. A cheap CI-running
// assertion that the NEW zero-rate inputs carry the 44px min-height utility
// (the shared shadcn Input is 36px; these feature inputs are bumped inline —
// the global primitive is NOT changed). The @a11y E2E (boundingBox ≥44) is
// preview-gated; this structural guard runs on every commit.
// ---------------------------------------------------------------------------

describe('IssueInvoiceForm — 44px targets on the new controls (FR-036 / SC-011)', () => {
  /** AURA 5.30 `touchHeight="always"` (handoff #135) marks the field or radio-group root `is-touch-always`: 44px at every width. */
  const touchRoot = (el: HTMLElement) => el.closest('.is-touch-always');

  it('the zero-rate radio row and the cert number + date fields are 44px once zero-rate is revealed', () => {
    renderForm();
    expect(touchRoot(screen.getByRole('radio', { name: /Zero-rated/i }))).not.toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Zero-rated/i }));
    expect(touchRoot(screen.getByLabelText(/MFA certificate number/i))).not.toBeNull();
    expect(touchRoot(screen.getByLabelText(/Certificate date/i))).not.toBeNull();
  });

  it('the immutable-snapshot confirm field is 44px', () => {
    renderForm();
    expect(touchRoot(screen.getByLabelText(/to confirm/i))).not.toBeNull();
  });

  it('uses AURA\'s own size, not the retired 5.29 stand-in utilities', () => {
    const { container } = renderForm();
    fireEvent.click(screen.getByRole('radio', { name: /Zero-rated/i }));
    // The stand-in grew `.aura-input` / `.aura-choice` from a utility on the field root.
    expect(container.querySelector('[class*="_.aura-input"], [class*="_.aura-choice"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 088 FR-032 — post-fetch `formError` surface (`issue-invoice-error`).
//
// Issuing pins an IMMUTABLE §86/4 tax snapshot (void-only to change), so a
// POST failure must land INLINE in a focused role="alert" — never a transient
// toast the admin can miss. `issue-error-routing.ts` (the pure classifier) is
// unit-tested separately; these cases cover the RENDER half — that the routed
// result actually reaches the DOM through the `InlineAlert` migration.
// ---------------------------------------------------------------------------

/** Reject `res` shape the form reads: `res.json().error.code`. */
function rejectingFetch(code: string) {
  return vi.fn(async () => ({
    ok: false,
    json: async () => ({ error: { code } }),
  }));
}

/** Satisfy the typed-phrase gate on a default (standard-rate) form and submit. */
function confirmAndSubmit() {
  fireEvent.change(screen.getByLabelText(/to confirm/i), {
    target: { value: 'ISSUE' },
  });
  fireEvent.click(screen.getByRole('button', { name: /^Issue bill · [\d,.]+ THB$/ }));
}

describe('IssueInvoiceForm — concurrent 409 inline recovery (FR-032)', () => {
  it('renders the "already issued — refresh" prompt and refreshes on click', async () => {
    const fetchMock = rejectingFetch('invoice_already_issued');
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderForm();
      expect(screen.queryByTestId('issue-invoice-error')).toBeNull();

      confirmAndSubmit();

      const alert = await screen.findByTestId('issue-invoice-error');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // A stale-write 409 is NOT the admin's error → neutral, not destructive.
      expect(alert).toHaveAttribute('data-tone', 'neutral');
      expect(alert).toHaveAttribute('role', 'alert');
      expect(alert).toHaveTextContent(
        'This invoice was already issued in another session. Refresh to see the latest status and its number.',
      );

      expect(refreshMock).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      expect(refreshMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// The server refused the confirmed total (draft lines or the VAT rate changed
// after the page rendered): nothing was issued, so the admin refreshes to see
// and confirm the real figure.
describe('IssueInvoiceForm — stale total 409 inline recovery', () => {
  it('renders the "total changed — refresh" prompt and refreshes on click', async () => {
    const fetchMock = rejectingFetch('issue_total_changed');
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderForm();
      confirmAndSubmit();

      const alert = await screen.findByTestId('issue-invoice-error');
      expect(alert).toHaveAttribute('data-tone', 'neutral');
      expect(alert).toHaveTextContent(
        'The total changed after this page loaded, so nothing was issued. Refresh to see the current total, then issue again.',
      );
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      expect(refreshMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('IssueInvoiceForm — failure branch is focused + destructive (FR-032)', () => {
  it('renders the dedicated operator-actionable copy and moves focus onto the alert', async () => {
    const fetchMock = rejectingFetch('settings_missing');
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderForm();
      confirmAndSubmit();

      const alert = await screen.findByTestId('issue-invoice-error');
      expect(alert).toHaveAttribute('data-tone', 'destructive');
      expect(alert).toHaveTextContent(
        "Invoice settings haven't been configured for this organisation yet — configure them before issuing.",
      );
      // Not missable: tabIndex={-1} + the focus effect park focus on the alert.
      expect(alert).toHaveAttribute('tabindex', '-1');
      await waitFor(() => expect(alert).toHaveFocus());
      // The refresh affordance is concurrent-only.
      expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('interpolates the raw code into codeFallback for an unrouted failure', async () => {
    const fetchMock = rejectingFetch('some_unmapped_code');
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderForm();
      confirmAndSubmit();

      const alert = await screen.findByTestId('issue-invoice-error');
      expect(alert).toHaveAttribute('data-tone', 'destructive');
      expect(alert).toHaveTextContent('Error code: some_unmapped_code');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// Spec 122 US8b (T825) — the dialog shell on AURA: "Issue…" opens an
// alertdialog named by its title, described by the immutable-snapshot
// acknowledgement, holding the form; Cancel closes it.
// ---------------------------------------------------------------------------

describe('IssueInvoiceDialog — AURA alertdialog', () => {
  it('opens from "Issue…" as an alertdialog with the title and acknowledgement, and Cancel closes it', () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <IssueInvoiceDialog
          invoiceId="inv-1"
          summary={BASE_SUMMARY}
          taxAtPayment
          isMembership
          buyerIsVatRegistrant
          totalsByTreatment={priced(800_000)}
        />
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Issue…' }));
    const dialog = screen.getByRole('alertdialog', { name: enMessages.admin.invoices.issue.title });
    expect(dialog).toHaveAccessibleDescription(enMessages.admin.invoices.issue.review.immutableSnapshotAck);
    expect(screen.getByRole('button', { name: /^Issue bill · [\d,.]+ THB$/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: enMessages.admin.invoices.issue.cancel }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('IssueInvoiceForm — the buttons stay in view (spec 122 US8b, UX review)', () => {
  it('keeps Cancel and Issue in a row stuck to the bottom of the scrolling dialog body, stacked full width on a phone', () => {
    renderForm();
    const row = screen.getByRole('button', { name: enMessages.admin.invoices.issue.cancel }).parentElement!;
    expect(row).toHaveClass('sticky', 'bottom-0', 'max-sm:flex-col-reverse', 'max-sm:[&>*]:w-full');
  });
});
