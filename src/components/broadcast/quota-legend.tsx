/**
 * The key under an E-Blast quota bar: "■ Used · ▨ Reserved (in review or
 * scheduled)" (boards `Portal-broadcasts` and `Main`). Shown only while
 * something is reserved, under both the Benefits / compose quota card and the
 * Dashboard's benefit-usage bar, so the striped part reads the same on both.
 *
 * The swatches take the bar's tone, and the striped one repeats the 135°
 * stripe AURA's `Progress` draws for `secondaryValue`, finer (2/4px, not 3/6)
 * so a 12px swatch shows stripes rather than one slash. AURA has no legend for
 * that segment yet (stand-in until AURA #179).
 *
 * `aria-hidden`: the counters or the bar's `valueText` already say how many
 * are used and reserved, so the key is not read twice.
 */
// A mask: `#000` is only the opaque part (alpha), not a colour; the swatch's
// colour is its background, the bar's tone. Not a token on purpose.
const STRIPES = 'repeating-linear-gradient(135deg, #000 0 2px, transparent 2px 4px)';

export interface QuotaLegendProps {
  readonly usedLabel: string;
  readonly reservedLabel: string;
  /** The bar's tone: danger once the quota is used up. */
  readonly tone?: 'accent' | 'danger';
}

export function QuotaLegend({ usedLabel, reservedLabel, tone = 'accent' }: QuotaLegendProps): React.ReactElement {
  const swatch = tone === 'danger' ? 'bg-[var(--aura-fg-danger)]' : 'bg-[var(--aura-fg-accent)]';
  return (
    <div
      aria-hidden="true"
      data-testid="quota-legend"
      className="flex flex-wrap gap-x-4 gap-y-1 aura-text-caption text-[var(--aura-fg-secondary)]"
    >
      <span className="inline-flex items-center gap-1.5">
        <span className={`size-3 shrink-0 rounded-[2px] ${swatch}`} />
        {usedLabel}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          data-swatch="reserved"
          className={`size-3 shrink-0 rounded-[2px] ${swatch}`}
          style={{ maskImage: STRIPES, WebkitMaskImage: STRIPES }}
        />
        {reservedLabel}
      </span>
    </div>
  );
}
