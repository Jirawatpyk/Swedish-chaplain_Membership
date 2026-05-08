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
 * Two exceptions: `checkPasswordPolicy` and `buildResetPasswordEmail`
 * are imported as VALUES because they are pure functions with no
 * Infrastructure dependencies (no DB, no network, no Drizzle) — see
 * the block comment below the imports for details. The previous
 * `buildInvitationEmail` value-import was removed in T049 (2026-04-17)
 * when create-user migrated from synchronous send to outbox enqueue;
 * the template builder is now invoked from the outbox dispatcher.
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
import { buildResetPasswordEmail } from '@/modules/auth/infrastructure/email/reset-password-email';
import { checkPasswordPolicy } from '@/modules/auth/application/password-policy';
// Outbox enqueue for invitation emails (T049 close-out). Bypasses
// runInTenant because F1 invitation flow is cross-tenant (admin staff
// created without a tenant context); the outbox table has no RLS
// (operational data — see migration 0011 header) so a direct insert
// is the correct integration point.
import type { DbTx } from '@/lib/db';
import { notificationsOutbox } from '@/modules/auth/infrastructure/db/schema';
import { err, ok, type Result } from '@/lib/result';
import type {
  EnqueueInvitationInTxFn,
  EnqueueInvitationError,
} from '@/modules/auth/application/create-user';

// `checkPasswordPolicy` is imported as a value (not type-only) because it
// is a pure Application-layer function with no Infrastructure dependencies.
// This does NOT create a runtime cycle: password-policy.ts imports only
// the logger and Node crypto, never auth-deps. `buildResetPasswordEmail`
// follows the same rule — pure template builder, no DB or network,
// so injecting the value is safe even
// though they ship from the Infrastructure folder (the physical
// location is legacy; functionally they are Application concerns).
// The composition root is the only place these values appear; the use
// cases (`create-user.ts`, `forgot-password.ts`) take them as injectable
// `Deps` fields and import only the function TYPE.

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

// Re-export the Upstash-backed rate limiter so presentation-layer
// routes don't need their own deep infrastructure import. `src/lib/**`
// is the Chamber-OS composition adapter layer (eslint allow-listed).
export { rateLimiter };

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
  buildResetPasswordEmail,
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

/**
 * Default invitation-outbox enqueue — Path C atomic variant. Inserts
 * into `notifications_outbox` with `notification_type='member_invitation'`
 * and `tenant_id` set to the inviter's chamber slug (NOT NULL since
 * migration 0098 enabled FORCE RLS on this table). Uses the caller's
 * tx handle so user + invitation + outbox rows commit together (or
 * roll back together on any error). The dispatcher cron
 * (`/api/cron/outbox-dispatch`) renders + sends within its next ≤60s
 * tick. `cause` is sanitised to a string to prevent raw DB exception
 * leakage into upstream loggers.
 *
 * Why we don't switch to `runInTenant`:
 *   - `users` + `invitations` INSERTs are cross-tenant (Constitution
 *     Principle I — `users` is the global identity table) and
 *     `chamber_app` deliberately has NO INSERT grant on those tables
 *     (see migrations 0006/0016/0017). Switching this entire tx to
 *     `runInTenant` would `SET LOCAL ROLE chamber_app` and break the
 *     `users.createPendingInTx` + `tokens.createInvitationInTx` calls
 *     with permission-denied.
 *   - The `db.transaction(...)` path runs as the owner role which has
 *     `BYPASSRLS=TRUE`, so the FORCE RLS WITH CHECK on
 *     `notifications_outbox` is a no-op for owner inserts. We still
 *     pass `req.tenantId` so the row carries the real tenant slug,
 *     ensuring the per-tenant dispatcher path (chamber_app role) can
 *     read it back via the matching RLS policy.
 */
const enqueueInvitationInTx: EnqueueInvitationInTxFn = async (
  tx: DbTx,
  req,
): Promise<Result<{ outboxRowId: string }, EnqueueInvitationError>> => {
  try {
    const [row] = await tx
      .insert(notificationsOutbox)
      .values({
        tenantId: req.tenantId,
        notificationType: 'member_invitation',
        toEmail: req.toEmail.toLowerCase(),
        locale: req.locale ?? 'en',
        contextData: {
          token: req.token as string,
          role: req.role,
        },
      })
      .returning({ id: notificationsOutbox.id });
    if (!row) {
      return err({ code: 'no_row_returned' });
    }
    return ok({ outboxRowId: row.id });
  } catch (e) {
    return err({
      code: 'enqueue_failed',
      cause: e instanceof Error ? e.message : String(e),
    });
  }
};

export const defaultCreateUserDeps: CreateUserDeps = {
  users: userRepo,
  tokens: tokenRepo,
  audit: auditRepo,
  enqueueInvitationInTx,
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
