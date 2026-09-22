// @vitest-environment jsdom
/**
 * F119 T155 findings U3 + U4 — the two dialogs the `finalFocus` roll-call
 * found bare, and both are the exact failure the helper exists for: the
 * TRIGGER unmounts on success.
 *
 *   - `clear-halt-dialog.tsx` — on 200 the member is un-halted and
 *     `halt-state-banner.tsx:86-90` stops rendering that row's button.
 *   - `admin-image-allowlist-editor.tsx` — on 200 the row is replaced by the
 *     server's new allowlist and the Remove button goes with it. Removing
 *     several hostnames meant re-Tabbing from the top of the page each time.
 *
 * Base UI reads `finalFocus` while the trigger is STILL mounted, so the
 * default restore lands on a node removed milliseconds later → `<body>`.
 * WCAG 2.1 AA SC 2.4.3.
 *
 * Why the target is focused BY US and the answer is `false`: Base UI applies
 * the returned element as `getFirstTabbableElement(el)` — "the element, if
 * TABBABLE, or its first tabbable child". A `tabIndex={-1}` heading or table
 * is focusable but not tabbable, so Base UI would either skip it or substitute
 * a child link. Same reasoning, and the same shape, as
 * `dialog-final-focus-landmark.test.tsx`.
 *
 * A full Base UI AlertDialog render deadlocks under jsdom + React 19
 * startTransition (see `approve-reject-final-focus.test.ts`), so the seams are
 * the hook's callback and the source wiring — not a render.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveSurvivingTargetFinalFocus,
  useSurvivingTargetFinalFocus,
} from '@/components/broadcast/unmounting-trigger-final-focus';

function mountLandmark(): HTMLElement {
  const main = document.createElement('main');
  main.id = 'main-content';
  main.tabIndex = -1;
  document.body.appendChild(main);
  return main;
}

function mountSurvivor(id: string): HTMLElement {
  const el = document.createElement('h2');
  el.id = id;
  el.tabIndex = -1;
  document.body.appendChild(el);
  return el;
}

async function drainMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('resolveSurvivingTargetFinalFocus — the pure chain', () => {
  it('Cancel / ESC → null, so Base UI restores its own default (the trigger, which survives)', () => {
    expect(
      resolveSurvivingTargetFinalFocus({
        closedViaSuccess: false,
        survivor: {} as HTMLElement,
        mainContent: {} as HTMLElement,
      }),
    ).toBeNull();
  });

  it('SUCCESS close → the surviving element, never the about-to-unmount trigger', () => {
    const survivor = {} as HTMLElement;
    expect(
      resolveSurvivingTargetFinalFocus({
        closedViaSuccess: true,
        survivor,
        mainContent: {} as HTMLElement,
      }),
    ).toBe(survivor);
  });

  it('SUCCESS close with the survivor already gone → the #main-content landmark', () => {
    const main = {} as HTMLElement;
    expect(
      resolveSurvivingTargetFinalFocus({
        closedViaSuccess: true,
        survivor: null,
        mainContent: main,
      }),
    ).toBe(main);
  });

  it('nothing to land on → null (Base UI default contract)', () => {
    expect(
      resolveSurvivingTargetFinalFocus({
        closedViaSuccess: true,
        survivor: null,
        mainContent: null,
      }),
    ).toBeNull();
  });
});

describe('useSurvivingTargetFinalFocus — the hook focuses the survivor itself', () => {
  it('on a success close: answers `false` and lands focus on the survivor', async () => {
    mountLandmark();
    const survivor = mountSurvivor('halt-banner-heading');
    // Where Base UI's default would have left focus — proves the assertion
    // discriminates rather than observing the default.
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);

    const { result } = renderHook(() =>
      useSurvivingTargetFinalFocus('halt-banner-heading', { current: true }),
    );

    expect(result.current()).toBe(false);
    await drainMicrotasks();
    expect(document.activeElement).toBe(survivor);
  });

  it('on Cancel / ESC: answers `null` and moves nothing', async () => {
    mountLandmark();
    mountSurvivor('halt-banner-heading');
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    const { result } = renderHook(() =>
      useSurvivingTargetFinalFocus('halt-banner-heading', { current: false }),
    );

    expect(result.current()).toBeNull();
    await drainMicrotasks();
    expect(document.activeElement).toBe(trigger);
  });

  it('survivor removed before the microtask runs → focus falls to the landmark, never <body>', async () => {
    const main = mountLandmark();
    const survivor = mountSurvivor('halt-banner-heading');

    const { result } = renderHook(() =>
      useSurvivingTargetFinalFocus('halt-banner-heading', { current: true }),
    );
    expect(result.current()).toBe(false);
    // The last halted member was cleared: the whole banner goes away between
    // Base UI's read and the focus call.
    survivor.remove();

    await drainMicrotasks();
    expect(document.activeElement).toBe(main);
  });
});

// ── Source-structural: the wiring at each call site ────────────────────────
const DIALOGS = [
  { path: 'src/components/broadcast/admin/clear-halt-dialog.tsx', label: 'clear-halt-dialog' },
  {
    path: 'src/components/broadcast/admin-image-allowlist-editor.tsx',
    label: 'admin-image-allowlist-editor',
  },
] as const;

describe('U3 + U4 — both dialogs wire the surviving-target finalFocus', () => {
  for (const { path, label } of DIALOGS) {
    it(`${label} passes finalFocus to its dialog content`, () => {
      const src = readFileSync(resolve(process.cwd(), path), 'utf8');
      expect(
        src.includes('finalFocus='),
        `${label} must pass finalFocus — its trigger unmounts on success, so ` +
          "Base UI's default restore drops focus to <body>.",
      ).toBe(true);
    });

    it(`${label} raises closedViaSuccessRef so Cancel / ESC still return to the trigger`, () => {
      const src = readFileSync(resolve(process.cwd(), path), 'utf8');
      expect(
        src.includes('closedViaSuccessRef'),
        `${label} must distinguish the success close (trigger unmounts) from ` +
          'Cancel / ESC (trigger survives).',
      ).toBe(true);
    });
  }

  it('the halt banner heading is the focusable survivor the dialog names', () => {
    const banner = readFileSync(
      resolve(process.cwd(), 'src/components/broadcast/admin/halt-state-banner.tsx'),
      'utf8',
    );
    expect(banner).toContain('HALT_BANNER_HEADING_ID');
    expect(banner).toMatch(/tabIndex=\{-1\}/);
  });

  it('the allowlist table is the focusable survivor the dialog names', () => {
    const editor = readFileSync(
      resolve(process.cwd(), 'src/components/broadcast/admin-image-allowlist-editor.tsx'),
      'utf8',
    );
    expect(editor).toContain('ALLOWLIST_TABLE_ID');
    expect(editor).toMatch(/tabIndex=\{-1\}/);
  });
});
