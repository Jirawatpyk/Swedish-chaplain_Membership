/**
 * Shared transactional-abort helper for F1 use cases that orchestrate
 * multi-step bare `db.transaction(...)` transactions (not via
 * `runInTenant`, because F1 flows are cross-tenant).
 *
 * Pattern:
 *   try {
 *     const outcome = await db.transaction(async (tx) => {
 *       const a = await port1.doInTx(tx, ...);
 *       if (!a.ok) throw new TxAbort(mapError(a.error));
 *       // ... more steps ...
 *       return result;
 *     });
 *     return ok(outcome);
 *   } catch (e) {
 *     if (e instanceof TxAbort) return err(e.error);
 *     throw e;
 *   }
 *
 * Drizzle's `db.transaction(fn)` rolls back ONLY when `fn` throws;
 * `return err(...)` from inside the callback would commit. The sentinel
 * class makes the throw explicit + carries a typed error payload so the
 * outer catch can map it back to a use-case error without losing shape.
 *
 * Mirrors `src/modules/members/application/tx-abort.ts` (F3 pattern).
 *
 * Originally named `CreateUserAbort` (F1 create-user Path C refactor —
 * F1 PR #1 post-ship hardening). Renamed to `TxAbort` when redeem-invite
 * and reset-password adopted the same pattern. The deprecated alias was
 * removed at O9 (Round 3) after verifying zero call-site references.
 */
export class TxAbort<E> extends Error {
  constructor(public readonly error: E) {
    super();
    this.name = 'TxAbort';
  }
}
