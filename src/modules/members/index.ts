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
  derivePortalState,
  type PortalState,
} from './domain/portal-state';

// --- F114 member change requests (Domain) -----------------------------------
// Group A vs Group B (FR-002 / FR-004): the immediate set while the gate is
// on, and the proposable set with its targets + address-group line tuples.
export {
  PORTAL_IMMEDIATE_CONTACT_FIELDS,
  PORTAL_IMMEDIATE_MEMBER_FIELDS,
  type PortalImmediateContactField,
} from './domain/portal-self-update-fields';
export {
  PROPOSABLE_FIELD_KEYS,
  PROPOSABLE_FIELD_TARGET,
  CONTACT_FIELD_KEYS,
  COMPANY_FIELD_KEYS,
  REGISTERED_ADDRESS_LINES,
  BILLING_ADDRESS_LINES,
  ADDRESS_GROUP_KEYS,
  isProposableFieldKey,
  isContactFieldKey,
  isCompanyFieldKey,
  isAddressGroupKey,
  type ProposableFieldKey,
  type ContactFieldKey,
  type CompanyFieldKey,
  type ProposedFieldTarget,
  type RegisteredAddress,
  type BillingAddress,
  type AddressGroupKey,
} from './domain/change-request/proposable-fields';
export {
  CHANGE_REQUEST_STATES,
  CHANGE_REQUEST_OUTCOMES,
  CHANGE_REQUEST_SCOPES,
  WITHDRAWN_REASONS,
  FIELD_OUTCOMES,
  SUBMITTER_ROLES,
  DECISION_REASON_MAX_LENGTH,
  DECISION_NOTE_MAX_LENGTH,
  SUBMISSIONS_PER_WINDOW_CAP,
  SUBMISSION_WINDOW_HOURS,
  STAFF_NOTIFICATION_COALESCE_HOURS,
  OVERDUE_AFTER_DAYS,
  type ChangeRequest,
  type ChangeRequestId,
  type ChangeRequestState,
  type ChangeRequestOutcome,
  type ChangeRequestScope,
  type WithdrawnReason,
  type FieldOutcome,
  type SubmitterRole,
  type ProposedField,
  type ProposedValue,
  isDecided,
  isWithdrawn,
  type DecidedChangeRequest,
  type WithdrawnChangeRequest,
} from './domain/change-request/change-request';
export {
  deriveOutcome,
  deriveScope,
  diffAgainstRecord,
  affectsTaxDocuments,
  changedSinceSubmitted,
  proposedValuesEqual,
  type GroupBRecord,
  type GroupBProposal,
  type GroupBContactFields,
  type GroupBCompanyFields,
  type TaxAffectingContext,
  type DeriveScopeError,
} from './domain/change-request/policies';
export {
  validateProposal,
  normalizeWebsiteUrl,
  proposalSchema,
  type ProposalInput,
} from './domain/change-request/field-rules';
// F114 ports + the gate resolver (Application) and the two Infrastructure
// singletons the `src/lib` composition root wires (same pattern as
// `drizzleMemberRepo` / `f3DrizzleAuditAdapter` below).
export type {
  ChangeRequestRepo,
  ChangeRequestDraft,
  ChangeRequestDecision,
  ChangeRequestListFilter,
  ChangeRequestListRow,
  ChangeRequestListResult,
  ChangeRequestCursor,
  ChangeRequestPage,
  PendingStats,
} from './application/ports/change-request-repo';
export type { Reviewer, ReviewerDirectoryPort } from './application/ports/reviewer-directory-port';
export type {
  ChangeRequestScrubPort,
  ChangeRequestScrubResult,
} from './application/ports/change-request-scrub-port';
export type {
  TenantMemberChangeSettings,
  TenantMemberChangeSettingsPort,
} from './application/ports/tenant-member-change-settings-port';
export {
  makeMemberChangeGateResolver,
  resolveMemberChangeGate,
  type MemberChangeGate,
  type MemberChangeGateDeps,
  type MemberChangeGateResolver,
  type MemberChangeFlagPort,
} from './application/use-cases/change-requests/resolve-member-change-gate';
export { drizzleChangeRequestRepo } from './infrastructure/db/drizzle-change-request-repo';
export { drizzleTenantMemberChangeSettingsRepo } from './infrastructure/repos/drizzle-tenant-member-change-settings-repo';
// F114 use cases (one export block per story as they land).
export {
  submitChangeRequest,
  detectForbiddenProposalKeys,
  groupBRecordOf,
  memberHasBillingAddress,
  type SubmitChangeRequestDeps,
  type SubmitChangeRequestError,
  type SubmitChangeRequestInput,
  type SubmitChangeRequestOutcome,
} from './application/use-cases/change-requests/submit-change-request';
export {
  decideChangeRequest,
  type DecideChangeRequestDeps,
  type DecideChangeRequestError,
  type DecideChangeRequestInput,
  type DecideChangeRequestOutcome,
  type FieldDecision,
} from './application/use-cases/change-requests/decide-change-request';
export {
  acknowledgeChangeRequest,
  type AcknowledgeChangeRequestDeps,
  type AcknowledgeChangeRequestError,
  type AcknowledgeChangeRequestInput,
} from './application/use-cases/change-requests/acknowledge-change-request';
export {
  getChangeRequestReview,
  taxHintFor,
  type ChangeRequestReview,
  type ChangeRequestReviewField,
  type GetChangeRequestReviewDeps,
  type GetChangeRequestReviewError,
  type GetChangeRequestReviewInput,
  type TaxHint,
} from './application/use-cases/change-requests/get-change-request-review';
// F114 email builders — rendered by the outbox dispatcher at send time (R8).
export {
  buildChangeRequestSubmittedStaffEmail,
  type ChangeRequestEmailField,
  type ChangeRequestSubmittedStaffEmailInput,
} from './infrastructure/email/change-request-submitted-staff-email';
export {
  buildChangeRequestDecidedMemberEmail,
  resubmitLinkFor,
  type ChangeRequestDecidedEmailField,
  type ChangeRequestDecidedMemberEmailInput,
} from './infrastructure/email/change-request-decided-member-email';

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
  asMemberNumber,
  formatMemberNumber,
  parseMemberNumberQuery,
  InvalidMemberNumberError,
  DEFAULT_MEMBER_NUMBER_PREFIX,
  type MemberNumber,
} from './domain/value-objects/member-number';

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

