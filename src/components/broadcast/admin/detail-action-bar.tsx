'use client';

import { ActionBar } from '@jirawatpyk/aura-react';
import { cn } from '@/lib/utils';
import { DetailMoreMenu, DetailMoreMenuProvider } from './detail-more-menu';

/**
 * Spec 122 US12c-1 — the staff E-Blast detail page's action row (board
 * `Admin-broadcast-review`, maintainer 19 Oct): AURA's action bar, the
 * destructive actions (Cancel, Reject) in `start` and the next step (Start,
 * Schedule, Approve) at its end. The app's `chamber-viewport-actionbar` pins it
 * to the bottom of the screen on a phone (`Admin-broadcast-review-mobile`);
 * from 640px it is a plain row at the end of the page (`globals.css`).
 *
 * Below 640px the secondary actions fold into one ⋯ (`detail-more-menu`,
 * parity comment 20 Oct), so the bar holds one line: Reject, the next step, ⋯.
 *
 * The wrapper is `display: contents`, so the test id rides on the page without
 * becoming the sticky bar's containing block — the bar sticks within the page.
 */
export function DetailActionBar({
  start,
  moreLabel,
  status,
  className,
  children,
}: {
  readonly start?: React.ReactNode;
  /** The ⋯ menu's name ("More actions"). */
  readonly moreLabel: string;
  readonly className?: string | undefined;
  /** The phone status line (recipients · audience · time in stage); hidden from 640px. */
  readonly status?: React.ReactNode;
  readonly children?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="contents" data-testid="eblast-action-row">
      <DetailMoreMenuProvider>
        <ActionBar edgeBelow="sm" className={cn('chamber-viewport-actionbar eblast-detail-actions', className)} start={start} status={status}>
          {children}
          <DetailMoreMenu label={moreLabel} />
        </ActionBar>
      </DetailMoreMenuProvider>
    </div>
  );
}
