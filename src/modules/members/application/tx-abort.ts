/**
 * Shared transactional-abort helper for use cases that orchestrate
 * multi-step Postgres transactions via `runInTenant(...)`.
 *
 * Pattern:
 *   try {
 *     const outcome = await runInTenant(tenant, async (tx) => {
 *       const a = await port1.do(tx, ...);
 *       if (!a.ok) throw new UseCaseAbort(mapError(a.error));
 *       // ... more steps ...
 *       return result;
 *     });
 *     return ok(outcome);
 *   } catch (e) {
 *     if (e instanceof UseCaseAbort) return err(e.error);
 *     return err({ code: 'server_error', cause: e });
 *   }
 *
 * `throw new UseCaseAbort(error)` rolls back the transaction and the
 * outer catch re-surfaces the typed error — keeping the tx body free
 * of nested `if (!result.ok) { ... }` boilerplate.
 */
export class UseCaseAbort<E> extends Error {
  constructor(public readonly error: E) {
    super();
    this.name = 'UseCaseAbort';
  }
}