export {
  LEGAL_ENTITY_TYPES,
  VAT_DEFAULT_BY_CODE,
  isLegalEntityTypeCode,
  type LegalEntityTypeCode,
} from './domain/value-objects/legal-entity-type';

// --- Application use cases ----------------------------------------------------

export {
  createMember,
  createMemberSchema,
  type CreateMemberInput,
  type CreateMemberError,
  type CreateMemberDeps,
  type CreateMemberListener,
  type CreateMemberListenerEvent,
} from './application/use-cases/create-member';

export {
  getMember,
  type GetMemberError,
  type GetMemberDeps,
} from './application/use-cases/get-member';
export {
  getMemberEngagement,
  type GetMemberEngagementDeps,
  type GetMemberEngagementError,
} from './application/use-cases/get-member-engagement';
export type { MemberRisk } from './application/ports/member-repo';

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

export {
  loadMembersPortalStatus,
  type LoadMembersPortalStatusInput,
  type LoadMembersPortalStatusDeps,
} from './application/use-cases/load-members-portal-status';

export {
  countMembersNeedingPortalInvite,
} from './application/use-cases/count-members-needing-portal-invite';

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
  type ChangePlanSuccess,
} from './application/use-cases/change-plan';

// Plan-change -> billing remediation (Phase 2) — MEMBERS-owned port implemented
// by a renewals adapter. Exported so the renewals adapter can import the
// contract (renewals -> members, type-only) + the route/deps can reference the
// BillingEffect surface.
export type {
  PlanChangeBillingEffect,
  PlanChangeBillingEffectKind,
  PlanChangeBillingRemediationContext,
  PlanChangeBillingRemediationPort,
} from './application/ports/plan-change-billing-remediation-port';

