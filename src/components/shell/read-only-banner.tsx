'use client';

/**
 * The read-only note shown to a viewer who can browse a surface but not
 * change it (the manager on members / broadcasts / marketing audience).
 * One component so every surface says it the same way (108 PR-D review M8).
 *
 * No `aria-label` on the note: it would equal the visible text and a screen
 * reader would announce the region name AND its content (double-announce).
 * The visible `<p>` is the region's accessible content.
 */
import { InfoIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export function ReadOnlyBanner({
  children,
  className,
  ...rest
}: React.ComponentProps<'div'>): React.ReactElement {
  return (
    <div
      role="note"
      className={cn(
        'flex items-start gap-3 rounded-md border border-border bg-muted/40 px-4 py-3 text-sm',
        className,
      )}
      {...rest}
    >
      <InfoIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <p className="text-muted-foreground">{children}</p>
    </div>
  );
}
