/**
 * R3-F2 (2026-05-18 /speckit-review Round 3 Final) — exhaustiveness
 * assertion helpers for `switch` statements over discriminated unions.
 *
 * **Two variants** (R4-I5 added the throwing sibling):
 *
 *   `assertExhaustive(value): void`    — pure compile-time, no runtime throw.
 *                                        Use when the caller has a
 *                                        legitimate fall-through return /
 *                                        log / continue semantic.
 *
 *   `assertExhaustiveThrowing(value, context?): never` — throws at runtime
 *                                        with optional context. Use when
 *                                        the default arm SHOULD be
 *                                        unreachable and reaching it is
 *                                        an invariant violation. Returns
 *                                        `never` so TS narrows the
 *                                        surrounding function's control
 *                                        flow.
 *
 * Replaces the 2-line `const _exhaustive: never = x; void _exhaustive;`
 * pattern previously used at 4 call sites in F6:
 *   - `process-attendee-in-tx.ts` × 2 (markRefundedErrorMessage,
 *     quota-lookup cause)
 *   - `audit-error-message.ts` × 1
 *   - `eventcreate-csv-adapter.ts` × 1 (statusToPaymentStatus)
 * Plus 1 throwing site migrated to `assertExhaustiveThrowing`:
 *   - `process-attendee-in-tx.ts:486` (emitMatchResolutionAudit)
 *
 * Usage (non-throwing):
 * ```ts
 * switch (e.kind) {
 *   case 'db_error': return e.message;
 *   case 'invariant_violation': return e.invariant;
 *   default:
 *     assertExhaustive(e); // compile-error if new variant added
 *     return `unknown: ${JSON.stringify(e)}`;
 * }
 * ```
 *
 * Usage (throwing):
 * ```ts
 * switch (resolution.type) {
 *   case 'member_contact': await emit(...); return;
 *   case 'unmatched': await emit(...); return;
 *   default:
 *     assertExhaustiveThrowing(resolution,
 *       `emitMatchResolutionAudit registrationId=${registrationId}`);
 * }
 * ```
 *
 * If a future addition to the union is unhandled, the compiler infers
 * the `default` branch's value as the unhandled variant (not `never`)
 * and both helpers fail the build because the variant is not
 * assignable to `never`. Same compile-time enforcement as the pre-R3-F2
 * pattern.
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
export function assertExhaustive(value: never): void {
  void value;
}

/**
 * Throwing sibling — R4-I5 (2026-05-18 /speckit-review Round 4). Returns
 * `never` so TS narrows the surrounding function's control flow. Use
 * when the default arm SHOULD be unreachable (the type system already
 * protects); the runtime throw is a defence-in-depth invariant guard.
 *
 * Optional `context` arg threads a forensic breadcrumb into the
 * Error message (e.g. registrationId, tenantId) so SRE log forensics
 * see the originating call site.
 */
export function assertExhaustiveThrowing(
  value: never,
  context?: string,
): never {
  const ctxSuffix = context !== undefined ? ` (${context})` : '';
  throw new Error(
    `assertExhaustiveThrowing: unexpected variant ${JSON.stringify(value)}${ctxSuffix}`,
  );
}
