import * as React from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  Info,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Dashboard StatCard — label + big value + optional sub, with an
 * optional status variant. The variant is conveyed by BOTH a text
 * label and an icon (never colour alone — WCAG 1.4.1, spec §5).
 *
 * Server-safe: no `'use client'`, no hooks, pure presentation. The
 * caller supplies already-localised strings (no i18n inside the
 * primitive so it stays composable across portal surfaces).
 *
 * Heading rule (spec a11y-6): the label renders as a real `<h2>`, not
 * a CardTitle div, so the dashboard outline is h1 (PageHeader) → h2.
 *
 * The variant set is intentionally identical to the route-layer `StatVariant`
 * (dashboard-stats.ts) — the previously-declared `'ok'` member was dead (no
 * caller ever produced it; every source goes through `StatVariant` which has
 * no `'ok'`), so it was removed along with its unreachable icon/colour branches
 * (D1 review finding F1). Re-add a member here only when a caller produces it.
 */
export type StatCardVariant = 'neutral' | 'warning' | 'destructive';

const VARIANT_ICON: Record<Exclude<StatCardVariant, 'neutral'>, LucideIcon> = {
  warning: AlertTriangle,
  destructive: XCircle,
};

const VARIANT_STATUS_CLASS: Record<
  Exclude<StatCardVariant, 'neutral'>,
  string
> = {
  warning: 'text-warning',
  destructive: 'text-destructive',
};

export interface StatCardProps {
  /** Already-localised stat label. Rendered as a real `<h2>`. */
  readonly label: string;
  /** Already-localised primary value (the big number/text). */
  readonly value: React.ReactNode;
  /** Optional already-localised supporting line under the value. */
  readonly sub?: React.ReactNode;
  /** Status variant. Defaults to `neutral` (no status row). */
  readonly variant?: StatCardVariant;
  /**
   * Already-localised status text shown next to the variant icon.
   * Required to render the status row for non-neutral variants — the
   * text (not colour) is the accessible signal.
   */
  readonly variantLabel?: string;
  /**
   * Optional CTA rendered as a small button at the bottom of the card — e.g.
   * the membership card's "Renew now" link to the renewal flow when a cycle is
   * due/overdue/lapsed (067). Already-localised `label`; `href` is an internal
   * route. Omitted → no CTA (the card stays a pure stat). Keeping it IN the card
   * (vs a separate banner) avoids duplicating the status the card already shows.
   */
  readonly action?: { readonly href: string; readonly label: string };
  readonly className?: string;
}

export function StatCard({
  label,
  value,
  sub,
  variant = 'neutral',
  variantLabel,
  action,
  className,
}: StatCardProps) {
  const showStatus = variant !== 'neutral' && Boolean(variantLabel);
  const Icon = variant === 'neutral' ? Info : VARIANT_ICON[variant];

  return (
    <Card
      data-testid="stat-card"
      data-variant={variant}
      className={cn('h-full', className)}
    >
      <CardContent className="flex flex-col gap-1.5">
        <h2 className="text-caption font-medium text-muted-foreground">
          {label}
        </h2>
        <p className="text-2xl font-semibold leading-tight tabular-nums">
          {value}
        </p>
        {sub !== undefined ? (
          <p
            data-slot="stat-card-sub"
            className="text-caption text-muted-foreground"
          >
            {sub}
          </p>
        ) : null}
        {showStatus ? (
          <p
            data-testid="stat-card-status"
            className={cn(
              'mt-1 inline-flex items-center gap-1.5 text-caption font-medium',
              showStatus &&
                VARIANT_STATUS_CLASS[variant as Exclude<StatCardVariant, 'neutral'>],
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
            {variantLabel}
          </p>
        ) : null}
        {action ? (
          <Link
            href={action.href}
            className={cn(buttonVariants({ size: 'sm' }), 'mt-2 w-fit')}
          >
            {action.label}
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}
