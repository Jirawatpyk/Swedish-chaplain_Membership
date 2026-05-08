/**
 * create-user use case (T123, spec US4 AS1, FR-009) — Path C refactor.
 *
 * Admin invites a new staff / member by email. All 4 side effects
 * (user insert + invitation insert + outbox enqueue + audit append)
 * execute inside a SINGLE `db.transaction(...)` so the full flow is
 * atomic:
 *
 *   BEGIN;
 *     INSERT INTO users (... status='pending');
 *     INSERT INTO invitations (...);
 *     INSERT INTO notifications_outbox (...);
 *     INSERT INTO audit_log (... event='account_created');
 *   COMMIT;
 *
 * If ANY step fails the whole tx rolls back — no orphan user, no
 * invitation without an outbox row, no audit without state. Pre-Path-C
 * the flow used 3 separate connections + a compensating `deletePending`
 * call that had to be maintained manually and could leave the audit
 * event missing on the enqueue-fail path (the silent-success bug that
 * the L1-L3 observability layers surfaced).
 *
 * Why `db.transaction` directly and not `runInTenant`:
 *   - The `users` + `invitations` tables are cross-tenant (Constitution
 *     Principle I — `users` is the global identity table). The
 *     `chamber_app` role deliberately has NO INSERT grant on those
 *     tables (migrations 0006/0016/0017), so wrapping this tx in
 *     `runInTenant` would `SET LOCAL ROLE chamber_app` and break the
 *     pending-user + invitation INSERTs with permission-denied.
 *   - The owner role used by `db.transaction(...)` is `BYPASSRLS=TRUE`,
 *     so the FORCE RLS introduced on `notifications_outbox` by
 *     migration 0098 (F8 Phase 10A) is a no-op for owner inserts. The
 *     outbox row still carries the inviter's `tenant_id` so the
 *     downstream per-tenant dispatcher (chamber_app role under
 *     `runInTenant`) can read it back via the matching RLS policy.
 *   - `TenantTx`/`DbTx` types are structurally identical; repos accept
 *     either via the `DbTx` alias.
 *
 * Error mapping: `CreateUserAbort<E>` sentinel throws inside the tx
 * callback and the outer catch maps it back to the typed
 * `CreateUserError` union. Any unexpected throw (DB connection loss,
 * statement timeout) bubbles out as-is so the route returns 500.
 */
import { Result, err, ok } from '@/lib/result';
import { logger } from '@/lib/logger';
import { hashId } from '@/lib/log-id';
import { authMetrics } from '@/lib/metrics';
import { db, type DbTx } from '@/lib/db';
import { asEmailAddress, type TokenId, type UserId } from '@/modules/auth/domain/branded';
import type { Role } from '@/modules/auth/domain/role';
import type { UserAccount } from '@/modules/auth/domain/user';
// Type-only — see sign-in.ts for the Clean Architecture rationale.
import type { UserRepo } from '@/modules/auth/infrastructure/db/user-repo';
import type { TokenRepo } from '@/modules/auth/infrastructure/db/token-repo';
import type { AuditRepo } from '@/modules/auth/infrastructure/db/audit-repo';
import type { EmailLocale } from '@/modules/auth/infrastructure/email/reset-password-email';
import { CreateUserAbort } from './tx-abort';
import { defaultCreateUserDeps } from '@/lib/auth-deps';

// --- Public types -------------------------------------------------------------

export interface CreateUserInput {
  readonly email: string;
  readonly role: Role;
  readonly displayName?: string | null;
  readonly actorUserId: UserId;
  readonly sourceIp: string;
  readonly requestId: string;
  readonly locale?: EmailLocale | undefined;
  /**
   * Tenant slug of the chamber the inviter belongs to. Carried on the
   * `notifications_outbox` row so the dispatcher can route + audit per
   * tenant, and so the row passes the FORCE RLS WITH CHECK introduced
   * by migration 0098 (`tenant_id NOT NULL`). Pre-MTA the F1 flow
   * stamped this column null and assumed a single global dispatcher;
   * once F2+ landed multi-tenant, every invitation belongs to a
   * specific chamber even though the `users` table itself is cross-
   * tenant per Constitution Principle I.
   */
  readonly tenantId: string;
}

export interface CreateUserSuccess {
  readonly user: UserAccount;
  /** Branded token id — carry the type across the module boundary
   * so callers can't accidentally log or compare it as a raw string. */
  readonly invitationId: TokenId;
}

export type CreateUserError =
  | { readonly code: 'invalid-input' }
  | { readonly code: 'email-taken' }
  | { readonly code: 'invitation-create-failed' };

// --- Dependencies ------------------------------------------------------------

/**
 * Outbox enqueue port for invitation emails. Inserts a row into
 * `notifications_outbox` with `notification_type='member_invitation'`.
 */
