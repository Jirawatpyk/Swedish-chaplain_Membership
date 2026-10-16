/**
 * F9 (T033) — "Needs attention" list (FR-002). Each actionable item links to
 * the corresponding filtered list. Pure presentational server component; the
 * caller resolves labels/hrefs/counts.
 */
import Link from 'next/link';
import { Alert, Badge, Card } from '@jirawatpyk/aura-react/server';

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
 * Rendered as the house section-failure shape (UX I9): an AURA danger alert
 * with `role="status"` (the page rendered, one section did not — no
 * interruption), and it SUPPRESSES the all-clear state while it is present.
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
  // Spec 122 US11: an AURA card; each count is an AURA badge (pill) beside its
  // row link, as the board draws it. Numbers and hrefs are unchanged.
  return (
    <Card title={title} headingLevel={2}>
      <div className="grid gap-[var(--aura-space-3)]">
        {unavailable.map((u) => (
          <Alert
            key={u.id}
            tone="danger"
            role="status"
            data-testid={`needs-attention-${u.id}-unavailable`}
          >
            {u.label}
          </Alert>
        ))}
        {items.length === 0 ? (
          // Suppressed while anything is unavailable: an all-clear next to a
          // failed read is a claim the page cannot make.
          unavailable.length > 0 ? null : (
            <p role="status" className="aura-text-body text-[var(--aura-fg-secondary)]">
              {emptyLabel}
            </p>
          )
        ) : (
          <ul className="grid gap-[var(--aura-space-1)] aura-text-body">
            {items.map((item) => (
              <li key={item.id} className="flex min-h-9 items-center justify-between gap-[var(--aura-space-3)]">
                <Link href={item.href} className="min-w-0 text-[var(--aura-fg-primary)] underline-offset-4 hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center">
                  {item.label}
                </Link>
                <Badge tone="accent">{item.count}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
