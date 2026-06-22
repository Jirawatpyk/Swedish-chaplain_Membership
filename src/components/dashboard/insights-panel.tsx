'use client';

/**
 * F9 (T033) — Smart-insights panel (FR-004). Renders the dismissal-filtered
 * insight lines (each with a dismiss control), or a friendly empty state. The
 * caller resolves each line to a localised string + the dismiss labels.
 *
 * Optimistic dismiss: clicking a line hides it on the same tick (local key set)
 * then POSTs. The server re-render that `router.refresh()` triggers takes ~2-5s
 * (snapshot + insights + feed + charts), so without the optimistic hide the card
 * lingers and the click feels dead. A FAILED POST rolls the key back out so the
 * insight returns + an error toast fires. The fetch lives HERE (not in the
 * button) because the optimistic hide unmounts the button immediately — the
 * panel stays mounted for the whole request. The server re-render remains the
 * source of truth; the local keys only bridge the refresh gap.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InsightDismissButton } from './insight-dismiss-button';

export interface InsightLine {
  readonly key: string;
  readonly text: string;
  /** Member/segment ref the insight referenced; threaded into the dismissal key. */
  readonly scopeRef?: string;
}

/** Composite identity (matches the dismissal's (insightKey, scopeRef) tuple). */
function lineKey(line: InsightLine): string {
  return line.scopeRef !== undefined ? `${line.key}::${line.scopeRef}` : line.key;
}

export function InsightsPanel({
  title,
  emptyLabel,
  dismissLabel,
  dismissedLabel,
  dismissErrorLabel,
  lines,
}: {
  readonly title: string;
  readonly emptyLabel: string;
  readonly dismissLabel: string;
  readonly dismissedLabel: string;
  readonly dismissErrorLabel: string;
  readonly lines: readonly InsightLine[];
}) {
  const router = useRouter();
  const [dismissedKeys, setDismissedKeys] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const visible = lines.filter((line) => !dismissedKeys.has(lineKey(line)));

  function rollback(k: string): void {
    setDismissedKeys((prev) => {
      const next = new Set(prev);
      next.delete(k);
      return next;
    });
  }

  function onDismiss(line: InsightLine): void {
    const k = lineKey(line);
    // Optimistic hide on the same tick as the click.
    setDismissedKeys((prev) => new Set(prev).add(k));
    void (async () => {
      try {
        const res = await fetch('/api/admin/insights/dismiss', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            insightKey: line.key,
            ...(line.scopeRef !== undefined ? { scopeRef: line.scopeRef } : {}),
          }),
        });
        if (!res.ok) {
          rollback(k);
          toast.error(dismissErrorLabel);
          return;
        }
        toast.success(dismissedLabel);
        // Reconcile with the server (the suppressed insight drops from the
        // freshly-computed panel; the optimistic key already covers the gap).
        router.refresh();
      } catch {
        rollback(k);
        toast.error(dismissErrorLabel);
      }
    })();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {visible.length === 0 ? (
          <p role="status" className="text-body text-muted-foreground">
            {emptyLabel}
          </p>
        ) : (
          <ul className="grid gap-2 text-body">
            {visible.map((line) => (
              <li key={line.key} className="flex items-center justify-between gap-2">
                <span>{line.text}</span>
                <InsightDismissButton
                  // Compose a UNIQUE accessible name per insight (WCAG 2.4.6 /
                  // voice-control): "Dismiss insight: <the insight text>".
                  label={`${dismissLabel}: ${line.text}`}
                  onClick={() => onDismiss(line)}
                />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
