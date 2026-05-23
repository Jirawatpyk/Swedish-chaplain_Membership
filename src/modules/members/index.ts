/**
 * Public barrel for the `members` bounded context (F3).
 *
 * This is the ONLY surface that code OUTSIDE `src/modules/members/**`
 * may import from. The ESLint `no-restricted-imports` rule in
 * `eslint.config.mjs` blocks deep imports into `./domain/**`,
 * `./application/**`, and `./infrastructure/**` from anywhere but
 * inside this module.
 *
 * Exports are filled story-by-story as user stories land.
 *
 * See specs/005-members-contacts/plan.md § Constitution Check III
 * for the rationale behind the public barrel discipline.
 */

// --- Domain types (read-only) -------------------------------------------------

export {
  MEMBER_STATUSES,
  ARCHIVE_UNDELETE_WINDOW_DAYS,
  asTenantId,
  asPlanId,
  asMemberId,
  tryTenantId,
  tryPlanId,
  tryMemberId,
  type Member,
  type MemberId,
  type MemberStatus,
  type TenantId,
  type PlanId,
} from './domain/member';

export {
  PREFERRED_LANGUAGES,
  asContactId,
  tryContactId,
  type Contact,
  type ContactId,
  type PreferredLanguage,
} from './domain/contact';

export {
  OVERRIDE_REASON_CODES,
  type OverrideReason,
  type OverrideReasonCode,
} from './domain/value-objects/override-reason';

export {
  PORTAL_SELF_UPDATE_CONTACT_FIELDS,
  PORTAL_SELF_UPDATE_MEMBER_FIELDS,
  type PortalSelfUpdateContactField,
  type PortalSelfUpdateMemberField,
} from './domain/portal-self-update-fields';

export {
  assertNeverAuditEvent,
  type F3AuditEventType,
  type F3AuditEvent,
} from './application/ports/audit-port';

// Value-object constructor + branded types for use cases that compose
// Domain types outside this module (e.g. integration tests, adapters).
export {
  asEmail,
  isEmail,
  type Email,
  type EmailError,
} from './domain/value-objects/email';

export {
  asPhone,
  isPhone,
  type Phone,
  type PhoneError,
} from './domain/value-objects/phone';

export {
  asIsoCountryCode,
  isIsoCountryCode,
  type IsoCountryCode,
  type IsoCountryCodeError,
} from './domain/value-objects/iso-country-code';

export {
  asTaxId,
  type TaxId,
  type TaxIdError,
} from './domain/value-objects/tax-id';

export {
  asUserId,
  type UserId,
  type UserIdError,
} from './domain/value-objects/user-id';

export {
  asOverrideReason,
  isOverrideReasonCode,
  type OverrideReasonError,
} from './domain/value-objects/override-reason';

// --- Application use cases ----------------------------------------------------

export {
  createMember,
  createMemberSchema,
  type CreateMemberInput,
  type CreateMemberError,
  type CreateMemberDeps,
} from './application/use-cases/create-member';

export {
  getMember,
  type GetMemberError,
  type GetMemberDeps,
} from './application/use-cases/get-member';

export {
  directorySearch,
  directorySearchWithCount,
  type DirectorySearchInput,
  type DirectorySearchOutput,
  type DirectorySearchError,
  type DirectorySearchDeps,
  type DirectorySearchWithCountInput,
  type DirectorySearchWithCountOutput,
  type DirectoryRow,
} from './application/use-cases/directory-search';

// --- US3 use cases ----------------------------------------------------------

export {
  updateMember,
  updateMemberSchema,
  type UpdateMemberInput,
  type UpdateMemberError,
  type UpdateMemberDeps,
} from './application/use-cases/update-member';

export {
  changePlan,
  changePlanSchema,
  type ChangePlanInput,
  type ChangePlanError,
  type ChangePlanDeps,
} from './application/use-cases/change-plan';

export {
  addContact,
  updateContactFields,
  removeContact,
  promotePrimary,
  addContactSchema,
  updateContactFieldsSchema,
  type ContactCrudError,
  type ContactCrudDeps,
} from './application/use-cases/contact-crud';

export {
  affectedMembersCount,
  type AffectedMembersCountInput,
  type AffectedMembersCountError,
  type AffectedMembersCountDeps,
} from './application/use-cases/affected-members-count';

