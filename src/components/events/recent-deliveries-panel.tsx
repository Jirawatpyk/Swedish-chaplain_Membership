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
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { RelativeTime } from '@/components/ui/relative-time';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import type {
  RecentDelivery,
  RecentDeliveryProcessingOutcome,
} from '@/lib/events-admin-integration-deps';

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

/**
 * Closed set of processing-outcome values that have a corresponding
 * `processing.<value>` i18n key in `en/th/sv.json`. Any value outside
 * this set (including the receiver-side `'unknown'` discriminator)
 * falls back to rendering the raw string verbatim — UI never crashes
 * on a receiver-side enum extension.
 *
 * MUST stay aligned with the keys under
 * `admin.integrations.eventcreate.phaseC.recentDeliveries.processing`
 * — add a new entry to BOTH this set AND all 3 locale JSON files
 * when the receiver extends `processing_outcome` to a new value.
 */
const KNOWN_PROCESSING_OUTCOMES = new Set<RecentDeliveryProcessingOutcome>([
  'matched_member_contact',
  'matched_member_domain',
  'matched_member_fuzzy',
  'non_member',
  'unmatched',
  'short_circuited_test',
  'duplicate',
  'malformed',
  'rolled_back',
  'rate_limited',
  'ingest_disabled',
]);

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
        // Round-6 verify-fix 2026-05-13 (errors E3) — surface a
        // toast so a failed router.replace doesn't look identical to
        // "panel correctly shows zero rows". Revert optimistic state
        // so the Switch reflects the actual server-side filter.
        console.error('[F6] recent-deliveries toggle failed', e);
        setOptimisticInclude(!next);
        toast.error(t('toggleFailed'));
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
          {/*
            Round-6 verify-fix 2026-05-13 (A-03 UX) — dropped the
            redundant `aria-label` on `<Switch>`. The visible `<Label
            htmlFor>` association below already provides the accessible
            name for screen readers; carrying both yields a double-
            announcement and is an a11y anti-pattern. shadcn `<Switch>`
            forwards the native `aria-labelledby` via the
            `htmlFor`→`id` link, so removing the explicit aria-label
            is safe.
          */}
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

      {deliveries.length === 0 ? (
        <p className="rounded-md border border-dashed bg-muted/40 p-6 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <ul
          className="divide-y rounded-md border"
          aria-live="polite"
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
                    {KNOWN_PROCESSING_OUTCOMES.has(row.processingOutcome)
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
