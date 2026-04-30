/**
 * T066 — `resolve-segment-recipients.ts` Application use-case (F7).
 *
 * Resolves a `RecipientSegment` to a deduplicated, suppression-filtered,
 * self-excluded, halt-aware recipient list. The single source of truth
 * for "who actually receives this broadcast" used by both submit-time
 * (estimatedRecipientCount) and dispatch-time (actual send list).
 *
 * Pipeline:
 *   1. Dispatch by segment kind →
 *      - all_members / tier → membersBridge.getMembersBySegment
 *      - event_attendees_last_90d → eventAttendees.getLastNinetyDayAttendees (F6 stub returns [])
 *      - custom → use input emails (already validated by validate-custom-recipients)
 *   2. Filter halted members (already done by F3 use-case)
 *   3. Filter self (Q16 — exclude requesting member's primary contact email)
 *   4. Filter suppressed (marketingUnsubscribesRepo.lookupBatch)
 *   5. Surface orphans (members with NULL primary email — caller emits
 *      `broadcast_member_missing_primary_contact_email` audit per orphan)
 *   6. Hard-cap 5,000 (FR-016a)
 *
 * Returns the resolved recipient list (non-empty if successful) +
 * orphan member ids + dedup count for observability.
 */
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { RecipientSegment } from '../../domain/recipient-segment';
import type { MembersBridgePort } from '../ports/members-bridge-port';
import type { EventAttendeesRepository } from '../ports/event-attendees-repository';
import type { MarketingUnsubscribesRepo } from '../ports/marketing-unsubscribes-repo';
import {
  unsafeBrandEmailLower,
  type EmailLower,
} from '../../domain/value-objects/email-lower';

const AUDIENCE_HARD_CAP = 5000;

export type ResolveSegmentError =
  | { readonly kind: 'broadcast_empty_segment_blocked' }
  | {
      readonly kind: 'broadcast_audience_too_large';
      readonly count: number;
      readonly cap: number;
    };

export interface ResolveSegmentDeps {
  readonly tenant: TenantContext;
  readonly membersBridge: MembersBridgePort;
  readonly eventAttendees: EventAttendeesRepository;
  readonly marketingUnsubscribes: MarketingUnsubscribesRepo;
}

export interface ResolveSegmentInput {
  readonly segment: RecipientSegment;
  /** Member submitting the broadcast — excluded from recipients (Q16). */
  readonly requestingMemberPrimaryEmail: EmailLower | null;
  /** Already-validated custom emails (when segment.kind === 'custom'). */
  readonly customRecipients: ReadonlyArray<EmailLower> | null;
}

export interface ResolveSegmentOutput {
  readonly recipients: ReadonlyArray<EmailLower>;
  readonly estimatedCount: number;
  /** Member IDs missing a primary contact email (audit emit per orphan). */
  readonly orphans: ReadonlyArray<string>;
}

export async function resolveSegmentRecipients(
  deps: ResolveSegmentDeps,
  input: ResolveSegmentInput,
): Promise<Result<ResolveSegmentOutput, ResolveSegmentError>> {
  const { segment } = input;

  // Step 1: dispatch by segment kind
  let candidates: ReadonlyArray<EmailLower> = [];
  const orphans: string[] = [];

  if (segment.kind === 'all_members' || segment.kind === 'tier') {
    const members = await deps.membersBridge.getMembersBySegment(
      deps.tenant,
      segment.kind === 'all_members' ? 'all_members' : 'tier',
      segment.kind === 'tier' ? { tierCodes: segment.tierCodes } : {},
    );
    const emails: EmailLower[] = [];
    for (const m of members) {
      if (m.primaryContactEmail === null) {
        orphans.push(m.memberId);
        continue;
      }
      emails.push(m.primaryContactEmail);
    }
    candidates = emails;
  } else if (segment.kind === 'event_attendees_last_90d') {
    const attendees = await deps.eventAttendees.getLastNinetyDayAttendees(
      deps.tenant,
    );
    candidates = attendees.map((a) => a.emailLower);
  } else if (segment.kind === 'custom') {
    candidates = input.customRecipients ?? [];
  }

  // Step 2 (halted) is enforced by membersBridge.getMembersBySegment
  // (F3 use-case excludes halted members before returning).

  // Step 3: exclude self
  const selfExcluded =
    input.requestingMemberPrimaryEmail === null
      ? candidates
      : candidates.filter((e) => e !== input.requestingMemberPrimaryEmail);

  // Deduplicate (lower-cased branded values)
  const dedup = Array.from(new Set(selfExcluded)) as EmailLower[];

  // Step 4: suppression filter (single batched query)
  let final: EmailLower[] = dedup;
  if (dedup.length > 0) {
    const suppressed = await deps.marketingUnsubscribes.lookupBatch(
      deps.tenant.slug,
      dedup,
    );
    final = dedup.filter((e) => !suppressed.has(e));
  }

  // Brand-cast (defence-in-depth — primary contact emails could be string at the source)
  final = final.map((e) => unsafeBrandEmailLower(e));

  // Step 5: empty-after-filter check
  if (final.length === 0) {
    return err({ kind: 'broadcast_empty_segment_blocked' });
  }

  // Step 6: 5,000 hard cap
  if (final.length > AUDIENCE_HARD_CAP) {
    return err({
      kind: 'broadcast_audience_too_large',
      count: final.length,
      cap: AUDIENCE_HARD_CAP,
    });
  }

  return ok({
    recipients: final,
    estimatedCount: final.length,
    orphans,
  });
}
