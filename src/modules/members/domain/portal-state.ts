/**
 * Portal-access state of a member's PRIMARY contact, as shown in the admin
 * members directory (design doc 2026-07-23 §3.1, D1/D2).
 *
 * Pure domain — no framework imports. `now` is injected so the badge (derived
 * here) and the needs-invite SQL filter (derived from a bound timestamp) judge
 * expiry against the SAME instant (D8).
 *
 * `linkedUserId === null` safely means "never invited": `contacts.linked_user_id`
 * has an FK to `users` with ON DELETE SET NULL (0009_members_contacts.sql:137),
 * so the nightly prune of expired pending users nulls the column rather than
 * leaving a dangling id. (The Drizzle schema declares the column without the
 * reference — read the migration, not schema-contacts.ts.)
 */

export type PortalState =
  | 'active'
  | 'invited'
  | 'invite_expired'
  | 'not_invited';

export interface DerivePortalStateInput {
  readonly linkedUserId: string | null;
  /**
   * The FRESHEST unconsumed invitation for the linked user, or null when the
   * user has none (which — given the repo's never-redeemed anti-join — means
   * they activated). The repo is responsible for picking "freshest"; this
   * function trusts it.
   */
  readonly pendingInvitation: { readonly expiresAt: Date } | null;
  readonly now: Date;
}

export function derivePortalState(input: DerivePortalStateInput): PortalState {
  if (input.linkedUserId === null) return 'not_invited';
  if (input.pendingInvitation === null) return 'active';
  // `<=` matches the detail page's inline expiry test
  // (admin/members/[memberId]/page.tsx:270-276) so the two surfaces cannot
  // disagree on a borderline invitation.
  return input.pendingInvitation.expiresAt.getTime() <= input.now.getTime()
    ? 'invite_expired'
    : 'invited';
}
