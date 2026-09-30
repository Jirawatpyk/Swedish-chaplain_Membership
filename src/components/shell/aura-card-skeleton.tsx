/**
 * Spec 122 — a loading card in AURA's Card shape: skeleton bars where the
 * title and description go, the actions slot, and the body.
 *
 * AURA's `Card` renders `title` as a heading, and a heading cannot hold a
 * skeleton bar (an empty, busy heading in the outline), so the bars go in
 * AURA's free head, `header` (#87, 5.15), which adds no heading. A card whose
 * head holds real heading text takes AURA's `Card` with `title` instead.
 *
 * Server-safe: no hooks, no `'use client'`.
 */
import { Card } from '@jirawatpyk/aura-react/server';
import type { HTMLAttributes, ReactNode } from 'react';

export function AuraCardSkeleton({
  title,
  description,
  actions,
  children,
  className,
  ...rest
}: Omit<HTMLAttributes<HTMLDivElement>, 'title'> & {
  /** Bars in the title's place. */
  readonly title?: ReactNode;
  /** Bars in the description's place, under the title. */
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
  readonly className?: string;
}) {
  return (
    <Card
      {...rest}
      as="div"
      className={className}
      actions={actions}
      header={
        title || description ? (
          <>
            {title}
            {/* 2px: AURA's gap between a card title and its description */}
            {description ? <div className="mt-0.5">{description}</div> : null}
          </>
        ) : undefined
      }
    >
      {children}
    </Card>
  );
}
