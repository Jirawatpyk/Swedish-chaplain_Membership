/**
 * 108 PR-D (FR-031b) — the ONE shared vocabulary for "why does this contact
 * not receive a broadcast". Consumed by the member-page badge, the Marketing
 * audience page and (PR-C) the compose-time count feedback, so staff read the
 * same reason in the same words on every surface. i18n labels live under
 * `shared.marketingReason.*` (en/th/sv).
 *
 * Member-level facts come first, then contact-level facts, in this order.
 * `sender_own_contact` and `member_no_eligible_contact` are compose-time
 * reasons (a contact of the SENDING member is excluded; a member has no
 * contact that could receive) — they are part of the vocabulary here so the
 * count feedback cannot invent its own phrasing, and are derived by PR-C's
 * resolver, not by `marketingNonReceiptReasons`.
 *
 * Pure TypeScript — no framework imports.
 */
import type { MarketingState } from './contact';
import type { MemberStatus } from './member';

export const MARKETING_REASONS = [
  'member_inactive',
  'member_archived',
  'member_erased',
  'member_halted',
  'contact_removed',
  'off_by_staff',
  'off_by_contact',
  'unsubscribed',
  'sender_own_contact',
  'member_no_eligible_contact',
] as const;
export type MarketingReason = (typeof MARKETING_REASONS)[number];

export interface MarketingReasonInput {
  readonly memberStatus: MemberStatus;
  readonly memberErased: boolean;
  readonly memberHalted: boolean;
  readonly contactRemoved: boolean;
  /** The DISPLAYED state (`deriveMarketingState`); `'unavailable'` asserts nothing. */
  readonly state: MarketingState;
}

/**
 * Every reason that applies, member-level first. An empty array means the
 * contact receives marketing as far as this row can tell.
 */
export function marketingNonReceiptReasons(
  input: MarketingReasonInput,
): readonly MarketingReason[] {
  const reasons: MarketingReason[] = [];
  if (input.memberStatus === 'inactive') reasons.push('member_inactive');
  if (input.memberStatus === 'archived') reasons.push('member_archived');
  if (input.memberErased) reasons.push('member_erased');
  if (input.memberHalted) reasons.push('member_halted');
  if (input.contactRemoved) reasons.push('contact_removed');
  switch (input.state) {
    case 'off_by_staff':
      reasons.push('off_by_staff');
      break;
    case 'off_by_contact':
      reasons.push('off_by_contact');
      break;
    case 'unsubscribed':
      reasons.push('unsubscribed');
      break;
    case 'on':
    case 'unavailable':
      break;
  }
  return reasons;
}
