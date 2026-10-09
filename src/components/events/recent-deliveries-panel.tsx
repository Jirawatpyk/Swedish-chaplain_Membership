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
import {
  Card,
  StatusPill,
  Switch,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  type StatusTone,
} from '@jirawatpyk/aura-react';
import { RelativeTime } from '@/components/shell/relative-time';
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

/** Board `Admin-eventcreate`: Verified → ready, Signature rejected → blocked. */
function signatureTone(outcome: RecentDelivery['signatureOutcome']): StatusTone {
  if (outcome === 'verified') return 'ready';
  if (outcome === 'rejected') return 'blocked';
  return 'neutral';
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

  // Spec 122 US9c — board `Admin-eventcreate`: one card with the heading,
  // the switch, then the rows. Signature is a status pill; processing is
  // plain text. On phones each row reads as the time with its pill and one
  // line "processing · request ID" (the board's mobile list).
  return (
    <Card title={t('title')} headingLevel={2}>
      <div className="flex flex-col gap-[var(--aura-space-4)]">
        <Switch
          id="include-test-deliveries"
          label={t('includeTestDeliveriesLabel')}
          checked={optimisticInclude}
          onChange={handleToggle}
          disabled={pending}
        />

        {/*
          Round 2 MED-07 — one summary line announces the change, so a toggle
          does not re-read every row.
        */}
        <span role="status" aria-live="polite" className="sr-only">
          {pending
            ? t('updating')
            : t('listSummary', { count: deliveries.length })}
        </span>

        {deliveries.length === 0 ? (
          <p className="text-[var(--aura-fg-secondary)]">{t('empty')}</p>
        ) : (
          <Table
            caption={t('table.caption')}
            captionHidden
            bordered={false}
            stackBelow="sm"
            aria-busy={pending}
          >
            <THead>
              <Tr>
                <Th>{t('table.received')}</Th>
                <Th>{t('table.requestId')}</Th>
                <Th>{t('table.signature')}</Th>
                <Th>{t('table.processing')}</Th>
              </Tr>
            </THead>
            <TBody>
              {deliveries.map((row, index) => {
                const shortId = `${row.requestId.slice(0, 12)}${row.requestId.length > 12 ? '…' : ''}`;
                const processing = row.processingOutcome
                  ? KNOWN_RECENT_PROCESSING_OUTCOMES.has(row.processingOutcome)
                    ? t(`processing.${row.processingOutcome}`)
                    : row.processingOutcome
                  : null;
                const tone = signatureTone(row.signatureOutcome);
                return (
                  // Key includes the index: the 10-row read can repeat a
                  // (receivedAt, requestId) pair on a retried delivery.
                  <Tr key={`${row.receivedAt}-${row.requestId}-${index}`}>
                    <Td card="title">
                      <RelativeTime iso={row.receivedAt} />
                    </Td>
                    <Td mono className="max-sm:hidden">
                      {shortId}
                    </Td>
                    <Td card="action">
                      <StatusPill tone={tone} data-tone={tone}>
                        {t(`signature.${row.signatureOutcome}`)}
                      </StatusPill>
                    </Td>
                    <Td className="max-sm:hidden">{processing}</Td>
                    <Td label="" className="aura-text-caption text-[var(--aura-fg-secondary)] sm:hidden">
                      {processing ? `${processing} · ` : null}
                      <span className="aura-text-mono">{shortId}</span>
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        )}
      </div>
    </Card>
  );
}
