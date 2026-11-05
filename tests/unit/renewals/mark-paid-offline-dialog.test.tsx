/**
 * Review-fix I-1 (enterprise-ux, Wave 2 Task 5) — `MarkPaidOfflineDialog`
 * must show WHICH member/company is being settled when opened from the
 * pipeline table's row ⋯ menu: a money mutation (mints a §86/4 tax invoice
 * + completes the cycle) offered no in-dialog confirmation of identity on a
 * dense table. Mirrors the sibling "Mark contacted" dialog (`OutreachDialog`)
 * in the same ⋯ menu, which already shows the company name.
 *
 * Render-only test (no submit click): passing `open` directly to a
 * controlled Base UI Dialog is safe under jsdom — see
 * `plan-change-confirm-dialog.test.tsx`. Only a click-through submit flow
 * with `startTransition` deadlocks (the dialog-jsdom-hang memory documented
 * in `cycle-admin-actions.test.tsx`), which this test does not exercise.
 *
 * The cycle-detail caller (`cycle-admin-actions.tsx`) passes NO
 * `companyName` prop at all — the "without companyName" case below pins
 * that the dialog body stays exactly as it was pre-fix for that caller
 * (behaviour-preserving).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { MarkPaidOfflineDialog } from '@/app/(staff)/admin/renewals/_components/mark-paid-offline-dialog';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/toast')>();
  return { ...actual, toast: { ...actual.toast, error: toastError } };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const CYCLE_ID = '11111111-1111-1111-1111-111111111111';

function renderWithCompany(companyName: string) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MarkPaidOfflineDialog
        cycleId={CYCLE_ID}
        open
        onOpenChange={() => {}}
        companyName={companyName}
      />
    </NextIntlClientProvider>,
  );
}

function renderWithoutCompany() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MarkPaidOfflineDialog cycleId={CYCLE_ID} open onOpenChange={() => {}} />
    </NextIntlClientProvider>,
  );
}

describe('MarkPaidOfflineDialog — I-1 member-identity confirmation', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => cleanup());

  it('shows the company name when opened from the pipeline row ⋯ menu', () => {
    renderWithCompany('Acme Co., Ltd.');
    expect(screen.getByText('For Acme Co., Ltd.')).toBeInTheDocument();
  });

  it('renders nothing extra when companyName is absent (cycle-detail caller)', () => {
    renderWithoutCompany();
    expect(screen.queryByText(/^For /)).toBeNull();
  });
});

// 122 US7a (T708), board `Admin-renewal-mark-paid`: an AURA dialog with the
// method, reference and date (an AURA DatePicker), the tax-document warning,
// and the same request body.
describe('MarkPaidOfflineDialog on AURA', () => {
  const M = enMessages.admin.renewals.cycleDetail.markPaidOffline;

  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  /** An AURA DatePicker takes a typed ISO date on blur (US5b-2 precedent). */
  function typeDate(label: string, value: string) {
    // The required field's label ends with its asterisk.
    const input = screen.getByLabelText(new RegExp(`^${label}`));
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
  }

  it('is an AURA dialog with the method, reference and date fields and the tax-document warning', () => {
    renderWithCompany('Acme Co., Ltd.');
    const dialog = screen.getByRole('dialog', { name: M.dialogTitle });
    expect(dialog).toHaveClass('aura-dialog');
    expect(within(dialog).getByRole('combobox', { name: M.paymentMethodLabel })).toHaveTextContent(
      M.paymentMethod.bank_transfer,
    );
    expect(within(dialog).getByRole('textbox', { name: M.paymentReferenceLabel })).toBeRequired();
    expect(within(dialog).getByLabelText(new RegExp(`^${M.paymentDateLabel}`)).closest('.aura-field')?.querySelector('.aura-date__toggle')).not.toBeNull();
    const warning = within(dialog).getByText(M.taxDocWarningTitle).closest('.aura-alert');
    expect(warning).toHaveClass('aura-alert--warning');
    expect(warning).toHaveTextContent(M.taxDocWarningBody);
  });

  it('enables Mark paid once the reference and date are set, and sends the same body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    renderWithCompany('Acme Co., Ltd.');
    const confirm = screen.getByRole('button', { name: M.confirm });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: M.paymentReferenceLabel }), {
      target: { value: ' KBANK-240926 ' },
    });
    typeDate(M.paymentDateLabel, '2026-09-24');
    await waitFor(() => expect(confirm).not.toBeDisabled());
    fireEvent.click(confirm);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/admin/renewals/${CYCLE_ID}/mark-paid-offline`);
    expect(JSON.parse(init.body as string)).toEqual({
      payment_method: 'bank_transfer',
      payment_reference: 'KBANK-240926',
      payment_date: '2026-09-24',
    });
  });

  it('cannot be dismissed while the payment is being recorded (ux-standards § 6.4)', async () => {
    // The POST never settles: the dialog stays in its pending state.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const onOpenChange = vi.fn();
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MarkPaidOfflineDialog cycleId={CYCLE_ID} open onOpenChange={onOpenChange} />
      </NextIntlClientProvider>,
    );
    fireEvent.change(screen.getByRole('textbox', { name: M.paymentReferenceLabel }), {
      target: { value: 'KBANK-240926' },
    });
    typeDate(M.paymentDateLabel, '2026-09-24');
    const confirm = screen.getByRole('button', { name: M.confirm });
    await waitFor(() => expect(confirm).not.toBeDisabled());
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm).toHaveAttribute('aria-busy', 'true'));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  // #730 /code-review — a coverage overlap that names its covering bill links
  // it, with its OWN copy: never the live-bill "record the payment there",
  // which is wrong for another plan year or a bill already paid.
  // #73 — each linked toast is a short title plus a description, so the copy
  // does not wrap into a narrow column beside the action button (R130).
  it.each([
    {
      code: 'membership_coverage_overlap',
      body: { existing_invoice_id: 'inv-9' },
      title: M.error.membership_coverage_overlapTitle,
      detail: M.error.membership_coverage_overlapDetail,
      action: M.viewExistingInvoice,
    },
    {
      code: 'membership_bill_already_exists',
      body: { existing_invoice_id: 'inv-9' },
      title: M.error.membership_bill_already_existsTitle,
      detail: M.error.membership_bill_already_existsDetail,
      action: M.viewExistingInvoice,
    },
    {
      code: 'f4_orphan_invoice',
      body: { orphan_invoice_id: 'inv-7' },
      title: M.error.f4_orphan_invoiceTitle,
      detail: M.error.f4_orphan_invoiceDetail,
      action: M.viewOrphanInvoice,
    },
  ])('#73 the linked $code toast is a short title with a description', async (c) => {
    toastError.mockClear();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: c.code, ...c.body } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderWithCompany('Acme Co., Ltd.');
    fireEvent.change(screen.getByRole('textbox', { name: M.paymentReferenceLabel }), {
      target: { value: 'KBANK-1' },
    });
    typeDate(M.paymentDateLabel, '2026-09-24');
    const confirm = screen.getByRole('button', { name: M.confirm });
    await waitFor(() => expect(confirm).not.toBeDisabled());
    fireEvent.click(confirm);
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    const [message, opts] = toastError.mock.calls[0] as [
      string,
      { description?: string; action?: { label: string }; duration?: number },
    ];
    expect(typeof c.title).toBe('string');
    expect(typeof c.detail).toBe('string');
    expect(message).toBe(c.title);
    expect(opts.description).toBe(c.detail);
    expect(opts.action?.label).toBe(c.action);
    expect(opts.duration).toBe(30_000);
  });
});
