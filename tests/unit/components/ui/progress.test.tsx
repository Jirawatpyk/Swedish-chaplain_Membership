import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Progress } from '@/components/ui/progress';

describe('<Progress>', () => {
  it('renders role=progressbar with the given value', () => {
    render(<Progress value={40} aria-label="Upload" />);
    const el = screen.getByRole('progressbar', { name: 'Upload' });
    expect(el.getAttribute('aria-valuenow')).toBe('40');
    expect(el.getAttribute('aria-valuemin')).toBe('0');
    expect(el.getAttribute('aria-valuemax')).toBe('100');
    expect(el.getAttribute('data-state')).toBe('determinate');
  });

  it('clamps value between 0 and max', () => {
    render(<Progress value={150} aria-label="Over" />);
    const fill = screen.getByRole('progressbar').querySelector(
      '[data-slot="progress-fill"]',
    ) as HTMLElement;
    expect(fill.style.width).toBe('100%');
  });

  it('honors custom max and scales percent', () => {
    render(<Progress value={25} max={50} aria-label="Scaled" />);
    const el = screen.getByRole('progressbar');
    expect(el.getAttribute('aria-valuemax')).toBe('50');
    const fill = el.querySelector('[data-slot="progress-fill"]') as HTMLElement;
    expect(fill.style.width).toBe('50%');
  });

  it('enters indeterminate mode when value is omitted', () => {
    render(<Progress aria-label="Loading" />);
    const el = screen.getByRole('progressbar');
    expect(el.getAttribute('data-state')).toBe('indeterminate');
    expect(el.getAttribute('aria-valuenow')).toBeNull();
    expect(el.getAttribute('aria-valuemax')).toBeNull();
  });

  it('applies tone class for semantic coloring', () => {
    render(<Progress value={50} tone="success" aria-label="Paid" />);
    const el = screen.getByRole('progressbar');
    expect(el.className).toMatch(/bg-success/);
  });

  it('supports aria-labelledby as an alternative label', () => {
    render(
      <>
        <span id="lbl-x">Download</span>
        <Progress value={10} aria-labelledby="lbl-x" />
      </>,
    );
    expect(
      screen.getByRole('progressbar', { name: 'Download' }),
    ).toBeDefined();
  });
});
