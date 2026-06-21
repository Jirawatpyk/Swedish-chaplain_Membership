/**
 * BroadcastsDeliveryTombstonePort adapter — bridges F3 member erasure →
 * F7 `tombstoneDeliveriesForMemberInTx` (COMP-1 US2b, GDPR Art. 17 / PDPA §33).
 *
 * Single allowed F3 → F7 crossing point for the IN-TX delivery tombstone.
 * Imports F7's public barrel (`@/modules/broadcasts`) — Constitution
 * Principle III barrel-guard permits cross-module reads of public exports.
 * Internal F7 modules (`./application`, `./infrastructure`) are NOT imported.
 *
 * Unlike the post-commit `BroadcastsCascadePort` / `BroadcastsContentScrubPort`
 * adapters (which build their own deps + open their own tx), this adapter
 * forwards the CALLER'S tx straight to the repo method so the tombstone
 * co-commits with the member's `erased_at` inside the atomic members-scrub
 * tx. The repo method (`tombstoneDeliveriesForMemberInTx`) is GUC-gated, runs
 * on the `chamber_app` role, asserts the tx is bound to `tenantSlug`, and is
 * FAIL-LOUD — a DB error propagates so the caller's atomic tx rolls back.
 * This adapter therefore does NOT swallow / translate errors (no try/catch):
 * a throw is the correct atomic-rollback signal.
 */
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts';
import type { BroadcastsDeliveryTombstonePort } from '../../application/ports/broadcasts-delivery-tombstone-port';

/**
 * No-op delivery-tombstone adapter for tests that don't exercise the F7
 * boundary (`BroadcastsDeliveryTombstonePort` is required in production deps;
 * tests inject this stub instead of leaving the dep `undefined`).
 */
export const noopBroadcastsDeliveryTombstoneAdapter: BroadcastsDeliveryTombstonePort =
  {
    async tombstoneDeliveriesInTx() {
      return { tombstonedCount: 0 };
    },
    async redactCustomRecipientEmailsInTx() {
      return { redactedCount: 0 };
    },
  };

export const f7BroadcastsDeliveryTombstoneAdapter: BroadcastsDeliveryTombstonePort =
  {
    async tombstoneDeliveriesInTx(tx, tenantSlug, recipientEmails) {
      // Construct the tenant-bound repo and forward the CALLER'S tx — the
      // tombstone runs inside the atomic members-scrub tx, co-committing with
      // `erased_at`. The repo asserts `tx` is bound to `tenantSlug`. The
      // `tenantSlug` arrives already branded (`TenantSlug`, threaded from
      // `deps.tenant.slug`), and the repo method takes a `TenantSlug`, so it
      // flows straight through with NO `asTenantSlug` re-validation.
      const repo = makeDrizzleBroadcastsRepo(tenantSlug);
      return repo.tombstoneDeliveriesForMemberInTx(
        tx,
        tenantSlug,
        recipientEmails,
      );
    },
    async redactCustomRecipientEmailsInTx(tx, tenantSlug, recipientEmails) {
      // COMP-1 FIX-9 — same forwarding shape as tombstoneDeliveriesInTx:
      // construct the tenant-bound repo and forward the CALLER'S tx so the
      // element-wise custom-recipient redaction co-commits with `erased_at`
      // inside the atomic members-scrub tx. The repo asserts `tx` is bound to
      // `tenantSlug`, sets the GUC, and is FAIL-LOUD — a throw is the correct
      // atomic-rollback signal (no try/catch).
      const repo = makeDrizzleBroadcastsRepo(tenantSlug);
      return repo.redactMemberEmailFromCustomRecipientsInTx(
        tx,
        tenantSlug,
        recipientEmails,
      );
    },
  };
