'use client';

/**
 * T078 — Recent deliveries panel (F6 Phase 5 / FR-022).
 *
 * Renders up to 10 recent webhook deliveries (audit-derived). Default
 * filters out `processing_outcome = 'short_circuited_test'` rows per
 * round-2 R5 so live Zapier traffic isn't crowded out by test webhooks.
 * Switch toggle to include test deliveries.
 *
 * Each row shows: received-at relative time + request ID excerpt +
 * signature-outcome badge + processing-outcome badge + matched member.
 *
 * Empty state renders when no rows match the current filter.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { RelativeTime } from '@/components/ui/relative-time';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  KNOWN_RECENT_PROCESSING_OUTCOMES,
  type RecentDelivery,
  type RecentDeliveryProcessingOutcome,
} from '@/lib/events-admin-integration-types';

/**
 * Round-6 verify-fix 2026-05-13 (type-design C3) — Component now
 * consumes the canonical `RecentDelivery` type from the composition
 * adapter directly, eliminating the previously-duplicated
 * `RecentDeliveryRow` interface. Single source of truth for the row
 * shape — a refactor on the adapter side surfaces TS errors at the UI
 * consumer instead of relying on structural compatibility (which
 * succeeded until either side added a new field).
 */
export interface RecentDeliveriesPanelProps {
  readonly deliveries: ReadonlyArray<RecentDelivery>;
  readonly includeTestDeliveries: boolean;
}

function signatureBadgeVariant(
  outcome: RecentDelivery['signatureOutcome'],
): 'default' | 'destructive' | 'secondary' {
  if (outcome === 'verified') return 'default';
  if (outcome === 'rejected') return 'destructive';
  return 'secondary';
}

function processingBadgeVariant(
  outcome: RecentDeliveryProcessingOutcome | null,
): 'default' | 'destructive' | 'secondary' | 'outline' {
  if (!outcome) return 'outline';
  if (outcome === 'short_circuited_test') return 'secondary';
  if (
    outcome === 'matched_member_contact' ||
    outcome === 'matched_member_domain' ||
    outcome === 'matched_member_fuzzy'
  ) {
    return 'default';
  }
  if (outcome === 'non_member' || outcome === 'unmatched') return 'secondary';
  if (outcome === 'rolled_back' || outcome === 'malformed') return 'destructive';
  return 'outline';
}

export function RecentDeliveriesPanel({
  deliveries,
  includeTestDeliveries,
}: RecentDeliveriesPanelProps) {
  const t = useTranslations(
    'admin.integrations.eventcreate.phaseC.recentDeliveries',
  );
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [optimisticInclude, setOptimisticInclude] = useState(
    includeTestDeliveries,
  );

  function handleToggle(next: boolean) {
    setOptimisticInclude(next);
    // Round 3 M-err-6 (2026-05-13) — keep a narrow try/catch around
    // `new URL(window.location.href)`. In a real browser the throw is
    // unreachable, but Playwright fixtures / Sentry session-replay /
    // tenant-specific service workers can shim `window.location` —
    // an unwrapped throw inside `startTransition` would propagate to
    // a React render-phase error and unmount the entire Phase C
    // panel. Catch + console.error preserves the panel and surfaces
    // the shim mismatch to DevTools so the cause is debuggable.
    startTransition(() => {
      try {
        const url = new URL(window.location.href);
        if (next) {
          url.searchParams.set('includeTestDeliveries', 'true');
        } else {
          url.searchParams.delete('includeTestDeliveries');
        }
        router.replace(url.pathname + url.search);
      } catch (e) {
        console.error(
          '[F6] recent-deliveries toggle navigation failed',
          e,
        );
      }
    });
  }

  return (
    <section className="space-y-3" aria-labelledby="recent-deliveries-heading">
      <header className="flex items-center justify-between gap-3">
        <h2
          id="recent-deliveries-heading"
          className="text-h3 font-semibold"
        >
          {t('title')}
        </h2>
        <div className="flex items-center gap-2">
          {/* Accessible name comes from the sibling `<Label htmlFor>`. */}
          <Switch
            id="include-test-deliveries"
            checked={optimisticInclude}
            onCheckedChange={handleToggle}
            disabled={pending}
          />
          <Label
            htmlFor="include-test-deliveries"
            className="cursor-pointer text-sm"
          >
            {t('includeTestDeliveriesLabel')}
          </Label>
        </div>
      </header>

      {/*
        Round 2 MED-07 fix (2026-05-13) — `aria-live="polite"` moved
        OFF the `<ul>` to a dedicated `<span role="status">` summary
        below. The previous wiring caused VoiceOver/NVDA to re-announce
        every visible row (up to 10 rows × 3 badge labels) on every
        filter toggle — extremely verbose. The summary span announces
        only the row-count delta, which is the meaningful change.
        `aria-busy={pending}` is retained on the `<ul>` so AT
        suppresses any sub-tree announcements during the transition.
      */}
      <span role="status" aria-live="polite" className="sr-only">
        {pending
          ? t('updating')
          : t('listSummary', { count: deliveries.length })}
      </span>

      {deliveries.length === 0 ? (
        <p className="rounded-md border border-dashed bg-muted/40 p-6 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <ul
          className="divide-y rounded-md border"
          aria-busy={pending}
        >
          {deliveries.map((row) => (
            <li
              key={`${row.receivedAt}-${row.requestId}`}
              className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex flex-col gap-1">
                <RelativeTime iso={row.receivedAt} className="text-xs text-muted-foreground" />
                <code className="font-mono text-xs text-muted-foreground">
                  {row.requestId.slice(0, 12)}
                  {row.requestId.length > 12 ? '…' : ''}
                </code>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={signatureBadgeVariant(row.signatureOutcome)}>
                  {t(`signature.${row.signatureOutcome}`)}
                </Badge>
                {row.processingOutcome ? (
                  <Badge variant={processingBadgeVariant(row.processingOutcome)}>
                    {KNOWN_RECENT_PROCESSING_OUTCOMES.has(row.processingOutcome)
                      ? t(`processing.${row.processingOutcome}`)
                      : row.processingOutcome}
                  </Badge>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
