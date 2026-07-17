/**
 * Unit tests for <OnlinePaymentDisabledCard> — G4 T082.
 * Contract: specs/009-online-payment FR-030 empty-state.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import { OnlinePaymentDisabledCard } from '@/app/(member)/portal/invoices/[invoiceId]/_components/online-payment-disabled-card';

const messages = {
  portal: {
    payment: {
      disabled: {
        title: 'Online payment unavailable',
        body: 'Online card and PromptPay payments are not available for this invoice. Please contact the chamber administrator for bank-transfer instructions.',
        contactAdminCta: 'Contact administrator',
        contactAdminCtaAria: 'Contact administrator about invoice {invoiceNumber}',
        noContactEmail:
          'No administrator email is configured yet. Please contact the chamber office directly.',
        mailSubject: 'Bank-transfer instructions for invoice {invoiceNumber}',
      },
    },
  },
};

function renderCard(tenantContactEmails: readonly string[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <OnlinePaymentDisabledCard
        invoiceNumber="TSCC-2026-0007"
        tenantContactEmails={tenantContactEmails}
      />
    </NextIntlClientProvider>,
  );
}

describe('<OnlinePaymentDisabledCard>', () => {
  afterEach(() => cleanup());

  it('renders icon + title + body + CTA when a contact email is configured', () => {
    renderCard(['ops@tscc.example']);
    const card = screen.getByTestId('online-payment-disabled-card');
    // Icon is aria-hidden but present in the tree.
    expect(card.querySelector('svg')).not.toBeNull();
    expect(screen.getByText('Online payment unavailable')).toBeTruthy();
    expect(
      screen.getByText(
        /Online card and PromptPay payments are not available/,
      ),
    ).toBeTruthy();
    expect(screen.getByTestId('online-payment-disabled-cta')).toBeTruthy();
  });

  it('CTA href is a mailto with interpolated invoice number in the subject', () => {
    renderCard(['ops@tscc.example']);
    const cta = screen.getByTestId(
      'online-payment-disabled-cta',
    ) as HTMLAnchorElement;
    expect(cta.tagName).toBe('A');
    expect(cta.href.startsWith('mailto:ops@tscc.example')).toBe(true);
    // The subject is URL-encoded — decode before asserting.
    const url = new URL(cta.href);
    expect(url.searchParams.get('subject')).toBe(
      'Bank-transfer instructions for invoice TSCC-2026-0007',
    );
  });

  it('comma-joins multiple recipients into the mailto `to` field', () => {
    renderCard(['secretary@swecham.com', 'finance@swecham.com']);
    const cta = screen.getByTestId(
      'online-payment-disabled-cta',
    ) as HTMLAnchorElement;
    expect(cta.tagName).toBe('A');
    // mailto `to` list is comma-separated (RFC 6068); the subject follows `?`.
    expect(cta.href.startsWith(
      'mailto:secretary@swecham.com,finance@swecham.com?',
    )).toBe(true);
    const url = new URL(cta.href);
    expect(url.searchParams.get('subject')).toBe(
      'Bank-transfer instructions for invoice TSCC-2026-0007',
    );
  });

  it('empty recipient list → CTA disabled + help text visible', () => {
    renderCard([]);
    const cta = screen.getByTestId('online-payment-disabled-cta');
    expect(cta.tagName).toBe('BUTTON');
    expect((cta as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByTestId('online-payment-disabled-no-email-help').textContent,
    ).toMatch(/No administrator email is configured yet/);
  });
});
