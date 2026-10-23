/**
 * 124 US5 — the states a dashboard card can be in besides its figures: the
 * skeleton its Suspense island shows (at the loaded card's height, so nothing
 * jumps), the one-card failure (US5.3: that card alone, with its reference id
 * and Try again; the others render), and "No invoices match these filters"
 * (US3.5: a filter that matches nothing is the card's own zero, never the
 * page-level empty state).
 */
import { Card, EmptyState } from '@jirawatpyk/aura-react/server';
import { SkeletonBlock } from '@/components/shell/page-skeletons';
import { TryAgainButton } from './try-again-button';

export interface CardErrorCopy {
  readonly title: string;
  readonly description: string;
  readonly tryAgain: string;
}

export function CardError({ copy }: { readonly copy: CardErrorCopy }) {
  return (
    <EmptyState
      tone="danger"
      size="sm"
      icon="circle-alert"
      headingLevel={false}
      title={copy.title}
      description={copy.description}
      action={<TryAgainButton label={copy.tryAgain} />}
      data-testid="dashboard-card-error"
    />
  );
}

export function NoMatch({ label }: { readonly label: string }) {
  return (
    <p data-testid="dashboard-no-match" className="m-0 py-[var(--aura-space-4)] text-sm text-[var(--aura-fg-secondary)]">
      {label}
    </p>
  );
}

/** One skeleton bar per entry, `[width, height]` in px (or a CSS width). */
type Bars = readonly (readonly [number | string, number])[];

const SKELETONS = {
  aging: [[240, 22], ['100%', 24], ['100%', 24], ['100%', 24], ['100%', 24], ['100%', 24], [260, 18]],
  attention: [['100%', 24], ['100%', 24], ['100%', 24], ['100%', 24], ['100%', 24]],
  oldestOverdue: [['100%', 28], ['100%', 28], ['100%', 28], ['100%', 28], ['100%', 28], ['100%', 28]],
  trend: [[360, 48], ['100%', 220], [320, 18]],
  methods: [['100%', 20], ['100%', 20], ['100%', 20], ['100%', 20], ['100%', 20], ['100%', 20], ['100%', 36]],
} as const satisfies Record<string, Bars>;

export type DashboardCardKind = keyof typeof SKELETONS;

export function CardSkeleton({
  kind,
  title,
  description,
}: {
  readonly kind: DashboardCardKind;
  readonly title: string;
  readonly description?: string;
}) {
  return (
    <Card title={title} headingLevel={2} {...(description ? { description } : {})} aria-busy="true">
      <div className="flex flex-col gap-[var(--aura-space-3)]">
        {SKELETONS[kind].map(([width, height], i) => (
          <SkeletonBlock key={i} style={{ width, height, maxWidth: '100%' }} />
        ))}
      </div>
    </Card>
  );
}
