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
import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from '@/lib/toast';
import { Card } from '@jirawatpyk/aura-react';
import { InsightDismissButton } from './insight-dismiss-button';

export interface InsightLine {
  readonly key: string;
  readonly text: string;
  /** Member/segment ref the insight referenced; threaded into the dismissal key. */
  readonly scopeRef?: string;
}

/** Focus target meaning "the panel title" (no insight left to land on). */
const TITLE_TARGET = '\u0000title';

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
  // WCAG 2.4.3: the dismissed row's button unmounts with it, which would drop
  // focus to <body>. Focus moves to the next insight's button, else the
  // previous one, else the panel title.
  const titleId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const focusAfterHide = useRef<string | null>(null);

  useEffect(() => {
    const target = focusAfterHide.current;
    if (target === null) return;
    focusAfterHide.current = null;
    if (target === TITLE_TARGET) {
      const heading = document.getElementById(titleId);
      heading?.setAttribute('tabindex', '-1');
      heading?.focus();
      return;
    }
    const row = Array.from(listRef.current?.querySelectorAll<HTMLLIElement>('li[data-insight-key]') ?? []).find(
      (li) => li.dataset.insightKey === target,
    );
    row?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [dismissedKeys, titleId]);

  function rollback(k: string): void {
    setDismissedKeys((prev) => {
      const next = new Set(prev);
      next.delete(k);
      return next;
    });
  }

  function onDismiss(line: InsightLine): void {
    const k = lineKey(line);
    const at = visible.findIndex((l) => lineKey(l) === k);
    const neighbour = visible[at + 1] ?? visible[at - 1];
    focusAfterHide.current = neighbour ? lineKey(neighbour) : TITLE_TARGET;
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
    <Card title={title} titleId={titleId} headingLevel={2}>
      {visible.length === 0 ? (
        <p role="status" className="aura-text-body text-[var(--aura-fg-secondary)]">
          {emptyLabel}
        </p>
      ) : (
        <ul ref={listRef} className="grid gap-[var(--aura-space-1)] aura-text-body">
          {visible.map((line) => (
            <li key={line.key} data-insight-key={lineKey(line)} className="flex items-center justify-between gap-[var(--aura-space-2)]">
              <span className="min-w-0">{line.text}</span>
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
    </Card>
  );
}
