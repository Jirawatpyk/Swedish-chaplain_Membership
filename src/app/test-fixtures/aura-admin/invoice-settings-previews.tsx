'use client';

/**
 * Spec 122 US8c-2 (T858) — preview helpers for the invoice settings
 * (`/test-fixtures/aura-admin?view=invoice-settings&state=…`, board
 * `Admin-invoice-settings`). The fixture values and the dirty / prefix-confirm
 * driver live here; nothing can save (the PATCH reaches no database).
 */
import { useEffect, useRef, type ReactNode } from 'react';
import type { InvoiceSettingsFormInitialValues } from '@/components/invoices/invoice-settings-form';

export const INVOICE_SETTINGS_FIXTURE: InvoiceSettingsFormInitialValues = {
  currency_code: 'THB',
  legal_name_th: 'สภาหอการค้าไทย-สวีเดน',
  legal_name_en: 'Thai-Swedish Chamber of Commerce',
  brand_name: 'SweCham',
  tax_id: '0994000187203',
  registered_address_th: '29 อาคารบางกอกบิสสิเนสเซ็นเตอร์ ชั้น 11 ซอยสุขุมวิท 63\nแขวงคลองตันเหนือ เขตวัฒนา กรุงเทพฯ 10110',
  registered_address_en: '29 Bangkok Business Center, 11th Floor, Sukhumvit 63\nKhlong Tan Nuea, Watthana, Bangkok 10110',
  vat_percent: '7.00',
  registration_fee_baht: '5000.00',
  invoice_number_prefix: 'SC',
  credit_note_number_prefix: 'CN',
  receipt_numbering_mode: 'separate',
  receipt_number_prefix: 'RC',
  fiscal_year_start_month: 1,
  default_net_days: 30,
  pro_rate_policy: 'monthly',
  auto_email_enabled: true,
  logo_blob_key: 'tenants/swecham/invoice-logo.png',
  seller_is_head_office: true,
  seller_branch_code: null,
  wht_note_th: null,
  wht_note_en: null,
  termination_notice_th: null,
  termination_notice_en: null,
  bank_payee_name: 'Thai-Swedish Chamber of Commerce',
  bank_account_no: '123-4-56789-0',
  bank_account_type: 'Savings',
  bank_name: 'Kasikornbank',
  bank_branch: 'Sukhumvit 63',
  bank_address: null,
  bank_swift: 'KASITHBK',
  payment_instructions_th: null,
  payment_instructions_en: 'Please quote the invoice number in the transfer reference.',
};

/** Types into an input the way a user would, so React's onChange runs. */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * `dirty`: edits the short name so the save bar shows. `prefix-confirm`: edits
 * the invoice prefix and submits, so the §87 prefix-change confirmation opens.
 */
export function InvoiceSettingsPreviewDriver({
  action,
  children,
}: {
  readonly action: 'dirty' | 'prefix-confirm' | null;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!action) return;
    let tries = 0;
    const id = window.setInterval(() => {
      const root = ref.current;
      const field = root?.querySelector<HTMLInputElement>(action === 'dirty' ? '#brand_name' : '#inv_prefix');
      if (!field && ++tries < 50) return;
      window.clearInterval(id);
      if (!field) return;
      typeInto(field, action === 'dirty' ? 'SweCham Bangkok' : 'SCB');
      if (action === 'prefix-confirm') {
        window.setTimeout(() => field.form?.requestSubmit(), 50);
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [action]);
  // `contents` keeps the page's own column gaps (DetailContainer lays out its children).
  return (
    <div ref={ref} className="contents">
      {children}
    </div>
  );
}
