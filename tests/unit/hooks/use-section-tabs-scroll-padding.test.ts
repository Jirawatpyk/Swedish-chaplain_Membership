/**
 * Unit tests for useSectionTabsScrollPadding — paired with
 * src/hooks/use-section-tabs-scroll-padding.ts. A sticky section-tab row
 * under the shell bar publishes its measured height as
 * `--chamber-section-tabs-height` on the root, which `globals.css` adds to
 * `scroll-padding-top`, so an anchored section lands below the row without a
 * fixed number. The variable goes away when the row unmounts.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useSectionTabsScrollPadding } from '@/hooks/use-section-tabs-scroll-padding';

const VAR = '--chamber-section-tabs-height';
const read = () => document.documentElement.style.getPropertyValue(VAR);

let observed: (() => void) | null = null;
const disconnect = vi.fn();

beforeEach(() => {
  observed = null;
  disconnect.mockClear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        observed = cb;
      }
      observe() {}
      disconnect() {
        disconnect();
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty(VAR);
});

function rowOfHeight(h: { value: number }): HTMLElement {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({ height: h.value }) as DOMRect;
  return el;
}

describe('useSectionTabsScrollPadding', () => {
  it('publishes the row height on the root', () => {
    const h = { value: 48 };
    renderHook(() => useSectionTabsScrollPadding({ current: rowOfHeight(h) }));
    expect(read()).toBe('48px');
  });

  it('follows the row when it resizes', () => {
    const h = { value: 48 };
    renderHook(() => useSectionTabsScrollPadding({ current: rowOfHeight(h) }));
    h.value = 60;
    observed!();
    expect(read()).toBe('60px');
  });

  it('removes the variable and stops observing on unmount', () => {
    const { unmount } = renderHook(() => useSectionTabsScrollPadding({ current: rowOfHeight({ value: 48 }) }));
    unmount();
    expect(read()).toBe('');
    expect(disconnect).toHaveBeenCalled();
  });

  it('does nothing without a row', () => {
    renderHook(() => useSectionTabsScrollPadding({ current: null }));
    expect(read()).toBe('');
  });
});
