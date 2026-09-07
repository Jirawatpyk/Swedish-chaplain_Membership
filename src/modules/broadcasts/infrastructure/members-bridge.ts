/**
 * T060 — F3 `MembersBridgePort` adapter (F7).
 *
 * Routes the F7 port surface to F3's barrel exports added in Batch C
 * (T029). Bridges the F3 `F7MemberRecipient` projection (string emails)
 * to F7's `MemberRecipient` (branded `EmailLower`).
 *
 * Segment dispatch:
 *   - `all_members` / `tier`, `audienceMode = 'primary_only'` → F3
 *     `getMembersBySegment` (one primary per member)
 *   - `all_members` / `tier`, `audienceMode = 'all_contacts'` → F3
 *     `getBroadcastRecipientContacts` (keyset walk, 5,000/page) +
 *     `countBroadcastOptedOutContacts` (108 PR-C)
 *   - `event_attendees_last_90d` / `custom` → return `[]` (resolved by
 *     F7's own use-cases via `EventAttendeesRepository` stub +
 *     `validate-custom-recipients`)
 *
 * Halt-state dispatch (Q14): the F3 use-case sets/clears the flag column
 * directly. F7 caller is responsible for emitting cross-module audit
 * events (`broadcast_member_dispatch_resumed`) at its own boundary
 * because F3's audit-event union does not include F7-owned events
 * (architectural deviation documented in plan.md § Complexity Tracking).
 */
