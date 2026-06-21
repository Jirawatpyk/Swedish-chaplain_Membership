/**
 * `erase-user` use case (COMP-1 US2a — Member Erasure F1 linked-user erasure /
 * GDPR Art.17 · PDPA §33).
 *
 * Anonymises an F1 login account so a GDPR-Art.17-erased member can no longer
 * authenticate: email → a globally-unique non-routable sentinel
 * (`erased+{userId}@erased.invalid`, lower-cased to satisfy the functional
 * `lower(email)` unique index), `password_hash` → NULL, `display_name` →
 * '[erased]', `status` → 'disabled', `email_verified` → false (the scrub
 * itself lives in `UserRepo.anonymiseErasedInTx`); then revokes any live
 * sessions. These compose into three independent sign-in guards
 * (`status='disabled'`, `password_hash` NULL, `email_verified=false` — see
 * sign-in.ts) so no single missed field re-opens authentication. Emits
 * `user_erased` (no PII in the payload) as the TAIL statement of the tx.
 *
 * Authority: this is an application use case — it performs NO actor
 * authorization itself. The CALLER (the members → auth erasure bridge / admin
 * route) is responsible for proving the operator may erase this account; the
 * `actorUserId` is recorded for the audit trail, not checked here.
 *
 * Runs in an OWNER-role `db.transaction` (the `users` table is cross-tenant —
 * no tenant_id, no RLS — so it cannot join a members `runInTenant` tx). Mirrors
 * `delete-invited-user.ts` (owner-role tx, `Pick` deps, never-throws → typed
 * err, audit at the tail).
 *
 * Idempotent / resumable: the sentinel is derived from the id, so a re-run on an
 * already-anonymised row writes byte-identical values with no unique-index
 * violation, and re-revoking 0 sessions is a no-op. `erased: false` means the
 * row was already gone (hard-deleted / never existed) — that is NOT an error, so
 * the success value carries `{ erased: false }` and the caller treats it as done.
 *
 * Audit ordering: the auth `appendInTx` NEVER throws across the boundary (it
 * catches the DB error → `logger.error` + `authMetrics.auditMissing`), so a
 * poisoned tx would swallow it silently. It MUST therefore be the LAST statement
 * before COMMIT — no non-audit statement may follow (see audit-repo.ts JSDoc).
 *
 * Never throws out: any DB error inside the tx (the anonymise scrub or the
 * session revoke) propagates to the outer try/catch → `err({ code:
 * 'erase-user-failed' })`, so the caller (the members → auth bridge) always sees
 * a typed Result and flips its cascade-clean flag for the US2d reconciler to
 * re-drive (Constitution Principle VIII).
 *
 * Last-admin trigger interaction (DISTINCT signal): `anonymiseErasedInTx` flips
 * `status active→disabled` with an UPDATE keyed on `users.id`. If the erased
 * member's contact is linked to the LAST active admin login, the
 * `users_last_admin_protection` BEFORE-UPDATE trigger (migration 0003) raises
 * `SQLSTATE 23514` to refuse leaving the tenant with zero active admins — and it
 * is CORRECT to refuse. This is not a transient fault: blindly mapping it to the
 * generic `'erase-user-failed'` would have on-call (and the US2d reconciler,
 * which re-drives forever) see only a looping generic failure with no idea it is
 * the irreducible last-admin case. So the catch checks `isLastAdminTriggerError`
 * BEFORE the generic mapping and returns the DISTINCT `'erase-user-last-admin'`
 * code (+ a distinct `erase_user.last_admin_blocked` log line, userId only, no
 * PII), mirroring `disable-user.ts` / `change-role.ts`. OPERATOR remediation:
 * promote another admin (or transfer the admin's contact link to a different
 * login) before the erasure can complete — we never bypass the trigger or
 * force-disable the last admin; surfacing the distinct code is what lets an
 * operator act. Everything else still maps to `'erase-user-failed'`.
 */
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { isLastAdminTriggerError } from '@/lib/db-errors';
import { err, ok, type Result } from '@/lib/result';
import type { UserId } from '@/modules/auth/domain/branded';
import type { ActorRef } from '@/modules/auth/domain/audit-event';
import type { UserRepo } from '@/modules/auth/infrastructure/db/user-repo';
import type { SessionRepo } from '@/modules/auth/infrastructure/db/session-repo';
import type { AuditRepo } from '@/modules/auth/infrastructure/db/audit-repo';
import { defaultEraseUserDeps } from '@/lib/auth-deps';

