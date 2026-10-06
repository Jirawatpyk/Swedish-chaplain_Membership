'use client';

/**
 * Quota-effect badge (F6 Phase 4 + ui-design-specialist round-10 I3).
 *
 * Indicates whether a registration consumed a member's partnership
 * or cultural-quota slot. Four states reflect the data-model
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
 * - none          — neither → "Not counted"
 *
 * Text plus tone per WCAG 2.1 SC 1.4.1 non-colour-alone (each state has its
 * own word).
 *
 * I3 — Tooltip support: optional `tooltip` prop wraps the badge in a
 * tooltip trigger so admins hovering "Over quota" / "Partner benefit"
 * get the explanation without leaving the table.
 *
 * Spec 122 US9a (T904): on AURA `Badge` in the board's tones
 * (`Admin-event-detail`): partner benefit and cultural quota accent, over
 * quota danger, and `none` ("Not counted", the attendee table's fourth state)
 * a neutral outline. A client module, as `match-status-badge.tsx`.
 */
import type { ReactNode } from 'react';
import { Badge, Tooltip, type Tone } from '@jirawatpyk/aura-react';

export type QuotaEffectKind = 'partnership' | 'cultural' | 'over_quota' | 'none';

interface QuotaEffectBadgeProps {
  readonly kind: QuotaEffectKind;
  readonly label: string;
  readonly tooltip?: ReactNode;
  readonly className?: string;
}

const TONE: Readonly<Record<QuotaEffectKind, { readonly tone: Tone; readonly variant: 'soft' | 'outline' }>> = {
  partnership: { tone: 'accent', variant: 'soft' },
  cultural: { tone: 'accent', variant: 'soft' },
  over_quota: { tone: 'danger', variant: 'soft' },
  none: { tone: 'neutral', variant: 'outline' },
};

export function QuotaEffectBadge({ kind, label, tooltip, className }: QuotaEffectBadgeProps) {
  const { tone, variant } = TONE[kind];
  const badge = (
    <Badge tone={tone} variant={variant} className={className} data-quota-effect={kind}>
      {label}
    </Badge>
  );
  if (!tooltip) return badge;
  // Hover explanation only, as on the match badge (no Tab stop per badge).
  return <Tooltip content={tooltip}>{badge}</Tooltip>;
}
