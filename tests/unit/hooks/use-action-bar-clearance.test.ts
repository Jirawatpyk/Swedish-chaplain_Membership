// @vitest-environment jsdom
/**
 * Unit tests for useActionBarClearance — paired with
 * src/hooks/use-action-bar-clearance.ts. The clearance a focused field needs
 * above a viewport ActionBar: the bar's measured height, its offset from the
 * screen's bottom edge, and a 16px gap.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useActionBarClearance } from '@/hooks/use-action-bar-clearance';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function mountBar(className: string, height: number, bottom = '0px', position = 'sticky'): HTMLElement {
  const bar = document.createElement('div');
  bar.className = className;
  bar.style.bottom = bottom;
  bar.style.position = position;
  document.body.append(bar);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { height: this.classList.contains(className) ? height : 0 } as DOMRect;
  });
  return bar;
}

describe('useActionBarClearance', () => {
  it('is the bar height plus its bottom offset plus a 16px gap', () => {
    mountBar('my-bar', 114, '8px');
    const { result } = renderHook(() => useActionBarClearance(true, '.my-bar'));
    expect(result.current).toBe(138);
  });

  it('is 0 while inactive', () => {
    mountBar('my-bar', 114);
    const { result } = renderHook(() => useActionBarClearance(false, '.my-bar'));
    expect(result.current).toBe(0);
  });

  it('is 0 when no bar matches', () => {
    const { result } = renderHook(() => useActionBarClearance(true, '.missing'));
    expect(result.current).toBe(0);
  });

  // AURA un-sticks the bar on a short screen (400% zoom, a phone held
  // sideways): it then sits in the page flow and covers nothing.
  it('is 0 while the bar is not sticky', () => {
    mountBar('my-bar', 114, '8px', 'static');
    const { result } = renderHook(() => useActionBarClearance(true, '.my-bar'));
    expect(result.current).toBe(0);
  });

  // D-039 — below 640px the bar is AURA's edge strip (`edgeBelow="sm"`),
  // `position: fixed`: AURA pads the page and sets the scroll padding itself
  // from `--aura-actionbar-height`, so the hook must not count it again.
  it('is 0 while the bar is AURA’s fixed edge strip', () => {
    mountBar('my-bar', 62, '0px', 'fixed');
    const { result } = renderHook(() => useActionBarClearance(true, '.my-bar'));
    expect(result.current).toBe(0);
  });

  it('follows the bar when it grows (a reason wraps it to two rows)', () => {
    let fire: () => void = () => {};
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          fire = cb;
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    let height = 62;
    const bar = mountBar('my-bar', 0);
    vi.spyOn(bar, 'getBoundingClientRect').mockImplementation(() => ({ height }) as DOMRect);
    const { result } = renderHook(() => useActionBarClearance(true, '.my-bar'));
    expect(result.current).toBe(78);
    height = 114;
    act(() => fire());
    expect(result.current).toBe(130);
    vi.unstubAllGlobals();
  });

  it('starts from 0 again when it turns back on and finds no bar', () => {
    const bar = mountBar('my-bar', 114);
    const { result, rerender } = renderHook(({ on }) => useActionBarClearance(on, '.my-bar'), {
      initialProps: { on: true },
    });
    expect(result.current).toBe(130);
    rerender({ on: false });
    bar.remove();
    rerender({ on: true });
    expect(result.current).toBe(0);
  });

  // PR M — a bar that holds a ref is measured through it: no page-wide
  // selector, so another bar on the page is never measured instead.
  it('measures the element a ref points at', () => {
    const bar = mountBar('no-class-needed', 70, '12px');
    const { result } = renderHook(() => useActionBarClearance(true, { current: bar }));
    expect(result.current).toBe(98);
  });

  // D-039 review — crossing 640px swaps AURA's sticky card for its fixed edge
  // strip without always resizing the bar; the 640px query re-measures, so the
  // card's inline value never outlives it.
  it('re-measures when the width crosses 640px (card to edge strip)', () => {
    const listeners = new Map<string, () => void>();
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      addEventListener: (_: string, cb: () => void) => listeners.set(query, cb),
      removeEventListener: () => {},
    }));
    const bar = mountBar('my-bar', 70, '12px');
    const { result } = renderHook(() => useActionBarClearance(true, '.my-bar'));
    expect(result.current).toBe(98);
    bar.style.position = 'fixed';
    act(() => listeners.get('(min-width: 40rem)')?.());
    expect(result.current).toBe(0);
    vi.unstubAllGlobals();
  });
});
