import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ProgressBar } from '@/components/ui/progress-bar';

describe('<ProgressBar>', () => {
  it('renders the label and default percent readout', () => {
    render(<ProgressBar label="Uploading" value={42} />);
    expect(screen.getByText('Uploading')).toBeDefined();
    expect(screen.getByText('42%')).toBeDefined();
  });

  it('wires aria-labelledby from the visible label to the progressbar', () => {
    render(<ProgressBar label="Quota" value={10} />);
    const bar = screen.getByRole('progressbar', { name: 'Quota' });
    expect(bar).toBeDefined();
  });

  it('hides the label visually when hideLabel is true but keeps it for SR', () => {
    render(<ProgressBar label="Hidden" value={5} hideLabel />);
    // sr-only wrapper still in DOM so accessibility name works
    expect(screen.getByRole('progressbar', { name: 'Hidden' })).toBeDefined();
  });

  it('uses custom formatValue for locale-aware readouts', () => {
    render(
      <ProgressBar
        label="Bytes"
        value={1_200_000}
        max={5_000_000}
        formatValue={(_p, v, m) =>
          `${(v / 1_000_000).toFixed(1)} MB of ${m / 1_000_000} MB`
        }
      />,
    );
    expect(screen.getByText('1.2 MB of 5 MB')).toBeDefined();
  });

  it('omits the readout in indeterminate mode', () => {
    const { container } = render(<ProgressBar label="Loading…" />);
    const readouts = container.querySelectorAll('[aria-hidden="true"]');
    // Only the label row can contain the readout span; none should render.
    readouts.forEach((n) => {
      expect(n.textContent).not.toMatch(/%/);
    });
  });
});
