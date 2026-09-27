/**
 * Unit tests for useFixedBarScrollPadding — paired with
 * src/hooks/use-fixed-bar-scroll-padding.ts. WCAG 2.2 SC 2.4.11: while a
 * fixed-bottom bulk bar is shown, the root scroller's `scroll-padding-bottom`
 * equals the bar's height, and the previous value comes back when it hides.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useFixedBarScrollPadding } from '@/hooks/use-fixed-bar-scroll-padding';

const root = () => document.documentElement.style;

describe('useFixedBarScrollPadding', () => {
  afterEach(() => {
    root().scrollPaddingBottom = '';
  });

  it('sets scroll-padding-bottom to the bar height while active, and tracks height changes', () => {
    const { rerender } = renderHook(({ h }) => useFixedBarScrollPadding(true, h), {
      initialProps: { h: 64 },
    });
    expect(root().scrollPaddingBottom).toBe('64px');
    rerender({ h: 157 });
    expect(root().scrollPaddingBottom).toBe('157px');
  });

  it('leaves the root untouched while inactive', () => {
    root().scrollPaddingBottom = '12px';
    renderHook(() => useFixedBarScrollPadding(false, 64));
    expect(root().scrollPaddingBottom).toBe('12px');
  });

  it('restores the previous value when the bar hides or unmounts', () => {
    root().scrollPaddingBottom = '12px';
    const { rerender, unmount } = renderHook(
      ({ active }) => useFixedBarScrollPadding(active, 80),
      { initialProps: { active: true } },
    );
    expect(root().scrollPaddingBottom).toBe('80px');
    rerender({ active: false });
    expect(root().scrollPaddingBottom).toBe('12px');
    rerender({ active: true });
    unmount();
    expect(root().scrollPaddingBottom).toBe('12px');
  });
});
