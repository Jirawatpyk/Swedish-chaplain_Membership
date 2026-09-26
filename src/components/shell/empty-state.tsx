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
  /**
   * When false, render without the dashed-border box chrome (just centred
   * icon + copy) — for use INSIDE a Card/section that already supplies the
   * surface, avoiding a double border. Defaults to true (standalone bordered
   * placeholder, the original behaviour).
   */
  readonly bordered?: boolean;
  /**
   * Fix round 1 M-3 — override the icon's colour class. Defaults to
   * `text-muted-foreground` (unchanged for every existing consumer). Lets a
   * deliberate positive-affirmation empty state (e.g. the at-risk widget's
   * "no one at risk" `ShieldCheck`) keep its `text-success` green after
   * routing through this shared primitive.
   */
  readonly iconClassName?: string;
  /** Optional test hook (e.g. list-empty E2E assertions). */
  readonly 'data-testid'?: string;
  /**
   * When false, the placeholder is NOT a `role="status"` live region. For a
   * list that already owns one announcer and must not gain a second (the E-Blast
   * queue, FR-025): it announces the empty view itself. Defaults to true
   * (unchanged for every existing consumer).
   */
  readonly announce?: boolean;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  bordered = true,
  iconClassName,
  'data-testid': dataTestId,
  announce = true,
}: EmptyStateProps) {
  // Spec 122 US1 — AURA's EmptyState markup (its classes, so its spacing,
  // tint and dashed edge), drawn here rather than imported: this is a server
  // component, and server files never import AURA (docs/aura-adoption.md).
  // The title stays a <p>, not AURA's heading, so no page's outline changes.
  return (
    <div
      data-testid={dataTestId}
      className={cn('aura-empty', bordered && 'is-bordered', className)}
      role={announce ? 'status' : undefined}
    >
      {Icon ? (
        <span className="aura-empty__icon" aria-hidden>
          <Icon className={cn('size-6', iconClassName)} aria-hidden />
        </span>
      ) : null}
      <p className="aura-empty__title">{title}</p>
      {description ? <p className="aura-empty__text">{description}</p> : null}
      {action ? <div className="aura-empty__action">{action}</div> : null}
    </div>
  );
}
