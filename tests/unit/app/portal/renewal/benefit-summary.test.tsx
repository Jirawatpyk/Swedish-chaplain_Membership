/**
 * Spec 122 US7c (T742) — the renewal page's benefit summary on AURA.
 *
 * Board `Portal-renewal`: a "Benefit summary" card, metered benefits as
 * AURA progress bars ("2 of 6"), an unmetered benefit as a plain row with
 * no bar, and the neutral fallback when the reader is unavailable.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { BenefitSummary } from '@/app/(member)/portal/renewal/[memberId]/_components/benefit-summary';
import type { BenefitConsumptionEntry } from '@/modules/renewals';

afterEach(cleanup);

const BENEFITS: BenefitConsumptionEntry[] = [
  { key: 'eblast', used: 2, quota: 6 },
  { key: 'cultural_ticket', used: 0, quota: 2 },
  { key: 'event_attendance', used: 3, quota: null },
] as BenefitConsumptionEntry[];

function renderSummary(benefits = BENEFITS, benefitsAvailable = true) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BenefitSummary benefits={benefits} benefitsAvailable={benefitsAvailable} />
    </NextIntlClientProvider>,
  );
}

describe('<BenefitSummary> on AURA (US7c)', () => {
  it('is an AURA card headed "Benefit summary" (h2) and labelled by it', () => {
    renderSummary();
    const region = screen.getByRole('region', { name: 'Benefit summary' });
    expect(region.className).toMatch(/aura-card/);
    expect(within(region).getByRole('heading', { level: 2, name: 'Benefit summary' })).toBeInTheDocument();
  });

  it('draws each metered benefit as an AURA progress bar reading "used of quota"', () => {
    renderSummary();
    const bars = screen.getAllByRole('progressbar');
    expect(bars).toHaveLength(2);
    const eblast = screen.getByRole('progressbar', { name: /E-Blasts/ });
    expect(eblast).toHaveAttribute('aria-valuenow', '2');
    expect(eblast).toHaveAttribute('aria-valuemax', '6');
    expect(eblast).toHaveAttribute('aria-valuetext', '2 of 6');
    expect(eblast.closest('.aura-progress')).not.toBeNull();
    expect(screen.getByRole('progressbar', { name: /Cultural tickets/ })).toHaveAttribute(
      'aria-valuenow',
      '0',
    );
  });

  it('shows an unmetered benefit as a plain row, "3 · Unlimited" (board), with no bar', () => {
    renderSummary();
    const row = screen.getByText('Events attended').closest('li')!;
    expect(row.textContent).toContain('3 · Unlimited');
    expect(within(row).queryByRole('progressbar')).toBeNull();
  });

  it('keeps the neutral fallback when the reader is unavailable', () => {
    renderSummary([], false);
    expect(screen.getByText('Benefit summary unavailable.')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});
