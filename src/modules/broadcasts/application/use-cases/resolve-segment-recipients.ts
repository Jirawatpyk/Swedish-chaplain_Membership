/**
 * T066 — `resolve-segment-recipients.ts` Application use-case (F7).
 *
 * Resolves a `RecipientSegment` to a deduplicated, suppression-filtered,
 * self-excluded, halt-aware recipient list. The single source of truth
 * for "who actually receives this broadcast" used by submit-time
 * (estimatedRecipientCount), the recipient-count endpoints, and every
 * dispatch path (dispatch-scheduled, split-large-broadcasts,
 * dispatch-batches). Any other recipient query is a defect (108 contract
 * broadcast-audience § preamble).
 *
 * Pipeline (108 PR-C, contract § 2):
 *   1. Source by segment kind →
 *      - all_members / tier, `audienceMode = 'all_contacts'` →
 *        membersBridge.getContactsBySegment: every eligible contact of every
 *        eligible member (FR-020); a null contact is an orphan (FR-029)
 *      - all_members / tier, `audienceMode = 'primary_only'` →
 *        membersBridge.getMembersBySegment: one primary per member (the
 *        pre-108 leg; a null primary email is an orphan)
 *      - event_attendees_last_90d → eventAttendees.getLastNinetyDayAttendees
 *      - custom → input emails (already validated by validate-custom-recipients)
 *      A failed bridge read on either member leg is a typed
 *      `resolve.server_error` — never an empty audience (research R8).
 *   2. Halted / inactive / archived / erased members are excluded by the F3
 *      query behind the bridge (FR-021), on both legs.
 *   3. Self-exclusion by MEMBER id (`requestingMemberId`): every contact of
 *      the submitting member, member-based segments only (FR-022, FR-022a —
 *      the custom list is exempt; the old email-equality arm is gone).
 *   4. Dedupe by address (FR-023).
 *   5. Suppression: `lookupBatch` in chunks of 5,000.
 *  5b. Per-contact marketing opt-out (108 PR-D, FR-022a) —
 *      `membersBridge.filterMarketingOptedOut`, AFTER suppression so an
 *      address on both lists counts once; a failed lookup REJECTS (throws),
 *      never fail-open. On the all_contacts leg the F3 query already
 *      excluded opted-out contacts, so this is defence in depth there.
 *   6. Empty → `broadcast_empty_segment_blocked`; above the cap →
 *      `broadcast_audience_too_large` — never truncated (FR-016a, US5).
 *
 * `droppedByPreference` (FR-022a "tell the sender how many"): every
 * opt-out drop, plus — for the custom list and the attendee segment only —
 * every suppression drop (US3 AS9: "2 addresses were excluded by recipient
 * preference" covers an unsubscribed address as much as a switched-off
 * one). On a member-based segment an unsubscribed person is simply not in
 * the audience, so suppression is not a "drop" there.
 */
import { err, ok, type Result } from '@/lib/result';
import { broadcastsMetrics } from '@/lib/metrics';
import type { TenantContext } from '@/modules/tenants';
import type { RecipientSegment } from '../../domain/recipient-segment';
import type { AudienceMode } from '../../domain/audience-mode';
import type { MembersBridgePort } from '../ports/members-bridge-port';
import type { EventAttendeesRepository } from '../ports/event-attendees-repository';
import type { MarketingUnsubscribesRepo } from '../ports/marketing-unsubscribes-repo';
import {
  unsafeBrandEmailLower,
  type EmailLower,
} from '../../domain/value-objects/email-lower';

/**
 * Contract § 2 step 5 — `lookupBatch` chunk size. A 50,000-recipient audience
 * (US5, batching ON) is 10 round trips, never one 50,000-parameter `= ANY`.
 * 5,000 rather than 1,000: the resolve is latency-bound (T081 measured
 * 20,000 contacts at 42 round trips ≈ 9–11 s from a ~220 ms-RTT workstation),
 * and the F3 opt-out filter already sends the whole batch as one array.
 */
const SUPPRESSION_LOOKUP_CHUNK = 5000;

export type ResolveSegmentError =
  | { readonly kind: 'broadcast_empty_segment_blocked' }
  | {
      readonly kind: 'broadcast_audience_too_large';
      readonly count: number;
      readonly cap: number;
    }
  /**
   * 108 PR-C — the member-leg bridge read failed (Neon outage, RLS denial,
   * a keyset page that did not come back). Typed so submit maps it to
   * `submit.server_error` (no reject audit — nothing was decided) and the
   * dispatch paths to `dispatch.server_error` (the broadcast stays
   * `approved`; the next tick retries). It must never be reported as an
   * empty or too-large audience.
   */
  | { readonly kind: 'resolve.server_error'; readonly message: string };

