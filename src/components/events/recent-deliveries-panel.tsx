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

export interface RecentDeliveryRow {
  readonly receivedAt: string;
  readonly requestId: string;
  readonly signatureOutcome: 'verified' | 'rejected' | 'unknown';
  readonly processingOutcome: string | null;
  readonly matchedMemberId: string | null;
  readonly registrationId: string | null;
}

export interface RecentDeliveriesPanelProps {
  readonly deliveries: ReadonlyArray<RecentDeliveryRow>;
  readonly includeTestDeliveries: boolean;
}

function signatureBadgeVariant(
  outcome: RecentDeliveryRow['signatureOutcome'],
): 'default' | 'destructive' | 'secondary' {
  if (outcome === 'verified') return 'default';
  if (outcome === 'rejected') return 'destructive';
  return 'secondary';
}

function processingBadgeVariant(
  outcome: string | null,
): 'default' | 'destructive' | 'secondary' | 'outline' {
  if (!outcome) return 'outline';
  if (outcome === 'short_circuited_test') return 'secondary';
  if (outcome.startsWith('matched_member')) return 'default';
  if (outcome === 'non_member' || outcome === 'unmatched') return 'secondary';
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
    startTransition(() => {
      const url = new URL(window.location.href);
      if (next) {
        url.searchParams.set('includeTestDeliveries', 'true');
      } else {
        url.searchParams.delete('includeTestDeliveries');
      }
      router.replace(url.pathname + url.search);
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
          <Switch
            id="include-test-deliveries"
            checked={optimisticInclude}
            onCheckedChange={handleToggle}
            disabled={pending}
            aria-label={t('includeTestDeliveriesLabel')}
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
                    {t(`processing.${row.processingOutcome}`, {
                      defaultMessage: row.processingOutcome,
                    } as unknown as Record<string, string>)}
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
