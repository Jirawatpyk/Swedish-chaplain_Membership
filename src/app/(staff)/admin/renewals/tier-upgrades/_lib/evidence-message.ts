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

/**
 * Plan-change UX C2 — compose the Accept-dialog description.
 *
 * Restates the pricing evidence AND the old→new plan move WITH the actual
 * annual fees (e.g. ฿36,000 → ฿60,000), so an admin approving a price increase
 * sees the numbers, not just plan names (ux-standards § 6.2 — repeat the
 * figures before a money action). A fee absent from the resolved plan map
 * (archived / deleted plan) renders the localised `fee_unknown` token in that
 * slot rather than a blank or `NaN`.
 *
 * Pure (takes the translate + THB-format callbacks), so it is unit-testable
 * against the real messages without a React render.
 *
 * @param formatThb formats a raw MAJOR-baht figure to a `฿…` string (same
 *   contract as {@link buildEvidenceMessage}); fees are stored in MINOR units,
 *   so they are divided by 100 before formatting.
 */
export function buildAcceptDialogMessage(
  t: (key: string, values?: Record<string, string | number>) => string,
  args: {
    readonly evidence: TierUpgradeEvidenceView | null;
    readonly fromPlanLabel: string;
    readonly toPlanLabel: string;
    readonly fromFeeMinorUnits?: number;
    readonly toFeeMinorUnits?: number;
  },
  formatThb: (majorBaht: number) => string,
): string {
  const evidenceText = args.evidence
    ? buildEvidenceMessage(t, args.evidence, formatThb)
    : t('evidence.unavailable');
  const feeText = (minorUnits: number | undefined): string =>
    minorUnits === undefined
      ? t('actions.accept.fee_unknown')
      : formatThb(minorUnits / 100);
  return t('actions.accept.evidence_restated', {
    evidence: evidenceText,
    fromPlan: args.fromPlanLabel,
    toPlan: args.toPlanLabel,
    fromFee: feeText(args.fromFeeMinorUnits),
    toFee: feeText(args.toFeeMinorUnits),
  });
}
