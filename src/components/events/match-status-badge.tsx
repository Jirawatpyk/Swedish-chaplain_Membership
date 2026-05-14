/**
 * Match-status badge (F6 Phase 4 + ui-design-specialist round-10 I3/I6).
 *
 * Visual indicator for the 5-state attendee match cascade
 * (FR-012). Combines shape (filled vs. outline), icon, AND text
 * to satisfy WCAG 2.1 SC 1.4.1 non-colour-alone for status
 * communication.
 *
 * Variants (rebranded round-10 C3 — "confidence ladder"):
 * - member_contact  — filled green CheckCircle2 ("Verified contact")
 * - member_domain   — outline green BadgeCheck ("Verified domain")
 *                     I6: swapped from `Check` to `BadgeCheck` so the
 *                     16px icon is visually distinct from member_contact.
 * - member_fuzzy    — outline amber CircleEqual ("Likely match")
 * - non_member      — outline neutral Circle ("Non-member")
 * - unmatched       — filled red AlertTriangle ("Needs review")
 *
 * I3 — Tooltip support:
 *   When the caller passes `tooltip`, the badge becomes a tooltip
 *   trigger; otherwise renders the bare badge (back-compat — keeps
 *   the table dense and lets non-attendee surfaces opt-in).
 *
 * The label + tooltip strings are localised by the caller via next-intl.
 */
import type { ReactNode } from 'react';
import {
  CheckCircle2,
  BadgeCheck,
  CircleEqual,
  Circle,
  AlertTriangle,
  type LucideIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { MatchType } from '@/modules/events';

interface MatchStatusBadgeProps {
  readonly matchType: MatchType;
  readonly label: string;
  /** Optional tooltip body — when present wraps the badge in a tooltip. */
  readonly tooltip?: ReactNode;
  readonly className?: string;
}

interface VariantConfig {
  readonly Icon: LucideIcon;
  readonly badgeClass: string;
}

/**
 * Tailwind tokens picked for **WCAG 2.1 SC 1.4.11** non-text contrast (≥3:1)
 * against both light card background (oklch 1.000 ≈ #fff) and dark card
 * background (oklch 0.145 ≈ #262626). Verify-finding U1 raised
 * that `-700` dark borders measured 2.13–2.76:1 — bumped to `-500` shades
 * which clear 3:1 in both themes.
 */
const VARIANT_MAP: Readonly<Record<MatchType, VariantConfig>> = {
  member_contact: {
    Icon: CheckCircle2,
    badgeClass:
      'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-100 border-emerald-600 dark:border-emerald-500',
  },
  member_domain: {
    Icon: BadgeCheck,
    badgeClass:
      'border-emerald-600 text-emerald-900 dark:border-emerald-500 dark:text-emerald-100',
  },
  member_fuzzy: {
    Icon: CircleEqual,
    badgeClass:
      'border-amber-600 text-amber-900 dark:border-amber-500 dark:text-amber-100',
  },
  non_member: {
    Icon: Circle,
    badgeClass: 'border-border text-foreground',
  },
  unmatched: {
    Icon: AlertTriangle,
    badgeClass: 'bg-destructive/10 text-destructive border-destructive',
  },
};

export function MatchStatusBadge({
  matchType,
  label,
  tooltip,
  className,
}: MatchStatusBadgeProps) {
  const { Icon, badgeClass } = VARIANT_MAP[matchType];
  const badge = (
    <Badge
      variant="outline"
      className={cn(badgeClass, className)}
      aria-label={label}
    >
      <Icon aria-hidden="true" data-icon="inline-start" />
      <span>{label}</span>
    </Badge>
  );
  if (!tooltip) return badge;
  // Round-11 review fix — TooltipProvider HOISTED to the calling table
  // (attendee-table, events-list-table) so 50-row tables don't spawn
  // 100+ providers per render. Caller MUST wrap the table body in
  // `<TooltipProvider>` for the tooltip to function.
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            className="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          />
        }
      >
        {badge}
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
