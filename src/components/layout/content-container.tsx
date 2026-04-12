import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

type ContentContainerProps = {
  children: ReactNode;
  variant?: 'admin' | 'portal';
  fullBleed?: boolean;
  className?: string;
};

export function ContentContainer({
  children,
  variant = 'admin',
  fullBleed = false,
  className,
}: ContentContainerProps) {
  return (
    <div
      data-slot="content-container"
      data-variant={variant}
      data-full-bleed={fullBleed ? 'true' : 'false'}
      className={cn(
        'mx-auto w-full',
        !fullBleed &&
          (variant === 'portal'
            ? 'max-w-[var(--content-max-width-portal)]'
            : 'max-w-[var(--content-max-width-admin)]'),
        'px-[var(--page-padding-x)] py-[var(--page-padding-y)]',
        className,
      )}
    >
      {children}
    </div>
  );
}