export interface ResolveSegmentDeps {
  readonly tenant: TenantContext;
  readonly membersBridge: MembersBridgePort;
  readonly eventAttendees: EventAttendeesRepository;
  readonly marketingUnsubscribes: MarketingUnsubscribesRepo;
  /**
   * 108 PR-C — which leg builds a member-based audience. Decided once in the
   * composition root from `FEATURE_CONTACT_MARKETING_RECIPIENTS`; see
   * `domain/audience-mode.ts`.
   */
  readonly audienceMode: AudienceMode;
  /**
   * 108 PR-C T085 (FR-041 / FR-042) — the ONE ceiling,
   * `audienceCeiling(batchingEnabled)` from `domain/audience-ceiling.ts`,
   * passed in by the composition root so count, submit and dispatch compare
   * against the same number and the refusal echoes it. Never truncate to it.
   */
  readonly audienceCeiling: number;
}

export interface ResolveSegmentInput {
  readonly segment: RecipientSegment;
  /**
   * Member submitting the broadcast — EVERY contact of that member is
   * excluded from a member-based audience (FR-022; Q16 widened from "the
   * primary contact email"). `null` for a non-member caller (an admin
   * counting an audience without a proxied member).
   */
  readonly requestingMemberId: string | null;
  /** Already-validated custom emails (when segment.kind === 'custom'). */
  readonly customRecipients: ReadonlyArray<EmailLower> | null;
  /**
   * Which call site is asking (code-review finding 6). This resolver runs at
   * SUBMIT and again at DISPATCH; `broadcasts.marketing_opt_out_filter_count`
   * is documented as a per-dispatch counter whose ABSENCE is the alarm, so
   * submits emitting the same series would keep it alive and mask a dead
   * dispatch-side filter — the exact failure the emit-at-zero design exists to
   * catch. The label also stops the same drop being counted twice.
   */
  readonly phase: 'submit' | 'dispatch';
}

export interface ResolveSegmentOutput {
  readonly recipients: ReadonlyArray<EmailLower>;
  readonly estimatedCount: number;
  /**
   * Member ids with NO eligible contact (FR-029) — the caller emits the
   * missing-recipient audit per orphan. On the primary_only leg: a null
   * primary email. On the all_contacts leg: zero live, not-opted-out
   * contacts (a member with secondaries but no primary is NOT an orphan).
   */
  readonly orphans: ReadonlyArray<string>;
  /**
   * FR-022a — entries removed "by recipient preference": every per-contact
   * opt-out drop (any segment kind), plus every suppression drop on the
   * custom list and the attendee segment (see the module docblock). Counted
   * separately from `orphans`. Shown to the sender as a number, never as
   * addresses.
   */
  readonly droppedByPreference: number;
}

interface Candidate {
  /** Owning member for self-exclusion; null for attendee / custom entries. */
  readonly memberId: string | null;
  readonly emailLower: EmailLower;
}

async function lookupSuppressedChunked(
  repo: MarketingUnsubscribesRepo,
  tenantId: string,
  emails: ReadonlyArray<EmailLower>,
): Promise<ReadonlySet<EmailLower>> {
  const suppressed = new Set<EmailLower>();
  for (let i = 0; i < emails.length; i += SUPPRESSION_LOOKUP_CHUNK) {
    const chunk = emails.slice(i, i + SUPPRESSION_LOOKUP_CHUNK);
    const hit = await repo.lookupBatch(tenantId, chunk);
    for (const e of hit) suppressed.add(e);
  }
  return suppressed;
}

