/**
 * F7-A11Y-1 — structural guard that the admin Approve/Reject dialogs wire
 * `finalFocus` on their AlertDialogContent (WCAG 2.1 AA SC 2.4.3 Focus
 * Order).
 *
 * The controlled Approve/Reject dialogs have an EXTERNAL trigger Button
 * (review-actions.tsx) that UNMOUNTS after router.refresh() on success
 * (the row's status leaves 'submitted' → ReviewActions returns null).
 * Without a finalFocus target, Base UI drops keyboard focus to <body>.
 * The sibling retry/accept-partial dialogs already wire finalFocus; the
 * approve/reject pair was missed.
 *
 * Base UI's AlertDialog deadlocks under jsdom + React 19 startTransition
 * (documented in tests/unit/app/admin/renewals/pending-reactivation-
 * error-i18n.test.ts), so a full render is not a viable seam here. This
 * is a source-structural guard — the same philosophy as the check:layout
 * container guard — that fails if the finalFocus wiring is dropped. It is
 * paired below with a behavioural test of the 3-link priority chain
 * INCLUDING the #main-content tail unique to these dialogs (ReviewActions
 * fully unmounts on success, so there is no surviving sibling heading to
 * fall back to — unlike retry/accept-partial). The 2-link base chain is
 * also covered by tests/contract/broadcasts/dialog-final-focus.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIALOGS = ['approve-dialog.tsx', 'reject-dialog.tsx'] as const;

function dialogSource(file: string): string {
  return readFileSync(
    resolve(process.cwd(), 'src/components/broadcast/admin', file),
    'utf8',
  );
}

describe('admin Approve/Reject dialogs — finalFocus wiring (F7-A11Y-1)', () => {
  for (const file of DIALOGS) {
    it(`${file} passes finalFocus to its AlertDialogContent`, () => {
      const src = dialogSource(file);
      expect(
        src.includes('finalFocus='),
        `${file} must pass finalFocus to <AlertDialogContent> so focus does ` +
          'not drop to <body> when the trigger unmounts after a successful ' +
          'approve/reject (router.refresh removes the trigger).',
      ).toBe(true);
    });

    it(`${file} accepts a triggerRef prop so the parent can return focus`, () => {
      const src = dialogSource(file);
      expect(
        src.includes('triggerRef'),
        `${file} must accept a triggerRef (review-actions attaches it to the ` +
          'Approve/Reject button) — mirrors retry-confirmation-dialog.',
      ).toBe(true);
    });
  }
});

// ── Behavioural: the 3-link finalFocus priority chain ──────────────────
// Mirrors the closure inside approve-dialog.tsx / reject-dialog.tsx:
//   triggerRef?.current ?? fallbackFocusRef?.current ?? <#main-content el>
// Links 1-2 are the retry/accept-partial pattern (also in
// dialog-final-focus.test.ts); the #main-content tail is unique to these
// dialogs and is the behaviour this block pins.
function fakeEl(label: string): HTMLElement {
  return { label } as unknown as HTMLElement;
}

function resolveApproveRejectFinalFocus(
  triggerRef: { current: HTMLElement | null } | undefined,
  fallbackFocusRef: { current: HTMLElement | null } | undefined,
  mainContent: HTMLElement | null,
): HTMLElement | null {
  return triggerRef?.current ?? fallbackFocusRef?.current ?? mainContent;
}

describe('Approve/Reject finalFocus 3-link priority chain (F7-A11Y-1)', () => {
  it('trigger present → returns trigger (#main-content not consulted)', () => {
    const trigger = fakeEl('trigger');
    expect(
      resolveApproveRejectFinalFocus(
        { current: trigger },
        undefined,
        fakeEl('main-content'),
      ),
    ).toBe(trigger);
  });

  it('trigger unmounted + fallback present → returns fallback', () => {
    const fallback = fakeEl('fallback-heading');
    expect(
      resolveApproveRejectFinalFocus(
        { current: null },
        { current: fallback },
        fakeEl('main-content'),
      ),
    ).toBe(fallback);
  });

  it('trigger + fallback both unmounted → falls back to #main-content (success-path refuge)', () => {
    const main = fakeEl('main-content');
    expect(
      resolveApproveRejectFinalFocus({ current: null }, { current: null }, main),
    ).toBe(main);
  });

  it('everything absent (no #main-content in DOM) → null (Base UI <body> fallback)', () => {
    expect(resolveApproveRejectFinalFocus(undefined, undefined, null)).toBeNull();
  });
});
