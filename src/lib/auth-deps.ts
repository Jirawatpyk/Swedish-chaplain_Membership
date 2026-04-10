/**
 * Auth composition root (H1 Clean Architecture remediation).
 *
 * This file is the SINGLE place in the codebase where Application-layer
 * use cases meet Infrastructure-layer concrete singletons. Every auth
 * use case imports its dependency types via `import type { ... }`
 * from infrastructure (compile-time only), and its default dependency
 * instance from THIS file. That breaks the constitutional Clean
 * Architecture violation flagged in the F1 verify gate review:
 * Application used to import concrete `argon2Hasher`, `userRepo`, etc.
 * directly, which pulled Infrastructure modules into the Application
 * bundle even though the DI pattern was correctly applied at runtime.
 *
 * Why `src/lib/` and not `src/modules/auth/application/`:
 * composition roots sit OUTSIDE the layer hierarchy they wire. Placing
 * this file inside `application/` would recreate the exact violation
 * we're fixing — Application would import Infrastructure again.
 *
 * Why there is a circular-looking edge: use cases import
 * `defaultXxxDeps` (value) from here, and this file imports the
 * `XxxDeps` interfaces (type-only) from each use case. Type-only
 * imports are compile-time erased — there is NO runtime cycle.
 * Two exceptions: `checkPasswordPolicy` and `buildInvitationEmail`
 * are imported as VALUES because they are pure functions with no
 * Infrastructure dependencies (no DB, no network, no Drizzle) — see
 * the block comment below the imports for details.
 *
 * Tests and route handlers that want the default deps object can
 * import from either path: this file OR the re-export at the bottom
 * of each use case file. Both paths resolve to the same object.
 */
import { argon2Hasher } from '@/modules/auth/infrastructure/password/argon2-hasher';
import { rateLimiter } from '@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter';
import { userRepo } from '@/modules/auth/infrastructure/db/user-repo';
import { sessionRepo } from '@/modules/auth/infrastructure/db/session-repo';
import { auditRepo } from '@/modules/auth/infrastructure/db/audit-repo';
import { tokenRepo } from '@/modules/auth/infrastructure/db/token-repo';
import { emailSender } from '@/modules/auth/infrastructure/email/resend-client';
import { buildInvitationEmail } from '@/modules/auth/infrastructure/email/invitation-email';
import { checkPasswordPolicy } from '@/modules/auth/application/password-policy';

// `checkPasswordPolicy` is imported as a value (not type-only) because it
// is a pure Application-layer function with no Infrastructure dependencies.
// This does NOT create a runtime cycle: password-policy.ts imports only
// the logger and Node crypto, never auth-deps. `buildInvitationEmail`
// follows the same rule — pure template-builder, no DB or network, so
// injecting the value is safe even though it ships from the Infrastructure
// folder (the physical location is legacy; functionally it is an
// Application concern).

// Type-only back-references to the Application use cases. These
// imports are elided at compile time — no runtime cycle.
import type { SignInDeps } from '@/modules/auth/application/sign-in';
import type { SignOutDeps } from '@/modules/auth/application/sign-out';
import type { ForgotPasswordDeps } from '@/modules/auth/application/forgot-password';
import type { ResetPasswordDeps } from '@/modules/auth/application/reset-password';
import type { ChangePasswordDeps } from '@/modules/auth/application/change-password';
import type { CreateUserDeps } from '@/modules/auth/application/create-user';
import type { RedeemInviteDeps } from '@/modules/auth/application/redeem-invite';
import type { DisableUserDeps } from '@/modules/auth/application/disable-user';
import type { EnableUserDeps } from '@/modules/auth/application/enable-user';
import type { ChangeRoleDeps } from '@/modules/auth/application/change-role';
import type { HeartbeatDeps } from '@/modules/auth/application/heartbeat';

// Shared default clock — single source of truth for "now" across every
// default deps object. Tests still override `now` via their own stubs;
// production call sites all share this reference.
const wallClock = (): Date => new Date();

export const defaultSignInDeps: SignInDeps = {
  users: userRepo,
  sessions: sessionRepo,
  audit: auditRepo,
  hasher: argon2Hasher,
  limiter: rateLimiter,
  now: wallClock,
};

export const defaultSignOutDeps: SignOutDeps = {
  sessions: sessionRepo,
  audit: auditRepo,
};

export const defaultForgotPasswordDeps: ForgotPasswordDeps = {
  users: userRepo,
  tokens: tokenRepo,
  audit: auditRepo,
  limiter: rateLimiter,
  email: emailSender,
  now: wallClock,
};

export const defaultResetPasswordDeps: ResetPasswordDeps = {
  users: userRepo,
  tokens: tokenRepo,
  sessions: sessionRepo,
  audit: auditRepo,
  hasher: argon2Hasher,
  limiter: rateLimiter,
  checkPolicy: checkPasswordPolicy,
  now: wallClock,
};

export const defaultChangePasswordDeps: ChangePasswordDeps = {
  users: userRepo,
  sessions: sessionRepo,
  audit: auditRepo,
  hasher: argon2Hasher,
  limiter: rateLimiter,
  checkPolicy: checkPasswordPolicy,
  now: wallClock,
};

export const defaultCreateUserDeps: CreateUserDeps = {
  users: userRepo,
  tokens: tokenRepo,
  audit: auditRepo,
  email: emailSender,
  buildInvitationEmail,
  now: wallClock,
};

export const defaultRedeemInviteDeps: RedeemInviteDeps = {
  users: userRepo,
  tokens: tokenRepo,
  sessions: sessionRepo,
  audit: auditRepo,
  hasher: argon2Hasher,
  limiter: rateLimiter,
  checkPolicy: checkPasswordPolicy,
  now: wallClock,
};

export const defaultDisableUserDeps: DisableUserDeps = {
  users: userRepo,
  sessions: sessionRepo,
  audit: auditRepo,
  now: wallClock,
};

export const defaultEnableUserDeps: EnableUserDeps = {
  users: userRepo,
  audit: auditRepo,
};

export const defaultChangeRoleDeps: ChangeRoleDeps = {
  users: userRepo,
  sessions: sessionRepo,
  audit: auditRepo,
};

export const defaultHeartbeatDeps: HeartbeatDeps = {
  sessions: sessionRepo,
  limiter: rateLimiter,
  now: wallClock,
};
