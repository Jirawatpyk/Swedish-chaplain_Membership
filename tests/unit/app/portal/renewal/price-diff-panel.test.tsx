/**
 * Spec 122 US7c — the renewal price band (board `Portal-renewal`).
 *
 * The board rules a line between "Current locked-in price", "New price" and
 * "Difference"; each pair is its own row so the rule spans label and amount.
 * The amounts and the signed difference stay exactly as `formatThbMinorUnits`
 * prints them.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { PriceDiffPanel } from '@/app/(member)/portal/renewal/[memberId]/_components/price-diff-panel';

afterEach(cleanup);

describe('<PriceDiffPanel> (US7c)', () => {
  it('rules each price pair as its own row, amounts unchanged', () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PriceDiffPanel currentPriceMinorUnits={3_600_000} newPriceMinorUnits={2_600_000} />
      </NextIntlClientProvider>,
    );
    const dl = screen.getByTestId('price-diff-panel').querySelector('dl')!;
    expect(dl.className).toMatch(/divide-y/);
    const rows = Array.from(dl.children);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.tagName).toBe('DIV');
      expect(row.querySelectorAll('dt')).toHaveLength(1);
      expect(row.querySelectorAll('dd')).toHaveLength(1);
    }
    expect(screen.getByTestId('price-current')).toHaveTextContent('฿36,000.00');
    expect(screen.getByTestId('price-new')).toHaveTextContent('฿26,000.00');
    expect(screen.getByTestId('price-delta')).toHaveTextContent('-฿10,000.00');
  });
});
