'use client';

import { useId } from 'react';

/**
 * SweCham / TSCC official brand mark — the "Interlocking Link".
 *
 * Two woven rings reading as a Thailand–Sweden partnership and the twin "C"s
 * of Chamber of Commerce. Single source of truth for the logo across the app
 * (sidebar, portal, auth pages, empty states).
 *
 * Colour model (theme-aware, no hard-coded brand drift):
 *   - Ring A + wordmark use `currentColor` so the mark reverses automatically:
 *     navy on light surfaces, white on dark. Default text colour is set on the
 *     root via Tailwind (`text-[#0B2A4A] dark:text-white`) and can be overridden
 *     by passing a `text-*` utility through `className`.
 *   - Ring B (gold) is pinned to the product accent token `--brand-accent`
 *     (#C9A227) so the logo gold and the UI accent stay in lock-step.
 *
 * Accessibility: when `title` is provided the SVG is exposed as an image with
 * that label; otherwise it is decorative (`aria-hidden`) — use the decorative
 * form whenever an adjacent text node already names the brand.
 */
export type BrandVariant = 'mark' | 'lockup' | 'vertical';

interface BrandMarkProps {
  readonly variant?: BrandVariant;
  readonly className?: string;
  /** Accessible name. Omit to render the mark as decorative (aria-hidden). */
  readonly title?: string;
}

const GOLD = 'var(--brand-accent)';
const WORDMARK_FONT = 'var(--font-geist-sans), "Segoe UI", system-ui, sans-serif';

export function BrandMark({ variant = 'mark', className, title }: BrandMarkProps) {
  const rawId = useId();
  // clipPath ids must be unique per instance AND valid CSS selectors.
  const clipId = `swecham-weave-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const a11y = title
    ? ({ role: 'img', 'aria-label': title } as const)
    : ({ 'aria-hidden': true, focusable: false } as const);

  const rootClass = ['text-[#0B2A4A] dark:text-white', className]
    .filter(Boolean)
    .join(' ');

  // The interlocking-link symbol, shared by every variant. Gold ring is drawn
  // over navy everywhere; navy is then redrawn (clipped to the top crossing)
  // so it sits over gold there — producing a true woven chain link.
  const symbol = (
    <>
      <circle cx="42" cy="48" r="20" fill="none" stroke="currentColor" strokeWidth="11" />
      <circle cx="62" cy="48" r="20" fill="none" stroke={GOLD} strokeWidth="11" />
      <g clipPath={`url(#${clipId})`}>
        <circle cx="42" cy="48" r="20" fill="none" stroke="currentColor" strokeWidth="11" />
      </g>
    </>
  );

  const defs = (
    <defs>
      <clipPath id={clipId}>
        <rect x="44" y="18" width="16" height="24" />
      </clipPath>
    </defs>
  );

  if (variant === 'lockup') {
    return (
      <svg viewBox="0 0 516 120" className={rootClass} {...a11y}>
        {defs}
        <g transform="translate(6,12) scale(0.92)">{symbol}</g>
        <text
          x="116"
          y="62"
          fontFamily={WORDMARK_FONT}
          fontSize="46"
          fontWeight="700"
          letterSpacing="-1.5"
          fill="currentColor"
        >
          SweCham
        </text>
        <rect x="118" y="74" width="60" height="3.5" rx="1.75" fill={GOLD} />
        <text
          x="118"
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
        {defs}
        <g transform="translate(91,12) scale(1.42)">{symbol}</g>
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
      {defs}
      {symbol}
    </svg>
  );
}
