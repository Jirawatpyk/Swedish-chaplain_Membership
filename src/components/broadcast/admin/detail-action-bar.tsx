'use client';

import { ActionBar } from '@jirawatpyk/aura-react';

/**
 * Spec 122 US12c-1 — the staff E-Blast detail page's action row (board
 * `Admin-broadcast-review`, maintainer 19 Oct): AURA's action bar, the
 * destructive actions (Cancel, Reject) in `start` and the next step (Start,
 * Schedule, Approve) at its end. The app's `chamber-viewport-actionbar` pins it
 * to the bottom of the screen on a phone (`Admin-broadcast-review-mobile`);
 * from 640px it is a plain row at the end of the page (`globals.css`).
 *
 * The wrapper is `display: contents`, so the test id rides on the page without
 * becoming the sticky bar's containing block — the bar sticks within the page.
 */
export function DetailActionBar({
  start,
  children,
}: {
  readonly start?: React.ReactNode;
  readonly children?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="contents" data-testid="eblast-action-row">
      <ActionBar className="chamber-viewport-actionbar eblast-detail-actions" start={start} touchHeight>
        {children}
      </ActionBar>
    </div>
  );
}
