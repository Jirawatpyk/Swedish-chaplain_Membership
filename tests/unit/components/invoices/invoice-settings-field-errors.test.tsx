/**
 * settings-ux-invoice-reminders (wave A / C1) — field-level error feedback.
 *
 * Closes three enterprise-UX review findings on `InvoiceSettingsForm`
 * (Task-7 MEDIUM + 2 related gaps):
 *
 *   (a) Per-guard field targeting — a blocked client-side submit must
 *       focus the field the guard that ACTUALLY FIRED is about, not
 *       merely the first `:invalid` element in DOM order. Proven with a
 *       guard-order/DOM-order mismatch: `vat_percent` (guard-checked
 *       2nd) fires while `currency_code` (DOM position 1, the very
 *       first field in the form) is ALSO simultaneously invalid but its
 *       guard hasn't run yet — the old global `:invalid` scan would
 *       have focused `currency_code` (wrong field, wrong message).
 *   (b) Server `invalid_body` + `fieldErrors` (the route's zod
 *       `.flatten()`) must mark + focus the named field(s), mapped from
 *       the schema field name to the input's DOM id where they differ
 *       (`registered_address_th` -> `#addr_th`, `invoice_number_prefix`
 *       -> `#inv_prefix`, etc. — see `FIELD_ID_MAP` in the component).
 *   (c) An empty required-text field (route schema `.min(1)`) must block
 *       submit CLIENT-SIDE — no `fetch` call — with that field focused.
 *       Before this fix, the ONLY thing that ever caught a blank
 *       required field was the server's 400, and even then nothing was
 *       focused.
 *
 * Every assertion here targets `aria-invalid` + `document.activeElement`
 * directly (never the `:invalid` CSS pseudo-class), so these tests don't
 * depend on jsdom's constraint-validation fidelity.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
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

// jsdom has no real IntersectionObserver — the orchestrator mounts
// <SectionNav>, which mounts the real (un-mocked) useScrollSpy hook. Same
// no-op stand-in as invoice-settings-fullbody.test.tsx.
class NoopIntersectionObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}
beforeEach(() => {
  (globalThis as unknown as { IntersectionObserver: typeof NoopIntersectionObserver }).IntersectionObserver =
    NoopIntersectionObserver;
  // tests/setup.ts installs fake timers globally — the fieldErrors test
  // awaits a mocked fetch(), which needs real timers (same fix as
  // invoice-settings-fullbody.test.tsx).
  vi.useRealTimers();
});
afterEach(() => {
  vi.useFakeTimers();
  vi.restoreAllMocks();
});

// Every guard-relevant field starts VALID — each test deliberately
// invalidates only the field(s) it's testing.
const FIXTURE: InvoiceSettingsFormInitialValues = {
  currency_code: 'THB',
  legal_name_th: 'บริษัท ทดสอบ จำกัด',
  legal_name_en: 'Test Company Ltd.',
  brand_name: '',
  tax_id: '0994000187203',
  registered_address_th: 'ที่อยู่ทดสอบ',
  registered_address_en: 'Test address',
  vat_percent: '7.00',
  registration_fee_baht: '0',
  invoice_number_prefix: 'INV',
  credit_note_number_prefix: 'CN',
  receipt_numbering_mode: 'separate',
  receipt_number_prefix: 'RC',
  fiscal_year_start_month: 1,
  default_net_days: 30,
  pro_rate_policy: 'monthly',
  auto_email_enabled: true,
  logo_blob_key: null,
  // head office — the seller-branch guard doesn't apply.
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

function renderSettings(overrides: Partial<InvoiceSettingsFormInitialValues> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <InvoiceSettingsForm
        initialValues={{ ...FIXTURE, ...overrides }}
        currentUserRole="admin"
        exists
      />
    </NextIntlClientProvider>,
  );
}

describe('InvoiceSettingsForm — C1(a) per-guard field targeting', () => {
  it('focuses the field the FIRED guard is about, not the first DOM :invalid element', () => {
    const { container } = renderSettings();
    const form = container.querySelector('form')!;

    // vat_percent's guard is checked 2nd in handleSubmit's sequence;
    // currency_code's guard is checked 6th, even though currency_code is
    // the very FIRST field in DOM order. Invalidate both: the vat guard
    // fires first and must win the focus, not currency_code's DOM
    // position.
    fireEvent.change(container.querySelector('#vat_percent')!, {
      target: { value: '999' },
    });
    fireEvent.change(container.querySelector('#currency_code')!, {
      target: { value: 'us' },
    });

    fireEvent.submit(form);

    expect(document.activeElement?.id).toBe('vat_percent');
    expect(container.querySelector('#vat_percent')).toHaveAttribute('aria-invalid', 'true');
    // The vat guard returned before ever reaching currency_code's check —
    // it must not be marked, even though it's also independently invalid.
    expect(container.querySelector('#currency_code')).not.toHaveAttribute('aria-invalid');
    expect(container.querySelector('[role="alert"]')).toHaveTextContent(
      /VAT must be between 0 and 30 percent/i,
    );
  });
});

describe('InvoiceSettingsForm — C1(b) server fieldErrors mapping', () => {
  it('marks + focuses the server-named field, mapped through FIELD_ID_MAP when the DOM id differs', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'invalid_body',
            details: {
              formErrors: [],
              fieldErrors: {
                // schema key differs from its DOM id (`#addr_th`) —
                // proves FIELD_ID_MAP is actually consulted, not just the
                // raw schema key.
                registered_address_th: ['String must contain at least 1 character(s)'],
                invoice_number_prefix: ['String must contain at least 1 character(s)'],
              },
            },
          },
        }),
        { status: 400 },
      ),
    );

    const { container, findByText } = renderSettings();
    const form = container.querySelector('form')!;

    fireEvent.submit(form);

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/tenant-invoice-settings',
      expect.objectContaining({ method: 'PATCH' }),
    );

    // Both server-named fields get marked...
    await findByText(/fill in the highlighted required fields/i);
    expect(container.querySelector('#addr_th')).toHaveAttribute('aria-invalid', 'true');
    expect(container.querySelector('#inv_prefix')).toHaveAttribute('aria-invalid', 'true');
    // ...but only the FIRST one (object key order) gets focus.
    expect(document.activeElement?.id).toBe('addr_th');
  });
});

describe('InvoiceSettingsForm — C1(c) empty required-text field blocks submit client-side', () => {
  it('blocks submit with no fetch call when a required text field is blank', () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const { container } = renderSettings({ legal_name_en: '' });
    const form = container.querySelector('form')!;

    fireEvent.submit(form);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.activeElement?.id).toBe('legal_name_en');
    expect(container.querySelector('#legal_name_en')).toHaveAttribute('aria-invalid', 'true');
    expect(container.querySelector('[role="alert"]')).toHaveTextContent(
      /fill in the highlighted required fields/i,
    );
  });

  it('walks the required-text fields top-to-bottom — an earlier blank field wins over a later one', () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    // Both legal_name_th (Organization, earlier in DOM) and
    // credit_note_number_prefix (Numbering, later in DOM) are blank —
    // the earlier one must be the one blocked + focused.
    const { container } = renderSettings({
      legal_name_th: '',
      credit_note_number_prefix: '',
    });
    const form = container.querySelector('form')!;

    fireEvent.submit(form);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.activeElement?.id).toBe('legal_name_th');
    expect(container.querySelector('#legal_name_th')).toHaveAttribute('aria-invalid', 'true');
    // The later field wasn't reached by this guard at all.
    expect(container.querySelector('#cn_prefix')).not.toHaveAttribute('aria-invalid');
  });
});
