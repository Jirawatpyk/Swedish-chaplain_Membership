// @vitest-environment jsdom
/**
 * Unit tests for useActionBarClearance — paired with
 * src/hooks/use-action-bar-clearance.ts. The clearance a focused field needs
 * above a viewport ActionBar: the bar's measured height, its offset from the
 * screen's bottom edge, and a 16px gap.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useActionBarClearance } from '@/hooks/use-action-bar-clearance';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function mountBar(className: string, height: number, bottom = '0px'): void {
  const bar = document.createElement('div');
  bar.className = className;
  bar.style.bottom = bottom;
  document.body.append(bar);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { height: this.classList.contains(className) ? height : 0 } as DOMRect;
  });
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
});
