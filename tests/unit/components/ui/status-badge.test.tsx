import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { StatusBadge } from '@/components/ui/status-badge';

describe('<StatusBadge>', () => {
  it('renders children', () => {
    render(<StatusBadge tone="success">Paid</StatusBadge>);
    expect(screen.getByText('Paid')).toBeDefined();
  });

  it('exposes data-slot and data-tone for downstream styling hooks', () => {
    render(<StatusBadge tone="warning">Overdue</StatusBadge>);
    const el = screen.getByText('Overdue');
    expect(el.getAttribute('data-slot')).toBe('status-badge');
    expect(el.getAttribute('data-tone')).toBe('warning');
  });

  it('defaults to neutral tone when tone prop is omitted', () => {
    render(<StatusBadge>Draft</StatusBadge>);
    expect(screen.getByText('Draft').getAttribute('data-tone')).toBe('neutral');
  });

  it('applies subtle emphasis by default (surface bg)', () => {
    render(<StatusBadge tone="success">Paid</StatusBadge>);
    const el = screen.getByText('Paid');
    expect(el.className).toMatch(/bg-success-surface/);
    expect(el.className).not.toMatch(/bg-success\s/);
  });

  it('switches to solid fill when emphasis=solid', () => {
    render(
      <StatusBadge tone="success" emphasis="solid">
        Paid
      </StatusBadge>,
    );
    const el = screen.getByText('Paid');
    expect(el.getAttribute('data-emphasis')).toBe('solid');
    expect(el.className).toMatch(/bg-success\s/);
    expect(el.className).toMatch(/text-success-foreground/);
  });

  it('merges custom className', () => {
    render(
      <StatusBadge tone="info" className="custom-x">
        Pending
      </StatusBadge>,
    );
    expect(screen.getByText('Pending').className).toMatch(/custom-x/);
  });

  it('forwards arbitrary span props (e.g. aria-label for icon-only badges)', () => {
    render(
      <StatusBadge tone="destructive" aria-label="Failed payment">
        <svg aria-hidden="true" />
      </StatusBadge>,
    );
    expect(screen.getByLabelText('Failed payment')).toBeDefined();
  });
});
