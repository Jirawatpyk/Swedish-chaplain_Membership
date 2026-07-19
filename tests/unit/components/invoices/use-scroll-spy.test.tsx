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
  expect(result.current.active).toBe('s2');
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
  expect(result.current.active).toBe('s2');

  act(() => cb([
    { target: document.getElementById('s2'), isIntersecting: false, intersectionRatio: 0, boundingClientRect: { top: -300 } },
    { target: document.getElementById('s1'), isIntersecting: false, intersectionRatio: 0, boundingClientRect: { top: -500 } },
  ]));
  expect(result.current.active).toBe('s2');
});

// code-review follow-up (finding 4) — the IntersectionObserver callback
// only reports entries whose intersection STATE CHANGED, not every
// currently-intersecting section. Fire two SEPARATE callbacks: #1 makes
// s2 intersecting (active flips to s2); #2 contains ONLY s1 becoming
// intersecting with a smaller `top` than s2's LAST-KNOWN top — s2 is not
// part of this batch at all. If the hook only looked at the current
// batch, s1 would win purely because it's the only visible entry THIS
// tick — asserting on `top` proves it's actually comparing s1 against
// s2's carried-over state (topmost-across-the-full-map), not just
// picking whatever the latest batch contains.
it('computes the topmost section across the FULL accumulated state, not just the latest batch', () => {
  const { result } = renderHook(() => useScrollSpy(['s1', 's2']));
  act(() => cb([
    { target: document.getElementById('s2'), isIntersecting: true, intersectionRatio: 0.9, boundingClientRect: { top: 100 } },
  ]));
  expect(result.current.active).toBe('s2');

  act(() => cb([
    { target: document.getElementById('s1'), isIntersecting: true, intersectionRatio: 0.9, boundingClientRect: { top: 10 } },
  ]));
  expect(result.current.active).toBe('s1');
});

// code-review follow-up (finding 5) — `setActive` lets a consumer
// (SectionNav's `goToSection`) optimistically flip `active` without
// waiting for an IntersectionObserver callback.
it('exposes a setActive setter that updates active independently of any IntersectionObserver callback', () => {
  const { result } = renderHook(() => useScrollSpy(['s1', 's2']));
  expect(result.current.active).toBe('s1');
  act(() => result.current.setActive('s2'));
  expect(result.current.active).toBe('s2');
});
