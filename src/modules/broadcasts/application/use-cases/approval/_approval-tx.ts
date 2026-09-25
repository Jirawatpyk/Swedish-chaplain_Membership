/**
 * F119 PR-2 — the transaction shape every approval-round use case shares
 * (research R19): ONE `runInTenant` (`BroadcastsRepo.withTx`), the broadcast
 * re-read `FOR UPDATE` first, and **throw-to-rollback** for every refusal.
 *
 * `return err()` inside the `withTx` callback COMMITS whatever the callback
 * already wrote (CLAUDE.md § Gotchas; the F114 `Refusal` precedent). So a
 * refusal is thrown as `ApprovalRefusal`, which rolls the tx back, and is
 * turned back into a `Result` outside the callback.
 *
 * Pure Application — no framework imports.
 */
import type { BroadcastsRepo } from '../../ports/broadcasts-repo';

/** The four `BroadcastsRepo` methods an approval-round use case may touch. */
export type ApprovalBroadcastsRepo = Pick<
  BroadcastsRepo,
  'withTx' | 'lockForUpdate' | 'findByIdInTx' | 'applyTransition'
>;

/** A refusal raised inside the tx so the tx rolls back; carries the use case's error. */
export class ApprovalRefusal<E> extends Error {
  constructor(readonly refusal: E) {
    super('approval_refusal');
    this.name = 'ApprovalRefusal';
  }
}
