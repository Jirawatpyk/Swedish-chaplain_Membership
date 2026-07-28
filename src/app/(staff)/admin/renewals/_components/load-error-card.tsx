/**
 * `LoadErrorCard` — shared "couldn't load" chrome for the `/admin/renewals`
 * pipeline sub-cards (Task 8).
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
import { AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

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
  const content = (
    <>
      <AlertTriangle
        aria-hidden="true"
        className={isMuted ? 'h-10 w-10 text-muted-foreground' : 'h-10 w-10 text-destructive'}
      />
      <div
        className={
          isMuted
            ? 'text-base font-medium text-muted-foreground'
            : 'text-base font-medium text-destructive'
        }
      >
        {message}
      </div>
      {children}
    </>
  );
  const role = isMuted ? 'status' : 'alert';
  const ariaLive = isMuted ? 'polite' : 'assertive';
  if (!card) {
    return (
      <div
        role={role}
        aria-live={ariaLive}
        className="flex flex-col items-center gap-4 py-6 text-center"
      >
        {content}
      </div>
    );
  }
  return (
    <Card>
      <CardContent
        role={role}
        aria-live={ariaLive}
        className="flex flex-col items-center gap-4 py-12 text-center"
      >
        {content}
      </CardContent>
    </Card>
  );
}
