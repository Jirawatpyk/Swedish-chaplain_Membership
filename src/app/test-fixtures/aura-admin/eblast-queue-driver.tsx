'use client';

/**
 * 122 US12b (T1219) — opens a review-queue dialog for the `view=broadcasts`
 * previews, the way an admin does: `bulk` ticks the first actionable row and
 * presses "Approve selected"; the others press their trigger by its label.
 * Keeps trying until a dialog is open, for up to 5 s (the queue hydrates
 * after this effect first runs).
 */
import { useEffect, useRef, type ReactNode } from 'react';

const TRIGGER_LABEL = {
  approve: 'Approve',
  reject: 'Reject',
  'clear-halt': 'Review + clear halt',
} as const;

export type QueuePreviewDialog = keyof typeof TRIGGER_LABEL | 'bulk';

export function QueueDialogDriver({
  dialog,
  children,
}: {
  readonly dialog: QueuePreviewDialog;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let tries = 0;
    const id = window.setInterval(() => {
      const root = ref.current;
      if (!root || document.querySelector('[role="dialog"], [role="alertdialog"]') || ++tries > 50) {
        window.clearInterval(id);
        return;
      }
      const buttons = [...root.querySelectorAll<HTMLButtonElement>('button')].filter(
        (b) => !b.disabled && b.getClientRects().length > 0,
      );
      if (dialog === 'bulk') {
        const approveSelected = buttons.find((b) => b.textContent?.trim().startsWith('Approve selected'));
        if (approveSelected) {
          approveSelected.click();
          return;
        }
        root
          .querySelector<HTMLInputElement>('[role="row"]:not(:first-child) input[type="checkbox"]:not(:checked)')
          ?.click();
        return;
      }
      const label = TRIGGER_LABEL[dialog];
      buttons.find((b) => b.textContent?.trim() === label)?.click();
    }, 100);
    return () => window.clearInterval(id);
  }, [dialog]);
  return <div ref={ref}>{children}</div>;
}
