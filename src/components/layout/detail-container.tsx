import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

type DetailContainerProps = {
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

export function DetailContainer({
  children,
  className,
  'aria-busy': ariaBusy,
}: DetailContainerProps) {
  return (
    <div
      data-slot="layout-container"
      data-variant="detail"
      aria-busy={ariaBusy}
      className={cn(
        'mx-auto w-full max-w-[var(--layout-max-width-detail)]',
        'px-[var(--page-padding-x)] py-[var(--page-padding-y)]',
        'flex flex-col gap-[var(--page-section-gap)]',
        className,
      )}
    >
      {children}
    </div>
  );
}