export {
  addContact,
  updateContactFields,
  updateUnlinkedContactEmail,
  removeContact,
  promotePrimary,
  addContactSchema,
  updateContactFieldsSchema,
  type ContactCrudError,
  type ContactCrudDeps,
} from './application/use-cases/contact-crud';

// --- 108 PR-D — per-contact marketing opt-out (staff toggle + portal self) ---
export {
  setContactMarketingOptOut,
  type SetContactMarketingOptOutDeps,
  type SetContactMarketingOptOutError,
  type SetContactMarketingOptOutInput,
  type SetContactMarketingOptOutOutcome,
} from './application/use-cases/set-contact-marketing-opt-out';
export type { MarketingSuppressionLookupPort } from './application/ports/marketing-suppression-lookup-port';
export {
  filterMarketingOptedOutEmails,
  type FilterMarketingOptedOutEmailsDeps,
} from './application/use-cases/filter-marketing-opted-out-emails';
export {
  listMarketingAudience,
  MARKETING_AUDIENCE_PAGE_SIZE,
  type ListMarketingAudienceDeps,
  type ListMarketingAudienceError,
  type ListMarketingAudienceInput,
  type ListMarketingAudienceResult,
  type MarketingAudienceFilter,
  type MarketingAudienceRow,
  type MarketingAudienceStateFilter,
} from './application/use-cases/list-marketing-audience';
export type {
  MarketingAudienceRepoFilter,
  MarketingAudienceRepoRow,
} from './application/ports/member-repo';
export {
  MARKETING_REASONS,
  marketingNonReceiptReasons,
  type MarketingReason,
} from './domain/marketing-reason';
export {
  contactMarketing,
  deriveMarketingState,
  MARKETING_OPT_OUT_SOURCES,
  MARKETING_STATES,
  RECEIVES_MARKETING,
  type MarketingOptOut,
  type MarketingOptOutSource,
  type MarketingState,
} from './domain/contact';

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
export { countActiveMembersOnPlan } from './infrastructure/db/count-active-members-on-plan';
// W0-02 — tx-bound variant for use inside an existing runInTenant tx
// (plan-repo `softDeleteGuarded` uses this to count within the advisory-lock tx).
export { countActiveMembersOnPlanInTx } from './infrastructure/db/count-active-members-on-plan';
// 059 / PR-A Task 6c — batched VAT-REGISTRANT lookup backing the F6
// event-detail `buyerIsVatRegistrant` enrichment. Replaces the
// 064-remediation-B5 tax-id-PRESENCE lookup: issuance now decides the event
// document class on the RECORDED registrant flag, not on "is tax_id
// non-blank", so the picker must ask the same question or it offers an option
// the server will refuse. Same free-function-through-the-barrel composition
// pattern as the countActiveMembersOnPlan pair above; callers thread their own
// runInTenant tx (Principle I).
export { memberVatRegistrantByIdsInTx } from './infrastructure/db/member-vat-registrant';

// COMP-1 US3-A — narrow erasure-status read for the member-detail ErasedBanner.
// Same free-function-through-the-barrel narrow-read pattern as the
// countActiveMembersOnPlan / memberVatRegistrantByIdsInTx pair above (avoids
// widening the MemberRepo interface + its many test stubs). Threads its own
// runInTenant tx internally (Principle I).
export {
  getMemberErasureStatus,
  type MemberErasureStatus,
} from './infrastructure/db/member-erasure-status';

// COMP-1 US3-D — data-resolution reads for the DPO erasure-evidence log.
// Same free-function-through-the-barrel narrow-read pattern as
// getMemberErasureStatus above. `listMemberLinkedUserIds` binds the
// tenant-NULL `user_erased` evidence arm to a member; `listErasedMembers`
// is the page's keyset-paginated top-level list. Both thread their own
// runInTenant tx internally (Principle I).
export {
  listMemberLinkedUserIds,
  listErasedMembers,
  type ErasedMemberRow,
  type ErasedMembersCursor,
  type ListErasedMembersInput,
  type ListErasedMembersResult,
} from './infrastructure/db/member-erasure-evidence-reads';

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

