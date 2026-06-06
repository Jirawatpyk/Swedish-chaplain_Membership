import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CreditCard } from 'lucide-react';
import { QuickAction } from '@/components/portal/dashboard/quick-action';

describe('<QuickAction>', () => {
  it('renders a link with the given href and label', () => {
    render(
      <QuickAction href="/portal/invoices" label="Pay invoice" icon={CreditCard} />,
    );
    const link = screen.getByRole('link', { name: 'Pay invoice' });
    expect(link.getAttribute('href')).toBe('/portal/invoices');
  });

  it('guarantees a >=44px target via the min-h-11 utility', () => {
    render(
      <QuickAction href="/portal/edit" label="Edit profile" icon={CreditCard} />,
    );
    const link = screen.getByRole('link', { name: 'Edit profile' });
    expect(link.className).toContain('min-h-11');
  });

  it('renders the icon as decorative (aria-hidden) so the label is the name', () => {
    render(
      <QuickAction href="/portal/benefits" label="View benefits" icon={CreditCard} />,
    );
    const link = screen.getByRole('link', { name: 'View benefits' });
    const svg = link.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });

  it('applies primary chrome by default and secondary when requested', () => {
    const { rerender } = render(
      <QuickAction href="/a" label="A" icon={CreditCard} />,
    );
    expect(screen.getByRole('link', { name: 'A' }).getAttribute('data-emphasis')).toBe(
      'primary',
    );
    rerender(
      <QuickAction href="/b" label="B" icon={CreditCard} emphasis="secondary" />,
    );
    expect(screen.getByRole('link', { name: 'B' }).getAttribute('data-emphasis')).toBe(
      'secondary',
    );
  });
});
