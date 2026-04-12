import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

type ContentContainerProps = {
  children: ReactNode;
  variant?: 'admin' | 'portal';
  fullBleed?: boolean;
  className?: string;
};

const MAX_WIDTH_BY_VARIANT = {
  admin: 'max-w-[var(--content-max-width-admin)]',
  portal: 'max-w-[var(--content-max-width-portal)]',
} as const;

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
      data-full-bleed={String(fullBleed)}
      className={cn(
        'mx-auto w-full',
        !fullBleed && MAX_WIDTH_BY_VARIANT[variant],
        'px-[var(--page-padding-x)] py-[var(--page-padding-y)]',
        className,
      )}
    >
      {children}
    </div>
  );
}
