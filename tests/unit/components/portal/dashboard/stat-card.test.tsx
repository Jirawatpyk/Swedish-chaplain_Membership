import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatCard } from '@/components/portal/dashboard/stat-card';

describe('<StatCard>', () => {
  it('renders the label as a real h2, the value, and the sub', () => {
    render(
      <StatCard label="Outstanding balance" value="฿1,200" sub="2 invoices" />,
    );
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading.textContent).toBe('Outstanding balance');
    expect(screen.getByText('฿1,200')).toBeDefined();
    expect(screen.getByText('2 invoices')).toBeDefined();
  });

  it('omits the sub element when no sub is provided', () => {
    const { container } = render(<StatCard label="Members" value="131" />);
    expect(
      container.querySelector('[data-slot="stat-card-sub"]'),
    ).toBeNull();
  });

  it('exposes the variant via a data attribute AND a visible status text (not colour-only)', () => {
    render(
      <StatCard
        label="Membership"
        value="Action needed"
        variant="warning"
        variantLabel="Action needed"
      />,
    );
    const card = screen.getByTestId('stat-card');
    expect(card.getAttribute('data-variant')).toBe('warning');
    // Non-colour-only signal: the variant label text is present in the DOM.
    const status = screen.getByTestId('stat-card-status');
    expect(status.textContent).toContain('Action needed');
    // And an icon accompanies it (aria-hidden, paired with the text).
    expect(status.querySelector('svg')).not.toBeNull();
  });

  it('defaults to the neutral variant with no status row', () => {
    render(<StatCard label="Plan" value="Premium" />);
    const card = screen.getByTestId('stat-card');
    expect(card.getAttribute('data-variant')).toBe('neutral');
    expect(screen.queryByTestId('stat-card-status')).toBeNull();
  });
});
