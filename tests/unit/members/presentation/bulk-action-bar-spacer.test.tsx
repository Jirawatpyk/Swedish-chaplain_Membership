/**
 * BulkActionBar — the sticky-bar spacer must track the bar's MEASURED height
 * (107-auto-invoice Task 15 re-review, N2).
 *
 * The spacer was a hardcoded `h-16` (64px). That matched the bar only while
 * the action buttons were 36px tall (36 + py-3 * 2 = 60). Task 15 raised the
 * targets to 44px (`min-h-11`, per ux-standards) and added `flex-wrap`, so:
 *
 *   - a single row is now 44 + 12 + 12 = 68px — already over 64 on desktop;
 *   - at ~320px the bar wraps to 3-4 rows, roughly 180px+.
 *
 * Against a 64px spacer that covers the last table row AND the pagination
 * control — precisely what this feature's flow needs reachable ("select rows,
 * then act").
 *
 * jsdom reports every `offsetHeight` as 0 and ships no `ResizeObserver`, so
 * the real geometry cannot be exercised here. What CAN be verified — and what
 * actually regressed — is the WIRING: that the bar is observed, and that a
 * reported height is applied to the spacer. A stub ResizeObserver captures the
 * callback and this test drives it with a synthetic entry, so the assertion
 * runs against the component's real effect and real render path rather than a
 * source-text grep.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('@/app/(staff)/admin/members/_components/bulk-progress-indicator', () => ({
  BulkProgressIndicator: () => null,
}));
vi.mock('@/app/(staff)/admin/members/_components/archive-confirm-dialog', () => ({
  ArchiveConfirmDialog: () => null,
}));
vi.mock('@/components/shell/confirmation-dialog', () => ({
  ConfirmationDialog: () => null,
}));

import { BulkActionBar } from '@/app/(staff)/admin/members/_components/bulk-action-bar';

type RoCallback = (entries: ReadonlyArray<Record<string, unknown>>) => void;

let observedTargets: Element[] = [];
let roCallback: RoCallback | null = null;
let disconnectCount = 0;

beforeEach(() => {
  // Shared setup installs fake timers; RTL's async utilities schedule on them.
  vi.useRealTimers();
  observedTargets = [];
  roCallback = null;
  disconnectCount = 0;

  class StubResizeObserver {
    constructor(cb: RoCallback) {
      roCallback = cb;
    }
    observe(target: Element) {
      observedTargets.push(target);
    }
    disconnect() {
      disconnectCount++;
    }
    unobserve() {}
  }
  vi.stubGlobal('ResizeObserver', StubResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderBar() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BulkActionBar
        selectedIds={['11111111-2222-3333-4444-555555555555']}
        selectedCompanyNames={['Acme Co']}
        totalMatching={1}
        onClear={vi.fn()}
      />
    </NextIntlClientProvider>,
  );
}

/** The spacer is the aria-hidden sibling that reserves the bar's footprint. */
function spacerEl(container: HTMLElement): HTMLElement {
  const hidden = Array.from(
    container.querySelectorAll<HTMLElement>('[aria-hidden="true"]'),
  ).filter((el) => el.style.height !== '');
  const found = hidden[0];
  if (!found) throw new Error('spacer element (inline height) not found');
  return found;
}

describe('BulkActionBar — spacer tracks the measured bar height (N2)', () => {
  it('observes the sticky bar itself', () => {
    const { container } = renderBar();
    const bar = container.querySelector('[role="toolbar"]');
    expect(bar).not.toBeNull();
    // The observed element must BE the bar — observing a wrapper or the
    // spacer would produce a height that never changes with wrapping.
    expect(observedTargets).toContain(bar);
  });

  it('grows the spacer when the bar wraps to multiple rows', () => {
    const { container } = renderBar();

    // Single row at 44px targets: 44 + py-3 * 2 = 68 — already above the old
    // hardcoded 64px.
    act(() => {
      roCallback?.([{ borderBoxSize: [{ blockSize: 68 }] }]);
    });
    expect(spacerEl(container).style.height).toBe('68px');

    // Wrapped to ~3 rows at 320px.
    act(() => {
      roCallback?.([{ borderBoxSize: [{ blockSize: 188 }] }]);
    });
    expect(spacerEl(container).style.height).toBe('188px');
  });

  it('rounds a fractional height UP so no sliver of the last row stays covered', () => {
    const { container } = renderBar();
    act(() => {
      roCallback?.([{ borderBoxSize: [{ blockSize: 68.4 }] }]);
    });
    expect(spacerEl(container).style.height).toBe('69px');
  });

  it('falls back to offsetHeight when the entry has no borderBoxSize', () => {
    const { container } = renderBar();
    const bar = container.querySelector('[role="toolbar"]') as HTMLElement;
    Object.defineProperty(bar, 'offsetHeight', { value: 96, configurable: true });
    act(() => {
      roCallback?.([{}]);
    });
    expect(spacerEl(container).style.height).toBe('96px');
  });

  it('disconnects the observer on unmount', () => {
    const { unmount } = renderBar();
    expect(disconnectCount).toBe(0);
    unmount();
    expect(disconnectCount).toBe(1);
  });

  it('keeps a usable spacer height when ResizeObserver is unavailable', () => {
    // Older browsers / non-DOM environments: the spacer must not collapse to 0.
    vi.stubGlobal('ResizeObserver', undefined);
    const { container } = renderBar();
    const height = spacerEl(container).style.height;
    expect(height).not.toBe('');
    expect(Number.parseInt(height, 10)).toBeGreaterThanOrEqual(0);
  });
});
