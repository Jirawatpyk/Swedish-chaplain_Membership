import { renderHook, act } from '@testing-library/react';
import { useScrollSpy } from '@/components/invoices/invoice-settings/use-scroll-spy';

// Minimal shape covering only what the hook reads off each entry — jsdom
// has no real IntersectionObserver, so this stand-in avoids `any` while
// keeping the mock deliberately narrower than the full DOM interface.
interface MockObserverEntry {
  target: Element | null;
  isIntersecting: boolean;
  intersectionRatio: number;
  boundingClientRect: { top: number };
}
type MockObserverCallback = (entries: MockObserverEntry[]) => void;

let cb: MockObserverCallback;
beforeEach(() => {
  cb = () => {};
  class MockIntersectionObserver {
    constructor(fn: MockObserverCallback) { cb = fn; }
    observe() {} disconnect() {} unobserve() {}
  }
  (globalThis as unknown as { IntersectionObserver: typeof MockIntersectionObserver }).IntersectionObserver =
    MockIntersectionObserver;
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

// Documented "retain the last active section" behaviour: once nothing is
// intersecting (e.g. the user is between two sections, or has scrolled past
// the last one), the hook must not fall back to null — the nav's
// aria-current would otherwise vanish mid-scroll.
it('retains the last active section when a later batch has nothing intersecting', () => {
  const { result } = renderHook(() => useScrollSpy(['s1', 's2']));
  act(() => cb([
    { target: document.getElementById('s2'), isIntersecting: true, intersectionRatio: 0.9, boundingClientRect: { top: 10 } },
    { target: document.getElementById('s1'), isIntersecting: false, intersectionRatio: 0, boundingClientRect: { top: -200 } },
  ]));
  expect(result.current).toBe('s2');

  act(() => cb([
    { target: document.getElementById('s2'), isIntersecting: false, intersectionRatio: 0, boundingClientRect: { top: -300 } },
    { target: document.getElementById('s1'), isIntersecting: false, intersectionRatio: 0, boundingClientRect: { top: -500 } },
  ]));
  expect(result.current).toBe('s2');
});
