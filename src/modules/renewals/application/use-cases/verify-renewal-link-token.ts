/**
 * F8 Phase 5 Wave A.5 · T120 — `verifyRenewalLinkToken` use-case.
 *
 * Implements steps 1-8 of research.md R1 v2 token verification (step 9
 * — sign-in member to a session — is presentation-layer; the route
 * handler at `src/app/(member)/portal/renewal/[memberId]/page.tsx`
 * does that).
 *
 * Verification ordering matches FR-027 step-by-step so a failure
 * audit's `reason` field maps 1:1 to the step that rejected:
 *
 *   1. (caller) Resolve `tenantFromRequest` via F1's
 *      `resolveTenantFromRequest()` and pass it as `expectedTenantId`.
 *   2. Token format check         → reason: 'malformed_token'
 *   3. HMAC verify (R16 dual-key) → reason: 'mac_mismatch'
 *   4. Expiry check               → reason: 'expired'
 *   5. Cross-tenant check         → reason: 'cross_tenant'
 *   6. Replay check               → reason: 'replayed'
 *   7. Member-tenant ownership    → reason: 'member_not_found_in_tenant'
 *      (collapsed via cycle lookup: cycle exists in tenant ∧ cycle.memberId
 *      === payload.mid, by transitive RLS).
 *   8. Mark token consumed (atomic — race-safe via PK conflict).
 *
 * Edge case (CHK033 / spec.md § Edge Cases): if the cycle is already
 * `completed` when the token verifies (T-30 fired after T-90 link
 * completed the cycle), DO NOT mark the token consumed — return
 * `'cycle_already_completed'` so the caller renders an idempotent
 * "already complete" page. The fresh token can be re-used by repeated
 * clicks within TTL without consuming any DB slot. Audit
 * `renewal_token_clicked_on_completed_cycle` for forensics.
 *
 * Audit invariants (Constitution Principle VIII):
 *   - Every reject path emits `renewal_token_invalid` once with the
 *     mapped reason. Pre-tenant-bind audits (malformed, mac_mismatch,
 *     expired) emit under the request-resolved tenant context.
 *   - Successful verify emits `renewal_self_service_initiated` (NOT
 *     in the same path as the completed-cycle audit — the two paths
 *     are mutually exclusive).
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import type { ConsumedLinkTokensRepo } from '../ports/consumed-link-tokens-repo';
import { parseCycleId } from '../../domain/renewal-cycle';

export const verifyRenewalLinkTokenInputSchema = z.object({
  /** Raw `v1.<payload>.<mac>` token from the URL query param. */
  rawToken: z.string().min(1).max(2048),
  /**
   * Tenant resolved from the inbound request via F1's
   * `resolveTenantFromRequest()`. Compared against the token's `tid`
   * for the cross-tenant check (research.md R1 v2 step 5).
   */
  expectedTenantId: z.string().min(1),
  /** Injectable clock for deterministic tests. */
  now: z.date(),
  requestId: z.string().nullable().optional(),
  correlationId: z.string().min(1),
});

export type VerifyRenewalLinkTokenInput = z.infer<
  typeof verifyRenewalLinkTokenInputSchema
>;

export type VerifyRenewalLinkTokenSuccess =
  | {
      readonly kind: 'success';
      readonly memberId: string;
      readonly cycleId: string;
      readonly verifiedWith: 'primary' | 'fallback';
    }
  | {
      readonly kind: 'cycle_already_completed';
      readonly memberId: string;
      readonly cycleId: string;
      readonly verifiedWith: 'primary' | 'fallback';
    };

/**
 * Discriminated union — splits programmer-error path (`invalid_input`,
 * Zod schema rejection BEFORE token verification) from genuine
 * security-rejection paths (HMAC mismatch, expiry, replay, cross-tenant,
 * member-cycle mismatch). PR #24 deep-review fix — the previous shape
 * folded both into `kind: 'invalid_token'` so a caller switching on
 * `kind` could not distinguish "I should return HTTP 400 (programmer
 * forgot to validate the URL)" from "I should return HTTP 404 generic
 * (no-oracle policy per FR-027)". The `kind: 'invalid_input'` arm is
 * NEVER user-facing; it surfaces only when a use-case wrapper passes a
 * malformed shape. The route handler in `redeem-link/route.ts` treats
 * BOTH kinds as the same generic-failure UX path, but the kind split
 * lets the route distinguish in logs/metrics.
 */
