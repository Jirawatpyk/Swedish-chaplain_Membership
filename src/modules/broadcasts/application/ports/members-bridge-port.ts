/**
 * T028 — `MembersBridgePort` Application port (F7).
 *
 * Cross-module read + write against F3 (`@/modules/members` public
 * barrel). Used by F7 use cases for:
 *   - Segment recipient resolution (FR-015 + FR-015c + FR-015d / Q8)
 *   - Custom-list tenant-graph validation (FR-015d / Q9)
 *   - Halt-flag management (Q14 — per-broadcast complaint-rate auto-halt)
 *   - Acknowledgement flag management (Q15 — GDPR Art. 7 banner)
 *
 * Concrete adapter (Phase 4 Infrastructure) calls F3's barrel exports
 * added in T029 (Batch C). The 7 methods below correspond 1:1 with
 * the 7 new F3 exports specified in tasks.md L111.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { TenantContext } from '@/modules/tenants';
import type { Result } from '@/lib/result';
import type { EmailLower } from '../../domain/value-objects/email-lower';
import type { BroadcastSegmentType } from '../../domain/value-objects/segment-type';

/**
 * Minimal member projection returned by segment resolution. NOT the
 * full F3 Member aggregate — F7 only needs identity + primary contact
 * email + tier code for dispatch.
 */
export interface MemberRecipient {
  readonly memberId: string;
  readonly displayName: string;
  readonly primaryContactEmail: EmailLower | null;
  readonly tierCode: string | null;
  readonly broadcastsHaltedUntilAdminReview: boolean;
}

export interface ContactLookup {
  readonly memberId: string;
  readonly contactId: string;
  readonly emailLower: EmailLower;
}

/**
 * Halt-flag summary for the admin queue surface (Q14 / R3-NEW-3
 * banner). One row per member with `broadcasts_halted_until_admin_review = true`.
 */
export interface MemberHaltSummary {
  readonly memberId: string;
  readonly displayName: string;
  readonly haltedSinceBroadcastId: string;
  readonly haltedSinceAt: Date;
}

export type MemberHaltError =
  | { readonly kind: 'member_halt.member_not_found'; readonly memberId: string }
  | { readonly kind: 'member_halt.unauthorized'; readonly actorRole: string };

export type MarkAckError =
  | { readonly kind: 'mark_ack.member_not_found'; readonly memberId: string }
  // Round 5 CRIT — surfaces F3 repo failures (RLS denial, Neon outage,
  // statement timeout) so the route can return 500 + logger.error
  // instead of silently 200-OK with `wasNew:false` (GDPR Art. 7 risk:
  // banner dismisses but consent column never written).
  | { readonly kind: 'mark_ack.repo_error'; readonly cause: unknown };

/**
 * Bridge success contract — the F7 use-case decides "fresh" vs
 * "idempotent" purely on `previouslyNull`. Round-5 code-review CRIT
 * found that returning bare `void` here collapsed both paths into
 * one, making the use-case's `'idempotent'` branch dead and emitting
 * a duplicate `member_acknowledged_broadcasts_terms` audit row on
 * every re-ack. Fix: surface `previouslyNull` through the port.
 */
export interface MarkAckSuccess {
  readonly previouslyNull: boolean;
}

export interface SegmentResolveParams {
  readonly tierCodes?: ReadonlyArray<string>;
}

export interface MembersBridgePort {
  /**
   * Resolve a segment to its recipient list (FR-015 + FR-015c).
   * Filters out members with NULL `primary_contact_email` (emits
   * `broadcast_member_missing_primary_contact_email` audit at use-case
   * site for each one). Filters out members halted via Q14
   * (`broadcasts_halted_until_admin_review = true`).
   */
  getMembersBySegment(
    tenantCtx: TenantContext,
    segmentType: BroadcastSegmentType,
    params: SegmentResolveParams,
  ): Promise<ReadonlyArray<MemberRecipient>>;

  /**
   * Get a single member's primary contact email (FR-002 precondition
   * `j` — sender reply-to is `members.primary_contact_email`).
   */
  getMemberPrimaryContact(
    tenantCtx: TenantContext,
    memberId: string,
  ): Promise<EmailLower | null>;

  /**
   * F7.1-HIGHC — boolean existence check, distinguishing "wrong member
   * id" from "member exists but lacks primary contact email" in the
   * proxy-submit + similar admin paths. Cheap `EXISTS` query; returns
   * `true` even when the member has no primary email.
   */
  memberExistsInTenant(
    tenantCtx: TenantContext,
    memberId: string,
  ): Promise<boolean>;

  /**
   * Look up an email against ANY contact in the tenant graph (FR-015d
   * custom-list validation branch 2: secondary contacts).
   */
  lookupContactEmailInTenant(
    tenantCtx: TenantContext,
    emailLower: EmailLower,
  ): Promise<ContactLookup | null>;

  /**
   * Look up an email against ANY member's primary contact email
   * (FR-015d custom-list validation branch 1).
   */
  lookupMemberPrimaryContactEmailInTenant(
    tenantCtx: TenantContext,
    emailLower: EmailLower,
  ): Promise<MemberRecipient | null>;

  /**
   * Q14 — list all members in tenant currently halted from broadcasting
   * (admin queue red-banner surface). Empty array means no halts.
   */
  getMembersHaltedInTenant(
    tenantCtx: TenantContext,
  ): Promise<ReadonlyArray<MemberHaltSummary>>;

  /**
   * Q14 — admin clear-halt action. Emits
   * `broadcast_member_dispatch_resumed` audit at the use-case site.
   * Manager role denied.
   */
  setMemberHalt(
    tenantCtx: TenantContext,
    memberId: string,
    halted: boolean,
  ): Promise<Result<void, MemberHaltError>>;

  /**
   * Q15 — member CTA "Acknowledge" on the GDPR Art. 7 banner. Emits
   * `member_acknowledged_broadcasts_terms` audit at the use-case site.
   * `locale` is recorded for compliance audit ("which language was
   * the consent shown in?").
   */
  markBroadcastsAcknowledged(
    tenantCtx: TenantContext,
    memberId: string,
    locale: 'en' | 'th' | 'sv',
  ): Promise<Result<MarkAckSuccess, MarkAckError>>;
}
