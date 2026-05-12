/**
 * T029 — `AttendeeMatcher` Application port (F6).
 *
 * The 4-rule match cascade per FR-012 + research.md R4:
 *   1. `member_contact` — exact contact-email match against
 *                          `contacts.email` (case-insensitive)
 *   2. `member_domain`  — email-domain match against
 *                          `members.email_domain` IF the attendee's
 *                          email domain is NOT on the personal-email
 *                          deny list (research.md R4 / data-model.md § 5)
 *   3. `member_fuzzy`   — Levenshtein-distance match (≤2 by default)
 *                          on `normaliseCompanyName(attendee.company)`
 *                          vs. each member's
 *                          `members.normalised_company_name`. Returns
 *                          the unique winner; ambiguity → `unmatched`.
 *   4. `non_member`     — none of the above; attendee has valid email
 *                          but no member affinity
 *   5. `unmatched`      — explicitly ambiguous fuzzy (>1 winners with
 *                          equal distance) — admin must relink per FR-014
 *
 * The Infrastructure adapter (`drizzle-attendee-matcher.ts`, Phase 3
 * T046) issues SQL against F3's `members` + `contacts` tables read-only.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { Result } from '@/lib/result';
import type { TenantId, MemberId, ContactId } from '@/modules/members';
import type {
  AttendeeEmail,
} from '../../domain/branded-types';
import type { MatchResolution } from '../../domain/event-registration';

export interface MatchAttendeeInput {
  readonly tenantId: TenantId;
  readonly attendeeEmail: AttendeeEmail;
  readonly attendeeCompany: string | null;
  /**
   * Optional Levenshtein-distance threshold for step 3 fuzzy match.
   * Default 2 per research.md R4. Passed explicitly so test fixtures
   * can dial the threshold.
   */
  readonly fuzzyDistanceThreshold?: number;
}

/**
 * Match outcome — shape mirrors the Domain `MatchResolution` aggregate
 * plus optional fuzzy-match diagnostics for the audit payload (per
 * contracts/audit-port.md § 2).
 */
export interface MatchAttendeeOutput {
  readonly resolution: MatchResolution;
  /**
   * Populated when `resolution.type === 'member_fuzzy'`. Records the
   * matched member's normalised company name + Levenshtein distance
   * to the attendee company — emitted to the
   * `attendee_matched_member_fuzzy` audit event.
   */
  readonly fuzzyDetail: {
    readonly attendeeCompanyOriginal: string;
    readonly matchedMemberCompanyNormalised: string;
    readonly levenshteinDistance: number;
  } | null;
  /**
   * Populated when `resolution.type === 'unmatched'`. Lists every
   * candidate member that tied at the lowest Levenshtein distance for
   * forensic audit + admin manual-relink decision support.
   */
  readonly unmatchedCandidates: ReadonlyArray<{
    readonly memberId: MemberId;
    readonly levenshteinDistance: number;
  }> | null;
}

export type AttendeeMatcherError =
  | { readonly kind: 'db_error'; readonly message: string };

export interface AttendeeMatcher {
  match(
    input: MatchAttendeeInput,
  ): Promise<Result<MatchAttendeeOutput, AttendeeMatcherError>>;
}

/**
 * Helper accessor — narrows the resolution to the contact-match shape
 * for the audit payload (`attendee_matched_member_contact`).
 */
export function isContactMatch(
  resolution: MatchResolution,
): resolution is MatchResolution & {
  matchedMemberId: MemberId;
  matchedContactId: ContactId;
} {
  return (
    resolution.type === 'member_contact' &&
    resolution.matchedMemberId !== null &&
    resolution.matchedContactId !== null
  );
}
