import type { ReactNode } from 'react';
import { Container } from '@jirawatpyk/aura-react/server';

import { cn } from '@/lib/utils';

type TableContainerProps = {
  children: ReactNode;
  className?: string;
  /**
   * Pass-through ARIA busy signal — set to `"true"` on loading.tsx
   * skeleton renders so AT users hear "busy" instead of stepping
   * through every nameless Skeleton placeholder. Round-7 R2-B
   * staff-review fix (2026-05-13).
   */
  'aria-busy'?: boolean | 'true' | 'false';
};

/**
 * The table page column: AURA's `Container` widened to the 96rem (1536px) table column, the one
 * width AURA has no size for (the maintainer's decision of 2 Oct 2026), with the app's own page gutter, which steps at
 * 768 and 1024px (a utility wins under `styles.layer.css`, AURA 5.27 #131).
 * `data-slot` / `data-variant` are what `check:layout`, the e2e width specs
 * and the portal hero rule select on.
 */
export function TableContainer({
  children,
  className,
  'aria-busy': ariaBusy,
}: TableContainerProps) {
  return (
    <Container
      data-slot="layout-container"
      data-variant="table"
      aria-busy={ariaBusy}
      className={cn(
        'max-w-[var(--layout-max-width-table)]',
        'px-[var(--page-padding-x)] pt-[var(--page-padding-y)] pb-[var(--page-padding-bottom)]',
        'flex flex-col gap-[var(--page-section-gap)]',
        className,
      )}
    >
      {children}
    </Container>
  );
}
