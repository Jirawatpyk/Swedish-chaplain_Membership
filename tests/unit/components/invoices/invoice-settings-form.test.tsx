/**
 * 088 US5 / T072b (FR-036 / SC-011) — settings-form target-size + grouping guard.
 *
 * A cheap, always-green CI assertion (rendered against the REAL en.json so a
 * dangling key would surface as MISSING_MESSAGE) that:
 *   - the NEW US5 controls (seller branch + bank-block inputs) carry the 44px
 *     `min-h-11` utility — the shared shadcn Input is 36px and is NOT changed;
 *     these feature inputs are bumped inline (FR-036 ≥44×44px touch target);
 *   - the primary Save button is ≥44px;
 *   - every section is grouped with `<fieldset><legend>` (mobile-first grouping).
 *
 * The measurable @a11y check (axe + boundingBox ≥44 + 320/375 reflow) lives in
 * the preview-gated `tests/e2e/invoicing/invoice-settings-a11y.spec.ts`; this is
 * the structural guard that runs on every commit.
 *
 * NOTE (documented scope): the F4 Numbering-section prefix inputs (invoice /
 * credit-note / receipt) predate 088 US5 and are intentionally left at 36px —
 * bumping only the receipt prefix would split one 2-col grid row 36/36/44. The
 * form-wide 36↔44 mix is flagged for a design call, not resolved here.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

// Task 7 — the orchestrator now mounts <SectionNav>, which mounts the real
// (un-mocked) useScrollSpy hook. jsdom has no real IntersectionObserver;
// same no-op stand-in as section-nav.test.tsx — this file's assertions
// don't depend on scroll-driven active-section updates.
class NoopIntersectionObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}
beforeEach(() => {
  (globalThis as unknown as { IntersectionObserver: typeof NoopIntersectionObserver }).IntersectionObserver =
    NoopIntersectionObserver;
});

const BASE_VALUES: InvoiceSettingsFormInitialValues = {
  currency_code: 'THB',
  legal_name_th: 'บริษัท',
  legal_name_en: 'Company',
  brand_name: '',
  tax_id: '0994000187203',
  registered_address_th: 'ที่อยู่',
  registered_address_en: 'Address',
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
  // seller_is_head_office:false → the branch input renders for the guard.
  seller_is_head_office: false,
  seller_branch_code: '00001',
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

function renderSettings(
  overrides: Partial<InvoiceSettingsFormInitialValues> = {},
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <InvoiceSettingsForm
        initialValues={{ ...BASE_VALUES, ...overrides }}
        currentUserRole="admin"
        exists
      />
    </NextIntlClientProvider>,
  );
}

describe('InvoiceSettingsForm — target-size on new US5 controls (FR-036 / SC-011)', () => {
  it('seller branch + bank-block inputs carry min-h-11 (44px)', () => {
    const { container } = renderSettings();
    for (const id of [
      'seller_branch',
      'bank_payee',
      'bank_name',
      'bank_account_no',
      'bank_account_type',
      'bank_branch',
      'bank_swift',
    ]) {
      const el = container.querySelector(`#${id}`);
      expect(el, `#${id} should render`).not.toBeNull();
      expect(el).toHaveClass('min-h-11');
    }
  });

  it('the primary Save button carries min-h-11 (44px)', () => {
    renderSettings();
    expect(screen.getByRole('button', { name: /Save settings/i })).toHaveClass(
      'min-h-11',
    );
  });
});

describe('InvoiceSettingsForm — fieldset/legend grouping (FR-036)', () => {
  it('groups every section with a <fieldset><legend>', () => {
    const { container } = renderSettings();
    const legends = container.querySelectorAll('fieldset > legend');
    // currency, identity, tax, numbering, defaults, seller, whtNote, bank, logo.
    expect(legends.length).toBeGreaterThanOrEqual(9);
  });
});
