/**
 * T064 — Match-status badge (F6 Phase 4).
 *
 * Visual indicator for the 5-state attendee match cascade
 * (FR-012). Combines shape (filled vs. outline), icon, AND text
 * to satisfy WCAG 2.1 SC 1.4.1 non-colour-alone for status
 * communication.
 *
 * Variants:
 *   - member_contact  — filled green check (highest confidence)
 *   - member_domain   — outline green check (domain inference)
 *   - member_fuzzy    — outline amber tilde (fuzzy match, review-worthy)
 *   - non_member      — outline neutral dot (not a member)
 *   - unmatched       — filled red warning (ambiguous, review-required)
 *
 * The label is localised by the caller via next-intl — the badge
 * receives the resolved string. Default `aria-label` falls back
 * to the visible text.
 */
import {
  CheckCircle2,
  Check,
  CircleEqual,
  Circle,
  AlertTriangle,
  type LucideIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { MatchType } from '@/modules/events';

interface MatchStatusBadgeProps {
  readonly matchType: MatchType;
  readonly label: string;
  readonly className?: string;
}

interface VariantConfig {
  readonly Icon: LucideIcon;
  readonly badgeClass: string;
}

const VARIANT_MAP: Readonly<Record<MatchType, VariantConfig>> = {
  member_contact: {
    Icon: CheckCircle2,
    badgeClass:
      'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200 border-emerald-200 dark:border-emerald-800',
  },
  member_domain: {
    Icon: Check,
    badgeClass:
      'border-emerald-300 text-emerald-900 dark:border-emerald-700 dark:text-emerald-200',
  },
  member_fuzzy: {
    Icon: CircleEqual,
    badgeClass:
      'border-amber-300 text-amber-900 dark:border-amber-700 dark:text-amber-200',
  },
  non_member: {
    Icon: Circle,
    badgeClass:
      'border-border text-muted-foreground',
  },
  unmatched: {
    Icon: AlertTriangle,
    badgeClass:
      'bg-destructive/10 text-destructive border-destructive/30',
  },
};

export function MatchStatusBadge({
  matchType,
  label,
  className,
}: MatchStatusBadgeProps) {
  const { Icon, badgeClass } = VARIANT_MAP[matchType];
  return (
    <Badge
      variant="outline"
      className={cn(badgeClass, className)}
      // Use the localised label as the accessible name so screen
      // readers announce "Matched (exact email)" etc. rather than
      // the raw enum value.
      aria-label={label}
    >
      <Icon aria-hidden="true" data-icon="inline-start" />
      <span>{label}</span>
    </Badge>
  );
}
