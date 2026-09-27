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
        'px-[var(--page-padding-x)] pt-[var(--page-padding-y)] pb-[var(--page-padding-bottom)]',
        'flex flex-col gap-[var(--page-section-gap)]',
        className,
      )}
    >
      {children}
    </div>
  );
}
