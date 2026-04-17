import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

type DetailContainerProps = {
  children: ReactNode;
  className?: string;
};

export function DetailContainer({ children, className }: DetailContainerProps) {
  return (
    <div
      data-slot="layout-container"
      data-variant="detail"
      className={cn(
        'mx-auto w-full max-w-[var(--layout-max-width-detail)]',
        'px-[var(--page-padding-x)] py-[var(--page-padding-y)]',
        className,
      )}
    >
      {children}
    </div>
  );
}
