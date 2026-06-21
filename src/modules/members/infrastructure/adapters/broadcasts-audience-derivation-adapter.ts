/**
 * BroadcastsAudienceDerivationPort adapter — bridges F3 member erasure →
 * F7 `listMemberResendAudienceContactsInTx` (COMP-1 US3-C, GDPR Art. 17 / PDPA
 * §33 sub-processor propagation).
 *
 * Single allowed F3 → F7 crossing point for the IN-TX Resend-audience read.
 * Imports F7's public barrel (`@/modules/broadcasts`) — Constitution Principle
 * III barrel-guard permits cross-module reads of public exports. Internal F7
 * modules (`./application`, `./infrastructure`) are NOT imported.
 *
 * Like the US2b delivery-tombstone adapter (and unlike the post-commit
 * `BroadcastsCascadePort` / `BroadcastsContentScrubPort` adapters, which build
 * their own deps + open their own tx), this adapter forwards the CALLER'S tx
 * straight to the repo method so the read runs inside the atomic members-scrub
 * tx — capturing the `(audience, email)` pairs WHILE the member's emails are
 * still live, BEFORE the same tx's delivery tombstone redacts them. The repo
 * method runs a plain SELECT on the `chamber_app` role, asserts the tx is bound
 * to `tenantSlug`, and is FAIL-LOUD — a DB error propagates so the caller's
 * atomic tx rolls back. This adapter therefore does NOT swallow / translate
 * errors (no try/catch): a throw is the correct atomic-rollback signal.
 */
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts';
import type { BroadcastsAudienceDerivationPort } from '../../application/ports/broadcasts-audience-derivation-port';

/**
 * No-op audience-derivation adapter for tests that don't exercise the F7
 * boundary (`BroadcastsAudienceDerivationPort` is required in production deps;
 * tests inject this stub instead of leaving the dep `undefined`).
 */
export const noopBroadcastsAudienceDerivationAdapter: BroadcastsAudienceDerivationPort =
  {
    async listMemberAudienceContactsInTx() {
      return [];
    },
  };

export const f7BroadcastsAudienceDerivationAdapter: BroadcastsAudienceDerivationPort =
  {
    async listMemberAudienceContactsInTx(tx, tenantSlug, emails) {
      // Construct the tenant-bound repo and forward the CALLER'S tx — the read
      // runs inside the atomic members-scrub tx, capturing the live emails
      // before the same tx's delivery tombstone redacts them. The repo asserts
      // `tx` is bound to `tenantSlug`. The `tenantSlug` arrives already branded
      // (`TenantSlug`, threaded from `deps.tenant.slug`), and the repo method
      // takes a `TenantSlug`, so it flows straight through with NO `asTenantSlug`
      // re-validation.
      const repo = makeDrizzleBroadcastsRepo(tenantSlug);
      return repo.listMemberResendAudienceContactsInTx(tx, tenantSlug, emails);
    },
  };
