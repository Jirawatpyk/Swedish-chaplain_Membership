/**
 * `ErrorBoundary` — minimal client-side React error boundary (fix round 2,
 * renewals money-band review, checklist item #3).
 *
 * Verifies the two contract points the renewals money band
 * (`pipeline-money-band.tsx`) depends on:
 *   - a child that renders without throwing passes through unchanged (no
 *     extra DOM wrapper — the boundary renders `children` directly);
 *   - a child that throws during render is caught, and the boundary renders
 *     its `fallback` (default `null`) instead of propagating the throw to
 *     the route's `error.tsx`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorBoundary } from '@/components/shell/error-boundary';

function Bomb(): never {
  throw new Error('boom');
}

describe('ErrorBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders children normally when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>fine</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('fine')).toBeInTheDocument();
  });

  it('renders null (the default fallback) when a child throws during render, instead of propagating', () => {
    // React (dev mode) and this boundary's own `componentDidCatch` both log
    // the caught error to the console — expected noise for this test, not a
    // real failure. Silenced so the test's own output stays readable.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(window.console, 'error').mockImplementation(() => {});

    const { container } = render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a custom fallback when provided', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(window.console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary fallback={<p>recovered</p>}>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText('recovered')).toBeInTheDocument();
  });
});
