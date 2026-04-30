/**
 * T060 — F3 `MembersBridgePort` adapter (F7).
 *
 * Routes the F7 port surface to F3's barrel exports added in Batch C
 * (T029). Bridges the F3 `F7MemberRecipient` projection (string emails)
 * to F7's `MemberRecipient` (branded `EmailLower`).
 *
 * Segment dispatch:
 *   - `all_members` / `tier` → F3 `getMembersBySegment`
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
import type { TenantContext } from '@/modules/tenants';
import {
  drizzleMemberRepo,
  drizzleContactRepo,
  asMemberId,
  getMembersBySegment as f3GetMembersBySegment,
  getMemberPrimaryContact as f3GetMemberPrimaryContact,
  lookupContactEmailInTenant as f3LookupContactEmailInTenant,
  lookupMemberPrimaryContactEmailInTenant as f3LookupMemberPrimaryContactEmailInTenant,
  getMembersHaltedInTenant as f3GetMembersHaltedInTenant,
  setMemberHalt as f3SetMemberHalt,
  markBroadcastsAcknowledged as f3MarkBroadcastsAcknowledged,
} from '@/modules/members';
import type { BroadcastSegmentType } from '../domain/value-objects/segment-type';
import { unsafeBrandEmailLower } from '../domain/value-objects/email-lower';
import type {
  ContactLookup,
  MarkAckError,
  MemberHaltError,
  MemberHaltSummary,
  MemberRecipient,
  MembersBridgePort,
  SegmentResolveParams,
} from '../application/ports/members-bridge-port';
import type { EmailLower } from '../domain/value-objects/email-lower';

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
    if (!result.ok) return [];
    return result.value.map(brandRecipient);
  },

  async getMemberPrimaryContact(
    tenantCtx: TenantContext,
    memberId: string,
  ): Promise<EmailLower | null> {
    const result = await f3GetMemberPrimaryContact(
      { tenant: tenantCtx, memberRepo: drizzleMemberRepo },
      asMemberId(memberId),
    );
    if (!result.ok || result.value === null) return null;
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
    if (!result.ok || result.value === null) return null;
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
    if (!result.ok || result.value === null) return null;
    return brandRecipient(result.value);
  },

  async getMembersHaltedInTenant(
    tenantCtx: TenantContext,
  ): Promise<ReadonlyArray<MemberHaltSummary>> {
    const result = await f3GetMembersHaltedInTenant({
      tenant: tenantCtx,
      memberRepo: drizzleMemberRepo,
    });
    if (!result.ok) return [];
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
  ): Promise<Result<void, MemberHaltError>> {
    const result = await f3SetMemberHalt(
      { tenant: tenantCtx, memberRepo: drizzleMemberRepo },
      asMemberId(memberId),
      halted,
      { actorRole: 'admin' },
    );
    if (result.ok) return ok(undefined);
    if ('code' in result.error && result.error.code === 'member_halt.unauthorised') {
      return err({ kind: 'member_halt.unauthorized', actorRole: 'admin' });
    }
    return err({ kind: 'member_halt.member_not_found', memberId });
  },

  async markBroadcastsAcknowledged(
    tenantCtx: TenantContext,
    memberId: string,
    _locale: 'en' | 'th' | 'sv',
  ): Promise<Result<void, MarkAckError>> {
    const result = await f3MarkBroadcastsAcknowledged(
      {
        tenant: tenantCtx,
        memberRepo: drizzleMemberRepo,
        clock: { now: () => new Date() },
      },
      asMemberId(memberId),
    );
    if (result.ok) return ok(undefined);
    if ('code' in result.error && result.error.code === 'mark_ack.member_not_found') {
      return err({ kind: 'mark_ack.member_not_found', memberId });
    }
    return err({ kind: 'mark_ack.already_acknowledged' });
  },
};