export interface EraseUserInput {
  /** The F1 login account to anonymise (cross-tenant `users.id`). */
  readonly userId: string;
  /** Session user id of the operator (or a `system:*` sentinel) — audit actor. */
  readonly actorUserId: string;
  readonly requestId: string;
  readonly sourceIp: string | null;
}

export interface EraseUserSuccess {
  /**
   * `true`  — the `users` row was anonymised (or re-anonymised idempotently).
   * `false` — a no-op: no row matched the id (already hard-deleted / never
   *           existed). NOT an error — the erasure goal (no resolvable login)
   *           already holds.
   */
  readonly erased: boolean;
}

export type EraseUserError = {
  /**
   * `'erase-user-last-admin'` — the anonymise UPDATE tripped the
   * `users_last_admin_protection` trigger (SQLSTATE 23514): the erased member's
   * contact is linked to the last active admin login. NOT transient — the
   * trigger is correct; an operator must promote another admin / transfer the
   * contact link first. Distinct from `'erase-user-failed'` so on-call (and the
   * US2d reconciler) can tell it apart from a transient infra fault.
   * `'erase-user-failed'` — every other DB fault inside the tx.
   */
  readonly code: 'erase-user-failed' | 'erase-user-last-admin';
  readonly cause: unknown;
};

export interface EraseUserDeps {
  readonly users: Pick<UserRepo, 'anonymiseErasedInTx'>;
  readonly sessions: Pick<SessionRepo, 'deleteByUserIdInTx'>;
  readonly audit: Pick<AuditRepo, 'appendInTx'>;
}

export { defaultEraseUserDeps };

export async function eraseUser(
  input: EraseUserInput,
  deps: EraseUserDeps = defaultEraseUserDeps,
): Promise<Result<EraseUserSuccess, EraseUserError>> {
  // `users` is cross-tenant — a UUID id, never a branded value at this boundary.
  // The repo + audit row types want the brand; cast at the trust boundary
  // (same convention as delete-invited-user.ts's `actorUserId as ActorRef`).
  const userId = input.userId as UserId;
  try {
    const outcome = await db.transaction(async (tx) => {
      // 1. Scrub the users row. Plain `{ erased }` (NOT a Result) — a DB error
      //    THROWS and is caught by the outer try/catch. `erased:false` just
      //    means no row matched the id (already gone) — handled as success.
      const { erased } = await deps.users.anonymiseErasedInTx(tx, userId);

      // 2. Revoke any live sessions (idempotent — 0 sessions is fine on a re-run
      //    or when US1 already revoked them inside the members tx). Returns the
      //    revoked COUNT and throws on a DB error (session-repo throw-style).
      await deps.sessions.deleteByUserIdInTx(tx, userId);

      // 3. Audit at the TAIL (auth appendInTx never-throws — must be last so a
      //    poisoned tx cannot swallow a non-audit statement after it).
      await deps.audit.appendInTx(tx, {
        eventType: 'user_erased',
        actorUserId: input.actorUserId as ActorRef,
        targetUserId: userId,
        sourceIp: input.sourceIp,
        // No PII (no email / display name) — only the opaque id.
        summary: `user_erased ${input.userId}`,
        requestId: input.requestId,
      });

      return { erased };
    });
    return ok(outcome);
  } catch (e) {
    // Distinct signal FIRST: the `users_last_admin_protection` trigger (SQLSTATE
    // 23514) refuses to disable the last active admin. Correct refusal, NOT a
    // transient fault — surface it apart from the generic failure so on-call can
    // act (promote another admin) instead of watching the US2d reconciler loop on
    // a generic error. Mirrors disable-user.ts / change-role.ts. userId only, no
    // PII.
    if (isLastAdminTriggerError(e)) {
      logger.error(
        { requestId: input.requestId, userId: input.userId },
        'erase_user.last_admin_blocked',
      );
      return err({ code: 'erase-user-last-admin', cause: e });
    }
    logger.error(
      {
        requestId: input.requestId,
        // Forbidden-log hygiene (COMP-1 PR-review FIX D): never log the raw
        // error message — a Postgres error can embed SQL param VALUES (the
        // erased user's PII). Log only the error CLASS name. The original error
        // is still carried structurally on the returned `cause` (not a log).
        errKind: e instanceof Error ? e.constructor.name : 'unknown',
      },
      'erase_user.failed',
    );
    return err({ code: 'erase-user-failed', cause: e });
  }
}
