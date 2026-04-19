/**
 * Generic transaction-abort carrier for the F4 throw-catch pattern.
 *
 * Why: returning `err(...)` from inside `withTx` resolves the callback
 * normally and the underlying Drizzle transaction COMMITS. For errors
 * that occur AFTER a side-effectful step (most importantly
 * `sequenceAllocator.allocateNext`) we MUST throw to force rollback —
 * then catch outside the tx and map to a typed `Result`.
 *
 * Each use case declares its own subclass so `instanceof` narrowing
 * remains type-exact. The subclass pattern (rather than a generic
 * helper) is intentional:
 *   - Type narrowing via `instanceof` gives the outer catch access to
 *     the concrete error union without unsafe casts.
 *   - A runtime marker pattern (e.g. `{ _throw: E }`) would require a
 *     type predicate + `unknown` cast — noisier than the class form.
 *
 * Usage:
 *   ```ts
 *   class IssueInvoiceInternalError extends TxAbort<IssueInvoiceError> {}
 *
 *   try {
 *     return await deps.invoiceRepo.withTx(async (tx) => {
 *       // ... eventually:
 *       throw new IssueInvoiceInternalError({ code: 'overflow', fy });
 *     });
 *   } catch (e) {
 *     if (e instanceof IssueInvoiceInternalError) return err(e.error);
 *     throw e;
 *   }
 *   ```
 *
 * Pure TypeScript — no framework imports (Principle III).
 */
export class TxAbort<E> extends Error {
  readonly error: E;
  constructor(error: E) {
    const code = (error as { code?: string })?.code ?? 'unknown';
    super(`TxAbort: ${code}`);
    this.error = error;
    // Preserve the subclass name in stack traces — `new.target` is
    // the concrete subclass when this ctor runs as super().
    this.name = new.target.name;
  }
}
