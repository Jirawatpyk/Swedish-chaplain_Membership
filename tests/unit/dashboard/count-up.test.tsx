/**
 * Task 15 (067-dashboard-interactive-charts) — `<CountUp>` unit tests.
 *
 * `<CountUp>` wraps a dashboard KPI's headline NUMBER with a rolling-number
 * animation (spec: `.superpowers/sdd/task-15-brief.md`). It takes
 * `locale` + `variant` ('integer' | 'thb') rather than a `format` function
 * prop — `StaffHomePage` (the caller) is a Server Component and `<CountUp>`
 * is a Client Component, and functions cannot cross that RSC boundary (an
 * earlier `format`-prop version threw "Functions cannot be passed directly
 * to Client Components" at runtime). `<CountUp>` builds its own
 * `Intl.NumberFormat` internally, mirroring the page's own
 * `numberFmt`/`thbFmt` construction exactly.
 *
 * Three constraints are load-bearing and pinned as separate tests; a 4th
 * test drives the rAF loop to completion as a lenient extra (timing/rAF
 * internals, not part of the hard contract):
 *
 *  1. SSR parity — the FIRST render (before any effect/timer has run) shows
 *     the FINAL formatted number — no-JS / SR / SEO / CLS all see the real
 *     number. A server render never executes effects at all, so asserting
 *     immediately after `render()`, before advancing anything, is the
 *     closest jsdom proxy for "this is what SSR would emit".
 *  2. Reduced motion — `prefers-reduced-motion: reduce` mocked truthy means
 *     the component must never schedule an animation frame; the displayed
 *     text stays the final formatted value.
 *  3. No `aria-live` — a per-frame live region would spam screen readers on
 *     every intermediate frame; the element carries no `aria-live`
 *     attribute at all (SR reads the number at rest, like any static text).
 *
 * jsdom workaround: jsdom has NO `matchMedia` implementation at all (throws
 * `TypeError: … is not a function`) — same as every other 067 chart test
 * (see `tests/unit/components/dashboard/mini-series-chart.test.tsx`'s
 * docblock) — every test here stubs it.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { CountUp } from '@/components/dashboard/count-up';

/** jsdom has no `matchMedia` at all — stub it so
 * `useSyncExternalStore(subscribeMotionPreference, getAllowMotion, …)` can
 * read a `MediaQueryList`-shaped value instead of throwing. */
function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

const thbFmt = new Intl.NumberFormat('en', {
  style: 'currency',
  currency: 'THB',
  maximumFractionDigits: 0,
});

describe('CountUp', () => {
  it('renders the final integer value synchronously on first render (SSR parity)', () => {
    stubMatchMedia(false);
    render(<CountUp value={1234} locale="en" variant="integer" />);
    // Immediately after render(), before any rAF/timer has been driven —
    // the FINAL number must already be on screen.
    expect(screen.getByText(new Intl.NumberFormat('en').format(1234))).toBeInTheDocument();
  });

  it('renders the final THB value synchronously on first render (SSR parity)', () => {
    stubMatchMedia(false);
    const { container } = render(<CountUp value={1234} locale="en" variant="thb" />);
    // `getByText` collapses whitespace in the DOM's OWN text before matching
    // but does not do the same to the string you hand it — Intl's THB
    // currency format inserts a non-breaking space (U+00A0) between symbol
    // and amount, so compare raw textContent with whitespace normalized on
    // BOTH sides instead of relying on getByText's asymmetric normalization.
    expect(container.textContent?.replace(/\s/g, ' ')).toBe(
      thbFmt.format(1234).replace(/\s/g, ' '),
    );
  });

  it('reduced motion: shows the final value immediately and schedules no animation frame', () => {
    stubMatchMedia(true); // prefers-reduced-motion: reduce
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
    render(<CountUp value={999} locale="en" variant="integer" />);
    expect(screen.getByText('999')).toBeInTheDocument();
    expect(rafSpy).not.toHaveBeenCalled();
  });

  it('carries no aria-live attribute (no per-frame SR announcements)', () => {
    stubMatchMedia(false);
    const { container } = render(<CountUp value={42} locale="en" variant="integer" />);
    expect(container.querySelector('[aria-live]')).not.toBeInTheDocument();
  });

  it('animates from 0 up to the final integer value across driven rAF frames, then stops re-scheduling', () => {
    stubMatchMedia(false); // motion allowed
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});

    render(<CountUp value={1000} locale="en" variant="integer" durationMs={100} />);

    // First driven frame is the animation's own t=0 — must show 0, not the
    // final value (proves it actually restarts from 0 rather than no-op-ing).
    act(() => {
      frames.shift()?.(0);
    });
    expect(screen.getByText('0')).toBeInTheDocument();

    // Drive every subsequently-queued frame forward in time until the loop
    // stops re-scheduling itself (progress has reached 1).
    let now = 0;
    while (frames.length > 0) {
      const cb = frames.shift();
      now += 50;
      act(() => {
        cb?.(now);
      });
    }

    expect(screen.getByText(new Intl.NumberFormat('en').format(1000))).toBeInTheDocument();
  });
});