export async function resolveSegmentRecipients(
  deps: ResolveSegmentDeps,
  input: ResolveSegmentInput,
): Promise<Result<ResolveSegmentOutput, ResolveSegmentError>> {
  const { segment } = input;
  const memberBased = segment.kind === 'all_members' || segment.kind === 'tier';

  // Step 1: source by segment kind
  let candidates: ReadonlyArray<Candidate> = [];
  const orphans: string[] = [];

  if (segment.kind === 'all_members' || segment.kind === 'tier') {
    const params =
      segment.kind === 'tier' ? { tierCodes: segment.tierCodes } : {};
    const sourced: Candidate[] = [];
    try {
      if (deps.audienceMode === 'all_contacts') {
        const rows = await deps.membersBridge.getContactsBySegment(
          deps.tenant,
          segment.kind,
          params,
        );
        for (const r of rows) {
          if (r.contactId === null || r.emailLower === null) {
            orphans.push(r.memberId);
            continue;
          }
          sourced.push({ memberId: r.memberId, emailLower: r.emailLower });
        }
      } else {
        const members = await deps.membersBridge.getMembersBySegment(
          deps.tenant,
          segment.kind,
          params,
        );
        for (const m of members) {
          if (m.primaryContactEmail === null) {
            orphans.push(m.memberId);
            continue;
          }
          sourced.push({ memberId: m.memberId, emailLower: m.primaryContactEmail });
        }
      }
    } catch (e) {
      // The bridge already logged the class of failure; the caller decides
      // whether this is a retry (dispatch) or a 500 (submit).
      return err({
        kind: 'resolve.server_error',
        message: e instanceof Error ? e.message : 'unknown error',
      });
    }
    candidates = sourced;
    // 108 PR-C T090 — one increment per member-based resolve, labelled by the
    // leg in force so the flag flip shows on the dashboard.
    broadcastsMetrics.audienceResolvedTotal(deps.tenant.slug, segment.kind, deps.audienceMode);
  } else if (segment.kind === 'event_attendees_last_90d') {
    const attendees = await deps.eventAttendees.getLastNinetyDayAttendees(
      deps.tenant,
    );
    candidates = attendees.map((a) => ({ memberId: null, emailLower: a.emailLower }));
  } else if (segment.kind === 'custom') {
    candidates = (input.customRecipients ?? []).map((emailLower) => ({
      memberId: null,
      emailLower,
    }));
  }

  // Step 2 (member eligibility: active, not erased, not halted) is enforced
  // by the F3 query behind the bridge on both legs (FR-021).

  // Step 3: self-exclusion by member id — member-based segments only. The
  // custom list is exempt (FR-022a, contract § 2 step 3); attendee rows are
  // not member-keyed here.
  const selfExcluded =
    memberBased && input.requestingMemberId !== null
      ? candidates.filter((c) => c.memberId !== input.requestingMemberId)
      : candidates;

  // Step 4: dedupe by address (lower-cased branded values), keeping order.
  const dedup = Array.from(new Set(selfExcluded.map((c) => c.emailLower)));

  // Step 5: suppression filter, chunked (contract § 2 step 5).
  let final: EmailLower[] = dedup;
  let suppressionDropped = 0;
  if (dedup.length > 0) {
    const suppressed = await lookupSuppressedChunked(
      deps.marketingUnsubscribes,
      deps.tenant.slug,
      dedup,
    );
    final = dedup.filter((e) => !suppressed.has(e));
    // T172 — emit-site wiring (Phase 9). Number of recipients dropped
    // by the suppression anti-join.
    suppressionDropped = dedup.length - final.length;
    if (suppressionDropped > 0) {
      broadcastsMetrics.suppressionFilterCount(deps.tenant.slug, suppressionDropped);
    }
  }

  // Step 5b (108 PR-D, FR-022a): per-contact marketing opt-out — runs on
  // the post-suppression list so a double-listed address counts once, and
  // is skipped when nothing is left. The bridge REJECTS on a failed lookup:
  // never fail-open onto people who objected (privacy B-1 / security HIGH-1).
  // On the all_contacts leg the SQL already excluded opted-out contacts;
  // this is defence in depth there and the count is still MEASURED.
  let optOutDropped = 0;
  if (final.length > 0) {
    const optedOut = await deps.membersBridge.filterMarketingOptedOut(
      deps.tenant,
      final,
    );
    if (optedOut.size > 0) {
      // Measured, not trusted: a bridge answering outside the batch must not
      // inflate the count or the metric (review LOW-17).
      const before = final.length;
      final = final.filter((e) => !optedOut.has(e));
      optOutDropped = before - final.length;
    }
    // Emitted whenever the filter RAN, including at zero (staff review P2).
    // Guarding on `> 0` made "nobody has opted out" and "step 5b was deleted"
    // the same signal — no series either way — and SweCham cuts over with zero
    // opt-outs, so the catalogue's "a drop to 0 means the filter stopped"
    // alarm could never have fired. `.add(0)` still registers the series.
    // Labelled by phase (code-review finding 6): the alarm watches the
    // `dispatch` series, which ongoing submits must not keep alive.
    broadcastsMetrics.marketingOptOutFilterCount(
      deps.tenant.slug,
      optOutDropped,
      input.phase,
    );
  }

  // FR-022a — what the sender is told was "excluded by recipient preference".
  const droppedByPreference =
    optOutDropped + (memberBased ? 0 : suppressionDropped);

  // Brand-cast (defence-in-depth — primary contact emails could be string at the source)
  final = final.map((e) => unsafeBrandEmailLower(e));

  // Step 6: empty-after-filter check
  if (final.length === 0) {
    return err({ kind: 'broadcast_empty_segment_blocked' });
  }

  // Step 6: the ceiling — never truncated (FR-041), one definition (FR-042)
  if (final.length > deps.audienceCeiling) {
    return err({
      kind: 'broadcast_audience_too_large',
      count: final.length,
      cap: deps.audienceCeiling,
    });
  }

  return ok({
    recipients: final,
    estimatedCount: final.length,
    orphans,
    droppedByPreference,
  });
}
