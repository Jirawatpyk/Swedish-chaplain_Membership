import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { StatusDot } from '@/components/ui/status-dot';

describe('<StatusDot>', () => {
  it('renders a role=status element with the required aria-label', () => {
    render(<StatusDot tone="success" aria-label="Active" />);
    const el = screen.getByRole('status', { name: 'Active' });
    expect(el).toBeDefined();
    expect(el.getAttribute('data-slot')).toBe('status-dot');
    expect(el.getAttribute('data-tone')).toBe('success');
  });

  it('applies the matching tone background class', () => {
    render(<StatusDot tone="warning" aria-label="At risk" />);
    const el = screen.getByRole('status');
    expect(el.className).toMatch(/bg-warning/);
  });

  it('defaults to neutral tone when tone prop omitted', () => {
    render(<StatusDot aria-label="Unknown" />);
    expect(screen.getByRole('status').getAttribute('data-tone')).toBe('neutral');
  });

  it('adds motion-safe pulse animation when pulse=true', () => {
    render(<StatusDot tone="destructive" pulse aria-label="Live alert" />);
    expect(screen.getByRole('status').className).toMatch(/animate-pulse/);
  });

  it('does not add pulse animation by default', () => {
    render(<StatusDot tone="info" aria-label="Static" />);
    expect(screen.getByRole('status').className).not.toMatch(/animate-pulse/);
  });
});
