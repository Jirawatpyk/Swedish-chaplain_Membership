/**
 * Application port — F1 linked-login erasure for member right-to-erasure
 * (COMP-1 US2a — GDPR Art. 17 / PDPA §33).
 *
 * When a member is erased, its scrub anonymises the F3 member + contact rows
 * but the linked F1 *login* accounts (`users` rows, cross-tenant — no
 * tenant_id, no RLS) still resolve the original email at sign-in. This port is
 * the members → auth bridge that anonymises each such login so the erased
 * member can no longer authenticate. Used by `erase-member` as a POST-COMMIT
 * best-effort cascade (the member scrub has already committed; the F1 erasure
 * runs per linked-user id in its own owner-role tx).
 *
 * Cross-module note: the `users` table lives in F1 (`auth`). The adapter
 * (`infrastructure/adapters/auth-user-erasure-adapter.ts`) is the single
 * allowed crossing point for this F3 use-case; it calls auth's public barrel
 * export `eraseUser`. Application-layer callers depend ONLY on this port — no
 * auth type leaks into the members Application layer (Principle III).
 *
 * Best-effort + idempotent contract: a re-run on an already-anonymised login
 * is a no-op (the auth use-case derives a deterministic sentinel from the id),
 * so the cascade is safely resumable. `erased: false` is a SUCCESS — it means
 * the `users` row was already gone (hard-deleted / never existed), i.e. the
 * erasure goal already holds. A failure returns a typed `err` (NEVER a throw)
 * so `erase-member` flips `allCascadesClean = false` and the US2d reconciler
 * re-drives the linked-user that did not erase. The adapter logs + emits a
 * failure metric (`authMetrics.eraseCascadeOutcome`) BEFORE returning the
 * `err`, on BOTH the auth-`err` and the unexpected-throw path, so a stuck
 * cascade is traceable + alertable (the `err` itself drops the `cause`).
 */
import type { Result } from '@/lib/result';

export interface UserErasurePort {
  /**
   * Anonymise one F1 login account (`users.id`). Idempotent.
   *
   * @param userId  the cross-tenant `users.id` linked to an erased member.
   * @param meta.actorUserId  the admin (or `system:*` sentinel) that initiated
   *   the member erasure — recorded as the `user_erased` audit actor.
   * @param meta.requestId  forensic correlation id; the adapter substitutes a
   *   `'system:erase-cascade'` sentinel when null so the audit row always
   *   carries one (the `system:*` prefix is DPO-greppable via
   *   `request_id LIKE 'system:%'`).
   *
   * @returns `ok({ erased })` — `true` anonymised, `false` no-op (row already
   *   gone, still a success). `err({ code })` — the auth erasure failed; the
   *   caller treats it as not-clean and the reconciler re-drives.
   */
  eraseUser(
    userId: string,
    meta: { readonly actorUserId: string; readonly requestId: string | null },
  ): Promise<Result<{ readonly erased: boolean }, { readonly code: string }>>;
}
