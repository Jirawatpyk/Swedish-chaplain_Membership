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
 * **Fixed regression (user-reported flash)**: the component used to show the
 * FINAL number on first paint, then visibly snap to 0 before counting up.
 * The fix splits "the correct number" and "the animated visual" into two
 * DIFFERENT DOM nodes:
 *   - a visible, `aria-hidden` `<span class="absolute …">` that ALWAYS
 *     starts at 0 (server render AND first client render alike) and only
 *     ever counts UP;
 *   - a `sr-only` sibling `<span>` that ALWAYS holds the FINAL formatted
 *     value, server-rendered, never animating — screen readers, no-JS, and
 *     SEO crawlers read the real number from there.
 * There's also a third, `invisible` + `aria-hidden` sizer span (also holding
 * the FINAL value) purely to reserve the box's width so the KPI card never
 * reflows as the visible digits grow.
 *
 * Because the final formatted string can now appear in up to two places at
 * once (the width sizer and the sr-only span), tests target the VISIBLE
 * animated node and the sr-only node directly via `container.querySelector`
 * (keyed on the literal Tailwind class names `absolute` / `invisible` /
 * `sr-only`, which are stable attribute values regardless of whether
 * Tailwind's CSS is loaded in jsdom) rather than `screen.getByText`, which
 * would throw on the resulting duplicate text matches.
 *
 * Six tests, all load-bearing:
 *  1+2. SSR parity (integer + THB) — the FIRST render (before any
 *     effect/timer has run) shows the VISIBLE number at the START value (0)
 *     and the sr-only span at the FINAL value. A server render never
 *     executes effects at all, so asserting immediately after `render()`,
 *     before advancing anything, is the closest jsdom proxy for "this is
 *     what SSR would emit".
 *  3. Reduced motion — `prefers-reduced-motion: reduce` mocked truthy means
 *     the component must never schedule an animation frame; the VISIBLE
 *     number jumps straight to the final value on mount.
 *  4. No `aria-live` — a per-frame live region would spam screen readers on
 *     every intermediate frame; no element in the tree carries `aria-live`
 *     at all (SR users read the static sr-only span instead).
 *  5. Animate-to-completion — driving a stubbed rAF loop end-to-end proves
 *     the VISIBLE number starts at 0, stays 0 on the animation's own first
 *     frame, and lands EXACTLY on the final formatted string once progress
 *     reaches 1.
 *  6. StrictMode regression — renders `<CountUp>` inside `<StrictMode>` and
 *     drives a REAL (id-tracking) fake `requestAnimationFrame`/
 *     `cancelAnimationFrame` pair — not the trivial no-op `cancelAnimationFrame`
 *     stub test 5 uses — because the bug this guards against only
 *     reproduces when a cancelled frame is actually removed from the
 *     pending queue, exactly like a real browser. See that test's own
 *     comment for why "shows the final value" alone would NOT catch the
 *     regression (the sr-only span already shows the final value before any
 *     effect runs, bug or not — the VISIBLE node is what must be checked).
 *
 * jsdom workaround: jsdom has NO `matchMedia` implementation at all (throws
 * `TypeError: … is not a function`) — same as every other 067 chart test
 * (see `tests/unit/components/dashboard/mini-series-chart.test.tsx`'s
 * docblock) — every test here stubs it.
 */
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { CountUp } from '@/components/dashboard/count-up';

/**
 * A minimal but REAL rAF/cAF pair: `cancelAnimationFrame` actually removes
 * the pending callback (unlike a no-op stub), so a cancelled frame never
 * fires — matching real browser behavior closely enough to reproduce the
 * StrictMode mount→cleanup→remount bug this test guards against.
 */
function createFakeRaf() {
  let nextId = 0;
  const pending = new Map<number, FrameRequestCallback>();
  const raf = vi.fn((cb: FrameRequestCallback) => {
    nextId += 1;
    pending.set(nextId, cb);
    return nextId;
  });
  const caf = vi.fn((id: number) => {
    pending.delete(id);
  });
  /** Invoke every currently-pending callback once, then clear them — frames
   * scheduled DURING this flush (i.e. the loop rescheduling itself) land in
   * `pending` for the next flush, matching real rAF semantics. */
  function flush(time: number) {
    const callbacks = [...pending.values()];
    pending.clear();
    callbacks.forEach((cb) => cb(time));
  }
  return { raf, caf, pending, flush };
}

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

/** The VISIBLE, animated copy — `aria-hidden` + `absolute` (positioned over
 * the width-reserving sizer). This is the node whose text content moves
 * across frames. */
function getVisible(container: HTMLElement): Element | null {
  return container.querySelector('span[aria-hidden="true"].absolute');
}

/** The accessible copy — always the FINAL value, never animates. */
function getSrOnly(container: HTMLElement): Element | null {
  return container.querySelector('span.sr-only');
}

const thbFmt = new Intl.NumberFormat('en', {
  style: 'currency',
  currency: 'THB',
  maximumFractionDigits: 0,
});

describe('CountUp', () => {
  it('integer variant: first render shows the VISIBLE number at the START value (0); sr-only holds the FINAL value', () => {
    stubMatchMedia(false);
    const { container } = render(<CountUp value={1234} locale="en" variant="integer" />);
    // Immediately after render(), before any rAF/timer has been driven.
    expect(getVisible(container)?.textContent).toBe('0');
    expect(getSrOnly(container)?.textContent).toBe(new Intl.NumberFormat('en').format(1234));
  });

  it('THB variant: first render shows the VISIBLE number at the START value (formatted 0); sr-only holds the FINAL value', () => {
    stubMatchMedia(false);
    const { container } = render(<CountUp value={1234} locale="en" variant="thb" />);
    // `Intl`'s THB currency format inserts a non-breaking space (U+00A0)
    // between symbol and amount — normalize whitespace on both sides before
    // comparing raw textContent.
    expect(getVisible(container)?.textContent?.replace(/\s/g, ' ')).toBe(
      thbFmt.format(0).replace(/\s/g, ' '),
    );
    expect(getSrOnly(container)?.textContent?.replace(/\s/g, ' ')).toBe(
      thbFmt.format(1234).replace(/\s/g, ' '),
    );
  });

  it('reduced motion: the VISIBLE number jumps straight to the final value on mount; no animation frame is scheduled', () => {
    stubMatchMedia(true); // prefers-reduced-motion: reduce
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
    const { container } = render(<CountUp value={999} locale="en" variant="integer" />);
    expect(getVisible(container)?.textContent).toBe('999');
    expect(rafSpy).not.toHaveBeenCalled();
  });

  it('carries no aria-live attribute anywhere (no per-frame SR announcements)', () => {
    stubMatchMedia(false);
    const { container } = render(<CountUp value={42} locale="en" variant="integer" />);
    expect(container.querySelector('[aria-live]')).not.toBeInTheDocument();
  });

  it('animates the VISIBLE number from 0 up to the final integer value across driven rAF frames, landing exactly on the final formatted string', () => {
    stubMatchMedia(false); // motion allowed
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});

    const { container } = render(
      <CountUp value={1000} locale="en" variant="integer" durationMs={100} />,
    );

    // Before any frame is driven, the VISIBLE number already reads 0 (the
    // SSR-parity contract) — restated here as a baseline before animating.
    expect(getVisible(container)?.textContent).toBe('0');

    // First driven frame is the animation's own t=0 — must still show 0
    // (proves it actually restarts from 0 rather than no-op-ing).
    act(() => {
      frames.shift()?.(0);
    });
    expect(getVisible(container)?.textContent).toBe('0');

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

    expect(getVisible(container)?.textContent).toBe(new Intl.NumberFormat('en').format(1000));
  });

  it('plays the count-up animation on a persisting mount under React StrictMode (regression: a run-once entry guard is defeated by StrictMode double-invoke)', () => {
    // Regression coverage for a bug fixed alongside this component: an
    // earlier mount effect guarded itself with a `hasStartedRef` "run once"
    // latch. Under StrictMode (`reactStrictMode: true` in next.config.ts —
    // also how Playwright's e2e dev server runs), React mounts the effect,
    // runs its cleanup, then mounts it again, all before the first paint.
    // The cleanup's `cancelAnimationFrame` cancelled the first scheduled
    // frame; the guard then blocked the SECOND (persisting) mount from
    // scheduling a replacement, so NO animation frame ever survived and the
    // visible number stayed stuck at its initial value forever.
    stubMatchMedia(false); // motion allowed
    const { raf, caf, pending, flush } = createFakeRaf();
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', caf);

    const { container } = render(
      <StrictMode>
        <CountUp value={500} locale="en" variant="integer" durationMs={100} />
      </StrictMode>,
    );

    // The persisting (second) StrictMode mount must have left exactly one
    // live frame queued — proves the cancelled first frame did NOT survive
    // and a replacement WAS scheduled (the bug: this map is empty here).
    expect(pending.size).toBeGreaterThan(0);

    // Driving that surviving frame at t=0 must show 0 on the VISIBLE node —
    // proves the animation actually (re)started from 0. Asserting the final
    // value alone would NOT catch the bug: the sr-only span already renders
    // the final formatted value before any effect runs, so a
    // permanently-stuck VISIBLE display would still pass a "final value is
    // present somewhere in the tree" assertion taken in isolation.
    act(() => flush(0));
    expect(getVisible(container)?.textContent).toBe('0');

    // Drive every subsequently-queued frame to completion.
    let now = 0;
    let iterations = 0;
    while (pending.size > 0 && iterations < 50) {
      now += 20;
      act(() => flush(now));
      iterations += 1;
    }

    expect(getVisible(container)?.textContent).toBe(new Intl.NumberFormat('en').format(500));
  });
});
