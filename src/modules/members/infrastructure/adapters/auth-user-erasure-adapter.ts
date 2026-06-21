/**
 * UserErasurePort adapter — bridges F3 member erasure → F1 `eraseUser`
 * (COMP-1 US2a). Mirror of `delete-invited-user-port-adapter.ts` (the other
 * members → auth composition glue).
 *
 * Single allowed F3 → F1 crossing point for linked-login erasure. Imports F1's
 * public barrel (`@/modules/auth`) — Constitution Principle III barrel-guard
 * permits cross-module reads of public exports. Internal auth modules
 * (`./application`, `./infrastructure`) are NOT imported.
 *
 * Mapping: the members-side port passes `userId` + `{ actorUserId, requestId }`;
 * the auth `EraseUserInput` additionally wants `sourceIp` (always `null` on this
 * server-side cascade — no inbound request) and a non-null `requestId` (the
 * `'system'` sentinel when the caller has none). The auth `eraseUser` is
 * never-throws (returns a typed `Result`), but this best-effort cascade adapter
 * STILL wraps the call in try/catch so a calling-convention throw cannot kill
 * the per-user loop in `erase-member` (the linked-user iteration must survive
 * one bad user and continue, so the US2d reconciler re-drives only the failed
 * one).
 *
 * Both failure shapes map to a typed port `err`, but with DISTINCT `code`s — a
 * caught throw is `'erase-user-threw'`, an auth `err` forwards the auth code
 * unchanged (`'erase-user-failed'` for a transient infra fault, or
 * `'erase-user-last-admin'` when the anonymise UPDATE tripped the
 * last-admin-protection trigger) — so the classes stay forensically
 * distinguishable. Both paths also log BEFORE returning (carrying `userId` +
 * `cascade`, plus the error CLASS name — `causeKind` on the auth-err path,
 * `errKind` on the throw path; never a raw message, COMP-1 FIX D) and emit
 * `authMetrics.eraseCascadeOutcome` so a stuck cascade — security-relevant: an
 * erased member can still authenticate until the US2d reconciler re-drives the
 * failed login — is alertable on a bounded label, not just a log grep. The
 * auth-err path picks the metric label from the code: `'erase-user-last-admin'`
 * → the distinct `'last_admin'` label (operator-remediated: promote another
 * admin — never a Neon recovery, so it must NOT hide in the `'failed'` rate),
 * everything else → `'failed'`.
 */
import { eraseUser } from '@/modules/auth';
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { authMetrics } from '@/lib/metrics';
import type { UserErasurePort } from '../../application/ports/user-erasure-port';

export const authUserErasureAdapter: UserErasurePort = {
  async eraseUser(
    userId,
    meta,
  ): Promise<Result<{ readonly erased: boolean }, { readonly code: string }>> {
    // The audit row needs a non-empty requestId; the server-side cascade has
    // no inbound request id, so fall back to a stable sentinel. The `system:*`
    // prefix matches the project correlation convention so a DPO
    // `request_id LIKE 'system:%'` filter sweeps these cascade rows. Resolve it
    // ONCE here and reuse it for BOTH the `eraseUser` call (→ the audit row) and
    // the two failure logs below, so a future US2d-reconciler caller that passes
    // `requestId === null` writes the SAME correlation id to the log as to the
    // audit row (logging the raw `meta.requestId` would diverge to `null`).
    const auditRequestId = meta.requestId ?? 'system:erase-cascade';
    try {
      const result = await eraseUser({
        userId,
        actorUserId: meta.actorUserId,
        requestId: auditRequestId,
        // Server-side cascade — no client request, hence no source IP.
        sourceIp: null,
      });
      if (!result.ok) {
        // Auth-err is the MOST COMMON failure (Neon down → typed `err` with a
        // SQLSTATE/PG `cause`). Log BEFORE returning, symmetric with the throw
        // path below, carrying `userId` + `cause` so the US2d reconciler and
        // on-call can trace WHICH linked login failed and WHY (the auth-side
        // log lacks `userId`). `cause` is a PG message, PII-free; never log
        // email/displayName. The port RETURN type still drops `cause` (Task 6
        // branches only on `.ok`) — it surfaces in the log + metric only.
        logger.error(
          {
            err: result.error.code,
            // Forbidden-log hygiene (COMP-1 PR-review FIX D): the auth `cause` is
            // a raw PG error — a Postgres message can embed SQL param VALUES (the
            // erased member's PII). Log only the cause CLASS name; `err` (the
            // typed auth code) already carries the failure semantics for triage.
            causeKind:
              result.error.cause instanceof Error
                ? result.error.cause.constructor.name
                : 'unknown',
            userId,
            requestId: auditRequestId,
            cascade: 'f1_user_erasure',
          },
          'members.erase.user_erasure_failed',
        );
        // Pick the metric label from the code so a stuck last-admin erasure —
        // operator-remediated (promote another admin), NOT a Neon recovery — is
        // alertable on its own label instead of buried in the 'failed' rate.
        authMetrics.eraseCascadeOutcome(
          result.error.code === 'erase-user-last-admin' ? 'last_admin' : 'failed',
        );
        return err({ code: result.error.code });
      }
      return ok({ erased: result.value.erased });
    } catch (e) {
      // `eraseUser` is never-throws by contract; a throw here is an unexpected
      // calling-convention failure. Map it to a typed port err (best-effort —
      // the caller's loop continues to the next linked user). The `'threw'`
      // metric label keeps this contract-violation class distinct from the
      // expected-infra `'failed'` class above.
      logger.error(
        {
          // Forbidden-log hygiene (COMP-1 PR-review FIX D): error CLASS name only,
          // never the raw message (it can embed SQL param VALUES = erased PII).
          errKind: e instanceof Error ? e.constructor.name : 'unknown',
          userId,
          requestId: auditRequestId,
          cascade: 'f1_user_erasure',
        },
        'members.erase.user_erasure_threw',
      );
      authMetrics.eraseCascadeOutcome('threw');
      return err({ code: 'erase-user-threw' });
    }
  },
};
