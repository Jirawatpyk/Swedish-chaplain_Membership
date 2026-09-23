'use client';

/**
 * F119 T155 (U3, U4) — `finalFocus` for a dialog whose TRIGGER unmounts on
 * success and whose replacement target is a landmark-ish node rather than
 * another button.
 *
 * The sibling helper (`useDialogFinalFocus` in
 * `@/components/shell/reason-confirmation-dialog`) serves the Approve /
 * Reject / Cancel dialogs, which hold a `triggerRef` and a fallback ref. The
 * two dialogs this one serves cannot: their trigger is an
 * `<AlertDialogTrigger render={<Button/>}>` with no ref at the call site, and
 * the element that survives the success close is a heading or a table, not a
 * control.
 *
 * Two facts about Base UI's `FloatingFocusManager` shape this API:
 *
 *   1. a `finalFocus` getter that answers `null` falls back to the DEFAULT —
 *      the trigger. That is exactly right on Cancel / ESC, where the trigger
 *      survives, so this helper answers `null` there and wires nothing;
 *   2. a returned element is applied as `getFirstTabbableElement(el)` — "the
 *      element, if TABBABLE, or its first tabbable child". A `tabIndex={-1}`
 *      heading is focusable but not tabbable, so returning it would move
 *      focus to some descendant link, or nowhere. So on the success close we
 *      focus the survivor OURSELVES and answer `false` ("move nothing").
 *
 * WCAG 2.1 AA SC 2.4.3 (Focus Order).
 */
import { useCallback } from 'react';

export interface SurvivingTargetFinalFocusInput {
  /**
   * `true` when the dialog is closing because the action SUCCEEDED — the path
   * that runs `router.refresh()` / replaces the list and takes the trigger
   * with it. `false` on Cancel / ESC.
   */
  readonly closedViaSuccess: boolean;
  /** The element that outlives the trigger (a section heading, a list container). */
  readonly survivor: HTMLElement | null;
  /** The layout's `<main id="main-content" tabIndex={-1}>`, the last resort. */
  readonly mainContent: HTMLElement | null;
}

/**
 * Pure, so the chain is testable without a render (Base UI's AlertDialog
 * deadlocks under jsdom + React 19 `startTransition`).
 *
 * `null` means "Base UI, use your default" — never "focus nothing".
 */
export function resolveSurvivingTargetFinalFocus(
  input: SurvivingTargetFinalFocusInput,
): HTMLElement | null {
  if (!input.closedViaSuccess) return null;
  return input.survivor ?? input.mainContent;
}

/**
 * Build the `finalFocus` getter for a dialog whose trigger unmounts on
 * success.
 *
 * @param survivorId  id of the element to land on — it must carry
 *                    `tabIndex={-1}` so it is focusable.
 * @param closedViaSuccessRef  raised by the caller on the success close.
 */
export function useSurvivingTargetFinalFocus(
  survivorId: string,
  closedViaSuccessRef: React.RefObject<boolean>,
): () => HTMLElement | false | null {
  return useCallback((): HTMLElement | false | null => {
    if (typeof document === 'undefined') return null;
    const mainContent = document.getElementById('main-content');
    const target = resolveSurvivingTargetFinalFocus({
      closedViaSuccess: closedViaSuccessRef.current,
      survivor: document.getElementById(survivorId),
      mainContent,
    });
    if (target === null) return null;
    // Base UI queues ITS focus in one microtask after reading this getter;
    // ours is queued first, so the inner one runs after theirs —
    // deterministic without a timer. The `isConnected` re-check covers the
    // case where the survivor ITSELF goes away with the refresh (the last
    // halted member cleared → the whole banner unmounts).
    queueMicrotask(() => {
      queueMicrotask(() => {
        const live = target.isConnected ? target : mainContent;
        if (live !== null && live.isConnected) live.focus({ preventScroll: true });
      });
    });
    return false;
  }, [survivorId, closedViaSuccessRef]);
}
