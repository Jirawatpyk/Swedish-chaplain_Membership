/**
 * Quota-effect badge (F6 Phase 4 + ui-design-specialist round-10 I3).
 *
 * Indicates whether a registration consumed a member's partnership
 * or cultural-quota slot. Three states reflect the data-model
 * boolean pair `(counted_against_partnership, counted_against_cultural_quota)`
 * + the derived `isOverQuota` flag:
 *
 * - partnership   — counted_against_partnership=true → "Partner benefit"
 * - cultural      — counted_against_cultural_quota=true → "Cultural quota"
 * - over_quota    — isOverQuota=true → "Over quota" (visible on
 * events flagged partner/cultural where the
 * registration could NOT be counted because the
 * member's allotment is exhausted OR the
 * attendee isn't a member)
 * - none          — neither — no badge rendered (returns null)
 *
 * Combines shape + icon + text per WCAG 2.1 SC 1.4.1 non-colour-alone.
 *
 * I3 — Tooltip support: optional `tooltip` prop wraps the badge in a
 * tooltip trigger so admins hovering "Over quota" / "Partner benefit"
 * get the explanation without leaving the table.
 */
import type { ReactNode } from 'react';
import { Award, Sparkles, AlertOctagon, type LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export type QuotaEffectKind = 'partnership' | 'cultural' | 'over_quota';

interface QuotaEffectBadgeProps {
  readonly kind: QuotaEffectKind;
  readonly label: string;
  readonly tooltip?: ReactNode;
  readonly className?: string;
}

interface VariantConfig {
  readonly Icon: LucideIcon;
  readonly badgeClass: string;
}

/**
 * Tokens picked for WCAG 2.1 SC 1.4.11 (≥3:1) — see match-status-badge.tsx
 * for the same dark-mode adjustment rationale (U1 ).
 */
const VARIANT_MAP: Readonly<Record<QuotaEffectKind, VariantConfig>> = {
  partnership: {
    Icon: Award,
    badgeClass:
      'border-sky-600 text-sky-900 dark:border-sky-500 dark:text-sky-100',
  },
  cultural: {
    Icon: Sparkles,
    badgeClass:
      'border-violet-600 text-violet-900 dark:border-violet-500 dark:text-violet-100',
  },
  over_quota: {
    Icon: AlertOctagon,
    badgeClass:
      'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-100 border-amber-600 dark:border-amber-500',
  },
};

export function QuotaEffectBadge({
  kind,
  label,
  tooltip,
  className,
}: QuotaEffectBadgeProps) {
  const { Icon, badgeClass } = VARIANT_MAP[kind];
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
  return (
    <TooltipProvider>
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
    </TooltipProvider>
  );
}
