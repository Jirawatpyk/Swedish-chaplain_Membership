'use client';

/**
 * 122 US5b-2 — one card per fieldset, as the member form boards draw it. The
 * card IS the fieldset, named by its h2 (AURA labels a titled card by its
 * title), so the group keeps an accessible name without a separate legend.
 */
import type { ReactNode } from 'react';
import { Card } from '@jirawatpyk/aura-react';

export function FormSectionCard({
  id,
  title,
  description,
  children,
}: {
  /** Prefix for the heading id (`${id}-heading`). */
  readonly id: string;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <Card
      as="fieldset"
      title={title}
      titleId={`${id}-heading`}
      headingLevel={2}
      description={description}
      // A fieldset is min-content wide by default; min-w-0 lets it shrink with
      // the column instead of pushing the page sideways on a phone.
      className="min-w-0"
    >
      {children}
    </Card>
  );
}
