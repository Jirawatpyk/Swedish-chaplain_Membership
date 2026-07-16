/**
 * SweCham / TSCC brand mark — the chamber's real logo: three Swedish crowns
 * behind Thai-flag brush strokes (artwork supplied by TSCC, 2026-07; source
 * rasters in docs/import/, vectorised to public/brand/tscc-mark.svg).
 *
 * The crown artwork is referenced via SVG <image> rather than inlined: its
 * ~84KB of traced path data stays out of the JS bundle and the asset is
 * fetched and cached once for the whole app.
 *
 * Colour rules:
 *   - The artwork's flag blue (#20419A) is near-invisible on dark surfaces
 *     (1.02:1 against the sidebar navy), so every variant paints a white
 *     tile behind the crowns in dark mode. Surfaces that are dark in BOTH
 *     themes (the navy staff sidebar) must add their own always-on white
 *     chip at the call site — the tile here is dark-theme-only.
 *   - Wordmark text keeps `currentColor` (navy on light, white on dark, via
 *     the root utilities) and the gold rule stays pinned to --brand-accent,
 *     so lockup/vertical still reverse with the theme.
 *
 * Accessibility (unchanged contract): when `title` is provided the SVG is
 * exposed as an image with that label; otherwise it is decorative
 * (`aria-hidden`) — use the decorative form whenever an adjacent text node
 * already names the brand.
 */
export type BrandVariant = 'mark' | 'lockup' | 'vertical';

interface BrandMarkProps {
  readonly variant?: BrandVariant;
  readonly className?: string;
  /** Accessible name. Omit to render the mark as decorative (aria-hidden). */
  readonly title?: string;
}

const MARK_SRC = '/brand/tscc-mark.svg';
const GOLD = 'var(--brand-accent)';
const WORDMARK_FONT = 'var(--font-geist-sans), "Segoe UI", system-ui, sans-serif';

/** White tile behind the crowns — visible only on the dark theme. */
function DarkTile(props: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rx: number;
}) {
  return <rect {...props} className="fill-white opacity-0 dark:opacity-100" />;
}

export function BrandMark({ variant = 'mark', className, title }: BrandMarkProps) {
  const a11y = title
    ? ({ role: 'img', 'aria-label': title } as const)
    : ({ 'aria-hidden': true, focusable: false } as const);

  const rootClass = ['text-[#0B2A4A] dark:text-white', className]
    .filter(Boolean)
    .join(' ');

  if (variant === 'lockup') {
    return (
      <svg viewBox="0 0 516 120" className={rootClass} {...a11y}>
        <DarkTile x={0} y={2} width={140} height={116} rx={14} />
        <image href={MARK_SRC} x="8" y="10" width="124" height="100" />
        <text
          x="160"
          y="62"
          fontFamily={WORDMARK_FONT}
          fontSize="46"
          fontWeight="700"
          letterSpacing="-1.5"
          fill="currentColor"
        >
          SweCham
        </text>
        <rect x="162" y="74" width="60" height="3.5" rx="1.75" fill={GOLD} />
        <text
          x="162"
          y="96"
          fontFamily={WORDMARK_FONT}
          fontSize="11.5"
          fontWeight="600"
          letterSpacing="2"
          fill="var(--muted-foreground)"
        >
          THAI–SWEDISH CHAMBER OF COMMERCE
        </text>
      </svg>
    );
  }

  if (variant === 'vertical') {
    return (
      <svg viewBox="0 0 330 248" className={rootClass} {...a11y}>
        <DarkTile x={76} y={0} width={178} height={148} rx={16} />
        <image href={MARK_SRC} x="88" y="10" width="154" height="128" />
        <text
          x="165"
          y="200"
          textAnchor="middle"
          fontFamily={WORDMARK_FONT}
          fontSize="42"
          fontWeight="700"
          letterSpacing="-1.5"
          fill="currentColor"
        >
          SweCham
        </text>
        <rect x="135" y="211" width="60" height="3.5" rx="1.75" fill={GOLD} />
        <text
          x="165"
          y="233"
          textAnchor="middle"
          fontFamily={WORDMARK_FONT}
          fontSize="10.5"
          fontWeight="600"
          letterSpacing="1.9"
          fill="var(--muted-foreground)"
        >
          THAI–SWEDISH CHAMBER OF COMMERCE
        </text>
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 104 96" className={rootClass} {...a11y}>
      <DarkTile x={0} y={4} width={104} height={88} rx={12} />
      <image href={MARK_SRC} x="4" y="8" width="96" height="80" />
    </svg>
  );
}
