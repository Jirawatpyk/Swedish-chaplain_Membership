import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FileText } from 'lucide-react';
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
  it('draws AURA Stat markup: label in the head, value, caption, and the board icon (spec 122 US3)', () => {
    const { container } = render(
      <StatCard label="Outstanding balance" value="38,520.00 THB" sub="1 unpaid invoice" headIcon={FileText} />,
    );
    const card = screen.getByTestId('stat-card');
    expect(card).toHaveClass('aura-stat');
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading).toHaveClass('aura-stat__label');
    expect(heading.parentElement).toHaveClass('aura-stat__head');
    expect(container.querySelector('.aura-stat__icon svg')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('38,520.00 THB')).toHaveClass('aura-stat__value');
    expect(screen.getByText('1 unpaid invoice').closest('.aura-stat__caption')).not.toBeNull();
  });

  it('is AURA\'s own Stat (#110, 5.17): the tone row in its status slot, no hand-drawn link overlay', () => {
    render(
      <StatCard label="Membership" value="Due" variant="warning" variantLabel="Due" sub="Renews in 5 days" href="/portal/renewal" />,
    );
    const card = screen.getByTestId('stat-card');
    // AURA's label link, stretched over the tile by AURA (linkArea="label")
    expect(card).toHaveClass('aura-stat--label-link');
    const link = screen.getByRole('link', { name: 'Membership' });
    expect(link).toHaveClass('aura-stat__link');
    expect(link.className).not.toMatch(/after:/);
    expect(card.className).not.toMatch(/has-\[a:focus-visible\]/);
    expect(screen.getByTestId('stat-card-status').closest('.aura-stat__status')).not.toBeNull();
  });

  it('renders its action as an AURA link button with a 44px target', () => {
    render(<StatCard label="Membership" value="Due" action={{ href: '/portal/renewal', label: 'Renew now' }} />);
    const link = screen.getByRole('link', { name: 'Renew now' });
    expect(link).toHaveClass('aura-btn', 'aura-btn--primary');
    expect(link).not.toHaveClass('aura-btn--sm');
  });

  it('with an href, the whole tile opens it, and the link is named by the label alone (spec 122 US3)', () => {
    render(<StatCard label="Outstanding balance" value="38,520.00 THB" sub="1 unpaid invoice" href="/portal/invoices" />);
    expect(screen.getByTestId('stat-card')).toHaveClass('aura-stat', 'is-interactive');
    const link = screen.getByRole('link', { name: 'Outstanding balance' });
    expect(link).toHaveAttribute('href', '/portal/invoices');
    expect(link.closest('h2')).not.toBeNull();
  });
});
