/**
 * Task 7 (settings-ux-invoice-reminders) — full-body invariance guard.
 *
 * The sticky Save bar (Task 3/7) never calls `fetch` itself; it drives
 * `formRef.current?.requestSubmit()`, re-entering the SAME `handleSubmit`
 * the bottom submit button uses. This test proves that wiring holds: the
 * PATCH fires exactly once and carries the FULL settings shape (identity
 * + tax fields untouched by this edit still ride along), not a partial
 * body keyed only to the field that changed. A regression here (e.g. the
 * sticky bar posting its own ad-hoc payload) would silently null out
 * every untouched tax-compliance field on save.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import {
  InvoiceSettingsForm,
  type InvoiceSettingsFormInitialValues,
} from '@/components/invoices/invoice-settings-form';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// jsdom has no real IntersectionObserver — the orchestrator now mounts
// <SectionNav>, which mounts the real (un-mocked) useScrollSpy hook. Same
// no-op stand-in as tests/unit/components/invoices/section-nav.test.tsx;
// this test doesn't depend on scroll-driven active-section updates.
class NoopIntersectionObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}
beforeEach(() => {
  (globalThis as unknown as { IntersectionObserver: typeof NoopIntersectionObserver }).IntersectionObserver =
    NoopIntersectionObserver;
  // tests/setup.ts installs fake timers globally (shouldAdvanceTime: false).
  // `findByRole`/`waitFor` poll via a real setTimeout internally, which
  // would otherwise hang until the suite's own 30s timeout — same fix as
  // tests/unit/components/pii-forms-post-method.test.tsx and the
  // <EventFeeForm> describe block in event-fee-form.test.tsx.
  vi.useRealTimers();
});
afterEach(() => {
  vi.useFakeTimers();
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

function renderForm() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <InvoiceSettingsForm initialValues={FIXTURE} currentUserRole="admin" exists />
    </NextIntlClientProvider>,
  );
}

describe('InvoiceSettingsForm — sticky Save full-body invariance (Task 7)', () => {
  it('sticky Save routes through the same handleSubmit (fetch PATCH fires once, full body)', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    renderForm();

    // Dirty a single field — the sticky bar only renders once the form
    // differs from its initial snapshot (isDirty).
    fireEvent.change(screen.getByLabelText(/short name/i), {
      target: { value: 'NewBrand' },
    });

    // The bottom submit button and the sticky bar's button share the same
    // translated label ("Save settings") — disambiguate by scoping the
    // query to the sticky bar's labelled region ("Save changes").
    const stickyRegion = await screen.findByRole('region', { name: /save changes/i });
    fireEvent.click(within(stickyRegion).getByRole('button', { name: /save/i }));

    await waitFor(() => {
      const patchCalls = fetchSpy.mock.calls.filter(([url]) =>
        String(url).includes('/api/tenant-invoice-settings'),
      );
      expect(patchCalls).toHaveLength(1);
    });

    const patchCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes('/api/tenant-invoice-settings'),
    );
    const [, init] = patchCalls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;

    // Full body, not a partial — identity/tax fields ride along untouched
    // even though only brand_name changed via the sticky Save.
    expect(body).toHaveProperty('tax_id', FIXTURE.tax_id);
    expect(body).toHaveProperty('legal_name_th', FIXTURE.legal_name_th);
    expect(body).toHaveProperty('vat_rate');
    expect(body).toHaveProperty('invoice_number_prefix', FIXTURE.invoice_number_prefix);
    expect(body.brand_name).toBe('NewBrand');
  });
});