// Post-ship R6 C1 — F2 `MemberAttachmentChecker` cross-module wiring.
// F2's `drizzle-member-attachment-checker.ts` infrastructure adapter
// calls this free function via the public barrel so the soft-delete
// FR-010 guard counts real members instead of always returning 0.
export { countActiveMembersOnPlan } from './application/use-cases/count-active-members-on-plan';

// --- US1 invite-portal use case ---------------------------------------------

export {
  invitePortal,
  type InvitePortalInput,
  type InvitePortalOutput,
  type InvitePortalError,
  type InvitePortalDeps,
  type CreateUserPort,
} from './application/use-cases/invite-portal';

// --- US3.b.2 use case -------------------------------------------------------

export {
  changeContactEmail,
  type ChangeContactEmailInput,
  type ChangeContactEmailOutput,
  type ChangeContactEmailError,
  type ChangeContactEmailDeps,
} from './application/use-cases/change-contact-email';

// --- US3.b.3 use cases ------------------------------------------------------

export {
  verifyContactEmail,
  type VerifyContactEmailInput,
  type VerifyContactEmailOutput,
  type VerifyContactEmailError,
  type VerifyContactEmailDeps,
} from './application/use-cases/verify-contact-email';

export {
  revertContactEmail,
  type RevertContactEmailInput,
  type RevertContactEmailOutput,
  type RevertContactEmailError,
  type RevertContactEmailDeps,
} from './application/use-cases/revert-contact-email';

export {
  resendVerificationEmail,
  type ResendVerificationInput,
  type ResendVerificationOutput,
  type ResendVerificationError,
  type ResendVerificationDeps,
} from './application/use-cases/resend-verification-email';

// --- US5 use cases ----------------------------------------------------------

export {
  memberSelfUpdate,
  selfUpdateSchema,
  SELF_UPDATE_CONTACT_SCHEMA_KEYS,
  SELF_UPDATE_MEMBER_SCHEMA_KEYS,
  type MemberSelfUpdateInput,
  type MemberSelfUpdateError,
  type MemberSelfUpdateDeps,
} from './application/use-cases/member-self-update';

export {
  inviteColleague,
  inviteColleagueSchema,
  type InviteColleagueInput,
  type InviteColleagueError,
  type InviteColleagueDeps,
} from './application/use-cases/invite-colleague';

// --- F1 spec:672-678 — admin invite with optional member link --------------

export {
  inviteUserForMember,
  type InviteUserForMemberInput,
  type InviteUserForMemberError,
  type InviteUserForMemberDeps,
  type InviteUserForMemberOutput,
} from './application/use-cases/invite-user-for-member';

// --- US4 use cases ----------------------------------------------------------

export {
  bulkAction,
  bulkActionSchema,
  BULK_CAP,
  BULK_RATE_MAX,
  BULK_RATE_WINDOW_SECONDS,
  type BulkActionInput,
  type BulkActionOutput,
  type BulkActionError,
  type BulkActionDeps,
  type BulkActionMeta,
} from './application/use-cases/bulk-action';

export {
  inlineEdit,
  inlineEditSchema,
  INLINE_EDIT_FIELDS,
  type InlineEditInput,
  type InlineEditError,
  type InlineEditDeps,
  type InlineEditMeta,
  type InlineEditField,
} from './application/use-cases/inline-edit';

// --- US6 use cases ----------------------------------------------------------

export {
  timelineList,
  timelineListSchema,
  type TimelineListInput,
  type TimelineListOutput,
  type TimelineListError,
  type TimelineListDeps,
} from './application/use-cases/timeline-list';

// --- US7 use cases ----------------------------------------------------------

export {
  archiveMember,
  archiveMemberSchema,
  type ArchiveMemberInput,
  type ArchiveMemberError,
  type ArchiveMemberDeps,
  type ArchiveMemberMeta,
} from './application/use-cases/archive-member';

export {
  undeleteMember,
  type UndeleteMemberError,
  type UndeleteMemberDeps,
  type UndeleteMemberMeta,
} from './application/use-cases/undelete-member';

export { archiveWindowStatus } from './domain/policies/archive-window-policy';
export type { ArchiveWindowStatus } from './domain/policies/archive-window-policy';

export type {
  TimelineEvent,
  TimelineResult,
  TimelinePort,
} from './application/ports/timeline-port';

