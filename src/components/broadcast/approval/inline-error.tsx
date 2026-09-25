/**
 * F119 T063 / T064 UX review — the one inline refusal line the approval
 * surfaces render (ux-standards § 4.1: below the field, `text-sm
 * text-destructive`, a `<CircleAlert />`, announced by `role="alert"` on first
 * appearance).
 *
 * Callers mount it only while there is a message and clear it at the start of
 * every request, so a repeated refusal is a NEW node and is announced again —
 * a live region whose text does not change says nothing.
 *
 * `tabIndex={-1}` makes it a programmatic focus target (§ 6.4 — "surfaced
 * inline, role=alert, focused") for a refusal that has no field to focus, or
 * whose field exposes no focusable handle; it stays out of the Tab order.
 */
import { CircleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface InlineErrorProps {
  readonly id: string;
  readonly message: string;
  readonly className?: string;
  readonly 'data-testid'?: string;
}

export function InlineError({ id, message, className, ...rest }: InlineErrorProps): React.ReactElement {
  return (
    <p
      id={id}
      role="alert"
      tabIndex={-1}
      className={cn('flex items-start gap-1.5 text-sm text-destructive', className)}
      {...rest}
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </p>
  );
}
