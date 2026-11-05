/**
 * `LoadErrorCard` — the ONE "couldn't load" chrome for staff surfaces. Born on
 * the `/admin/renewals` pipeline sub-cards (Task 8); promoted to the shell so
 * the audit log, invoices list and invoice payment-activity panel render a
 * load FAILURE with the same skin instead of a benign empty/invalid state
 * (admin design review). Pair with `ErrorCardActions` for retry / go back /
 * reference id.
 *
 * Extracted from the page-local copy (which the pipeline load-failure + the
 * pending-review load-failure already used) so every best-effort sub-card —
 * the members-without-cycle tray, the at-risk widget's error branch — renders
 * ONE error skin. `role="alert"` + `aria-live="assertive"` announce the
 * failure to screen readers (WCAG SC 4.1.3); the optional `children` slot
 * carries retry / go-back actions below the message.
 *
 * `card` (default `true`) mirrors `EmptyState`'s `bordered` escape hatch: the
 * bare variant (`card={false}`) drops the `<Card>` wrapper for use INSIDE an
 * existing Card/panel (e.g. the at-risk widget's own card), avoiding a
 * nested-card double border. Framework-free (no `'use client'`, no server-only
 * imports) so it renders in both server and client trees.
 *
 * Fix round 1 I-2 — `tone` (default `'destructive'`, byte-unchanged for every
 * existing consumer) adds a `'muted'` variant for auxiliary, non-blocking
 * surfaces where the loud red `role="alert"` + `aria-live="assertive"` skin is
 * disproportionate (e.g. one KPI band failing on an otherwise-working page).
 * `'muted'` swaps the destructive red for `text-muted-foreground` and the
 * announcement to `role="status"` / `aria-live="polite"` — a proportional,
 * non-interrupting "couldn't load" notice instead of a page-level alarm.
 */
import type { ReactNode } from 'react';
import { Card, EmptyState } from '@jirawatpyk/aura-react/server';

/*
 * PR O — AURA's EmptyState (from `/server`, so either tree): the danger tone
 * for `destructive`, the neutral one for `muted`; `bordered` is the `card`
 * flag (the old Card frame); the message is a paragraph, not a heading, so a
 * page's outline doesn't change; `children` (retry / go back) are its action.
 */
export function LoadErrorCard({
  message,
  children,
  card = true,
  tone = 'destructive',
}: {
  readonly message: string;
  readonly children?: ReactNode;
  readonly card?: boolean;
  readonly tone?: 'destructive' | 'muted';
}) {
  const isMuted = tone === 'muted';
  const state = (
    <EmptyState
      tone={isMuted ? 'neutral' : 'danger'}
      // A neutral bordered EmptyState is dashed (an empty or drop zone), so a
      // muted failure keeps the solid Card frame instead (UX review M4); the
      // bare variant sits in its parent panel at the small size.
      bordered={card && !isMuted}
      {...(card ? {} : { size: 'sm' as const })}
      icon="triangle-alert"
      headingLevel={false}
      role={isMuted ? 'status' : 'alert'}
      aria-live={isMuted ? 'polite' : 'assertive'}
      title={message}
      // AURA lays actions out in a row; ErrorCardActions is the buttons then
      // the reference id, which reads under them (UX review M2).
      {...(children ? { action: <div className="flex flex-col items-center gap-4">{children}</div> } : {})}
    />
  );
  return card && isMuted ? <Card as="div">{state}</Card> : state;
}
