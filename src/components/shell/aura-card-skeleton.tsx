/**
 * Spec 122 — a loading card in AURA's Card shape: a head with skeleton bars
 * where the title and description go, the actions slot, and the body.
 *
 * AURA's `Card` renders its title as a heading, and a heading cannot hold a
 * skeleton bar (an empty, busy heading in the outline). So the head is
 * AURA's own Card markup with bars in place of the text, kept in this one
 * file. A stand-in until AURA #87 (Card head that is not a heading, or a
 * loading card). A card whose head holds real heading text takes AURA's
 * `Card` with `title` instead.
 *
 * Server-safe: no hooks, no `'use client'`.
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function AuraCardSkeleton({
  title,
  description,
  actions,
  children,
  className,
}: {
  /** Bars in the title's place. */
  readonly title?: ReactNode;
  /** Bars in the description's place, under the title. */
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
  readonly className?: string;
}) {
  // stand-in until AURA #87 (Card loading head): AURA's Card markup, by hand
  return (
    <div aria-busy="true" aria-hidden="true" className={cn('aura-card', className)}>
      {title || actions ? (
        <div className="aura-card__head">
          <div className="aura-card__heading">
            {title}
            {description ? <div className="aura-card__desc">{description}</div> : null}
          </div>
          {actions ? <div className="aura-card__actions">{actions}</div> : null}
        </div>
      ) : null}
      {children ? <div className="aura-card__body">{children}</div> : null}
    </div>
  );
}
