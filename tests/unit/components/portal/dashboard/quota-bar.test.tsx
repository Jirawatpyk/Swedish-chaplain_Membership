import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QuotaBar } from '@/components/portal/dashboard/quota-bar';
import enMessages from '@/i18n/messages/en.json';

function renderBar(props: Partial<React.ComponentProps<typeof QuotaBar>> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <QuotaBar label="E-Blasts" used={2} max={5} {...props} />
    </NextIntlClientProvider>,
  );
}

describe('<QuotaBar>', () => {
  it('renders the visible label and a VISIBLE 2/5 readout', () => {
    renderBar();
    expect(screen.getByText('E-Blasts')).toBeDefined();
    // Visible readout from portal.dashboard.quotaBar.readout = "{used} of {max}".
    const readout = screen.getByText('2 of 5');
    expect(readout).toBeDefined();
    // It MUST be visible — not aria-hidden (spec a11y-5: NOT length alone).
    expect(readout.getAttribute('aria-hidden')).toBeNull();
  });

  it('exposes a progressbar with aria-valuenow/min/max', () => {
    renderBar();
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('2');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('5');
  });

  it('gives the progressbar an accessible name including used/max', () => {
    renderBar();
    // portal.dashboard.quotaBar.ariaLabel = "{label}: {used} of {max} used".
    const bar = screen.getByRole('progressbar', {
      name: 'E-Blasts: 2 of 5 used',
    });
    expect(bar).toBeDefined();
  });

  it('clamps aria-valuenow within [0, max] for over-quota inputs', () => {
    renderBar({ used: 9, max: 5 });
    const bar = screen.getByRole('progressbar');
    // Visible readout still shows the raw counts (member sees 9 of 5).
    expect(screen.getByText('9 of 5')).toBeDefined();
    // But aria-valuenow is clamped so AT does not announce out-of-range.
    expect(bar.getAttribute('aria-valuenow')).toBe('5');
  });
});