export type VerifyRenewalLinkTokenError =
  | {
      readonly kind: 'invalid_token';
      /**
       * Mirrors `renewal_token_invalid.payload.reason` per audit-port.
       * The caller MUST NOT propagate this reason to the user —
       * FR-027 mandates a generic "expired or invalid" page across
       * all failure modes (no oracle).
       */
      readonly reason:
        | 'malformed_token'
        | 'mac_mismatch'
        | 'expired'
        | 'replayed'
        | 'cross_tenant'
        | 'member_not_found_in_tenant';
    }
  | {
      readonly kind: 'invalid_input';
      /** Zod issue summary for ops triage — never user-facing. */
      readonly message: string;
    };

/**
 * Subset of `RenewalsDeps` actually used by this use-case. Lets unit
 * tests pass a minimal stub instead of the full deps bag.
 */
export interface VerifyRenewalLinkTokenDeps
  extends Pick<
    RenewalsDeps,
    'tokenVerifier' | 'cyclesRepo' | 'auditEmitter' | 'tenant'
  > {
  readonly consumedLinkTokensRepo: ConsumedLinkTokensRepo;
}

export async function verifyRenewalLinkToken(
  deps: VerifyRenewalLinkTokenDeps,
  rawInput: VerifyRenewalLinkTokenInput,
): Promise<
  Result<VerifyRenewalLinkTokenSuccess, VerifyRenewalLinkTokenError>
> {
  const parsed = verifyRenewalLinkTokenInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    // Pre-condition input failure — emit nothing (no token to forensically
    // record). Caller surface returns 400 (programmer error path).
    // PR #24 deep-review fix: distinct `kind: 'invalid_input'` arm so
    // callers can fork on programmer-error vs security-rejection.
    return err({
      kind: 'invalid_input',
      message: parsed.error.issues[0]?.message ?? 'invalid input shape',
    });
  }
  const input = parsed.data;
  const tenantId = input.expectedTenantId;

  // ---- Steps 2-5: HMAC verifier handles format / signature / version /
  // expiry / cross-tenant in a single call (research.md R1 v2 ordering).
  const verifyResult = deps.tokenVerifier.verify(input.rawToken, {
    expectedTenantId: tenantId,
    now: input.now,
  });
  if (!verifyResult.ok) {
    const reason = mapVerifyErrorToReason(verifyResult.error.kind);
    // Pre-HMAC paths (malformed_token / mac_mismatch) have no
    // tokenSha256 — verifier returns it only on success. Pass null;
    // emit helper threads it through optionally.
    await emitTokenInvalid(deps, tenantId, input, reason, null);
    return err({ kind: 'invalid_token', reason });
  }
  const { payload, tokenSha256, verifiedWith } = verifyResult.value;

  // ---- Step 7 (collapsed): cycle existence in tenant proves member
  // existence in tenant, since cycle.member_id is FK to members under
  // the same RLS-enforced tenant. The cycle lookup also gives us the
  // status needed for the "already complete" idempotent path.
  const cycleIdParsed = parseCycleId(payload.cid);
  if (!cycleIdParsed.ok) {
    await emitTokenInvalid(
      deps,
      tenantId,
      input,
      'member_not_found_in_tenant',
      tokenSha256,
    );
    return err({
      kind: 'invalid_token',
      reason: 'member_not_found_in_tenant',
    });
  }
  const cycle = await deps.cyclesRepo.findById(tenantId, cycleIdParsed.value);
  if (!cycle || cycle.memberId !== payload.mid) {
    await emitTokenInvalid(
      deps,
      tenantId,
      input,
      'member_not_found_in_tenant',
      tokenSha256,
    );
    return err({
      kind: 'invalid_token',
      reason: 'member_not_found_in_tenant',
    });
  }

  // ---- CHK033 race window: token verified but cycle already completed
  // (T-30 fired after T-90 closed the cycle). Idempotent no-op response;
  // do NOT consume the token (let repeated clicks within TTL keep
  // landing on the same "already complete" page).
  if (cycle.status === 'completed') {
    try {
      await deps.auditEmitter.emit(
        {
          type: 'renewal_token_clicked_on_completed_cycle' as const,
          payload: {
            cycle_id: cycle.cycleId,
            member_id: payload.mid,
            verified_with: verifiedWith,
          },
        },
        {
          tenantId,
          actorUserId: null,
          actorRole: 'member',
          correlationId: input.correlationId,
          requestId: input.requestId ?? null,
        },
      );
    } catch (e) {
      // Audit-emit is fire-and-forget per Wave I2 contract; never block
      // the user's idempotent success response on a logging failure.
      logger.warn(
        { err: e instanceof Error ? e.message : String(e) },
        '[verify-renewal-link-token] cycle-completed audit emit failed',
      );
    }
    return ok({
      kind: 'cycle_already_completed',
      memberId: payload.mid,
      cycleId: payload.cid,
      verifiedWith,
    });
  }

  // ---- Step 6 + 8: atomic mark consumed (replay detection via PK).
  const markResult = await deps.consumedLinkTokensRepo.markConsumed({
    tenantId,
    tokenSha256,
    consumedByMemberId: payload.mid,
    cycleId: payload.cid,
  });
  if (markResult.status === 'replay') {
    await emitTokenInvalid(deps, tenantId, input, 'replayed', tokenSha256);
    return err({ kind: 'invalid_token', reason: 'replayed' });
  }

  // ---- Success: emit `renewal_self_service_initiated` and return.
  try {
    await deps.auditEmitter.emit(
      {
        type: 'renewal_self_service_initiated' as const,
        payload: {
          cycle_id: cycle.cycleId,
          member_id: payload.mid,
          verified_with: verifiedWith,
        },
      },
      {
        tenantId,
        actorUserId: null,
        actorRole: 'member',
        correlationId: input.correlationId,
        requestId: input.requestId ?? null,
      },
    );
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e) },
      '[verify-renewal-link-token] self-service-initiated audit emit failed',
    );
  }
  return ok({
    kind: 'success',
    memberId: payload.mid,
    cycleId: payload.cid,
    verifiedWith,
  });
}

