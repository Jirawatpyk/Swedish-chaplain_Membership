import * as React from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  Info,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { auraButtonClass } from '@/components/shell/aura-markup';
import { cn } from '@/lib/utils';

/**
 * Dashboard StatCard — label + big value + optional sub, with an
 * optional status variant. The variant is conveyed by BOTH a text
 * label and an icon (never colour alone — WCAG 1.4.1, spec §5).
 *
 * Server-safe: no `'use client'`, no hooks, pure presentation. The
 * caller supplies already-localised strings (no i18n inside the
 * primitive so it stays composable across portal surfaces).
 *
 * Heading rule (spec a11y-6): the label renders as a real `<h2>`, not
 * a CardTitle div, so the dashboard outline is h1 (PageHeader) → h2.
 *
 * Spec 122 US3: AURA `Stat` markup (the `Main` / `Home-mobile` boards), drawn
 * with AURA's classes because this is a server component (`aura-markup.tsx`).
 * The label keeps its h2; `data-testid` / `data-variant` stay for the e2e.
 *
 * The variant set is intentionally identical to the route-layer `StatVariant`
 * (dashboard-stats.ts) — the previously-declared `'ok'` member was dead (no
 * caller ever produced it; every source goes through `StatVariant` which has
 * no `'ok'`), so it was removed along with its unreachable icon/colour branches
 * (D1 review finding F1). Re-add a member here only when a caller produces it.
 */
export type StatCardVariant = 'neutral' | 'warning' | 'destructive';

const VARIANT_ICON: Record<Exclude<StatCardVariant, 'neutral'>, LucideIcon> = {
  warning: AlertTriangle,
  destructive: XCircle,
};

const VARIANT_STATUS_CLASS: Record<
  Exclude<StatCardVariant, 'neutral'>,
  string
> = {
  warning: 'text-[var(--aura-alert-warning-fg)]',
  destructive: 'text-[var(--aura-fg-danger)]',
};

export interface StatCardProps {
  /** Already-localised stat label. Rendered as a real `<h2>`. */
  readonly label: string;
  /** Already-localised primary value (the big number/text). */
  readonly value: React.ReactNode;
  /** Optional already-localised supporting line under the value. */
  readonly sub?: React.ReactNode;
  /** Status variant. Defaults to `neutral` (no status row). */
  readonly variant?: StatCardVariant;
  /**
   * Already-localised status text shown next to the variant icon.
   * Required to render the status row for non-neutral variants — the
   * text (not colour) is the accessible signal.
   */
  readonly variantLabel?: string;
  /**
   * Optional CTA rendered as a small button at the bottom of the card — e.g.
   * the membership card's "Renew now" link to the renewal flow when a cycle is
   * due/overdue (067). Already-localised `label`. `href` is normally an
   * internal route (rendered via next/link); an EXTERNAL href — `mailto:`,
   * `tel:`, or `http(s)` — renders a plain `<a>` instead (Next `<Link>` is for
   * client-routed internal navigation). Omitted → no CTA (the card stays a
   * pure stat). Keeping it IN the card (vs a separate banner) avoids
   * duplicating the status the card already shows.
   *
   * Cluster 4 (2026-07-12): the `lapsed` kind now supplies a `mailto:`
   * contact-support action (there is no member self-serve renewal — renewal is
   * admin-driven), replacing the prior dead "Renew to restore" promise. The
   * caller decides the href; this primitive just renders it.
   */
  readonly action?: { readonly href: string; readonly label: string };
  /**
   * 059-membership-suspension — optional override for the status-row icon.
   * Defaults to the per-`variant` icon (`VARIANT_ICON`) when omitted. Needed
   * because `warning`/`destructive` are now each shared by TWO distinct
   * membership-card kinds (`due` vs `suspended`; the retired `overdue` vs
   * `lapsed`/terminated) that must stay visually distinguishable beyond
   * colour alone — e.g. `suspended` (amber `PauseCircle`, "paused, not an
   * accusation") vs `due` (amber `AlertTriangle`, "act soon"), and
   * `terminated` (red `TriangleAlert`) vs a same-tone destructive kind using
   * the default `XCircle`.
   */
  readonly icon?: LucideIcon;
  /** The small icon top-right of the tile, as the boards draw one per stat. */
  readonly headIcon?: LucideIcon;
  readonly className?: string;
}

/**
 * External protocols that must render a plain `<a>` (browser-handled, not
 * client-routed). `mailto:` / `tel:` open the OS handler; `http(s)` leaves the
 * app. Everything else is treated as an internal route via next/link.
 */
function isExternalHref(href: string): boolean {
  return /^(?:mailto:|tel:|https?:)/i.test(href);
}

export function StatCard({
  label,
  value,
  sub,
  variant = 'neutral',
  variantLabel,
  action,
  icon,
  headIcon: HeadIcon,
  className,
}: StatCardProps) {
  const showStatus = variant !== 'neutral' && Boolean(variantLabel);
  const Icon = icon ?? (variant === 'neutral' ? Info : VARIANT_ICON[variant]);

  return (
    <div
      data-testid="stat-card"
      data-variant={variant}
      className={cn('aura-stat h-full', className)}
    >
      <div className="aura-stat__head">
        <h2 className="aura-stat__label">{label}</h2>
        {HeadIcon ? (
          <span className="aura-stat__icon">
            <HeadIcon size={16} className="aura-icon" aria-hidden="true" focusable="false" />
          </span>
        ) : null}
      </div>
      <p className="aura-stat__value tabular-nums">{value}</p>
      {sub !== undefined || showStatus ? (
        <span className="aura-stat__foot flex-col items-start">
          {sub !== undefined ? (
            <span data-slot="stat-card-sub" className="aura-stat__caption">
              {sub}
            </span>
          ) : null}
          {showStatus ? (
            <span
              data-testid="stat-card-status"
              className={cn(
                'inline-flex items-center gap-1.5 text-[13px] font-medium',
                VARIANT_STATUS_CLASS[variant as Exclude<StatCardVariant, 'neutral'>],
              )}
            >
              <Icon className="size-3.5" aria-hidden="true" />
              {variantLabel}
            </span>
          ) : null}
        </span>
      ) : null}
      {action ? (
        // The card's one next step: AURA's primary default (44px) button, not
        // `sm` (32px), for the WCAG 2.5.5 target.
        isExternalHref(action.href) ? (
          <a href={action.href} className={cn(auraButtonClass(), 'mt-3 w-fit')}>
            {action.label}
          </a>
        ) : (
          <Link href={action.href} className={cn(auraButtonClass(), 'mt-3 w-fit')}>
            {action.label}
          </Link>
        )
      ) : null}
    </div>
  );
}
