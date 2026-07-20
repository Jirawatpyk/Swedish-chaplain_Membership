/**
 * WP6 — exhaustive evidence-line message builder (BP2 + correction C-13).
 *
 * Maps a parsed {@link TierUpgradeEvidenceView} to a localised sentence via the
 * reason-code-matched i18n keys (`evidence.<reasonCode>`). The `assertNever`
 * default arm forces a compile error if a new reason code is added to the union
 * without a copy key, so the queue can never render a raw ICU placeholder.
 *
 * Pure: takes the translate + currency-format callbacks as parameters, so it
 * is unit-testable without a React render (Base UI / next-intl providers).
 */
import type { TierUpgradeEvidenceView } from './tier-upgrade-queue-item';

function assertNever(x: never): never {
  throw new Error(`Unhandled tier-upgrade evidence reason: ${JSON.stringify(x)}`);
}

/**
 * @param t          next-intl translate scoped to `admin.renewals.tier_upgrades`.
 * @param view       parsed evidence view.
 * @param formatThb  formats a raw MAJOR-baht figure to a `฿…` string.
 */
export function buildEvidenceMessage(
  t: (key: string, values?: Record<string, string | number>) => string,
  view: TierUpgradeEvidenceView,
  formatThb: (majorBaht: number) => string,
): string {
  switch (view.reasonCode) {
    case 'declared_turnover_above_threshold':
      return t('evidence.declared_turnover_above_threshold', {
        turnover: formatThb(view.turnoverThb),
        date: view.thresholdMetAtLabel,
      });
    case 'paid_invoice_volume_above_threshold':
      return t('evidence.paid_invoice_volume_above_threshold', {
        volume: formatThb(view.invoiceVolumeThb),
        date: view.thresholdMetAtLabel,
      });
    case 'multi_signal':
      return t('evidence.multi_signal', {
        turnover: formatThb(view.turnoverThb),
        volume: formatThb(view.invoiceVolumeThb),
        date: view.thresholdMetAtLabel,
      });
    default:
      return assertNever(view);
  }
}
