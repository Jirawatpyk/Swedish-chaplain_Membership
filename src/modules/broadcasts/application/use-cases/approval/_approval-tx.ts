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

/** The five approval-round use cases that throw an `ApprovalRefusal` (#400 item 5). */
export type ApprovalUseCase =
  | 'start-formatted-version'
  | 'save-formatted-version'
  | 'send-version-to-member'
  | 'record-member-decision'
  | 'confirm-schedule';

/**
 * A refusal raised inside the tx so the tx rolls back; carries the use case's
 * error AND the use case that raised it.
 *
 * `E` is erased at runtime, so a catch site cannot tell its own refusal from
 * one some other use case threw (a shared helper, a nested call) — the cast
 * `e.refusal as XError` would read a foreign `kind` as its own, and the
 * route's `assertNever` would turn it into a 500 (#400 item 5). Every catch
 * site therefore checks `useCase` with {@link isOwnRefusal} BEFORE the cast
 * and rethrows anything else untouched.
 */
export class ApprovalRefusal<E> extends Error {
  constructor(
    readonly useCase: ApprovalUseCase,
    readonly refusal: E,
  ) {
    super('approval_refusal');
    this.name = 'ApprovalRefusal';
  }
}

/** True only for a refusal the named use case raised itself. */
export function isOwnRefusal(e: unknown, useCase: ApprovalUseCase): e is ApprovalRefusal<unknown> {
  return e instanceof ApprovalRefusal && e.useCase === useCase;
}
