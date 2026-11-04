/**
 * Spec 140 s2d (#735) — the ONE table of what Resend's answers about a draft
 * decide: one bounded `deleteBroadcastOnce`, then, on a 404 or a 403, one
 * bounded `retrieveBroadcastOnce`. Pure: each caller keeps its own calls (and
 * their order), its pause, its throw-under-lock, its timing fields, its result
 * shape and its log lines, and only maps this answer.
 *
 * The tables differ ON PURPOSE, so the caller names its policy (a closed
 * union, never boolean flags) and gets an answer type narrowed to that policy:
 *
 *   | policy           | caller                                   | 404              | 403, then GET                                  |
 *   | in_flight        | `settleAtResend` (under the row lock)    | pause, GET:      | handed / cancelled → unsendable; failed and    |
 *   |                  |                                          | not_found, or    | the rest undecided                             |
 *   |                  |                                          | handed           |                                                |
 *   | terminal_draft   | `settleTerminalDraft`                    | absent, no GET   | handed / cancelled, failed → unsendable        |
 *   | erased_refusal   | `deleteDraftBeforeRefusal`, erased       | absent, no GET   | never a GET: undecided, unless the earlier     |
 *   |                  |                                          |                  | probe read cancelled                           |
 *   | standing_refusal | `deleteDraftBeforeRefusal` (standing /   | absent, no GET   | the earlier probe read cancelled → unsendable; |
 *   |                  | terminal) + `…StandingRefusal`'s GET     |                  | else handed (+ sentAt) / cancelled, failed     |
 *   | orphan           | `settleOrphanAtResend`                   | pause, GET:      | handed / cancelled, failed → unsendable        |
 *   |                  |                                          | not_found only   |                                                |
 *
 * A retryable / other DELETE is undecided everywhere; anything not listed is
 * undecided. Exceptions are not answers: each caller keeps its own catch.
 *
 * `priorProbe` (the refusal policies only) is the reading the tick's earlier
 * probe gave for the id — `cancelled` means a 403 is an unsendable copy, so it
 * clears with no GET (only a draft can be sent, MEASURED 2026-10-29).
 *
 * `sentAt` rides only on the `standing_refusal` policy's `handed` answer (the
 * one caller that reports it); no other answer type can carry it, so it cannot
 * reach an evidence payload, `observedResendStatus` or an orphan outcome.
 *
 * Pure Application — no framework imports.
 */
import type { DeleteBroadcastOnceOutcome, RetrieveBroadcastOnceOutcome } from '../ports/broadcasts-gateway-port';
import { isHandedStatus, probedStatusOf, type ProbedStatus } from './_probe-refused-send';

export type ResendDraftPolicy = 'in_flight' | 'terminal_draft' | 'erased_refusal' | 'standing_refusal' | 'orphan';

type DeleteKind = DeleteBroadcastOnceOutcome['kind'];
type HandedStatus = 'queued' | 'sending' | 'sent';
/** The earlier probe's reading a refusal carries (`null` = it read nothing). */
type PriorProbe = 'draft' | 'cancelled' | null;

export interface DraftDeleted {
  readonly kind: 'deleted';
}
export interface DraftAbsent {
  readonly kind: 'absent';
}
/** GET next — after `REPROBE_PAUSE_MS` when `pause` (a 404 needs a second not-found). */
export interface DraftNeedsProbe<Del extends 'absent' | 'forbidden', Pause extends boolean> {
  readonly kind: 'probe';
  readonly deleted: Del;
  readonly pause: Pause;
}
/** Resend keeps a copy that can never be sent (only a draft can). */
export interface DraftUnsendable<S extends 'cancelled' | 'failed'> {
  readonly kind: 'unsendable';
  readonly status: S;
}
export interface DraftHanded {
  readonly kind: 'handed';
  readonly status: HandedStatus;
}
export interface DraftHandedWithSentAt extends DraftHanded {
  readonly sentAt: string | null;
}
/** The draft may still be there; `deleted` / `probed` are the closed readings the caller formats. */
export interface DraftUndecided<Del extends DeleteKind, P extends ProbedStatus | null> {
  readonly kind: 'undecided';
  readonly deleted: Del;
  readonly probed: P;
}

type ProbeAfterDelete<Pause404 extends boolean> = DraftNeedsProbe<'absent', Pause404> | DraftNeedsProbe<'forbidden', false>;
type UndecidedDelete = DraftUndecided<'retryable' | 'other', null>;

export type InFlightDeleteAnswer = DraftDeleted | ProbeAfterDelete<true> | UndecidedDelete;
export type InFlightProbeAnswer = DraftAbsent | DraftUnsendable<'cancelled'> | DraftHanded | DraftUndecided<'absent' | 'forbidden', ProbedStatus>;
export type TerminalDraftDeleteAnswer = DraftDeleted | DraftAbsent | DraftNeedsProbe<'forbidden', false> | UndecidedDelete;
export type TerminalDraftProbeAnswer = DraftUnsendable<'cancelled' | 'failed'> | DraftHanded | DraftUndecided<'forbidden', ProbedStatus>;
export type ErasedRefusalAnswer = DraftDeleted | DraftAbsent | DraftUnsendable<'cancelled'> | DraftUndecided<'forbidden' | 'retryable' | 'other', null>;
export type StandingRefusalDeleteAnswer =
  | DraftDeleted
  | DraftAbsent
  | DraftUnsendable<'cancelled'>
  | DraftNeedsProbe<'forbidden', false>
  | UndecidedDelete;
