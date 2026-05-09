/**
 * Unit tests for `<RelativeTime>` — SSR-safe relative-time renderer.
 *
 * Covers:
 *   1. SSR-stable initial render — renders the absolute date during
 *      first paint (mounted=false branch). Locks the regression
 *      class that the component was built to fix.
 *   2. Post-mount flip — after `useEffect`, renders the relative
 *      label.
 *   3. `dateTime` attribute always carries the canonical ISO.
 *   4. `title` prop forwarded to the `<time>` element.
 *   5. Shared-tick singleton — multiple `<RelativeTime>` instances
 *      with the default cadence subscribe to ONE setInterval (not N).
 *      Locks the R5 follow-up A scaling fix.
 *   6. Custom cadence falls back to per-instance setInterval.
 *   7. `refreshMs={0}` disables auto-refresh entirely.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import { RelativeTime } from '@/components/ui/relative-time';

const ENGLISH_MESSAGES = {} as const;

function renderWithLocale(ui: React.ReactNode, locale = 'en') {
  return render(
    <NextIntlClientProvider locale={locale} messages={ENGLISH_MESSAGES}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe('<RelativeTime>', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Pin the clock so absolute fallback + relative output are
    // deterministic across runs.
    vi.setSystemTime(new Date('2026-05-09T11:30:00Z'));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('SSR output renders the absolute date (no Date.now() in render path)', () => {
    // True SSR test via `renderToString` — exercises the same code
    // path Next.js uses on the server. `useEffect` does NOT fire
    // during SSR, so the `mounted` state stays false and the
    // absolute fallback wins. This is the load-bearing assertion
    // that locks the hydration-mismatch fix at the source.
    const iso = '2026-05-09T11:29:00Z'; // 60 seconds ago

    const html = renderToString(
      <NextIntlClientProvider locale="en" messages={ENGLISH_MESSAGES}>
        <RelativeTime iso={iso} />
      </NextIntlClientProvider>,
    );

    // Absolute label contains the year token; relative does not.
    expect(html).toMatch(/2026/);
    expect(html).not.toMatch(/minute ago|seconds ago/);
    // dateTime carries the canonical ISO regardless of which label
    // is currently shown. React renderToString may emit either
    // `datetime` (HTML standard attribute name) or `dateTime` (JSX
    // prop name preserved) depending on environment — both are
    // semantically correct.
    expect(html.toLowerCase()).toContain(`datetime="${iso.toLowerCase()}"`);
  });

  it('flips to relative-time after useEffect runs (post-hydration)', async () => {
    const iso = '2026-05-09T11:29:00Z'; // 60 seconds ago

    renderWithLocale(<RelativeTime iso={iso} />);

    // Run the useEffect that flips mounted=true.
    await act(async () => {
      await Promise.resolve();
    });

    const time = document.querySelector('time');
    expect(time).not.toBeNull();
    // Relative label for 60s ago: "1 minute ago" (en, numeric:'auto').
    expect(time?.textContent).toMatch(/minute/i);
    expect(time?.textContent).not.toMatch(/2026/);
  });

  it('forwards the title prop to the <time> element', async () => {
    const iso = '2026-05-09T11:29:00Z';
    renderWithLocale(<RelativeTime iso={iso} title="custom-tooltip" />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(document.querySelector('time')?.getAttribute('title')).toBe(
      'custom-tooltip',
    );
  });

  it('applies the className to the <time> element', async () => {
    renderWithLocale(
      <RelativeTime iso="2026-05-09T11:29:00Z" className="text-xs" />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.querySelector('time')?.className).toContain('text-xs');
  });

  it('shared-tick singleton: N instances subscribe to ONE setInterval (R5-A)', async () => {
    // Spy on global setInterval BEFORE mounting any RelativeTime
    // instance. The shared-tick singleton sets up exactly ONE
    // setInterval call regardless of how many RelativeTime
    // instances mount with the default cadence.
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    // Mount 5 instances — all default cadence → all subscribe to
    // the singleton → exactly 1 setInterval expected.
    renderWithLocale(
      <>
        <RelativeTime iso="2026-05-09T11:29:00Z" />
        <RelativeTime iso="2026-05-09T11:28:00Z" />
        <RelativeTime iso="2026-05-09T11:27:00Z" />
        <RelativeTime iso="2026-05-09T11:26:00Z" />
        <RelativeTime iso="2026-05-09T11:25:00Z" />
      </>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    // The shared-tick singleton creates EXACTLY ONE setInterval for
    // 5 default-cadence instances. Strictness matters here: a `<= 1`
    // assertion would silently pass if the singleton broke and
    // produced ZERO setInterval calls (state leak across tests, or
    // useEffect not running). Test isolation is ensured by
    // `cleanup()` in afterEach which unmounts all instances → their
    // useEffect cleanups call unsubscribe → last unsubscribe clears
    // the interval + nulls the id, so this test starts from a fresh
    // singleton and observes exactly one new spy call.
    const newIntervalCalls = setIntervalSpy.mock.calls.length;
    expect(newIntervalCalls).toBe(1);

    setIntervalSpy.mockRestore();
  });

  it('custom cadence falls back to a per-instance setInterval', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    // 1s cadence — non-default → bypasses the singleton.
    renderWithLocale(
      <>
        <RelativeTime iso="2026-05-09T11:29:00Z" refreshMs={1_000} />
        <RelativeTime iso="2026-05-09T11:28:00Z" refreshMs={1_000} />
      </>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    // 2 custom-cadence instances → 2 setInterval calls (one each).
    const customCadenceCalls = setIntervalSpy.mock.calls.filter(
      ([, ms]) => ms === 1_000,
    );
    expect(customCadenceCalls.length).toBe(2);

    setIntervalSpy.mockRestore();
  });

  it('refreshMs=0 disables auto-refresh entirely', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    renderWithLocale(
      <RelativeTime iso="2026-05-09T11:29:00Z" refreshMs={0} />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    // No setInterval scheduled for this instance (the singleton
    // path also short-circuits at the `refreshMs <= 0` guard).
    const calls = setIntervalSpy.mock.calls.length;
    expect(calls).toBe(0);

    setIntervalSpy.mockRestore();
  });
});
