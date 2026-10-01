/**
 * 122 US7b-1 (T726) — the tier upgrade queue page's body, shared by the page
 * and the no-DB preview route (`/test-fixtures/aura-admin?view=tier-upgrades`),
 * so the screenshots show the page itself. Boards `Admin-tier-upgrades` (+
 * `-accept`, `-mobile`).
 *
 * The page keeps the data, its `TableContainer` and its `PageHeader`
 * (check:layout reads the page file); it passes the section tabs (a Suspense
 * island) and the queue as nodes.
 */
import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { Alert, Card } from '@jirawatpyk/aura-react/server';
import { RenewalsErrorRetry } from '../../_components/renewals-error-retry';

export interface TierUpgradesViewProps {
  /** Pipeline / Pending review / Tasks / Tier upgrades, with their counts. */
  readonly sectionTabs: ReactNode;
  /** The queue (`TierUpgradeQueueClient`), or null when the read failed. */
  readonly queue: ReactNode;
  /** The queue read failed: say so rather than show an empty queue (I-UX-1). */
  readonly loadFailed?: boolean;
}

export async function renderTierUpgradesView({ sectionTabs, queue, loadFailed = false }: TierUpgradesViewProps) {
  const t = await getTranslations('admin.renewals.tier_upgrades');
  return (
    // One card on a desktop (board Admin-tier-upgrades); on a phone the rows
    // are cards of their own, so it drops its frame and padding, putting them
    // on the page gutter as the pipeline does.
    <Card flushBelow="sm" className="max-sm:border-0 max-sm:p-0">
      <div className="flex flex-col gap-[var(--aura-space-4)]">
        {sectionTabs}
        {loadFailed ? (
          // Phase 7 review-fix I-UX-1: an explicit failure, never the empty
          // state (which would read as "no candidates").
          <Alert
            tone="danger"
            title={t('error_state.title')}
            action={<RenewalsErrorRetry label={t('error_state.retry')} retryingLabel={t('error_state.retrying')} />}
          >
            {t('error_state.subtitle')}
          </Alert>
        ) : (
          <>
            {/* The phone list drops the per-fee "excl. VAT", so it is said
                once above it (board Admin-tier-upgrades-mobile). */}
            <p className="m-0 text-xs text-[var(--aura-fg-secondary)] sm:hidden">{t('fees_exclude_vat')}</p>
            {queue}
          </>
        )}
      </div>
    </Card>
  );
}
