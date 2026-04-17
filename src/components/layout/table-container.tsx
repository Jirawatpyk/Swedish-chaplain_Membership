import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

type TableContainerProps = {
  children: ReactNode;
  className?: string;
};

export function TableContainer({ children, className }: TableContainerProps) {
  return (
    <div
      data-slot="layout-container"
      data-variant="table"
      className={cn(
        'mx-auto w-full max-w-[var(--layout-max-width-table)]',
        'px-[var(--page-padding-x)] py-[var(--page-padding-y)]',
        className,
      )}
    >
      {children}
    </div>
  );
}