export type StandingRefusalProbeAnswer =
  | DraftUnsendable<'cancelled' | 'failed'>
  | DraftHandedWithSentAt
  | DraftUndecided<'forbidden', ProbedStatus>;
export type OrphanDeleteAnswer = InFlightDeleteAnswer;
export type OrphanProbeAnswer =
  | DraftAbsent
  | DraftUnsendable<'cancelled' | 'failed'>
  | DraftHanded
  | DraftUndecided<'absent' | 'forbidden', ProbedStatus>;

type Probe = RetrieveBroadcastOnceOutcome;

export function classifyResendDraftAnswer(policy: 'in_flight', deleted: DeleteKind, probe: null): InFlightDeleteAnswer;
export function classifyResendDraftAnswer(policy: 'in_flight', deleted: 'absent' | 'forbidden', probe: Probe): InFlightProbeAnswer;
export function classifyResendDraftAnswer(policy: 'terminal_draft', deleted: DeleteKind, probe: null): TerminalDraftDeleteAnswer;
export function classifyResendDraftAnswer(policy: 'terminal_draft', deleted: 'forbidden', probe: Probe): TerminalDraftProbeAnswer;
export function classifyResendDraftAnswer(
  policy: 'erased_refusal',
  deleted: DeleteKind,
  probe: null,
  priorProbe: PriorProbe,
): ErasedRefusalAnswer;
export function classifyResendDraftAnswer(
  policy: 'standing_refusal',
  deleted: DeleteKind,
  probe: null,
  priorProbe: PriorProbe,
): StandingRefusalDeleteAnswer;
export function classifyResendDraftAnswer(policy: 'standing_refusal', deleted: 'forbidden', probe: Probe): StandingRefusalProbeAnswer;
export function classifyResendDraftAnswer(policy: 'orphan', deleted: DeleteKind, probe: null): OrphanDeleteAnswer;
export function classifyResendDraftAnswer(policy: 'orphan', deleted: 'absent' | 'forbidden', probe: Probe): OrphanProbeAnswer;
export function classifyResendDraftAnswer(
  policy: ResendDraftPolicy,
  deleted: DeleteKind,
  probe: Probe | null,
  priorProbe: PriorProbe = null,
):
  | InFlightDeleteAnswer
  | InFlightProbeAnswer
  | TerminalDraftDeleteAnswer
  | TerminalDraftProbeAnswer
  | ErasedRefusalAnswer
  | StandingRefusalDeleteAnswer
  | StandingRefusalProbeAnswer
  | OrphanProbeAnswer {
  const refusal = policy === 'erased_refusal' || policy === 'standing_refusal';
  if (probe === null) {
    if (deleted === 'deleted') return { kind: 'deleted' };
    if (deleted === 'retryable' || deleted === 'other') return { kind: 'undecided', deleted, probed: null };
    if (deleted === 'absent') {
      // Two not-founds, with time between them, before an in-flight or orphan
      // 404 counts as gone; a terminal row or a refusal clears it at once.
      return policy === 'in_flight' || policy === 'orphan' ? { kind: 'probe', deleted: 'absent', pause: true } : { kind: 'absent' };
    }
    // A 403. A cancelled broadcast answers it too, and can never be sent.
    if (refusal && priorProbe === 'cancelled') return { kind: 'unsendable', status: 'cancelled' };
    // The erased refusal never probes: a 403 it cannot explain stays undecided.
    if (policy === 'erased_refusal') return { kind: 'undecided', deleted: 'forbidden', probed: null };
    return { kind: 'probe', deleted: 'forbidden', pause: false };
  }
  const probed = probedStatusOf(probe);
  if (deleted === 'absent') {
    if (probed === 'not_found') return { kind: 'absent' };
    // A 404 then a handed GET: in flight, the send Resend accepted (evidence);
    // for an orphan, an inconsistent pair — left for the next run.
    if (policy === 'in_flight' && probe.kind === 'present' && isHandedStatus(probe.status)) return { kind: 'handed', status: probe.status };
    return { kind: 'undecided', deleted: 'absent', probed };
  }
  // A 403, then the GET. POSITIVE tests only.
  if (probe.kind === 'present' && isHandedStatus(probe.status)) {
    return policy === 'standing_refusal'
      ? { kind: 'handed', status: probe.status, sentAt: probe.sentAt ?? null }
      : { kind: 'handed', status: probe.status };
  }
  if (probed === 'cancelled') return { kind: 'unsendable', status: 'cancelled' };
  // `failed` is unsendable too (MEASURED 2026-10-29), except in flight, where
  // the cascade still treats it as unexpected (`RetrieveBroadcastOnceOutcome`).
  if (probed === 'failed' && policy !== 'in_flight') return { kind: 'unsendable', status: 'failed' };
  return { kind: 'undecided', deleted: 'forbidden', probed };
}