// 107-auto-invoice Task 15 — the sole write path that SETS the per-member
// auto-invoice enrolment key (`members.auto_invoice_enrolled_at`); Task 18
// below is the sole write path that clears it.
export {
  bulkEnrolAutoInvoice,
  bulkEnrolAutoInvoiceSchema,
  type BulkEnrolAutoInvoiceInput,
  type BulkEnrolAutoInvoiceOutput,
  type BulkEnrolAutoInvoiceError,
  type BulkEnrolAutoInvoiceDeps,
  type BulkEnrolAutoInvoiceMeta,
} from './application/use-cases/bulk-enrol-auto-invoice';

// 107-auto-invoice Task 18 — the way back out. Unlike enrol, this applies
// NO membership-state gate: terminated / archived / suspended members are
// all un-enrolled. See the use-case header before changing that.
export {
  bulkUnenrolAutoInvoice,
  bulkUnenrolAutoInvoiceSchema,
  type BulkUnenrolAutoInvoiceInput,
  type BulkUnenrolAutoInvoiceOutput,
  type BulkUnenrolAutoInvoiceError,
  type BulkUnenrolAutoInvoiceDeps,
  type BulkUnenrolAutoInvoiceMeta,
} from './application/use-cases/bulk-unenrol-auto-invoice';

export {
  bulkSendPortalInvite,
  bulkSendPortalInviteSchema,
  type BulkSendPortalInviteInput,
  type BulkSendPortalInviteOutput,
  type BulkSendPortalInviteError,
  type BulkSendPortalInviteDeps,
  type BulkSendPortalInviteMeta,
  type InviteSkipReason,
  type InviteFailCode,
} from './application/use-cases/bulk-send-portal-invite';

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
  TIMELINE_SOURCES,
  TIMELINE_ACTOR_KINDS,
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

// --- COMP-1 US1 — GDPR Art. 17 / PDPA §33 member erasure --------------------

export {
  eraseMember,
  eraseMemberSchema,
  eraseReasonSchema,
  verificationMethodSchema,
  type EraseReason,
  type VerificationMethod,
  type EraseMemberInput,
  type EraseMemberError,
  type EraseMemberResult,
  type EraseMemberDeps,
  type EraseMemberMeta,
} from './application/use-cases/erase-member';

export { archiveWindowStatus } from './domain/policies/archive-window-policy';
export type { ArchiveWindowStatus } from './domain/policies/archive-window-policy';

export type {
  TimelineEvent,
  TimelineResult,
  TimelinePort,
  TimelineSource,
  TimelineActorKind,
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

// 108 PR-C — 1:N audience: one keyset page of recipient CONTACTS (US3).
export {
  getBroadcastRecipientContacts,
  type GetBroadcastRecipientContactsDeps,
  type GetBroadcastRecipientContactsInput,
} from './application/use-cases/get-broadcast-recipient-contacts';

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
  // 108 PR-C — contact-level projection + keyset cursor for the 1:N audience.
  F7ContactRecipient,
  BroadcastRecipientCursor,
  BroadcastRecipientContactsQuery,
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

// --- 055-member-number — allocator + settings (ALLOC group) -----------------

export { drizzleMemberNumberAllocator } from './infrastructure/repos/drizzle-member-number-allocator';
export type { MemberNumberAllocatorPort } from './application/ports/member-number-allocator-port';

export { drizzleMemberSettingsRepo } from './infrastructure/repos/drizzle-member-settings-repo';
export type { MemberSettingsReaderPort } from './application/ports/member-settings-port';

// Shared display-time prefix resolver — wraps the read in `runInTenant`
// (RLS) so every presentation surface formatting a member number reuses
// one RLS-safe helper instead of hand-copying the incantation.
export { resolveMemberNumberPrefix } from './application/use-cases/resolve-member-number-prefix';

// Review 2026-09-07 (108 PR-C, FR-022a) — the opted-out count behind
// `droppedByPreference` on the all_contacts leg.
export { countBroadcastOptedOutContacts } from './application/use-cases/count-broadcast-opted-out-contacts';
export type { BroadcastOptedOutCountQuery } from './application/ports/member-repo';
