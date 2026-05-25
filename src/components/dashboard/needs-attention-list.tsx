/**
 * F9 (T033) — "Needs attention" list (FR-002). Each actionable item links to
 * the corresponding filtered list. Pure presentational server component; the
 * caller resolves labels/hrefs/counts.
 */
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export interface NeedsAttentionItem {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly count: string;
}

export function NeedsAttentionList({
  title,
  emptyLabel,
  items,
}: {
  readonly title: string;
  /** Shown when no item needs attention (all counts zero) — FR-006 "all clear". */
  readonly emptyLabel: string;
  readonly items: readonly NeedsAttentionItem[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-body text-muted-foreground">{emptyLabel}</p>
        ) : (
          <ul className="grid gap-2 text-body">
            {items.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-3">
                <Link href={item.href} className="hover:underline">
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
