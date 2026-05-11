/**
 * F8 Phase 5 Wave A · T119 — `ConsumedLinkTokensRepo` Application port.
 *
 * Replay-protection primitive for renewal-link tokens (research.md R1
 * step 6 + 8). The verify-renewal-link-token use-case calls
 * `markConsumed` AFTER the verifier has succeeded — atomic insert into
 * `consumed_link_tokens` with `ON CONFLICT DO NOTHING` semantics. If
 * the row already existed (token replay), `markConsumed` returns
 * `{ status: 'replay', firstConsumedAt }` so the use-case can emit
 * `renewal_token_invalid { reason: 'replayed' }` audit and reject.
 *
 * Tenant isolation: callers thread `tenantId` explicitly + bind
 * `app.current_tenant` via `runInTenant` so RLS+FORCE policies on the
 * `consumed_link_tokens` table double-enforce isolation (Constitution
 * Principle I two-layer + research.md R1 step 7 defence-in-depth).
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */

export interface MarkConsumedInput {
  readonly tenantId: string;
  /** SHA-256 digest of the raw token bytes (32 bytes). */
  readonly tokenSha256: Uint8Array;
  readonly consumedByMemberId: string;
  readonly cycleId: string;
}

/**
 * Discriminated union — `'fresh'` means the row was newly inserted;
 * `'replay'` means the same `(tenantId, tokenSha256)` PK was already
 * present (replay attempt). The use-case maps `replay` to a generic
 * "link expired" 404 + audit per FR-027 step 6.
 */
export type MarkConsumedResult =
  | { readonly status: 'fresh'; readonly consumedAt: Date }
  | { readonly status: 'replay'; readonly firstConsumedAt: Date };

export interface ConsumedLinkTokensRepo {
  /**
   * Atomically claim the (tenantId, tokenSha256) PK. Returns `'fresh'`
   * on first consume, `'replay'` if the row already existed.
   *
   * MUST run with `app.current_tenant` already bound (caller wraps in
   * `runInTenant`). The DB row's `tenant_id` is derived from the input
   * — RLS+FORCE rejects writes that try to insert under a different
   * tenant context.
   */
  markConsumed(input: MarkConsumedInput): Promise<MarkConsumedResult>;
}
