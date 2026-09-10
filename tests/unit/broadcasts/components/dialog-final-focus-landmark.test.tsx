// @vitest-environment jsdom
/**
 * F7-A11Y-1, the half the pure resolver could not see (e2e `@bulk` focus case,
 * 2026-09-10).
 *
 * `resolveDialogFinalFocus` returns the `#main-content` landmark on a
 * successful close, and every dialog hands that to Base UI as `finalFocus`.
 * Base UI's `FloatingFocusManager` then applies it as
 *
 *     getFirstTabbableElement(returnElement)  // "the element, if tabbable,
 *                                             //  or its FIRST TABBABLE CHILD"
 *
 * and the landmark is `tabIndex={-1}` — focusable, NOT tabbable — so focus
 * landed on the first link inside <main> (traced on the review queue: the
 * page-header "Templates" link, from t+0 for 4 s). The intent of F7-A11Y-1 was
 * the landmark itself.
 *
 * So the hook does the landmark focus ITSELF, after Base UI's own microtask,
 * and answers `false` so Base UI moves nothing. Two things are pinned here:
 *   1. the return value is `false` when the target is the landmark (Base UI
 *      must not substitute a child);
 *   2. the landmark actually holds focus once the microtask queue has drained,
 *      even though a tabbable link sits inside it.
 * A full dialog render is not a viable seam under jsdom + React 19 (see
 * approve-reject-final-focus.test.ts); the hook's callback is.
 */
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { useDialogFinalFocus } from '@/components/broadcast/reason-confirmation-dialog';

function mountLandmark(): { main: HTMLElement; link: HTMLAnchorElement } {
  const main = document.createElement('main');
  main.id = 'main-content';
  main.tabIndex = -1;
  const link = document.createElement('a');
  link.href = '/admin/broadcasts/templates';
  link.textContent = 'Templates';
  main.appendChild(link);
  document.body.appendChild(main);
  return { main, link };
}

async function drainMicrotasks(): Promise<void> {
  // Base UI queues ONE microtask; the hook queues one inside one. Three
  // turns is enough for both to have run in any interleaving.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('useDialogFinalFocus — the #main-content landmark is focused by us, not substituted by Base UI', () => {
  beforeEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('on a success close: answers `false` to Base UI and focuses the landmark itself after the microtask pass', async () => {
    const { main, link } = mountLandmark();
    // Pretend Base UI's default would have won: put focus where its
    // "first tabbable child" rule would leave it.
    link.focus();
    expect(document.activeElement).toBe(link);

    const closedViaSuccessRef = { current: true };
    const { result } = renderHook(() =>
      useDialogFinalFocus(createRef<HTMLButtonElement>(), undefined, closedViaSuccessRef),
    );

    const answer = result.current();
    // Base UI reads this: `false` = "move nothing" — so it cannot pick the
    // landmark's first tabbable child.
    expect(answer).toBe(false);

    await drainMicrotasks();
    expect(document.activeElement).toBe(main);
  });

  it('when a mounted trigger is the target (Cancel / ESC), the trigger is returned untouched — Base UI focuses it', () => {
    mountLandmark();
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    const triggerRef = { current: trigger };
    const { result } = renderHook(() =>
      useDialogFinalFocus(triggerRef, undefined, { current: false }),
    );
    expect(result.current()).toBe(trigger);
  });

  it('a non-landmark fallback element is returned untouched too', () => {
    mountLandmark();
    const fallback = document.createElement('div');
    fallback.tabIndex = -1;
    document.body.appendChild(fallback);
    const { result } = renderHook(() =>
      useDialogFinalFocus(undefined, { current: fallback }, { current: true }),
    );
    expect(result.current()).toBe(fallback);
  });
});
