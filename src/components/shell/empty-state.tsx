/**
 * EmptyState — informational placeholder for empty lists (T048,
 * ux-standards § 3.1).
 *
 * Renders an icon, title, optional description, and an optional CTA
 * action. Used by F1's account lifecycle UI (T135) and by every list
 * surface in later phases.
 */
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface EmptyStateProps {
  readonly icon?: LucideIcon;
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border p-12 text-center',
        className,
      )}
      role="status"
    >
      {Icon ? (
        <Icon className="size-10 text-muted-foreground" aria-hidden />
      ) : null}
      <div className="space-y-1">
        <p className="text-base font-medium">{title}</p>
        {description ? (
          <p className="max-w-md text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
