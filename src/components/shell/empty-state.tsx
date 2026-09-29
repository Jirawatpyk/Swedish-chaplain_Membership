/**
 * EmptyState — informational placeholder for empty lists (T048,
 * ux-standards § 3.1).
 *
 * Renders an icon, title, optional description, and an optional CTA
 * action. Used by F1's account lifecycle UI (T135) and by every list
 * surface in later phases.
 */
import { EmptyState as AuraEmptyState } from '@jirawatpyk/aura-react/server';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

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
   * AURA's empty-state icon colour (unchanged for every existing consumer). Lets a
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
  // Spec 122 — AURA's EmptyState (#86, 5.14): the title stays a <p>
  // (`headingLevel={false}`) so no page's outline changes, and `announce`
  // decides the status role, which AURA leaves to the caller. Without an
  // icon AURA draws its default inbox icon.
  return (
    <AuraEmptyState
      data-testid={dataTestId}
      role={announce ? 'status' : undefined}
      className={className}
      bordered={bordered}
      headingLevel={false}
      icon={Icon ? <Icon className={iconClassName} aria-hidden /> : undefined}
      title={title}
      description={description}
      action={action}
    />
  );
}
