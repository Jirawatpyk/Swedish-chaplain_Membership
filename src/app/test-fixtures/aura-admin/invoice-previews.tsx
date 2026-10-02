'use client';

/**
 * 122 US8a (T808) — client previews for the invoice views that open a
 * dialog: the `Admin-record-payment` (+ `-mobile`) board is the list with the
 * issued row's "Record payment…" opened, the way an admin opens it. US8b
 * (T828) opens the detail page's Issue, Delete draft and Issue refund the
 * same way, found by test id or by the button's own label.
 */
import { useEffect, useRef, type ReactNode } from 'react';

export function OpenFirstMatchingButton({
  testId,
  label,
  children,
}: {
  /** The trigger's `data-testid`; the first one in the subtree is clicked once. */
  readonly testId?: string;
  /** Or the start of the trigger's visible label, for a trigger with no test id. */
  readonly label?: string;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const button = testId
      ? root.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
      : [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => label && b.textContent?.trim().startsWith(label));
    button?.click();
  }, [testId, label]);
  return <div ref={ref}>{children}</div>;
}
