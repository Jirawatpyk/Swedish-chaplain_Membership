/**
 * Spec 122 US8c-2 (T854) — the invoice settings page frame on AURA, board
 * `Admin-invoice-settings`, in one view the page and the no-DB preview both
 * render (spec Clarifications, Session 2026-10-03, US8c-2 start):
 *
 *   the page header → the "future invoices only" note (the first-time copy
 *   when no settings exist yet) → the section rail and one card per section.
 *
 * The legacy wrapper card ("Invoice configuration") goes: the board has none.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import en from '@/i18n/messages/en.json';
import type { InvoiceSettingsFormInitialValues } from '@/components/invoices/invoice-settings-form';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: en, namespace: namespace as never }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
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
});

const { renderInvoiceSettingsView } = await import(
  '@/app/(staff)/admin/settings/invoicing/_components/invoice-settings-view'
);

const s = en.admin.invoiceSettings;

const VALUES: InvoiceSettingsFormInitialValues = {
  currency_code: 'THB',
  legal_name_th: 'สภาหอการค้าไทย-สวีเดน',
  legal_name_en: 'Thai-Swedish Chamber of Commerce',
  brand_name: 'SweCham',
  tax_id: '0994000187203',
  registered_address_th: 'กรุงเทพฯ',
  registered_address_en: 'Bangkok',
  vat_percent: '7.00',
  registration_fee_baht: '0.00',
  invoice_number_prefix: 'SC',
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

async function renderView(exists: boolean) {
  const ui = (await renderInvoiceSettingsView({ initialValues: VALUES, canEdit: true, exists })) as ReactElement;
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe('invoice settings page frame (board Admin-invoice-settings)', () => {
  it('has the page header, the note, the section rail and six section cards', async () => {
    await renderView(true);
    expect(screen.getByRole('heading', { level: 1, name: s.title })).toBeInTheDocument();
    expect(screen.getByText(s.subtitle)).toBeInTheDocument();
    const note = screen.getByText(s.card.description).closest('.aura-alert');
    expect(note).not.toBeNull();
    const rail = screen.getByRole('navigation', { name: s.nav.label });
    for (const key of ['organization', 'tax', 'numbering', 'documentNotes', 'payment', 'branding'] as const) {
      expect(within(rail).getByRole('button', { name: s.sections[key] })).toBeInTheDocument();
      const heading = screen.getByRole('heading', { level: 2, name: s.sections[key] });
      expect(heading.closest('.aura-card')).not.toBeNull();
    }
  });

  it('drops the legacy "Invoice configuration" wrapper card', async () => {
    const { container } = await renderView(true);
    expect(screen.queryByText(s.card.title)).toBeNull();
    expect(container.querySelector('[data-slot="card"]')).toBeNull();
  });

  it('reads the first-time copy in the note when no settings exist', async () => {
    await renderView(false);
    expect(screen.getByText(s.card.firstTimeDescription).closest('.aura-alert')).not.toBeNull();
    expect(screen.queryByText(s.card.description)).toBeNull();
  });
});
