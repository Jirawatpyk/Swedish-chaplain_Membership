/**
 * settings-ux-invoice-reminders (wave A / C3 + Minors) — sticky-bar
 * clearance + Save-button enablement states.
 *
 * C3: the fixed-bottom `StickySaveBar` (>=68px + safe-area inset) covers
 * the in-form Save button + error text once scrolled to the end, while
 * `dirty`. The form's content wrapper gets a matching bottom-padding
 * class ONLY while dirty, so the last elements can scroll clear of it.
 *
 * Minor 1: the in-form Save is disabled once settings already exist and
 * nothing has changed (`exists && !dirty`) — but first-time creation
 * (`!exists`) must always stay enabled, even though a fresh form equals
 * DEFAULTS and is therefore technically not "dirty".
 *
 * Minor 2: a 503 READ_ONLY_MODE response gets its own message (retrying
 * immediately won't help) instead of the generic "save failed, try
 * again".
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

function renderSettings(
  overrides: Partial<InvoiceSettingsFormInitialValues> = {},
  exists = true,
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <InvoiceSettingsForm
        initialValues={{ ...FIXTURE, ...overrides }}
        currentUserRole="admin"
        exists={exists}
      />
    </NextIntlClientProvider>,
  );
}

describe('InvoiceSettingsForm — C3 sticky-bar clearance', () => {
  it('pads the content wrapper only while dirty, so the sticky bar never covers the last section', () => {
    const { container } = renderSettings();
    const wrapper = container.querySelector('#organization')!.parentElement!;

    expect(wrapper.className).not.toMatch(/pb-\[calc\(env\(safe-area-inset-bottom\)/);

    fireEvent.change(container.querySelector('#brand_name')!, {
      target: { value: 'NewBrand' },
    });

    expect(wrapper.className).toMatch(/pb-\[calc\(env\(safe-area-inset-bottom\)\+5rem\)\]/);
  });
});

describe('InvoiceSettingsForm — Minor: disable in-form Save when nothing to save', () => {
  // Scoped to `button[type="submit"]` rather than getByRole+name — once
  // the form is dirty, the StickySaveBar renders its OWN "Save settings"
  // button (`type="button"`, drives `requestSubmit()`) alongside the
  // in-form one (`type="submit"`), so a name-only query is ambiguous.
  it('disables the bottom Save when settings exist and the form is unchanged', () => {
    const { container } = renderSettings({}, true);
    expect(container.querySelector('button[type="submit"]')).toBeDisabled();
  });

  it('re-enables the bottom Save once a field is dirtied', () => {
    const { container } = renderSettings({}, true);
    fireEvent.change(container.querySelector('#brand_name')!, {
      target: { value: 'NewBrand' },
    });
    expect(container.querySelector('button[type="submit"]')).toBeEnabled();
  });

  it('never blocks first-time creation, even though a fresh form equals DEFAULTS (not dirty)', () => {
    const { container } = renderSettings({}, false);
    const submitButton = container.querySelector('button[type="submit"]');
    expect(submitButton).toBeEnabled();
    expect(submitButton).toHaveTextContent(/create settings/i);
  });
});

describe('InvoiceSettingsForm — code-review follow-up (finding 1): symmetric normalization keeps dirty clean after save', () => {
  it('does not count a trailing-space-only change to a trimmed field as dirty', () => {
    // bank_swift is stored server-side already trimmed; a user typing a
    // trailing space (which the PATCH body trims away — see `orNull`/
    // `swiftTrimmed` in handleSubmit) must not be treated as a real change.
    const { container } = renderSettings({ bank_swift: 'ABCDTHBK' });
    fireEvent.change(container.querySelector('#bank_swift')!, {
      target: { value: 'ABCDTHBK ' }, // trailing space only
    });
    expect(container.querySelector('button[type="submit"]')).toBeDisabled();
  });

  it('clears dirty once a save reloads initialValues with the server-normalized (trimmed/uppercased) value', () => {
    const { container, rerender } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <InvoiceSettingsForm initialValues={FIXTURE} currentUserRole="admin" exists />
      </NextIntlClientProvider>,
    );

    // Admin types a lower-case currency code.
    fireEvent.change(container.querySelector('#currency_code')!, {
      target: { value: 'usd' },
    });
    expect(container.querySelector('button[type="submit"]')).toBeEnabled();

    // Simulate a successful save's `router.refresh()`: the parent Server
    // Component re-fetches and passes a NEW `initialValues` prop with the
    // server-normalized (upper-cased) value. React does NOT reset the
    // `currencyCode` useState just because a prop changed — the field's
    // raw local state ("usd") is untouched — so the fix must normalize
    // BOTH sides identically for the dirty compare to agree afterward.
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <InvoiceSettingsForm
          initialValues={{ ...FIXTURE, currency_code: 'USD' }}
          currentUserRole="admin"
          exists
        />
      </NextIntlClientProvider>,
    );

    expect(container.querySelector('button[type="submit"]')).toBeDisabled();
  });
});

describe('InvoiceSettingsForm — Minor: READ_ONLY_MODE 503 gets a specific message', () => {
  it('shows the read-only message (not the generic "save failed") on a 503 read-only-mode response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'read-only-mode',
          message: 'The system is currently in read-only mode for maintenance.',
          retryAfterSeconds: 300,
          supportUrl: '/admin/support',
        }),
        { status: 503 },
      ),
    );

    const { container, findByText } = renderSettings();
    fireEvent.change(container.querySelector('#brand_name')!, {
      target: { value: 'NewBrand' },
    });
    fireEvent.submit(container.querySelector('form')!);

    await findByText(/temporarily read-only for maintenance/i);
    expect(container.querySelector('[role="alert"]')).not.toHaveTextContent(
      /save failed/i,
    );
  });
});
