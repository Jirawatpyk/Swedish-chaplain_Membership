// tests/unit/components/plans/money-display.test.tsx
//
// Plan fees use the app's money format — "36,000.00 THB" (`formatSatangThb`,
// suffix style) — not Intl currency style ("THB 36,000.00" / "฿36,000.00"),
// so the plans list, plan detail and wizard review read like invoices,
// payments and the member plan picker.

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { MoneyDisplay } from '@/components/plans/money-display';

afterEach(cleanup);

describe('MoneyDisplay', () => {
  it('renders minor units in the shared "36,000.00 THB" format', () => {
    render(
      <NextIntlClientProvider locale="en" messages={{}}>
        <MoneyDisplay amountMinorUnits={3_600_000} currencyCode="THB" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('36,000.00 THB')).toBeInTheDocument();
  });

  it('keeps satang', () => {
    render(
      <NextIntlClientProvider locale="en" messages={{}}>
        <MoneyDisplay amountMinorUnits={3_852_050} currencyCode="THB" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('38,520.50 THB')).toBeInTheDocument();
  });
});
