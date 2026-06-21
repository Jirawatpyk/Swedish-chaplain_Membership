/**
 * F7-A11Y-1 — focus-return correctness for the broadcast Approve / Reject /
 * Cancel confirmation dialogs (WCAG 2.1 AA SC 2.4.3 Focus Order).
 *
 * All three dialogs have an EXTERNAL trigger Button — review-actions.tsx for
 * approve/reject; the broadcast list/detail row for cancel — that UNMOUNTS
 * after the programmatic close paths (success / 409 concurrent-race / — for
 * cancel — 404/403 permanent): each runs router.refresh(), flipping the row
 * out of its actionable status so the trigger's owner returns null. At the
 * instant Base UI computes finalFocus the trigger is STILL mounted, so the
 * naive `triggerRef ?? fallback ?? #main-content` chain returns the trigger,
 * which is removed milliseconds later → keyboard focus drops to <body>.
 *
 * The fix: each dialog raises a `closedViaSuccessRef` flag on those
 * programmatic closes, and the shared finalFocus resolver SKIPS the
 * about-to-unmount trigger when the flag is set, landing on the surviving
 * fallback / #main-content landmark (the layout's <main tabIndex={-1}>).
 *
 * Base UI's AlertDialog deadlocks under jsdom + React 19 startTransition
 * (documented in tests/unit/app/admin/renewals/pending-reactivation-
 * error-i18n.test.ts), so a full render is not a viable seam. Two guards:
 *   1. Source-structural — each dialog wires finalFocus + triggerRef + the
 *      closedViaSuccessRef success-skip; a refactor that drops any of these
 *      silently reintroduces the <body> bug (same philosophy as check:layout).
 *   2. Behavioural — the REAL exported `resolveDialogFinalFocus` pure resolver
 *      (not a shadow reimplementation), including the load-bearing
 *      success-skip case. The 2-link base chain for the sibling
 *      retry/accept-partial dialogs lives in
 *      tests/contract/broadcasts/dialog-final-focus.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDialogFinalFocus } from '@/components/broadcast/resolve-dialog-final-focus';

const BROADCAST_DIR = 'src/components/broadcast';
const DIALOGS = [
  { subdir: 'admin', file: 'approve-dialog.tsx' },
  { subdir: 'admin', file: 'reject-dialog.tsx' },
  { subdir: '', file: 'cancel-broadcast-dialog.tsx' },
] as const;

function dialogSource(subdir: string, file: string): string {
  return readFileSync(resolve(process.cwd(), BROADCAST_DIR, subdir, file), 'utf8');
}

describe('broadcast confirmation dialogs — finalFocus wiring (F7-A11Y-1)', () => {
  for (const { subdir, file } of DIALOGS) {
    it(`${file} passes finalFocus to its dialog content`, () => {
      expect(
        dialogSource(subdir, file).includes('finalFocus='),
        `${file} must pass finalFocus so focus does not drop to <body> when ` +
          'the trigger unmounts after router.refresh().',
      ).toBe(true);
    });

    it(`${file} accepts a triggerRef so the parent can return focus`, () => {
      expect(
        dialogSource(subdir, file).includes('triggerRef'),
        `${file} must accept a triggerRef so Cancel/ESC return focus to the ` +
          'surviving trigger button.',
      ).toBe(true);
    });

    it(`${file} raises closedViaSuccessRef so finalFocus skips the unmounting trigger`, () => {
      expect(
        dialogSource(subdir, file).includes('closedViaSuccessRef'),
        `${file} must raise a closedViaSuccessRef on its programmatic close ` +
          'paths so the shared resolver skips the about-to-unmount trigger ' +
          '(else focus drops to <body>).',
      ).toBe(true);
    });
  }
});

// ── Behavioural: the success-aware finalFocus resolver ─────────────────────
// Tests the REAL exported helper (not a shadow reimplementation), so a
// regression in the live resolver is caught here. The load-bearing case is
// `closedViaSuccess`: on a success / 409 / permanent-error close the external
// trigger Button unmounts, so returning it would drop focus to <body>. The
// resolver SKIPS the trigger on that close and lands on the surviving
// fallback / #main-content landmark. WCAG 2.1 AA SC 2.4.3.
function fakeEl(label: string): HTMLElement {
  return { label } as unknown as HTMLElement;
}

describe('resolveDialogFinalFocus — success-aware priority chain (F7-A11Y-1)', () => {
  it('cancel/ESC (closedViaSuccess=false) + trigger present → returns trigger', () => {
    const trigger = fakeEl('trigger');
    expect(
      resolveDialogFinalFocus({
        closedViaSuccess: false,
        trigger,
        fallback: null,
        mainContent: fakeEl('main-content'),
      }),
    ).toBe(trigger);
  });

  it('SUCCESS close + trigger STILL present → SKIPS trigger → #main-content (the bug fix)', () => {
    const main = fakeEl('main-content');
    // The trigger is non-null at close time but about to unmount — returning
    // it would drop focus to <body>. Must skip to #main-content.
    expect(
      resolveDialogFinalFocus({
        closedViaSuccess: true,
        trigger: fakeEl('trigger'),
        fallback: null,
        mainContent: main,
      }),
    ).toBe(main);
  });

  it('SUCCESS close + fallback present → fallback (still skips trigger)', () => {
    const fallback = fakeEl('fallback-heading');
    expect(
      resolveDialogFinalFocus({
        closedViaSuccess: true,
        trigger: fakeEl('trigger'),
        fallback,
        mainContent: fakeEl('main-content'),
      }),
    ).toBe(fallback);
  });

  it('cancel + trigger unmounted + fallback present → returns fallback', () => {
    const fallback = fakeEl('fallback-heading');
    expect(
      resolveDialogFinalFocus({
        closedViaSuccess: false,
        trigger: null,
        fallback,
        mainContent: fakeEl('main-content'),
      }),
    ).toBe(fallback);
  });

  it('everything absent → null (Base UI <body> fallback contract)', () => {
    expect(
      resolveDialogFinalFocus({
        closedViaSuccess: true,
        trigger: null,
        fallback: null,
        mainContent: null,
      }),
    ).toBeNull();
  });
});
