/**
 * F7-A11Y-1 — final-focus target resolver for the broadcast Approve / Reject /
 * Cancel confirmation dialogs. Pure (no React, no DOM access) so it is
 * unit-testable without a jsdom render — Base UI's AlertDialog deadlocks under
 * jsdom + React 19 startTransition, so a full render is not a viable seam.
 *
 * The trigger Button lives OUTSIDE the dialog (review-actions.tsx for
 * approve/reject; the broadcast row for cancel) and UNMOUNTS after the
 * programmatic close paths — success / 409 concurrent-race / (for cancel)
 * 404/403 permanent: each runs `router.refresh()`, flipping the row out of its
 * actionable status so the trigger's owner returns null. At the instant Base UI
 * reads `finalFocus` the trigger is STILL mounted, so returning it moves focus
 * to a node removed milliseconds later → focus drops to `<body>`.
 *
 * Fix: on those closes the caller raises `closedViaSuccess`, and we SKIP the
 * trigger, landing on the surviving fallback / `#main-content` landmark (the
 * admin/member layout's `<main id="main-content" tabIndex={-1}>`, focusable).
 * On Cancel / ESC the trigger survives, so it is the least-surprising
 * focus-return target. WCAG 2.1 AA SC 2.4.3 (Focus Order).
 */
export interface DialogFinalFocusInput {
  /**
   * `true` when the dialog is closing because the action SUCCEEDED (or hit a
   * 409 concurrent-race, or — for cancel — a 404/403 permanent error): all run
   * `router.refresh()`, which unmounts the trigger. `false` on Cancel / ESC,
   * where the trigger survives.
   */
  readonly closedViaSuccess: boolean;
  readonly trigger: HTMLElement | null;
  readonly fallback: HTMLElement | null;
  readonly mainContent: HTMLElement | null;
}

export function resolveDialogFinalFocus(
  input: DialogFinalFocusInput,
): HTMLElement | null {
  if (input.closedViaSuccess) {
    // Trigger is about to unmount — never return it. Fall straight to the
    // surviving fallback, then the #main-content landmark.
    return input.fallback ?? input.mainContent;
  }
  return input.trigger ?? input.fallback ?? input.mainContent;
}