export interface EnqueueInvitationRequest {
  readonly toEmail: string;
  readonly token: TokenId;
  readonly role: Role;
  readonly locale?: EmailLocale | undefined;
  /**
   * Tenant slug of the chamber the invitation is for — written to
   * `notifications_outbox.tenant_id`. NOT NULL since migration 0098
   * (F8 Phase 10A) enabled FORCE RLS on the table; the column must
   * carry a real tenant slug so the row both satisfies the constraint
   * and is visible to the per-tenant dispatcher cron.
   */
  readonly tenantId: string;
}

/**
 * Literal union of known enqueue failure codes. Keeping this closed
 * lets consumers exhaustively handle the error space; the `cause`
 * field is sanitised (string) to avoid raw DB exception leakage.
 */
export type EnqueueInvitationErrorCode = 'enqueue_failed' | 'no_row_returned';

export interface EnqueueInvitationError {
  readonly code: EnqueueInvitationErrorCode;
  readonly cause?: string;
}

/**
 * Tx-scoped enqueue used by the atomic `createUser` flow. Inserts on
 * the caller's tx handle so the outbox row commits with the rest of
 * the flow (or rolls back together).
 */
export type EnqueueInvitationInTxFn = (
  tx: DbTx,
  request: EnqueueInvitationRequest,
) => Promise<Result<{ outboxRowId: string }, EnqueueInvitationError>>;

export interface CreateUserDeps {
  readonly users: UserRepo;
  readonly tokens: TokenRepo;
  readonly audit: AuditRepo;
  readonly enqueueInvitationInTx: EnqueueInvitationInTxFn;
  readonly now: () => Date;
}

export { defaultCreateUserDeps };

// --- Use case ----------------------------------------------------------------

export async function createUser(
  input: CreateUserInput,
  deps: CreateUserDeps = defaultCreateUserDeps,
): Promise<Result<CreateUserSuccess, CreateUserError>> {
  // Pre-tx validation — no point opening a tx for a malformed input.
  let normalisedEmail;
  try {
    normalisedEmail = asEmailAddress(input.email);
  } catch {
    return err({ code: 'invalid-input' });
  }

  const now = deps.now();

  try {
    const outcome = await db.transaction(async (tx) => {
      // 1. Duplicate check inside tx — holds the row so a concurrent
      //    admin invite cannot pass the same check and commit twice
      //    (TOCTOU race eliminated).
      const existing = await deps.users.findByEmailInTx(tx, normalisedEmail);
      if (existing) {
        throw new CreateUserAbort<CreateUserError>({ code: 'email-taken' });
      }

      // 2. Create pending user.
      const user = await deps.users.createPendingInTx(tx, {
        email: normalisedEmail,
        role: input.role,
        displayName: input.displayName ?? null,
      });

      // 3. Create invitation.
      const invitation = await deps.tokens.createInvitationInTx(tx, {
        userId: user.id,
        invitedByUserId: input.actorUserId,
        intendedRole: input.role,
        now,
      });

      // 4. Enqueue outbox — atomic with steps 1-3. If this returns err
      //    the throw triggers rollback, so users + invitations inserts
      //    are undone without needing a compensating delete path.
      const enqueueResult = await deps.enqueueInvitationInTx(tx, {
        toEmail: user.email,
        token: invitation.id,
        role: input.role,
        locale: input.locale,
        tenantId: input.tenantId,
      });
      if (!enqueueResult.ok) {
        logger.error(
          {
            requestId: input.requestId,
            errCode: enqueueResult.error.code,
            errCause: enqueueResult.error.cause,
            targetUserIdHash: hashId(user.id),
          },
          'create_user.invitation_enqueue_failed',
        );
        authMetrics.invitationEnqueueFailed(input.role, enqueueResult.error.code);
        throw new CreateUserAbort<CreateUserError>({
          code: 'invitation-create-failed',
        });
      }

      // 5. Audit — also in-tx so the append-only row commits with the
      //    state change (Principle VIII).
      await deps.audit.appendInTx(tx, {
        eventType: 'account_created',
        actorUserId: input.actorUserId,
        targetUserId: user.id,
        sourceIp: input.sourceIp,
        summary: `invited ${input.role} ${user.email}`,
        requestId: input.requestId,
      });

      return { user, invitationId: invitation.id };
    });

    // observability.md § 4.3 — invitation volume by role. Post-commit
    // so we don't count aborted transactions.
    authMetrics.invitationSent(input.role);
    return ok(outcome);
  } catch (e) {
    if (e instanceof CreateUserAbort) {
      return err(e.error as CreateUserError);
    }
    // Unexpected DB / network error. Log with context, re-raise so the
    // route handler maps it to 500. Pre-Path-C this path was reached
    // via `createInvitation` throw; now any step's throw lands here.
    logger.error(
      {
        requestId: input.requestId,
        errMessage: e instanceof Error ? e.message : String(e),
      },
      'create_user.unexpected_tx_failure',
    );
    throw e;
  }
}
