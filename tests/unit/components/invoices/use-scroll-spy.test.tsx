import { renderHook, act } from '@testing-library/react';
import { useScrollSpy } from '@/components/invoices/invoice-settings/use-scroll-spy';

let cb: (entries: any[]) => void;
beforeEach(() => {
  cb = () => {};
  (globalThis as any).IntersectionObserver = class {
    constructor(fn: any) { cb = fn; }
    observe() {} disconnect() {} unobserve() {}
  };
  document.body.innerHTML = '<section id="s1"></section><section id="s2"></section>';
});

it('returns the id of the most-visible intersecting section', () => {
  const { result } = renderHook(() => useScrollSpy(['s1', 's2']));
  act(() => cb([
    { target: document.getElementById('s2'), isIntersecting: true, intersectionRatio: 0.9, boundingClientRect: { top: 10 } },
    { target: document.getElementById('s1'), isIntersecting: false, intersectionRatio: 0, boundingClientRect: { top: -200 } },
  ]));
  expect(result.current).toBe('s2');
});