function mapVerifyErrorToReason(
  kind:
    | 'malformed_token'
    | 'signature_mismatch'
    | 'wrong_version'
    | 'tenant_mismatch'
    | 'expired',
): Extract<VerifyRenewalLinkTokenError, { kind: 'invalid_token' }>['reason'] {
  switch (kind) {
    case 'malformed_token':
    case 'wrong_version':
      return 'malformed_token';
    case 'signature_mismatch':
      return 'mac_mismatch';
    case 'expired':
      return 'expired';
    case 'tenant_mismatch':
      return 'cross_tenant';
  }
}

async function emitTokenInvalid(
  deps: VerifyRenewalLinkTokenDeps,
  tenantId: string,
  input: VerifyRenewalLinkTokenInput,
  reason: Extract<VerifyRenewalLinkTokenError, { kind: 'invalid_token' }>['reason'],
  tokenSha256: Uint8Array | null,
): Promise<void> {
  const sha256Hex =
    tokenSha256 === null
      ? null
      : Array.from(tokenSha256, (b) => b.toString(16).padStart(2, '0')).join('');
  // Constitution Principle VIII: every reject emits an audit event for
  // forensic visibility. `try/catch` because audit-emit is fire-and-
  // forget and MUST NOT mask the verify-failure response.
  //
  // Deep-review fix — token fingerprint included on post-HMAC paths
  // (replayed / cross_tenant / member_not_found_in_tenant) so SRE can
  // correlate multiple rejection events back to the same emailed token
  // (e.g. detect a replay-storm against one specific link). Pre-HMAC
  // paths pass `null` (verifier hasn't produced a sha256 yet).
  try {
    await deps.auditEmitter.emit(
      {
        type: 'renewal_token_invalid' as const,
        payload: {
          reason,
          ...(sha256Hex !== null ? { token_sha256: sha256Hex } : {}),
        },
      },
      {
        tenantId,
        actorUserId: null,
        actorRole: 'system',
        correlationId: input.correlationId,
        requestId: input.requestId ?? null,
      },
    );
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e), reason },
      '[verify-renewal-link-token] reject audit emit failed',
    );
  }
}
