/**
 * Duck-type a thrown gateway error into the `BroadcastsGatewayError`-compatible
 * shape. The Infrastructure adapter throws a `GatewayThrowable` carrying
 * `kind` + `subKind` + `resourceType`; we read those fields structurally so the
 * Application layer never imports from Infrastructure (Constitution
 * Principle III).
 *
 * Extracted from `dispatch-scheduled-broadcast.ts` in 108 Phase 9 so
 * `build-audience-tick.ts` classifies throws the SAME way. It previously had no
 * `catch` at all — 0 against the legacy path's 18 — so every Resend error
 * reached the cron as `uncaught_error`, the bucket reserved for programming
 * bugs, and left the row `approved` to be retried every five minutes for ever.
 * Two paths that classify differently are two paths an operator has to learn;
 * one shared reader is the point of this file.
 */

export type GatewayThrownShape = {
  kind?: string;
  subKind?: string;
  reason?: string;
  /**
   * Round 4, whole-branch review #7 — `'import'` added. The adapter tags a 404
   * on `GET /contacts/imports/{id}` with it, and this file reads the throw
   * STRUCTURALLY through a cast, so a narrower union here would have been a
   * silent lie: the value flows at runtime while `tsc` reports a type it does
   * not have. That is the cast-suppresses-the-compiler shape this branch has
   * been removing all round, so the union is widened along the whole chain
   * rather than only where the value is produced.
   */
  resourceType?: 'audience' | 'broadcast' | 'import';
  resourceId?: string;
  code?: string;
};

export function classifyThrown(
  e: unknown,
): GatewayThrownShape & { kind: string } {
  if (typeof e === 'object' && e !== null && 'kind' in e) {
    const shape = e as GatewayThrownShape;
    if (typeof shape.kind === 'string') {
      return { ...shape, kind: shape.kind };
    }
  }
  return {
    kind: 'unknown',
    reason: e instanceof Error ? e.message : String(e),
  };
}

/**
 * Is this classified throw one the caller should retry on a later tick?
 *
 * `retryable` is the adapter's own classification for 5xx / 429 / network. Every
 * other kind — `permanent` (a 4xx, e.g. the Resend Free plan's contact cap),
 * `resource_missing`, `idempotency_conflict`, `unknown` — is a statement that
 * re-attempting produces the same answer, so the broadcast must reach a terminal
 * state and tell the member rather than sit in `approved`.
 *
 * `unknown` counts as NON-retryable on purpose. It is reached when the throw
 * carries no `kind` at all, i.e. it is not a gateway error but a programming
 * fault, and retrying a programming fault every five minutes for ever is the
 * behaviour this whole change exists to remove.
 */
export function isRetryableThrow(kind: string): boolean {
  return kind === 'retryable';
}
