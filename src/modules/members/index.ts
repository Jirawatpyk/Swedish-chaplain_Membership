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
  type TenantId as MemberTenantId,
  type PlanId as MemberPlanId,
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
