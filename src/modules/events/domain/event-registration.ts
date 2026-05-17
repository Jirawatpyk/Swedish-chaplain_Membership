/**
 * T021 — `EventRegistrationAggregate` + supporting VOs (F6 Domain).
 *
 * One row per attendee registration. Carries:
 *   - attendee identity (subject to FR-032 differentiated retention)
 *   - match resolution (FR-012)
 *   - ticket info (record-only from EventCreate)
 *   - quota effect flags (FR-015–FR-018)
 *
 * Pseudonymisation marker: `piiPseudonymisedAt !== null` → `attendee.email`,
 * `attendee.name`, `attendee.company` are deterministic salted SHA-256
 * hashes (per-tenant salt from EVENTCREATE_PII_PSEUDONYM_SALT) and the
 * row is locked against admin relink — the relink dialog returns
 * "Cannot relink — attendee PII has been retention-purged" (FR-014).
 *
 * Pure TypeScript — Constitution Principle III. Cross-module branded
 * types come from public barrels.
 */
import type { TenantId, MemberId, ContactId } from '@/modules/members';
import type {
  EventId,
  RegistrationId,
  ExternalAttendeeId,
  AttendeeEmail,
} from './branded-types';
import type { MatchType } from './value-objects/match-type';
import type { PaymentStatus } from './value-objects/payment-status';

export interface Attendee {
  readonly email: AttendeeEmail;
  readonly name: string;
  readonly company: string | null;
}

export interface MatchResolution {
  readonly type: MatchType;
  readonly matchedMemberId: MemberId | null;
  readonly matchedContactId: ContactId | null;
}

/**
 * Phase C C2 — type-narrowed view per match_type variant. The aggregate
 * keeps the existing flat shape for migration-friendliness; this
 * discriminated union lets callers pattern-match against the
 * per-variant invariants. The migration 0136 CHECK constraint enforces
 * the same shape at write time:
 *   - 'non_member' / 'unmatched' → both IDs null + both counters false
 *   - 'member_contact' → matched_member_id + matched_contact_id present
 *   - 'member_domain' / 'member_fuzzy' → matched_member_id only
 */
export type MatchResolutionView =
  | {
      readonly type: 'member_contact';
      readonly matchedMemberId: MemberId;
      readonly matchedContactId: ContactId;
    }
  | {
      readonly type: 'member_domain' | 'member_fuzzy';
      readonly matchedMemberId: MemberId;
      readonly matchedContactId: null;
    }
  | {
      readonly type: 'non_member' | 'unmatched';
      readonly matchedMemberId: null;
      readonly matchedContactId: null;
    };

/**
 * Refine a `MatchResolution` to its variant-narrowed form. Returns null
 * if the underlying data violates the DB CHECK invariant (defensive —
 * the DB rejects writes that violate this; this returns null so
 * callers can fail gracefully without throwing).
 */
export function asMatchResolutionView(
  m: MatchResolution,
): MatchResolutionView | null {
  if (m.type === 'member_contact') {
    if (m.matchedMemberId !== null && m.matchedContactId !== null) {
      return {
        type: 'member_contact',
        matchedMemberId: m.matchedMemberId,
        matchedContactId: m.matchedContactId,
      };
    }
    return null;
  }
  if (m.type === 'member_domain' || m.type === 'member_fuzzy') {
    if (m.matchedMemberId !== null && m.matchedContactId === null) {
      return {
        type: m.type,
        matchedMemberId: m.matchedMemberId,
        matchedContactId: null,
      };
    }
    return null;
  }
  // non_member | unmatched
  if (m.matchedMemberId === null && m.matchedContactId === null) {
    return { type: m.type, matchedMemberId: null, matchedContactId: null };
  }
  return null;
}

export interface Ticket {
  readonly type: string | null;
  readonly priceThb: number | null;
  readonly paymentStatus: PaymentStatus;
}

/**
 * Quota effect flags. Both default to FALSE; turned TRUE by
 * `apply-quota-effect.ts` (Phase 6 T085) when the matched member's plan
 * has remaining allotment AND the event qualifies (partner-benefit or
 * cultural). The DB CHECK constraint on `event_registrations` enforces
 * that non-member / unmatched rows MUST keep both flags FALSE (FR-013).
 */
export interface QuotaEffect {
  readonly countedAgainstPartnership: boolean;
  readonly countedAgainstCulturalQuota: boolean;
}

export interface EventRegistrationAggregate {
  readonly tenantId: TenantId;
  readonly registrationId: RegistrationId;
  readonly eventId: EventId;
  readonly externalId: ExternalAttendeeId;

  readonly attendee: Attendee;
  readonly match: MatchResolution;
  readonly ticket: Ticket;
  readonly quotaEffect: QuotaEffect;

  readonly metadata: Readonly<Record<string, unknown>>;

  readonly registeredAt: Date;
  readonly importedAt: Date;
  readonly piiPseudonymisedAt: Date | null;
}

/**
 * Pure predicate: a row whose PII has been retention-purged is locked
 * against admin relink (FR-014). Used by Phase 9 `relink-registration`
 * use-case and the relink dialog UI.
 */
export function isPseudonymised(
  reg: Pick<EventRegistrationAggregate, 'piiPseudonymisedAt'>,
): boolean {
  return reg.piiPseudonymisedAt !== null;
}
