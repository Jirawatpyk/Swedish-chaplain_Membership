/**
 * F9 (T033) — "Needs attention" list (FR-002). Each actionable item links to
 * the corresponding filtered list. Pure presentational server component; the
 * caller resolves labels/hrefs/counts.
 */
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InlineAlert } from '@/components/ui/inline-alert';

export interface NeedsAttentionItem {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly count: string;
}

/**
 * One source of a count that could NOT be read this render (F114 PR-3 review,
 * reliability R-H2). The list drops items whose count is zero, so a failed
 * read is indistinguishable from "nothing to do" — and "All clear" is the one
 * answer the operator must never be given about a number we do not have.
 * Rendered as the house section-failure shape (UX I9): `role="status"` (the
 * page rendered, one section did not — no interruption) with a destructive
 * tone, and it SUPPRESSES the all-clear state while it is present.
 */
export interface NeedsAttentionUnavailable {
  readonly id: string;
  readonly label: string;
}

export function NeedsAttentionList({
  title,
  emptyLabel,
  items,
  unavailable = [],
}: {
  readonly title: string;
  /** Shown when no item needs attention (all counts zero) — FR-006 "all clear". */
  readonly emptyLabel: string;
  readonly items: readonly NeedsAttentionItem[];
  /** Sources whose count could not be read — never folded into `items`. */
  readonly unavailable?: readonly NeedsAttentionUnavailable[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className={unavailable.length > 0 ? 'grid gap-3' : undefined}>
        {unavailable.map((u) => (
          <InlineAlert
            key={u.id}
            tone="destructive"
            role="status"
            data-testid={`needs-attention-${u.id}-unavailable`}
          >
            <p className="text-sm">{u.label}</p>
          </InlineAlert>
        ))}
        {items.length === 0 ? (
          // Suppressed while anything is unavailable: an all-clear next to a
          // failed read is a claim the page cannot make.
          unavailable.length > 0 ? null : (
            <p role="status" className="text-body text-muted-foreground">
              {emptyLabel}
            </p>
          )
        ) : (
          <ul className="grid gap-2 text-body">
            {items.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-3">
                <Link
                  href={item.href}
                  className="rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                >
                  {item.label}
                </Link>
                <span className="tabular-nums font-medium">{item.count}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
