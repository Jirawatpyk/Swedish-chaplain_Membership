/**
 * Public barrel for the `auth` bounded context.
 *
 * This file is the ONLY surface that consumers OUTSIDE
 * `src/modules/auth/**` may import from. Deep imports into
 * `./domain/`, `./application/`, or `./infrastructure/` from outside
 * this module are blocked by `no-restricted-imports` in
 * `eslint.config.mjs` (Constitution Principle III — Clean
 * Architecture boundary enforcement).
 *
 * The barrel exposes:
 *   1. Application use cases — the only external way to MUTATE auth
 *      state (sign in, reset password, invite, etc.)
 *   2. Domain types that cross the boundary (Role, Portal, UserAccount,
 *      Session, audit event shapes) for consumers that need to type
 *      their own code against the auth surface
 *   3. Constructors for branded types (asUserId, asEmailAddress, etc.)
 *      because downstream code has to turn plain strings into brands
 *      at trust boundaries
 *
 * What is NOT exported here (on purpose):
 *   - Concrete Infrastructure singletons (`userRepo`, `sessionRepo`, …)
 *     — these are wired via the `auth-deps.ts` composition root only
 *   - Drizzle schema / row types — those leak ORM details
 *   - Private helper functions inside the Application layer
 *   - `password-policy.ts` internals — consumers use `checkPasswordPolicy`
 *     via the Application barrel (no raw rules exposed)
 *
 * Internal files inside `src/modules/auth/**` MUST NOT import from
 * this barrel (it would create a circular dependency on itself).
 * Internal cross-layer imports continue to use the deep paths:
 *   - `@/modules/auth/domain/role`
 *   - `@/modules/auth/application/sign-in`
 *   - `@/modules/auth/infrastructure/db/user-repo`
 * The ESLint rule excludes `src/modules/auth/**` itself so these
 * deep paths remain allowed inside the module.
 */

// --- Application: use cases ---------------------------------------------------

export {
  signIn,
  type SignInInput,
  type SignInSuccess,
  type SignInError,
  type SignInDeps,
} from './application/sign-in';

export {
  signOut,
  type SignOutInput,
  type SignOutDeps,
} from './application/sign-out';

export {
  forgotPassword,
  type ForgotPasswordInput,
  type ForgotPasswordSuccess,
  type ForgotPasswordError,
  type ForgotPasswordDeps,
} from './application/forgot-password';

export {
  resetPassword,
  type ResetPasswordInput,
  type ResetPasswordSuccess,
  type ResetPasswordError,
  type ResetPasswordDeps,
} from './application/reset-password';

export {
  changePassword,
  type ChangePasswordInput,
  type ChangePasswordSuccess,
  type ChangePasswordError,
  type ChangePasswordDeps,
} from './application/change-password';

export {
  createUser,
  type CreateUserInput,
  type CreateUserSuccess,
  type CreateUserError,
  type CreateUserDeps,
} from './application/create-user';

export {
  redeemInvite,
  type RedeemInviteInput,
  type RedeemInviteSuccess,
  type RedeemInviteError,
  type RedeemInviteDeps,
} from './application/redeem-invite';

export {
  disableUser,
  type DisableUserInput,
  type DisableUserSuccess,
  type DisableUserError,
  type DisableUserDeps,
} from './application/disable-user';

export {
  enableUser,
  type EnableUserInput,
  type EnableUserSuccess,
  type EnableUserError,
  type EnableUserDeps,
} from './application/enable-user';

export {
  changeRole,
  type ChangeRoleInput,
  type ChangeRoleSuccess,
  type ChangeRoleError,
  type ChangeRoleDeps,
} from './application/change-role';

export {
  heartbeat,
  type HeartbeatInput,
  type HeartbeatSuccess,
  type HeartbeatError,
  type HeartbeatDeps,
} from './application/heartbeat';

export { hasPermission } from './application/has-permission';
export type { Action, Resource } from './domain/policies';
export { canAccess, isReadOnlyRole } from './domain/policies';

export {
  checkPasswordPolicy,
  MIN_PASSWORD_LENGTH,
  type PasswordPolicyError,
  type PasswordPolicyResult,
} from './application/password-policy';

// --- Domain: cross-boundary types ---------------------------------------------

export type { Role, Portal } from './domain/role';
export {
  ROLES,
  STAFF_ROLES,
  PORTAL_FOR_ROLE,
  isRole,
  isStaffRole,
} from './domain/role';

export type { UserAccount, UserStatus } from './domain/user';
export {
  USER_STATUSES,
  isUserStatus,
  canTransition,
  isLocked,
} from './domain/user';

export type { Session } from './domain/session';
export {
  IDLE_TIMEOUT_MS,
  ABSOLUTE_LIFETIME_MS,
  isSessionValid,
  nextExpiryAt,
} from './domain/session';

export type {
  TokenFailureReason,
  PasswordResetToken,
  Invitation,
} from './domain/token';
export {
  RESET_TOKEN_TTL_MS,
  INVITATION_TTL_MS,
  isResetTokenValid,
  isInvitationValid,
  classifyTokenFailure,
} from './domain/token';

// Email template types — `EmailLocale` is a 3-letter union used by
// both `forgot-password.ts` input and every caller that wants to
// pass the user's preferred locale to the mailer. The template
// function itself (`buildResetPasswordEmail`, `buildInvitationEmail`)
// is pure and owned by Infrastructure, but the TYPE is a public
// contract and belongs on the barrel so callers don't need to
// deep-import it.
export type { EmailLocale } from './infrastructure/email/reset-password-email';

export type { AuditEventType, AuditEvent, ActorRef } from './domain/audit-event';
export { AUDIT_EVENT_TYPES, AUDIT_SUMMARY_MAX_LENGTH } from './domain/audit-event';

// F9 activity feed (FR-003) — read-only recent-audit-events reader.
export {
  listRecentAuditEvents,
  type AuditReadPort,
  type RecentAuditEvent,
} from './application/use-cases/list-recent-audit-events';
export { auditReadAdapter } from './infrastructure/db/audit-read-repo';

// --- Domain: branded-type constructors at trust boundaries --------------------

export {
  asUserId,
  asSessionToken,
  asTokenId,
  asResetTokenId,
  asResetTokenHash,
  asInvitationTokenId,
  asInvitationTokenHash,
  parseResetTokenId,
  parseInvitationTokenId,
  isHex64,
  asEmailVerificationTokenHash,
  asEmailRevertTokenHash,
  asEmailAddress,
  MalformedTokenError,
  asPasswordHash,
  asAuditEventId,
  type UserId,
  type SessionToken,
  type TokenId,
  type ResetTokenId,
  type ResetTokenHash,
  type InvitationTokenId,
  type InvitationTokenHash,
  type EmailVerificationTokenHash,
  type EmailRevertTokenHash,
  type EmailAddress,
  type PasswordHash,
  type AuditEventId,
} from './domain/branded';

// --- Infrastructure: shared adapters -----------------------------------------

export {
  rateLimiter,
  type RateLimiter,
  type RateLimitResult,
} from './infrastructure/rate-limit/upstash-rate-limiter';