import { ok, err, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { broadcastsMetrics } from '@/lib/metrics';
import { errKind } from '@/lib/log-id';
import type { TenantContext } from '@/modules/tenants';
import {
  drizzleMemberRepo,
  drizzleContactRepo,
  asMemberId,
  getMembersBySegment as f3GetMembersBySegment,
  getBroadcastRecipientContacts as f3GetBroadcastRecipientContacts,
  countBroadcastOptedOutContacts as f3CountBroadcastOptedOutContacts,
  type BroadcastRecipientCursor,
  getMemberPrimaryContact as f3GetMemberPrimaryContact,
  getMemberPreferredLocale as f3GetMemberPreferredLocale,
  lookupContactEmailInTenant as f3LookupContactEmailInTenant,
  filterMarketingOptedOutEmails as f3FilterMarketingOptedOutEmails,
  lookupMemberPrimaryContactEmailInTenant as f3LookupMemberPrimaryContactEmailInTenant,
  getMembersHaltedInTenant as f3GetMembersHaltedInTenant,
  setMemberHalt as f3SetMemberHalt,
  markBroadcastsAcknowledged as f3MarkBroadcastsAcknowledged,
} from '@/modules/members';
import type { BroadcastSegmentType } from '../domain/value-objects/segment-type';
import { unsafeBrandEmailLower } from '../domain/value-objects/email-lower';
import type {
  ContactLookup,
  ContactRecipient,
  MarkAckError,
  MarkAckSuccess,
  MemberHaltError,
  MemberHaltSummary,
  MemberRecipient,
  MembersBridgePort,
  SegmentResolveParams,
} from '../application/ports/members-bridge-port';
import type { EmailLower } from '../domain/value-objects/email-lower';

/**
 * 108 PR-C — F3 keyset page size for the 1:N audience (contract
 * broadcast-audience § 2 step 1). One round trip per 5,000 rows; a 50,000
 * ceiling is 10 pages. Raised from 1,000 by T081: 20,000 contacts at
 * 1,000-row pages were 42 round trips ≈ 9–11 s from a ~220 ms-RTT
 * workstation against FR-043's 3 s — the walk is latency-bound, so fewer,
 * larger pages are the honest fix (5,000 rows is ~500 KB of ids + emails).
 */
const CONTACT_PAGE_SIZE = 5000;

function brandRecipient(r: {
  memberId: string;
  displayName: string;
  primaryContactEmail: string | null;
  tierCode: string | null;
  broadcastsHaltedUntilAdminReview: boolean;
}): MemberRecipient {
  return {
    memberId: r.memberId,
    displayName: r.displayName,
    primaryContactEmail:
      r.primaryContactEmail !== null
        ? unsafeBrandEmailLower(r.primaryContactEmail.toLowerCase().trim())
        : null,
    tierCode: r.tierCode,
    broadcastsHaltedUntilAdminReview: r.broadcastsHaltedUntilAdminReview,
  };
}

export const membersBridge: MembersBridgePort = {
  async getMembersBySegment(
    tenantCtx: TenantContext,
    segmentType: BroadcastSegmentType,
    params: SegmentResolveParams,
  ): Promise<ReadonlyArray<MemberRecipient>> {
    if (segmentType === 'event_attendees_last_90d' || segmentType === 'custom') {
      // F7 use-cases resolve these via EventAttendeesRepository (stub) +
      // validate-custom-recipients respectively.
      return [];
    }

    const result = await f3GetMembersBySegment(
      { tenant: tenantCtx, memberRepo: drizzleMemberRepo },
      {
        segmentType,
        ...(params.tierCodes !== undefined && { tierCodes: params.tierCodes }),
      },
    );
    if (!result.ok) {
      // 108 PR-C T075 — this used to `return []`, which turned a Neon
      // outage into "nobody to send to" (`broadcast_empty_segment_blocked`):
      // the submit refused with a misleading reason and the dispatch tick
      // marked the broadcast failed for an audience that exists. A failed
      // read must fail the resolve so the caller retries (research R8).
      logger.error(
        {
          err: result.error.code,
          cause: errKind('cause' in result.error ? result.error.cause : undefined),
          tenantId: tenantCtx.slug,
          segmentType,
        },
        'broadcasts.members_bridge.segment_read_failed',
      );
      throw new Error(
        `members-bridge.getMembersBySegment: ${result.error.code} — refusing to resolve an empty audience`,
      );
    }
    return result.value.map(brandRecipient);
  },

  /**
   * 108 PR-C T075 — the 1:N page walk (port docblock has the contract). One
   * F3 call per 5,000 rows, cursor = the last row of the previous page (an
   * orphan's null contact id included — the F3 query compares on member_id
   * alone for that shape). A page shorter than the page size proves
   * exhaustion, so a small audience is one call and an exact multiple costs
   * one extra empty page. A failed page THROWS with the rows read so far in
   * the log (counts only — never an address, FR-053a).
   */
  async getContactsBySegment(
    tenantCtx: TenantContext,
    segmentType: BroadcastSegmentType,
    params: SegmentResolveParams,
  ): Promise<ReadonlyArray<ContactRecipient>> {
    if (segmentType === 'event_attendees_last_90d' || segmentType === 'custom') {
      return [];
    }
    const out: ContactRecipient[] = [];
    let after: BroadcastRecipientCursor | null = null;
    let pages = 0;
    for (;;) {
      const page = await f3GetBroadcastRecipientContacts(
        { tenant: tenantCtx, memberRepo: drizzleMemberRepo },
        {
          segmentType,
          ...(params.tierCodes !== undefined && { tierCodes: params.tierCodes }),
          after,
          limit: CONTACT_PAGE_SIZE,
        },
      );
      pages += 1;
      if (!page.ok) {
        logger.error(
          {
            err: page.error.code,
            cause: errKind('cause' in page.error ? page.error.cause : undefined),
            tenantId: tenantCtx.slug,
            segmentType,
            pages,
            rowsSoFar: out.length,
          },
          'broadcasts.members_bridge.contacts_page_failed',
        );
        throw new Error(
          `members-bridge.getContactsBySegment: ${page.error.code} — refusing to resolve a partial audience`,
        );
      }
      for (const r of page.value) {
        out.push({
          memberId: r.memberId,
          contactId: r.contactId,
          emailLower:
            r.emailLower === null
              ? null
              : unsafeBrandEmailLower(r.emailLower.toLowerCase().trim()),
          hasOptedOutContact: r.hasOptedOutContact,
        });
      }
      if (page.value.length < CONTACT_PAGE_SIZE) {
        // 108 PR-C T090 — pages walked per COMPLETED resolve (never on failure).
        broadcastsMetrics.audiencePagesTotal(tenantCtx.slug, pages);
        return out;
      }
      const last = page.value[page.value.length - 1]!;
      after =
        last.contactId === null
          ? { kind: 'after_member', memberId: last.memberId }
          : { kind: 'after_contact', memberId: last.memberId, contactId: last.contactId };
    }
  },

  async countOptedOutContactsBySegment(
    tenantCtx: TenantContext,
    segmentType: BroadcastSegmentType,
    params: SegmentResolveParams,
  ): Promise<number> {
    // Review 2026-09-07 (FR-022a) — see the port docblock. Not member-keyed
    // → nothing was excluded in SQL for these kinds.
    if (segmentType !== 'all_members' && segmentType !== 'tier') return 0;
    const result = await f3CountBroadcastOptedOutContacts(
      { tenant: tenantCtx, memberRepo: drizzleMemberRepo },
      {
        segmentType,
        ...(params.tierCodes !== undefined && { tierCodes: params.tierCodes }),
      },
    );
    if (!result.ok) {
      logger.error(
        {
          tenantId: tenantCtx.slug,
          segmentType,
          err: result.error.code,
          cause: errKind('cause' in result.error ? result.error.cause : undefined),
        },
        'members-bridge.count_opted_out_contacts_failed',
      );
      throw new Error(
        `members-bridge.countOptedOutContactsBySegment: ${result.error.code} — refusing to guess the preference count`,
      );
    }
    return result.value;
  },

  async getMemberPrimaryContact(
    tenantCtx: TenantContext,
    memberId: string,
  ): Promise<EmailLower | null> {
    const result = await f3GetMemberPrimaryContact(
      { tenant: tenantCtx, memberRepo: drizzleMemberRepo },
      asMemberId(memberId),
    );
    // Review 2026-09-07 — same doctrine as `memberExistsInTenant` below: a
    // genuine miss is null; a FAILED read throws. Collapsing both into null
    // let a Neon blip become `broadcast_member_missing_primary_contact_email`
    // — an append-only audit row asserting a fact nobody observed.
    if (!result.ok) {
      if (result.error.code === 'repo.not_found') return null;
      throw new Error(`members-bridge.getMemberPrimaryContact: ${result.error.code}`);
    }
    if (result.value === null) return null;
    return unsafeBrandEmailLower(result.value.toLowerCase().trim());
  },

  async memberExistsInTenant(
    tenantCtx: TenantContext,
    memberId: string,
  ): Promise<boolean> {
    // F7.1-HIGHC + Round-5 R5-S2 — discriminate F3 RepoError kinds:
    // `repo.not_found` (and unknown-ID + cross-tenant RLS-filtered)
    // → false; `repo.unexpected` (Neon outage / SQL error) is RE-
    // THROWN so the caller surfaces it as `submit.server_error` (500)
    // instead of misleading 422 `member_not_found`.
    const result = await drizzleMemberRepo.findById(
      tenantCtx,
      asMemberId(memberId),
    );
    if (result.ok) return true;
    if (result.error.code === 'repo.not_found') return false;
    throw new Error(
      `members-bridge.memberExistsInTenant: ${result.error.code}`,
    );
  },

  async lookupContactEmailInTenant(
    tenantCtx: TenantContext,
    emailLower: EmailLower,
  ): Promise<ContactLookup | null> {
    const result = await f3LookupContactEmailInTenant(
      { tenant: tenantCtx, contactRepo: drizzleContactRepo },
      emailLower as string,
    );
    // Review 2026-09-07 — a failed read THROWS so the unsubscribe use-case's
    // catch arm (the only log on that path) can actually fire; a miss is null.
    if (!result.ok) {
      if (result.error.code === 'repo.not_found') return null;
      throw new Error(`members-bridge.lookupContactEmailInTenant: ${result.error.code}`);
    }
    if (result.value === null) return null;
    return {
      memberId: result.value.memberId,
      contactId: result.value.contactId,
      emailLower: unsafeBrandEmailLower(
        result.value.emailLower.toLowerCase().trim(),
      ),
    };
  },

  async lookupMemberPrimaryContactEmailInTenant(
    tenantCtx: TenantContext,
    emailLower: EmailLower,
  ): Promise<MemberRecipient | null> {
    const result = await f3LookupMemberPrimaryContactEmailInTenant(
      { tenant: tenantCtx, memberRepo: drizzleMemberRepo },
      emailLower as string,
    );
    if (!result.ok) {
      if (result.error.code === 'repo.not_found') return null;
      throw new Error(
        `members-bridge.lookupMemberPrimaryContactEmailInTenant: ${result.error.code}`,
      );
    }
    if (result.value === null) return null;
    return brandRecipient(result.value);
  },

  async getMembersHaltedInTenant(
    tenantCtx: TenantContext,
  ): Promise<ReadonlyArray<MemberHaltSummary>> {
    const result = await f3GetMembersHaltedInTenant({
      tenant: tenantCtx,
      memberRepo: drizzleMemberRepo,
    });
    // Review 2026-09-07 — this read IS the Q14 halt gate (`submit-broadcast`
    // precondition k). Answering `[]` on a failed read let a halted member's
    // submit through during a Neon blip, with no log. A failed read THROWS;
    // the use-case maps it to `submit.server_error` and the admin queue
    // page renders an error state instead of a clean banner.
    if (!result.ok) {
      throw new Error(`members-bridge.getMembersHaltedInTenant: ${result.error.code}`);
    }
    return result.value.map((row) => ({
      memberId: row.memberId,
      displayName: row.displayName,
      // Q14 / R3-NEW-3: F3 row does not track which broadcast triggered
      // the halt. F7 admin queue surface joins against `broadcasts` if
      // it needs to surface the trigger broadcast. Empty placeholder here.
      haltedSinceBroadcastId: '',
      haltedSinceAt: row.haltedSinceAt,
    }));
  },

  async setMemberHalt(
    tenantCtx: TenantContext,
    memberId: string,
    halted: boolean,
    actorRole: 'admin' | 'super_admin' | 'marketing' | 'system',
  ): Promise<Result<void, MemberHaltError>> {
    const result = await f3SetMemberHalt(
      { tenant: tenantCtx, memberRepo: drizzleMemberRepo },
      asMemberId(memberId),
      halted,
      // 017 truth sweep — forward the caller's REAL actor; the old
      // hardcoded 'admin' satisfied F3's check on every path.
      { actorRole },
    );
    if (result.ok) return ok(undefined);
    if ('code' in result.error && result.error.code === 'member_halt.unauthorised') {
      return err({ kind: 'member_halt.unauthorized', actorRole });
    }
    return err({ kind: 'member_halt.member_not_found', memberId });
  },

  async markBroadcastsAcknowledged(
    tenantCtx: TenantContext,
    memberId: string,
    _locale: 'en' | 'th' | 'sv',
  ): Promise<Result<MarkAckSuccess, MarkAckError>> {
    const result = await f3MarkBroadcastsAcknowledged(
      {
        tenant: tenantCtx,
        memberRepo: drizzleMemberRepo,
        clock: { now: () => new Date() },
      },
      asMemberId(memberId),
    );
    if (result.ok) {
      // Round 5 code-review CRIT — forward `previouslyNull` so the F7
      // use-case can distinguish first consent from re-ack and emit
      // exactly one `member_acknowledged_broadcasts_terms` audit row
      // per member. Collapsing both paths to `ok(undefined)` made the
      // 'idempotent' branch in the use-case dead code.
      return ok({ previouslyNull: result.value.previouslyNull });
    }
    if ('code' in result.error && result.error.code === 'mark_ack.member_not_found') {
      return err({ kind: 'mark_ack.member_not_found', memberId });
    }
    // Round 5 CRIT — F3 repo failures (RLS denial, Neon outage, statement
    // timeout) surface as `repo.unexpected`. Surface as a distinct
    // error variant so the route returns 500 + logger.error instead of
    // silently 200-OK with `wasNew:false`.
    if ('code' in result.error && result.error.code === 'repo.unexpected') {
      return err({ kind: 'mark_ack.repo_error', cause: result.error.cause });
    }
    // Defence-in-depth: the F3 use-case's union currently covers only
    // `mark_ack.member_not_found` + `repo.unexpected`. Any future variant
    // would otherwise fall through silently. Treat as repo_error so the
    // route returns 500 instead of swallowing.
    return err({ kind: 'mark_ack.repo_error', cause: result.error });
  },

  /**
   * R5 verify-fix Errors-C2 (2026-05-02) — read `members.preferred_locale`
   * via F3 `getMemberPreferredLocale` use-case. Best-effort: F3 lookup
   * errors are LOGGED at warn (forensic trail for ops on Neon outage /
   * RLS denial / schema drift) then collapsed to null so the broadcast
   * dispatch path falls back to the tenant default locale rather than
   * blocking on a degraded sub-system.
   *
   * Admin sets via AdminPreferredLocaleCard on /admin/members/[id]/edit;
   * member sets via PreferredLocaleForm on /portal/account. Migration
   * 0082 added the column + CHECK constraint; NULL is the default for
   * legacy rows.
   */
  async getMemberPreferredLocale(
    tenantCtx: TenantContext,
    memberId: string,
  ): Promise<'en' | 'th' | 'sv' | null> {
    const result = await f3GetMemberPreferredLocale(
      { tenant: tenantCtx, memberRepo: drizzleMemberRepo },
      asMemberId(memberId),
    );
    if (!result.ok) {
      logger.warn(
        {
          err: result.error,
          tenantId: tenantCtx.slug,
          memberId,
        },
        'broadcasts.members_bridge.preferred_locale_lookup_failed',
      );
      return null;
    }
    return result.value;
  },

  /**
   * 108 PR-D (FR-022a) — NOT best-effort, unlike the locale lookup above:
   * a failed read THROWS so the resolve (and the dispatch tick) fails and
   * retries, instead of sending to people who objected.
   */
  async filterMarketingOptedOut(
    tenantCtx: TenantContext,
    emails: ReadonlyArray<EmailLower>,
  ): Promise<ReadonlySet<EmailLower>> {
    // Key the answer by the CALLER's own values, not by what came back from
    // the DB (review types MEDIUM-4): the resolver tests membership with
    // `optedOut.has(e)` on its own array, so a case difference between the
    // two sides would silently fail OPEN — the one direction this filter
    // must never fail in. `unsafeBrandEmailLower` is a cast, not a
    // normaliser, so it cannot rescue that.
    const byLower = new Map<string, EmailLower>();
    for (const e of emails) byLower.set(String(e).toLowerCase().trim(), e);
    const result = await f3FilterMarketingOptedOutEmails(
      { tenant: tenantCtx, contactRepo: drizzleContactRepo },
      [...byLower.keys()],
    );
    if (!result.ok) {
      logger.error(
        {
          err: result.error.code,
          cause: errKind('cause' in result.error ? result.error.cause : undefined),
          tenantId: tenantCtx.slug,
          batch: emails.length,
        },
        'broadcasts.members_bridge.marketing_opt_out_lookup_failed',
      );
      throw new Error(
        `marketing opt-out lookup failed (${result.error.code}) — refusing to resolve fail-open`,
      );
    }
    const out = new Set<EmailLower>();
    for (const e of result.value) {
      const original = byLower.get(e.toLowerCase());
      if (original !== undefined) out.add(original);
    }
    return out;
  },
};
