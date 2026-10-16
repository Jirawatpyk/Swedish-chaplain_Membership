/**
 * Spec 122 (2026-10-16, AURA #151) — `<PageHeader>` is a thin wrapper over
 * AURA's `PageHeader`: the same props for every call site, AURA's markup.
 * The root keeps `data-slot="page-header"` and `data-size`, which the page
 * padding and title-size rules in globals.css read.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AuraProvider } from '@jirawatpyk/aura-react';

import { PageHeader } from '@/components/layout/page-header';

afterEach(cleanup);

const root = (container: HTMLElement) => container.querySelector('[data-slot="page-header"]');

describe('<PageHeader> on AURA PageHeader', () => {
  it('renders AURA’s header, keeping the data-slot and size the stylesheet reads', () => {
    const { container, rerender } = render(<PageHeader title="Members" />);
    expect(root(container)).toHaveClass('aura-page-header');
    expect(root(container)).toHaveAttribute('data-size', 'default');
    rerender(<PageHeader title="Hi Anna" size="hero" />);
    expect(root(container)).toHaveAttribute('data-size', 'hero');
  });

  it('the title is AURA’s level-1 heading', () => {
    render(<PageHeader title="Users" />);
    const h1 = screen.getByRole('heading', { level: 1, name: 'Users' });
    expect(h1).toHaveClass('aura-page-header__title');
  });

  it('subtitle, badge, meta and actions land in AURA’s slots', () => {
    const { container } = render(
      <PageHeader
        title="Plans"
        subtitle="2026 catalogue"
        badge={<span data-testid="status">Active</span>}
        meta={<span data-testid="chips">TSCC-0042</span>}
        actions={<button type="button">New plan</button>}
      />,
    );
    expect(screen.getByText('2026 catalogue').closest('.aura-page-header__subtitle')).not.toBeNull();
    expect(screen.getByTestId('status').closest('.aura-page-header__title-addon')).not.toBeNull();
    expect(screen.getByTestId('chips').closest('.aura-page-header__meta')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'New plan' }).closest('.aura-page-header__actions')).not.toBeNull();
    expect(root(container)).toHaveClass('aura-page-header--actions-full-below-sm');
  });

  it('a detail page can turn its actions into AURA\'s phone bar, with a status line (#150)', () => {
    const { container } = render(
      <PageHeader
        title="Invoice SC-2026-000130"
        actions={<button type="button">Record payment</button>}
        actionsBarBelow="sm"
        actionsStatus="Total 107,000.00 THB incl. VAT"
      />,
    );
    expect(root(container)).toHaveClass('aura-page-header--actions-bar-below-sm');
    // AURA 5.48 (#154): on a screen 480px tall or less the bar gives way to
    // the header's own row, laid out by actionsFullWidthBelow, so both are
    // passed (the bar's rules win at a normal height).
    expect(root(container)).toHaveClass('aura-page-header--actions-full-below-sm');
    expect(screen.getByText('Total 107,000.00 THB incl. VAT').closest('.aura-page-header__status')).not.toBeNull();
  });

  it('an eyebrow of chips is a div row, not a paragraph', () => {
    render(<PageHeader title="Siam Nordic" eyebrow={<span data-testid="pill">Active</span>} />);
    const eyebrow = screen.getByTestId('pill').closest('.aura-page-header__eyebrow');
    expect(eyebrow?.tagName).toBe('DIV');
  });

  it('autoFocusTitle focuses the heading when the header mounts', () => {
    render(<PageHeader title="Renewal confirmed" autoFocusTitle />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
  });

  it('staff pages align the actions with the bottom of the text; the portal with its top', () => {
    const staff = render(
      <AuraProvider density="compact">
        <PageHeader title="Members" actions={<button type="button">New</button>} />
      </AuraProvider>,
    );
    expect(root(staff.container)).not.toHaveClass('aura-page-header--actions-start');
    staff.unmount();
    const portal = render(
      <AuraProvider density="comfortable">
        <PageHeader title="Hi Anna" actions={<button type="button">Edit</button>} />
      </AuraProvider>,
    );
    expect(root(portal.container)).toHaveClass('aura-page-header--actions-start');
  });
});