// --- US4 port ---------------------------------------------------------------
// RateLimitPort removed — rate limiting is a transport-layer concern
// and lives in the route handler via the F1 UpstashRateLimiter singleton
// exposed through the auth barrel (round-2 review C-1 / IMPORTANT I-8).

// ===========================================================================
// F7 Batch C extensions (T029) — F3 use-cases consumed by F7 bridges
// ===========================================================================

export {
  getMembersBySegment,
  type GetMembersBySegmentDeps,
  type GetMembersBySegmentInput,
} from './application/use-cases/get-members-by-segment';

export {
  getMemberPrimaryContact,
  type GetMemberPrimaryContactDeps,
} from './application/use-cases/get-member-primary-contact';

export {
  getMemberPreferredLocale,
  type GetMemberPreferredLocaleDeps,
  type LocaleLiteral,
} from './application/use-cases/get-member-preferred-locale';

export {
  setMemberPreferredLocale,
  type SetMemberPreferredLocaleActor,
  type SetMemberPreferredLocaleDeps,
  type SetMemberPreferredLocaleError,
  type SetMemberPreferredLocaleInput,
  type SetMemberPreferredLocaleOutcome,
} from './application/use-cases/set-member-preferred-locale';

// R4 Types-#6 — F3 adapters needed by routes that wire the
// `setMemberPreferredLocale` use-case (admin + member self-service).
export { drizzleMemberRepo as f3DrizzleMemberRepo } from './infrastructure/db/drizzle-member-repo';
export { drizzleAuditAdapter as f3DrizzleAuditAdapter } from './infrastructure/audit/audit-adapter';

export {
  lookupContactEmailInTenant,
  type ContactEmailLookupResult,
  type LookupContactEmailInTenantDeps,
} from './application/use-cases/lookup-contact-email-in-tenant';

export {
  lookupMemberPrimaryContactEmailInTenant,
  type LookupMemberPrimaryContactEmailInTenantDeps,
} from './application/use-cases/lookup-member-primary-contact-email-in-tenant';

export {
  getMembersHaltedInTenant,
  type GetMembersHaltedInTenantDeps,
} from './application/use-cases/get-members-halted-in-tenant';

export {
  setMemberHalt,
  type MemberHaltError,
  type SetMemberHaltDeps,
  type SetMemberHaltMeta,
} from './application/use-cases/set-member-halt';

export {
  markBroadcastsAcknowledged,
  type MarkAckError,
  type MarkAckResult,
  type MarkBroadcastsAcknowledgedDeps,
} from './application/use-cases/mark-broadcasts-acknowledged';

// F7 projection types — exported for F7-side bridge adapter consumption.
export type {
  F7MemberRecipient,
  F7MemberHaltSummary,
} from './application/ports/member-repo';

// F7 bridge — concrete `MemberRepo` + `ContactRepo` instances for F7's
// `members-bridge.ts` composition root. F7 invokes the F3 use-cases
// above through these repos. Tenant scoping is applied inside the
// repo's `runInTenant` calls.
export { drizzleMemberRepo } from './infrastructure/db/drizzle-member-repo';
export { drizzleContactRepo } from './infrastructure/db/drizzle-contact-repo';
export type { MemberRepo, RepoError } from './application/ports/member-repo';
export type { ContactRepo } from './application/ports/contact-repo';

// F3 spec § Edge Cases — invitation-email bounce handling. The Resend webhook
// (tenant-agnostic) calls `handleInvitationBounce`; it resolves the owner
// tenant(s) + marks each pending invitation failed + emits `invitation_bounced`.
export {
  handleInvitationBounce,
  resolveBouncedInviteContacts,
} from './infrastructure/handle-invitation-bounce';
export {
  markInvitationBounced,
  SYSTEM_ACTOR_RESEND_WEBHOOK,
  type MarkInvitationBouncedDeps,
  type MarkInvitationBouncedInput,
  type MarkInvitationBouncedError,
} from './application/use-cases/mark-invitation-bounced';

// F3 spec § Edge Cases — admin "Re-send invite" action for bounced invitations.
export {
  resendBouncedInvite,
  type ResendBouncedInviteDeps,
  type ResendBouncedInviteInput,
  type ResendBouncedInviteOutput,
  type ResendBouncedInviteError,
} from './application/use-cases/resend-bounced-invite';
