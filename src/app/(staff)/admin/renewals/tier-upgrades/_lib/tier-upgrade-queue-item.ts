/**
 * WP6 — client-facing tier-upgrade evidence view (BP2 + corrections C-13/C-20).
 *
 * The admin queue historically approved a price increase seeing only a coarse
 * "Turnover above threshold" reason label — the full `TierUpgradeEvidence`
 * union that `listForAdminQueue` returns was dropped in the page mapping. This
 * module is the presentation boundary that (a) re-validates the JSONB-sourced
 * evidence with zod (defensive for the new client dereference — C-20) and
 * (b) pre-formats the `thresholdMetAt` instant into a locale/BE-correct label
 * SERVER-side (C-11), so the client renders no raw ISO string and never
 * dereferences an unvalidated shape.
 *
 * The view's discriminant (`reasonCode`) is deliberately the SAME literal set
 * as the domain `TierUpgradeReasonCode` so a reflexive
 * `t(`evidence.${view.reasonCode}`)` in the message builder can never
 * MISSING_MESSAGE (C-13).
 */
import { z } from 'zod';

/**
 * Defensive zod shape for the JSONB `evidence` column. `.object()` strips
 * unknown keys (a future emit-site field can't leak into the client view),
 * and the discriminated union rejects a shape whose numeric metric doesn't
 * match its `reasonCode` (e.g. a turnover figure under a paid-invoice reason).
 */
const evidenceSchema = z.discriminatedUnion('reasonCode', [
  z.object({
    reasonCode: z.literal('declared_turnover_above_threshold'),
    turnoverThb: z.number(),
    thresholdMetAt: z.string(),
  }),
  z.object({
    reasonCode: z.literal('paid_invoice_volume_above_threshold'),
    invoiceVolumeThb: z.number(),
    thresholdMetAt: z.string(),
  }),
  z.object({
    reasonCode: z.literal('multi_signal'),
    turnoverThb: z.number(),
    invoiceVolumeThb: z.number(),
    thresholdMetAt: z.string(),
  }),
]);

/**
 * Client-serialisable evidence view. `thresholdMetAt` (raw ISO) is replaced by
 * `thresholdMetAtLabel` (formatted server-side); the metric figures stay raw
 * MAJOR-baht numbers so the client currency-formatter (narrowSymbol `฿`) owns
 * the display shape.
 */
export type TierUpgradeEvidenceView =
  | {
      readonly reasonCode: 'declared_turnover_above_threshold';
      readonly turnoverThb: number;
      readonly thresholdMetAtLabel: string;
    }
  | {
      readonly reasonCode: 'paid_invoice_volume_above_threshold';
      readonly invoiceVolumeThb: number;
      readonly thresholdMetAtLabel: string;
    }
  | {
      readonly reasonCode: 'multi_signal';
      readonly turnoverThb: number;
      readonly invoiceVolumeThb: number;
      readonly thresholdMetAtLabel: string;
    };

/**
 * Parse the domain `evidence` into a client view, formatting the threshold
 * date via the supplied server-side formatter.
 *
 * Returns `null` (→ the client renders the localised "unavailable" line) when:
 *   - the raw evidence is malformed / missing a metric (fails the zod parse), or
 *   - the evidence's own `reasonCode` disagrees with the suggestion's
 *     `reasonCode` (forensic drift — never render a mismatched figure on a
 *     money screen).
 *
 * `formatDate` is invoked at most once (for the single `thresholdMetAt`).
 */
export function parseTierUpgradeEvidenceView(
  reasonCode: string,
  rawEvidence: unknown,
  formatDate: (iso: string) => string,
): TierUpgradeEvidenceView | null {
  const parsed = evidenceSchema.safeParse(rawEvidence);
  if (!parsed.success) return null;
  const e = parsed.data;
  // reason_code_mismatch — the outer suggestion reason must agree with the
  // evidence arm; a disagreement means the JSONB drifted from the row.
  if (e.reasonCode !== reasonCode) return null;

  const thresholdMetAtLabel = formatDate(e.thresholdMetAt);
  switch (e.reasonCode) {
    case 'declared_turnover_above_threshold':
      return {
        reasonCode: e.reasonCode,
        turnoverThb: e.turnoverThb,
        thresholdMetAtLabel,
      };
    case 'paid_invoice_volume_above_threshold':
      return {
        reasonCode: e.reasonCode,
        invoiceVolumeThb: e.invoiceVolumeThb,
        thresholdMetAtLabel,
      };
    case 'multi_signal':
      return {
        reasonCode: e.reasonCode,
        turnoverThb: e.turnoverThb,
        invoiceVolumeThb: e.invoiceVolumeThb,
        thresholdMetAtLabel,
      };
  }
}
