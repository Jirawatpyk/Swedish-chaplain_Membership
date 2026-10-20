'use client';

import { useState } from 'react';
import { useBreakpoint } from '@jirawatpyk/aura-react';

/**
 * Spec 122 US12c-1 (maintainer, 19 Oct — board `Admin-eblast-design-mobile`):
 * where the version and the member's original stack (below `lg`), the original
 * folds into a disclosure so the version stays near the top of the page.
 *
 * It is ONE `<details>` at every width, open from `lg` with its summary hidden,
 * so the original's sandboxed preview frame is mounted once and is never
 * remounted when the width changes. The server renders it open (`useBreakpoint`
 * reads `lg` there); a phone folds it once it has hydrated.
 */
export function OriginalDisclosure({
  summary,
  children,
}: {
  readonly summary: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  const breakpoint = useBreakpoint();
  const stacked = breakpoint === 'base' || breakpoint === 'sm' || breakpoint === 'md';
  const [open, setOpen] = useState(!stacked);
  const [foldedFor, setFoldedFor] = useState(stacked);

  // Each change of layout resets the fold, during render rather than in an
  // effect: closed where the cards stack, open where they sit side by side
  // (the summary is hidden there, so it could not be reopened).
  if (foldedFor !== stacked) {
    setFoldedFor(stacked);
    setOpen(!stacked);
  }

  return (
    <details
      data-testid="eblast-original-disclosure"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="min-w-0 lg:h-full"
    >
      <summary className="flex min-h-11 cursor-pointer items-center rounded-[var(--aura-radius-md)] border border-[var(--aura-border-default)] bg-[var(--aura-bg-surface)] px-4 text-sm font-medium lg:hidden">
        {summary}
      </summary>
      <div className="max-lg:mt-3 h-full">{children}</div>
    </details>
  );
}
