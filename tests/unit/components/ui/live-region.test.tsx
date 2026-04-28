import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { LiveRegion } from '@/components/ui/live-region';

describe('<LiveRegion>', () => {
  it('renders role=status with aria-live=polite by default', () => {
    render(<LiveRegion>Saving…</LiveRegion>);
    const el = screen.getByRole('status');
    expect(el.getAttribute('aria-live')).toBe('polite');
    expect(el.getAttribute('aria-atomic')).toBe('true');
    expect(el.textContent).toBe('Saving…');
  });

  it('renders role=alert when politeness=assertive', () => {
    render(<LiveRegion politeness="assertive">Payment failed</LiveRegion>);
    const el = screen.getByRole('alert');
    expect(el.getAttribute('aria-live')).toBe('assertive');
  });

  it('is visually hidden by default (sr-only class)', () => {
    render(<LiveRegion data-testid="lr">msg</LiveRegion>);
    expect(screen.getByTestId('lr').className).toMatch(/sr-only/);
  });

  it('can be made visible when visuallyHidden=false (for dev/debug surfaces)', () => {
    render(
      <LiveRegion visuallyHidden={false} data-testid="lr">
        msg
      </LiveRegion>,
    );
    expect(screen.getByTestId('lr').className).not.toMatch(/sr-only/);
  });

  it('updates content without remounting (SR announces on update)', () => {
    const { rerender } = render(<LiveRegion>first</LiveRegion>);
    const el = screen.getByRole('status');
    expect(el.textContent).toBe('first');
    rerender(<LiveRegion>second</LiveRegion>);
    expect(el.textContent).toBe('second');
  });
});
