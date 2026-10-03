/**
 * Spec 122 US8c-2 (T857) — the sticky save bar on AURA ActionBar with Discard
 * (maintainer, 3 Oct: "Add Discard"), and the prefix-change confirmation on
 * the shared ConfirmationDialog (spec Clarifications, Session 2026-10-03).
 *
 * Discard puts every field back to the values the page loaded with (the
 * snapshot the dirty check compares against), clears the field errors and the
 * error line, sends no request, hides the bar and moves focus to the first
 * section. The confirmation keeps its copy and sends the same PATCH body.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { toast } from '@/lib/toast';
import {
  InvoiceSettingsForm,
  type InvoiceSettingsFormInitialValues,
} from '@/components/invoices/invoice-settings-form';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

class NoopIntersectionObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}
beforeEach(() => {
  (globalThis as unknown as { IntersectionObserver: typeof NoopIntersectionObserver }).IntersectionObserver =
    NoopIntersectionObserver;
  vi.useRealTimers();
});
afterEach(() => {
  vi.useFakeTimers();
  vi.restoreAllMocks();
});

const FIXTURE: InvoiceSettingsFormInitialValues = {
  currency_code: 'THB',
  legal_name_th: 'บริษัท ทดสอบ จำกัด',
  legal_name_en: 'Test Company Ltd.',
  brand_name: 'TestChamber',
  tax_id: '0994000187203',
  registered_address_th: 'ที่อยู่ทดสอบ',
  registered_address_en: 'Test address',
  vat_percent: '7.00',
  registration_fee_baht: '500.00',
  invoice_number_prefix: 'INV',
  credit_note_number_prefix: 'CN',
  receipt_numbering_mode: 'separate',
  receipt_number_prefix: 'RC',
  fiscal_year_start_month: 1,
  default_net_days: 30,
  pro_rate_policy: 'monthly',
  auto_email_enabled: true,
  logo_blob_key: null,
  seller_is_head_office: true,
  seller_branch_code: null,
  wht_note_th: null,
  wht_note_en: null,
  termination_notice_th: null,
  termination_notice_en: null,
  bank_payee_name: null,
  bank_account_no: null,
  bank_account_type: null,
  bank_name: null,
  bank_branch: null,
  bank_address: null,
  bank_swift: null,
  payment_instructions_th: null,
  payment_instructions_en: null,
};

const s = enMessages.admin.invoiceSettings;

function renderForm(exists = true) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <InvoiceSettingsForm initialValues={FIXTURE} canEdit exists={exists} />
    </NextIntlClientProvider>,
  );
}

const field = (id: string) => document.getElementById(id) as HTMLInputElement;

describe('sticky save bar on AURA ActionBar', () => {
  it('is absent while the form is clean', () => {
    renderForm();
    expect(screen.queryByRole('region', { name: s.stickyBar.label })).toBeNull();
  });

  it('once dirty shows "You have unsaved changes", then Discard, then Save settings', () => {
    renderForm();
    fireEvent.change(field('brand_name'), { target: { value: 'NewBrand' } });
    const bar = screen.getByRole('region', { name: s.stickyBar.label });
    expect(bar).toHaveClass('aura-actionbar');
    expect(bar).toHaveTextContent(s.stickyBar.unsaved);
    const buttons = within(bar).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual([s.stickyBar.discard, s.actions.save]);
    expect(buttons[0]).toHaveClass('aura-btn--secondary');
  });
});

describe('Discard', () => {
  it('puts every changed field back, hides the bar, focuses the first section and sends no request', () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    renderForm();
    fireEvent.change(field('brand_name'), { target: { value: 'NewBrand' } });
    fireEvent.change(field('vat_percent'), { target: { value: '10' } });
    fireEvent.change(field('bank_swift'), { target: { value: 'KASITHBK' } });
    fireEvent.click(screen.getByRole('switch', { name: /auto-email on issue\/payment/i }));

    const bar = screen.getByRole('region', { name: s.stickyBar.label });
    fireEvent.click(within(bar).getByRole('button', { name: s.stickyBar.discard }));

    expect(field('brand_name')).toHaveValue(FIXTURE.brand_name);
    expect(field('vat_percent')).toHaveValue(7);
    expect(field('bank_swift')).toHaveValue('');
    expect(screen.getByRole('switch', { name: /auto-email on issue\/payment/i })).toBeChecked();
    expect(screen.queryByRole('region', { name: s.stickyBar.label })).toBeNull();
    expect(document.getElementById('organization')).toHaveFocus();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('clears the error line and the field marks a blocked save left', () => {
    const { container } = renderForm();
    fireEvent.change(field('legal_name_en'), { target: { value: '' } });
    fireEvent.submit(container.querySelector('form')!);
    expect(field('legal_name_en')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(s.errors.requiredFields)).toBeInTheDocument();

    const bar = screen.getByRole('region', { name: s.stickyBar.label });
    fireEvent.click(within(bar).getByRole('button', { name: s.stickyBar.discard }));

    expect(field('legal_name_en')).toHaveValue(FIXTURE.legal_name_en);
    expect(field('legal_name_en')).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByText(s.errors.requiredFields)).toBeNull();
  });
});

describe('Discard waits for the saved values (financial review M1, L1)', () => {
  it('is disabled after a successful save until the refreshed values arrive', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const { container, rerender } = renderForm();
    fireEvent.change(field('vat_percent'), { target: { value: '10' } });
    fireEvent.submit(container.querySelector('form')!);
    const bar = () => screen.getByRole('region', { name: s.stickyBar.label });
    // Saved, but router.refresh() has not delivered the new values yet: the
    // form still differs from the stale snapshot, and Discard must not put
    // the pre-save values back.
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    await waitFor(() => expect(within(bar()).getByRole('button', { name: s.actions.save })).toBeEnabled());
    expect(within(bar()).getByRole('button', { name: s.stickyBar.discard })).toBeDisabled();
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <InvoiceSettingsForm initialValues={{ ...FIXTURE, vat_percent: '10.00' }} canEdit exists />
      </NextIntlClientProvider>,
    );
    fireEvent.change(field('brand_name'), { target: { value: 'Later edit' } });
    expect(within(bar()).getByRole('button', { name: s.stickyBar.discard })).toBeEnabled();
  });

  it('is disabled while a logo upload is in flight', async () => {
    let finish: (r: Response) => void = () => {};
    vi.spyOn(global, 'fetch').mockReturnValue(new Promise<Response>((r) => (finish = r)));
    renderForm();
    fireEvent.change(field('brand_name'), { target: { value: 'NewBrand' } });
    const file = new File(['x'], 'logo.png', { type: 'image/png' });
    fireEvent.change(document.getElementById('logo_file')!, { target: { files: [file] } });
    const bar = screen.getByRole('region', { name: s.stickyBar.label });
    await waitFor(() => expect(within(bar).getByRole('button', { name: s.stickyBar.discard })).toBeDisabled());
    finish(new Response(JSON.stringify({ logo_blob_key: 'tenants/x/logo.png' }), { status: 200 }));
    await waitFor(() => expect(within(bar).getByRole('button', { name: s.stickyBar.discard })).toBeEnabled());
  });
});

describe('in-form Save on AURA', () => {
  it('is an AURA Button at 44px', () => {
    const { container } = renderForm();
    const submit = container.querySelector('button[type="submit"]')!;
    expect(submit).toHaveClass('aura-btn', 'min-h-11');
  });
});

describe('prefix-change confirmation on the shared ConfirmationDialog', () => {
  it('opens on a prefix change with the same copy, and Change prefix sends the same full PATCH body', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const { container } = renderForm();
    fireEvent.change(field('inv_prefix'), { target: { value: 'SC' } });
    fireEvent.submit(container.querySelector('form')!);

    const dialog = await screen.findByRole('alertdialog', { name: s.prefixChange.title });
    expect(dialog).toHaveClass('aura-dialog');
    expect(dialog).toHaveTextContent(s.prefixChange.description);
    expect(fetchSpy).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: s.prefixChange.confirm }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/tenant-invoice-settings');
    expect((init as RequestInit).method).toBe('PATCH');
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body.invoice_number_prefix).toBe('SC');
    expect(body.credit_note_number_prefix).toBe(FIXTURE.credit_note_number_prefix);
    expect(body.tax_id).toBe(FIXTURE.tax_id);
    expect(body.vat_rate).toBe('0.0700');
  });

  it('Cancel closes it and sends nothing', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const { container } = renderForm();
    fireEvent.change(field('cn_prefix'), { target: { value: 'CR' } });
    fireEvent.submit(container.querySelector('form')!);
    const dialog = await screen.findByRole('alertdialog', { name: s.prefixChange.title });
    fireEvent.click(within(dialog).getByRole('button', { name: s.prefixChange.cancel }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
