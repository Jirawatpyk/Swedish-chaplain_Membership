'use client';

/**
 * Match-status badge (F6 Phase 4 + ui-design-specialist round-10 I3/I6).
 *
 * Visual indicator for the 5-state attendee match cascade (FR-012), a
 * "confidence ladder" (round-10 C3): Verified contact → Verified domain →
 * Likely match → Non-member → Needs review.
 *
 * I3 — Tooltip support:
 *   When the caller passes `tooltip`, the badge becomes a tooltip
 *   trigger; otherwise renders the bare badge (back-compat — keeps
 *   the table dense and lets non-attendee surfaces opt-in).
 *
 * The label + tooltip strings are localised by the caller via next-intl.
 *
 * Spec 122 US9a (T904): on AURA `Badge` in the board's tones
 * (`Admin-event-detail`): the two verified rungs success, "Likely match"
 * warning, "Needs review" danger, "Non-member" a neutral outline. The words
 * differ on every rung, so the board's icon-free badges stay non-colour-alone
 * (WCAG 1.4.1). A client module: AURA's root is client-only and the erasure
 * page (a Server Component) renders this badge too.
 */
import type { ReactNode } from 'react';
import { Badge, Tooltip, type Tone } from '@jirawatpyk/aura-react';
import type { MatchType } from '@/modules/events';

interface MatchStatusBadgeProps {
  readonly matchType: MatchType;
  readonly label: string;
  /** Optional tooltip body — when present wraps the badge in a tooltip. */
  readonly tooltip?: ReactNode;
  readonly className?: string;
}

const TONE: Readonly<Record<MatchType, { readonly tone: Tone; readonly variant: 'soft' | 'outline' }>> = {
  member_contact: { tone: 'success', variant: 'soft' },
  member_domain: { tone: 'success', variant: 'soft' },
  member_fuzzy: { tone: 'warning', variant: 'soft' },
  non_member: { tone: 'neutral', variant: 'outline' },
  unmatched: { tone: 'danger', variant: 'soft' },
};

export function MatchStatusBadge({ matchType, label, tooltip, className }: MatchStatusBadgeProps) {
  const { tone, variant } = TONE[matchType];
  const badge = (
    <Badge tone={tone} variant={variant} className={className} data-match-type={matchType}>
      {label}
    </Badge>
  );
  if (!tooltip) return badge;
  // Round-12 review fix kept: the badge takes no Tab stop (50–100 extra stops
  // on a 50-row table); its own text is the primary signal and the tooltip a
  // hover explanation.
  return <Tooltip content={tooltip}>{badge}</Tooltip>;
}
