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
          {/*
            F6.1 R3 a11y-fix 2026-05-16 — Base UI Switch generates an
            internal id (`base-ui-_R_…`) on its inner `<span role="switch">`
            that does NOT match the wrapper id we set, so `<Label htmlFor>`
            alone failed `aria-toggle-field-name` (no `aria-label` /
            `aria-labelledby` / visible text on the role=switch element).
            Add `aria-label` for AT consumers + keep the visible `<Label>`
            for sighted users (visual label remains; AT redundancy OK).
          */}
          <Switch
            id="include-test-deliveries"
            aria-label={t('includeTestDeliveriesLabel')}
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
        /*
          Phase 5 review-fix W-03 (2026-05-13) — proper `<table>`
          semantics replace the prior `<ul>/<li>` layout to satisfy
          WCAG 1.3.1 Information and Relationships. Each row has 4
          logical columns (received / request ID / signature / process)
          and AT users now hear the column context when each badge is
          announced.

          The wrapper `<div tabIndex={0}` enables horizontal scroll
          on narrow viewports (320–480px) without losing keyboard
          accessibility — the focusable container is the recommended
          accessible pattern for responsive tables per W3C's
          "Tables Tutorial" + WCAG 2.4.7 (Focus Visible).
          `role="region"` + `aria-labelledby` tie the scroller to
          the section heading so screen readers announce context
          when the user tabs into the scrollable region.
        */
        <div
          tabIndex={0}
          role="region"
          aria-labelledby="recent-deliveries-heading"
          className="overflow-x-auto rounded-md border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <table
            className="w-full min-w-[34rem] divide-y text-sm"
            aria-busy={pending}
          >
            <caption className="sr-only">{t('table.caption')}</caption>
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th
                  scope="col"
                  className="px-3 py-2 text-left font-medium"
                >
                  {t('table.received')}
                </th>
                <th
                  scope="col"
                  className="px-3 py-2 text-left font-medium"
                >
                  {t('table.requestId')}
                </th>
                <th
                  scope="col"
                  className="px-3 py-2 text-left font-medium"
                >
                  {t('table.signature')}
                </th>
                <th
                  scope="col"
                  className="px-3 py-2 text-left font-medium"
                >
                  {t('table.processing')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {deliveries.map((row, index) => (
                // Round 11 code-reviewer fix #3 (2026-05-14) — index
                // suffix prevents key collision on the `no-request-id`
                // sentinel. Two rows received in the same millisecond
                // with no `X-Request-ID` header would otherwise share
                // the same `${receivedAt}-${requestId}` key (sentinel
                // string is constant). Index disambiguates within the
                // map() call without harming stable-key semantics
                // because the list is sorted descending by timestamp +
                // capped at 10 rows; visual position is the natural
                // identity.
                <tr key={`${row.receivedAt}-${row.requestId}-${index}`}>
                  <td className="px-3 py-3 align-top">
                    <RelativeTime
                      iso={row.receivedAt}
                      className="text-xs text-muted-foreground"
                    />
                  </td>
                  <td className="px-3 py-3 align-top">
                    <code className="font-mono text-xs text-muted-foreground">
                      {row.requestId.slice(0, 12)}
                      {row.requestId.length > 12 ? '…' : ''}
                    </code>
                  </td>
                  <td className="px-3 py-3 align-top">
                    <Badge variant={signatureBadgeVariant(row.signatureOutcome)}>
                      {t(`signature.${row.signatureOutcome}`)}
                    </Badge>
                  </td>
                  <td className="px-3 py-3 align-top">
                    {row.processingOutcome ? (
                      <Badge variant={processingBadgeVariant(row.processingOutcome)}>
                        {KNOWN_RECENT_PROCESSING_OUTCOMES.has(row.processingOutcome)
                          ? t(`processing.${row.processingOutcome}`)
                          : row.processingOutcome}
                      </Badge>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
