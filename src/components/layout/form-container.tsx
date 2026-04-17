import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

type FormContainerProps = {
  children: ReactNode;
  className?: string;
};

export function FormContainer({ children, className }: FormContainerProps) {
  return (
    <div
      data-slot="layout-container"
      data-variant="form"
      className={cn(
        'mx-auto w-full max-w-[var(--layout-max-width-form)]',
        'px-[var(--page-padding-x)] py-[var(--page-padding-y)]',
        className,
      )}
    >
      {children}
    </div>
  );
}
