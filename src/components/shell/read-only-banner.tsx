/**
 * The read-only note shown to a viewer who can browse a surface but not
 * change it (the manager on members / broadcasts / marketing audience).
 * One component so every surface says it the same way (108 PR-D review M8).
 *
 * No `aria-label` on the note: it would equal the visible text and a screen
 * reader would announce the region name AND its content (double-announce).
 * The visible text is the region's accessible content.
 *
 * PR O — AURA's Alert (info tone) as a `note`, so it is not a live region;
 * from `/server`, so it renders in either tree.
 */
import type * as React from 'react';
import { Alert } from '@jirawatpyk/aura-react/server';

export function ReadOnlyBanner({
  children,
  className,
  ...rest
}: Omit<React.ComponentProps<'div'>, 'role' | 'title'>): React.ReactElement {
  return (
    <Alert tone="info" role="note" {...(className ? { className } : {})} {...rest}>
      {children}
    </Alert>
  );
}
