/**
 * SubprocessorErasurePort adapter — propagates a member erasure to external
 * sub-processors (COMP-1 US3-C, GDPR Art. 17 / PDPA §33 sub-processor erasure).
 *
 * Called by the `eraseMember` POST-COMMIT cascade (T5) with the `(audience,
 * email)` pairs captured in the atomic scrub tx BEFORE redaction (Task 3
 * `BroadcastsAudienceDerivationPort`). Two arms:
 *
 *   - Stripe : a PURE no-op TODAY (Principle IV / architect S1). No member↔
 *              Stripe-customer model exists; payments are ad-hoc Payment
 *              Intents. ZERO payments symbols are imported.
 *   - Resend : best-effort remove each captured pair from its audience. The
 *              gateway resolves on a 404 (already absent → erasure goal met)
 *              and throws a retryable `GatewayThrowable` on 5xx; the per-pair
 *              try/catch keeps the loop alive so one failure never aborts the
 *              cascade.
 *
 * Imports F7's public barrel (`@/modules/broadcasts`) for `resendBroadcasts
 * Gateway` only — Constitution Principle III barrel-guard permits cross-module
 * reads of public exports; internal F7 modules are NOT imported.
 *
 * Best-effort — NEVER throws (the loop catches every gateway throw). The
 * caller (T5) inspects the returned `resendOutcome` to emit the
 * `erasureMetrics.subprocessorErasure` metric + record the cascade-completion
 * proof; a `partial`/`failed` outcome is re-driven by the US2d reconciler /
 * US3-E DPO runbook.
 */
import { resendBroadcastsGateway } from '@/modules/broadcasts';
import { logger } from '@/lib/logger';
import type {
  SubprocessorErasurePort,
  SubprocessorErasureResult,
} from '../../application/ports/subprocessor-erasure-port';

/**
 * No-op sub-processor-erasure adapter for tests that don't exercise the F7
 * boundary (`SubprocessorErasurePort` is required in production deps; tests
 * inject this stub instead of leaving the dep `undefined`).
 */
export const noopSubprocessorErasureAdapter: SubprocessorErasurePort = {
  async propagate(): Promise<SubprocessorErasureResult> {
    return {
      resendOutcome: 'ok',
      resendContactsRemoved: 0,
      resendContactsFailed: 0,
      stripeOutcome: 'ok',
    };
  },
};

export const subprocessorErasureAdapter: SubprocessorErasurePort = {
  async propagate(input): Promise<SubprocessorErasureResult> {
    // ── Stripe arm: PURE no-op (Principle IV / architect S1). No member↔Stripe-
    // customer model exists; payments are ad-hoc Payment Intents. ZERO payments
    // symbols imported. Future-proofing: when a member↔customer model is added,
    // add a `customerErasure` use-case INSIDE the payments module + export it
    // from the payments barrel; call THAT here — never import payments infra.
    const stripeOutcome = 'ok' as const;

    // ── Resend arm: DETACH each captured (audience, email) pair.
    //
    // ⚠️ THIS DOES NOT DELETE THE CONTACT AT THE PROCESSOR, and the provider's
    // own response says it does. Measured 2026-09-09 (108 Phase 9 review U1):
    // `DELETE /audiences/{id}/contacts/{email}` answers `{"deleted": true}`;
    // afterwards the audience-scoped read 404s while an audience-less
    // `GET /contacts/{email}` still returns the contact at 200. An
    // audience-less `DELETE /contacts/{email}` was measured in the same run to
    // delete for real — so the capability exists (`deleteContactGlobally`) and
    // is deliberately NOT called here.
    //
    // Why not: the Resend account is ONE account shared by every tenant (a
    // single API key), so two tenants whose members share an address share ONE
    // contact record. A global delete during tenant A's erasure would destroy
    // tenant B's record — including the Resend-side `unsubscribed` flag that
    // `on_conflict=upsert` exists to preserve, so B's objecting member would
    // come back SUBSCRIBED on the next import. That trades an Art. 17 residual
    // for an Art. 21 regression on someone who never asked for anything.
    //
    // The erasure path already excludes peer-live-claimed emails
    // (`tombstoneEmails`), but that filter is WITHIN one tenant, and the
    // derivation query is tenant-scoped — neither can see a live holder in
    // another tenant. Making the global delete safe needs a deliberate
    // cross-tenant "is this address held by any live member anywhere" check,
    // which is an architectural decision, not something to slip into a review
    // fix. `tests/integration/members/erase-member-subprocessor-cascade.test.ts`
    // case 2 pins the boundary and is what caught this when I first wired the
    // global delete here.
    //
    // Consequence, recorded rather than hidden: the Global Contact SURVIVES
    // erasure. `docs/compliance/processing-records.md` carries it as a residual.
    let removed = 0;
    let failed = 0;
    for (const { audienceId, email } of input.audienceContacts) {
      try {
        await resendBroadcastsGateway.removeContactFromAudience(audienceId, email);
        removed += 1; // includes a 404 (already absent) — the gateway resolves.
      } catch (e) {
        failed += 1;
        logger.warn(
          {
            memberId: input.memberId,
            requestId: input.requestId,
            audienceId, // NEVER the email — forbidden-fields hygiene.
            errKind: e instanceof Error ? e.constructor.name : 'unknown',
            cascade: 'subprocessor_resend',
          },
          'erase-member: subprocessor Resend contact detach failed',
        );
      }
    }

    const resendOutcome =
      failed === 0 ? 'ok' : removed === 0 ? 'failed' : 'partial';
    return {
      resendOutcome,
      resendContactsRemoved: removed,
      resendContactsFailed: failed,
      stripeOutcome,
    };
  },
};
