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
 * per-variant invariants.
 *
 * R3.5.4 honest-doc closure — migration 0136 CHECK constraint enforces
 * ONLY the `'non_member' | 'unmatched' → both IDs null + both counters
 * false` invariant at write time (see
 * `drizzle/migrations/0136_f6_event_registrations_non_member_no_contact_check.sql`).
 * The positive-set invariants for the remaining variants:
 *   - 'member_contact' → matched_member_id + matched_contact_id present
 *   - 'member_domain' / 'member_fuzzy' → matched_member_id only
 * ...are enforced by application-layer (the F6 Phase 3 ingest pipeline
 * + Phase 4 admin routes) + the FK column nullability on
 * `matched_member_id` / `matched_contact_id` (which permits null at
 * the column level — the discriminated invariant lives in the
 * use-case path). R3.4.2 added a read-time defense:
 * `drizzleRegistrationsRepository.toAggregate` calls
 * `asMatchResolutionView` which throws `MatchResolutionInvariantError`
 * + bumps the `eventcreate_match_resolution_invariant_violation_total`
 * metric if any read-time row violates the invariant.
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
 * Refine a `MatchResolution` to its variant-narrowed form. Throws
 * `Error` if the underlying data violates the DB CHECK invariant at
 * migration 0136 — invariant violation at READ-time is an in-memory
 * bug (DB rejects writes that violate this), so we fail loudly rather
 * than silently returning null.
 *
 * Round 2 R2-S1 / H3.2 — the aggregate field `EventRegistrationAggregate.match`
 * is now typed as `MatchResolutionView`, and the Drizzle repo mapper
 * calls this function at the row→aggregate boundary.
 */
export class MatchResolutionInvariantError extends Error {
  constructor(public readonly raw: MatchResolution) {
    super(
      `MatchResolution invariant violated at read-time: type=${raw.type} matchedMemberId=${raw.matchedMemberId === null ? 'null' : 'set'} matchedContactId=${raw.matchedContactId === null ? 'null' : 'set'}`,
    );
    this.name = 'MatchResolutionInvariantError';
  }
}

export function asMatchResolutionView(m: MatchResolution): MatchResolutionView {
  if (m.type === 'member_contact') {
    if (m.matchedMemberId !== null && m.matchedContactId !== null) {
      return {
        type: 'member_contact',
        matchedMemberId: m.matchedMemberId,
        matchedContactId: m.matchedContactId,
      };
    }
    throw new MatchResolutionInvariantError(m);
  }
  if (m.type === 'member_domain' || m.type === 'member_fuzzy') {
    if (m.matchedMemberId !== null && m.matchedContactId === null) {
      return {
        type: m.type,
        matchedMemberId: m.matchedMemberId,
        matchedContactId: null,
      };
    }
    throw new MatchResolutionInvariantError(m);
  }
  // non_member | unmatched
  if (m.matchedMemberId === null && m.matchedContactId === null) {
    return { type: m.type, matchedMemberId: null, matchedContactId: null };
  }
  throw new MatchResolutionInvariantError(m);
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
  /**
   * H3.2 — tightened from `MatchResolution` to `MatchResolutionView`.
   * The Drizzle repo mapper calls `asMatchResolutionView()` at the
   * row→aggregate boundary; readers pattern-match on `match.type` and
   * get the per-variant invariant (e.g. `member_contact` →
   * `matchedMemberId` and `matchedContactId` are both non-null at
   * compile time).
   */
  readonly match: MatchResolutionView;
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
