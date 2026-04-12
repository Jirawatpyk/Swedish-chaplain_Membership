import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { PageHeader } from '@/components/layout/page-header';

describe('<PageHeader>', () => {
  it('renders title only', () => {
    render(<PageHeader title="Users" />);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toBe('Users');
  });

  it('renders title + subtitle', () => {
    render(<PageHeader title="Users" subtitle="42 accounts total" />);
    expect(screen.getByText('42 accounts total')).toBeDefined();
  });

  it('renders title + actions slot', () => {
    render(
      <PageHeader
        title="Plans"
        actions={<button type="button">New plan</button>}
      />,
    );
    expect(screen.getByRole('button', { name: 'New plan' })).toBeDefined();
  });

  it('renders title + subtitle + actions + badge', () => {
    render(
      <PageHeader
        title="Plans"
        subtitle="2026 catalogue"
        actions={<button type="button">New</button>}
        badge={<span data-testid="status">Active</span>}
      />,
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Plans');
    expect(screen.getByText('2026 catalogue')).toBeDefined();
    expect(screen.getByRole('button', { name: 'New' })).toBeDefined();
    expect(screen.getByTestId('status')).toBeDefined();
  });

  it('actions container has flex-wrap so buttons wrap below 640px', () => {
    const { container } = render(
      <PageHeader
        title="Plans"
        actions={<button type="button">New</button>}
      />,
    );
    const actionsWrapper = container.querySelector('[data-slot="page-header-actions"]');
    expect(actionsWrapper).toBeTruthy();
    expect(actionsWrapper?.className).toMatch(/flex/);
    expect(actionsWrapper?.className).toMatch(/flex-wrap/);
  });

  it('h1 uses .text-h1 semantic class (not direct Tailwind size)', () => {
    render(<PageHeader title="X" />);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.className).toMatch(/\btext-h1\b/);
    expect(h1.className).not.toMatch(/\btext-(?:xl|2xl|3xl)\b/);
  });
});
