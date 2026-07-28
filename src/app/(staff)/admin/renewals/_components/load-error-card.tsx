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
 */
import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

export function LoadErrorCard({
  message,
  children,
  card = true,
}: {
  readonly message: string;
  readonly children?: ReactNode;
  readonly card?: boolean;
}) {
  const content = (
    <>
      <AlertTriangle aria-hidden="true" className="h-10 w-10 text-destructive" />
      <div className="text-base font-medium text-destructive">{message}</div>
      {children}
    </>
  );
  if (!card) {
    return (
      <div
        role="alert"
        aria-live="assertive"
        className="flex flex-col items-center gap-4 py-6 text-center"
      >
        {content}
      </div>
    );
  }
  return (
    <Card>
      <CardContent
        role="alert"
        aria-live="assertive"
        className="flex flex-col items-center gap-4 py-12 text-center"
      >
        {content}
      </CardContent>
    </Card>
  );
}
