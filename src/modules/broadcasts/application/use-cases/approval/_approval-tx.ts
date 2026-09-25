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
// Type-only (erased at compile time): the five use cases import this file at
// runtime, so a value import back would be a module cycle.
import type { BroadcastsRepo } from '../../ports/broadcasts-repo';
import type { ConfirmScheduleError } from './confirm-schedule';
import type { RecordMemberDecisionRefusal } from './record-member-decision';
import type { SaveFormattedVersionError } from './save-formatted-version';
import type { SendVersionToMemberError } from './send-version-to-member';
import type { StartFormattedVersionError } from './start-formatted-version';

/** The four `BroadcastsRepo` methods an approval-round use case may touch. */
export type ApprovalBroadcastsRepo = Pick<
  BroadcastsRepo,
  'withTx' | 'lockForUpdate' | 'findByIdInTx' | 'applyTransition'
>;

/**
 * The five approval-round use cases that throw an `ApprovalRefusal` (#400
 * item 5), each mapped to the refusal it raises (#400 T2). Type-only: it ties
 * a tag to its payload, so neither can be chosen without the other.
 */
export interface RefusalByUseCase {
  readonly 'start-formatted-version': StartFormattedVersionError;
  readonly 'save-formatted-version': SaveFormattedVersionError;
  readonly 'send-version-to-member': SendVersionToMemberError;
  readonly 'record-member-decision': RecordMemberDecisionRefusal;
  readonly 'confirm-schedule': ConfirmScheduleError;
}

export type ApprovalUseCase = keyof RefusalByUseCase;

/**
 * A refusal raised inside the tx so the tx rolls back; carries the use case
 * that raised it AND that use case's error — one type (#400 T2): the payload
 * is `RefusalByUseCase[U]`, so a mismatched tag and payload do not compile.
 *
 * The tag is the only part that survives to runtime, so a catch site cannot
 * tell its own refusal from one some other use case threw (a shared helper, a
 * nested call) by the payload — it would read a foreign `kind` as its own, and
 * the route's `assertNever` would turn it into a 500 (#400 item 5). Every
 * catch site therefore checks the tag with {@link isOwnRefusal}, which
 * narrows the payload to its own error (no cast), and rethrows anything else.
 */
export class ApprovalRefusal<U extends ApprovalUseCase = ApprovalUseCase> extends Error {
  constructor(
    readonly useCase: U,
    readonly refusal: RefusalByUseCase[U],
  ) {
    super('approval_refusal');
    this.name = 'ApprovalRefusal';
  }
}

/** True only for a refusal the named use case raised itself — narrowed to that use case's error. */
export function isOwnRefusal<U extends ApprovalUseCase>(e: unknown, useCase: U): e is ApprovalRefusal<U> {
  return e instanceof ApprovalRefusal && e.useCase === useCase;
}
