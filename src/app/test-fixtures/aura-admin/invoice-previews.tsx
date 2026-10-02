'use client';

/**
 * 122 US8a (T808) — client previews for the invoice views that open a
 * dialog: the `Admin-record-payment` (+ `-mobile`) board is the list with the
 * issued row's "Record payment…" opened, the way an admin opens it.
 */
import { useEffect, useRef, type ReactNode } from 'react';

export function OpenFirstMatchingButton({
  testId,
  children,
}: {
  /** The trigger's `data-testid`; the first one in the subtree is clicked once. */
  readonly testId: string;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)?.click();
  }, [testId]);
  return <div ref={ref}>{children}</div>;
}
