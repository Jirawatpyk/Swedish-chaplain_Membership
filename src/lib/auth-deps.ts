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
import { checkPasswordPolicy } from '@/modules/auth/application/password-policy';

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

export const defaultSignInDeps: SignInDeps = {
  users: userRepo,
  sessions: sessionRepo,
  audit: auditRepo,
  hasher: argon2Hasher,
  limiter: rateLimiter,
  now: () => new Date(),
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
  now: () => new Date(),
};

export const defaultResetPasswordDeps: ResetPasswordDeps = {
  users: userRepo,
  tokens: tokenRepo,
  sessions: sessionRepo,
  audit: auditRepo,
  hasher: argon2Hasher,
  limiter: rateLimiter,
  checkPolicy: checkPasswordPolicy,
  now: () => new Date(),
};

export const defaultChangePasswordDeps: ChangePasswordDeps = {
  users: userRepo,
  sessions: sessionRepo,
  audit: auditRepo,
  hasher: argon2Hasher,
  limiter: rateLimiter,
  checkPolicy: checkPasswordPolicy,
  now: () => new Date(),
};

export const defaultCreateUserDeps: CreateUserDeps = {
  users: userRepo,
  tokens: tokenRepo,
  audit: auditRepo,
  email: emailSender,
  now: () => new Date(),
};

export const defaultRedeemInviteDeps: RedeemInviteDeps = {
  users: userRepo,
  tokens: tokenRepo,
  sessions: sessionRepo,
  audit: auditRepo,
  hasher: argon2Hasher,
  limiter: rateLimiter,
  checkPolicy: checkPasswordPolicy,
  now: () => new Date(),
};

export const defaultDisableUserDeps: DisableUserDeps = {
  users: userRepo,
  sessions: sessionRepo,
  audit: auditRepo,
  now: () => new Date(),
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
