import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

type PageHeaderProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  badge?: ReactNode;
  className?: string;
};

/**
 * Margin/padding use CSS logical properties so this renders correctly
 * in both LTR and future RTL locales without any changes at the call
 * site.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  badge,
  className,
}: PageHeaderProps) {
  return (
    <header
      data-slot="page-header"
      className={cn(
        '[margin-block-end:var(--page-header-gap)] flex flex-wrap items-start justify-between gap-3',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h1 data-slot="page-header-title" className="text-h1 text-foreground">
            {title}
          </h1>
          {badge}
        </div>
        {subtitle ? (
          // <div> (not <p>) because `subtitle` is typed `ReactNode` and
          // callers pass arbitrary elements (e.g. <SkeletonBlock> = a
          // <div>) from `loading.tsx`. A <p> with a <div> descendant
          // breaks HTML validity and triggers a React 19 hydration
          // error.
          <div
            data-slot="page-header-subtitle"
            className="[margin-block-start:0.25rem] text-body text-muted-foreground"
          >
            {subtitle}
          </div>
        ) : null}
      </div>
      {actions ? (
        <div
          data-slot="page-header-actions"
          className="flex flex-wrap items-center gap-2"
        >
          {actions}
        </div>
      ) : null}
    </header>
  );
}
