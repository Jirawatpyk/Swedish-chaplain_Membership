/**
 * 088 US8 (UX-A) — issue-invoice form (vat_treatment toggle + MFA-cert fields).
 *
 * Rendered against the REAL en.json (a missing key would surface as
 * MISSING_MESSAGE) inside an open <AlertDialog> — the RefundForm split pattern
 * that sidesteps the Base-UI-dialog jsdom trigger-transition hang.
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
import { AlertDialog } from '@/components/ui/alert-dialog';
import { IssueInvoiceForm } from '@/app/(staff)/admin/invoices/_components/issue-invoice-form';

const refreshMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: refreshMock, replace: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// RHF/transition interactions need real timers (tests/setup.ts installs fakes).
beforeEach(() => {
  vi.useRealTimers();
  refreshMock.mockClear();
});

const BASE_SUMMARY = {
  memberName: 'Embassy of Sweden',
  planDisplayName: 'Expo booth',
  planYear: 2026,
  subtotalText: '8,000.00',
  vatText: '0.00',
  vatPercent: '0%',
  totalText: '8,000.00',
} as const;

function renderForm(
  overrides: Partial<React.ComponentProps<typeof IssueInvoiceForm>> = {},
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AlertDialog open onOpenChange={() => undefined}>
        <IssueInvoiceForm
          invoiceId="inv-1"
          summary={BASE_SUMMARY}
          taxAtPayment
          isMembership={false}
          buyerIsVatRegistrant={false}
          subtotalSatang={800_000}
          onClose={() => undefined}
          {...overrides}
        />
      </AlertDialog>
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

      fireEvent.click(screen.getByRole('button', { name: /^Issue$/ }));

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
    renderForm({ subtotalSatang: 400_000 });
    expect(screen.queryByTestId('zero-rate-low-amount-warning')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Zero-rated/i }));
    const warn = screen.getByTestId('zero-rate-low-amount-warning');
    expect(warn).toHaveAttribute('role', 'status');
    expect(warn).toHaveTextContent(/below 5,000 THB/i);
  });

  it('does NOT warn when the subtotal is at or above the threshold', () => {
    renderForm({ subtotalSatang: 800_000 });
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
      fireEvent.click(screen.getByRole('button', { name: /^Issue$/ }));

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
      });
      expect('zeroRateCertBlobKey' in body).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sends an EMPTY POST body for a standard-rate issue (backward compatible)', async () => {
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
      fireEvent.click(screen.getByRole('button', { name: /^Issue$/ }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const [, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(init.method).toBe('POST');
      expect(init.body).toBeUndefined();
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
      fireEvent.click(screen.getByRole('button', { name: /^Issue$/ }));

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

describe('IssueInvoiceForm — target-size min-h-11 on new inputs (FR-036 / SC-011)', () => {
  it('cert number + cert date inputs carry min-h-11 (44px) once zero-rate is revealed', () => {
    renderForm();
    fireEvent.click(screen.getByRole('radio', { name: /Zero-rated/i }));
    expect(screen.getByLabelText(/MFA certificate number/i)).toHaveClass(
      'min-h-11',
    );
    expect(screen.getByLabelText(/Certificate date/i)).toHaveClass('min-h-11');
  });

  it('the immutable-snapshot confirm input carries min-h-11 (44px)', () => {
    renderForm();
    expect(screen.getByLabelText(/to confirm/i)).toHaveClass('min-h-11');
  });
});
