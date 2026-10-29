/**
 * T087 (108 US5) — build the Resend audience with ONE Contacts-Import call,
 * confirm it on a later tick, then send.
 *
 * ## Why this exists
 *
 * `addContactsToAudience` is a serial `await` loop at a measured ~2.08 req/s
 * (`POST /contacts`, mean 481 ms — research § R9), so roughly 623 contacts is
 * all one 300 s function can drain. Everything this codebase grew to work
 * around that — the split threshold, per-batch manifests, one-wave dispatch,
 * cross-tick drift guards — exists only because the push is per-contact. The
 * import is a single multipart request, ~412 ms whether it carries one address
 * or fifty thousand, so size stops being an engineering constraint and becomes
 * a Resend plan limit.
 *
 * ## Why it is a SEPARATE use case
 *
 * `dispatchScheduledBroadcast` is ~1,200 lines carrying orphan-audience reuse,
 * idempotency-conflict replay, the FR-021 retry budget and the batch hand-off.
 * Threading an `if (importEnabled)` through it would give every one of those
 * paths two shapes and make its 44-case suite the regression surface for both.
 * The cron picks one or the other by flag; neither knows the other exists.
 *
 * ## The two ticks
 *
 *   1. No `audience_import_id` → resolve, create (or REUSE) the audience,
 *      submit ONE import, store its id. **Nothing is sent.** Resend has only
 *      accepted the job.
 *   2. Id present → poll. Send only if EVERY clause of the completion rule
 *      passes. The row stays `approved` throughout, which is what keeps it
 *      cancellable (`cancelBroadcast` accepts only submitted/approved) — see
 *      migration 0298 for why there is no `audience_building` status.
 *
 * ## The completion rule, and why it is not defensive
 *
 * `status === 'completed'` is NOT a send signal. One import in five identical
 * probes returned `completed` with `failed: 0` and `total: 0` and attached
 * nothing (research § R9 V2 (c)). All four clauses are required, each with its
 * own reason so the audit row says which one refused:
 *
 *   - `failed === 0`                            → `failed_rows`
 *   - `created + updated + skipped === total`   → `counts_incoherent`
 *   - `total === the count WE resolved`         → `count_mismatch`
 *
 * The last clause re-resolves on the confirming tick, so an audience that
 * changed between the two ticks refuses the send instead of delivering to a
 * different set of people. That is FR-044 (a) — "the list is fixed at the first
 * attempt" — enforced by comparison rather than by a working table.
 */
import { err, ok, type Result } from '@/lib/result';
import { loadBrandChrome } from './_load-brand-chrome';
import type { BrandChromePort } from '../ports/brand-chrome-port';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { broadcastsMetrics } from '@/lib/metrics';
import { classifyThrown, isRetryableThrow } from './_classify-thrown';
import { dispatchRetryEpoch, resetDispatchRetryClock, RETRY_BUDGET_MS } from './_dispatch-retry-epoch';
import { enqueueDispatchFailureNotification } from './_enqueue-dispatch-failure-notification';
import { emitExpiredPlanAuditIfApplicable } from './_expired-plan-audit';
import type { TenantContext } from '@/modules/tenants';
import type { Broadcast, BroadcastId } from '../../domain/broadcast';
import { AuditPortInvariantError } from '../ports/audit-port';
import type { AuditEmitInput, AuditPort } from '../ports/audit-port';
import { standingRefusalAuditEvent } from './_member-send-standing';
import {
  decideDispatchStanding,
  recordDispatchHold,
  type DispatchStandingDeps,
} from './_dispatch-standing-gate';
import type { BroadcastsGatewayPort } from '../ports/broadcasts-gateway-port';
import { reclaimMintedBroadcast } from './_reclaim-minted-broadcast';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import {
  BroadcastConcurrentMutationError,
  BroadcastNotFoundError,
} from '../ports/broadcasts-repo';
import type { ClockPort } from '../ports/clock-port';
import type { MembersBridgePort } from '../ports/members-bridge-port';
import type { PlansBridgePort } from '../ports/plans-bridge-port';
import type { EmailTransactionalPort } from '../ports/email-transactional-port';
import type { ResolvedOrphan, ResolveSegmentError } from './resolve-segment-recipients';

/**
 * FR-044 (f). Measured from the SUBMIT, not from `scheduled_for`: a broadcast
 * can sit approved for hours before a tick picks it up, and the question here
 * is only "has the provider taken too long with the job we gave it".
 */
export const IMPORT_STUCK_AFTER_MS = 30 * 60 * 1_000;

export type BuildAudienceTickOutput =
  | { readonly kind: 'import_submitted'; readonly importId: string; readonly recipientCount: number }
  | { readonly kind: 'import_pending'; readonly importId: string }
  | { readonly kind: 'sent'; readonly resendBroadcastId: string; readonly recipientCount: number }
  /**
   * F119 PR-A R1 — the requesting member's membership is `suspended` (awaiting
   * payment): nothing was polled, submitted or sent, and the row stays
   * `approved` for the next tick (a tick-2 hold abandons its pending import —
   * `abandonPendingImportOnHold`). The same kind the legacy leg answers.
   */
  | { readonly kind: 'dispatch_held_member_suspended' };

/**
 * Why a build stopped for good. Each value is a DIFFERENT sentence in the audit
 * row, which is the point — `failed_to_dispatch` on its own tells an operator
 * nothing about whether to retry by hand, fix data, or raise a Resend plan.
 *
 * The first three are facts about a finished import job. The last four were
 * added in 108 Phase 9 review round 1, when six reviewers found that a gateway
 * throw, a provider `failed`, and an unparseable segment all escaped this use
 * case entirely — reaching the cron as `uncaught_error` and leaving the row
 * `approved` to be re-attempted every five minutes for ever.
 *
 * They deliberately reuse the `audience_import_failed` KIND rather than minting
 * new ones, so the cron's existing switch keeps routing them to
 * `permanent_failed` — and so the comment there claiming "the use case has
 * already moved the row and audited it" finally becomes true for every arm.
 */
export const IMPORT_FAILURE_REASONS = [
  'failed_rows',
  'counts_incoherent',
  'count_mismatch',
  /** The provider itself reported the job failed — do not wait out the 30 min. */
  'provider_failed',
  /** A 4xx from Resend. The measured instance is the Free plan's contact cap. */
  'gateway_permanent',
  /** A throw carrying no `kind`: not a gateway error, a programming fault. */
  'gateway_unknown',
  /** The row's own `segment_params` cannot be parsed. Retrying cannot fix data. */
  'malformed_segment',
  /** The audience grew past the accepted ceiling between submit and this tick. */
  'audience_too_large',
  /**
   * FR-021 / AS2 — an hour of retryable failures reaching the PROVIDER. Round 3
   * finding 3-7: this path had no wall-clock budget at all, so a persistently
   * retryable failure kept the row `approved` and was re-attempted every five
   * minutes indefinitely, never terminal and the member never told.
   */
  'retry_budget_exhausted',
  // Round 4 F3 — `retry_budget_exhausted_internal` was here. It was added on
  // 2026-09-09 to stop ONE reason covering both a provider outage and a Neon
  // fault, which is a real distinction; it is deleted because the branch that
  // produced it is deleted. The resolve-side budget it labelled killed
  // broadcasts on their first DB error whenever the row was already an hour
  // past its epoch, and forked the two legs on a flag. Nothing reaches this
  // value any more, so keeping it would leave a member-facing sentence in three
  // locales for a state the code cannot enter. See `onResolveFailure`.
  /** Everyone in the audience is suppressed or opted out — nothing to send to. */
  'audience_post_suppression_empty',
  /**
   * The Resend audience holds a DIFFERENT number of contacts than we resolved.
   *
   * Distinct from `count_mismatch`, which compares the import JOB's row count.
   * Round 3 finding 3-5: those are not the same question, and only this one can
   * see a contact left behind by an earlier attempt — imports are
   * `on_conflict=upsert` into a REUSED audience and nothing ever removes a
   * contact, so an address that unsubscribed between two attempts is still in
   * the audience and would still receive the broadcast.
   */
  'audience_membership_drift',
  /**
   * F119 PR-A — the member's broadcasts were halted pending admin review when
   * the send came due. Read at SEND time on both legs (the legacy leg records
   * the same token); PERMANENT by the maintainer's rule, even though a halt can
   * be cleared — the member submits a new E-Blast.
   */
  'member_halted',
  /**
   * F119 PR-A — the membership had ENDED (F8 `terminated`: cancelled /
   * coverage ended, lapsed, refunded) at send time. A `suspended` membership is
   * HELD, never refused, so this token no longer means "suspended".
   */
  'member_not_in_good_standing',
] as const;

export type ImportFailureReason = (typeof IMPORT_FAILURE_REASONS)[number];

/**
 * Every token that can reach the member's FR-021 email, which is
 * `ImportFailureReason` plus the stuck rule — `failTerminally` derives its
 * `reason` from the error KIND for that one, so it is not in the union above.
 *
 * A const tuple rather than a type alone, because round 3 finding 3-12's third
 * leg was that SEVEN of these rendered the same generic sentence in every
 * locale, and neither `check:i18n` nor a runtime `MISSING_MESSAGE` could see it:
 * `broadcast-notification-emails.ts:265` falls back with `?? generic` on a plain
 * object, so an absent key is indistinguishable from a deliberate one.
 *
 * `broadcast-failed-to-dispatch-email.test.ts` iterates THIS, so adding a reason
 * without adding its sentence in all three locales fails a test instead of
 * quietly telling a member "a technical problem prevented delivery".
 */
export const MEMBER_FACING_FAILURE_REASONS = [
  ...IMPORT_FAILURE_REASONS,
  'audience_import_stuck',
] as const;

/**
 * Round 4 L1 — the tokens a member-facing email may be asked to render.
 *
 * Exported as a TYPE because the legacy leg proved a `string` parameter is not
 * enough: `dispatchScheduledBroadcast` passed
 * `retry_budget_exhausted_after_1h:${subKind}:${reason}` — a composite built for
 * the `failure_reason` column — straight into the email builder, where it is a
 * LOOKUP KEY. It matched nothing, fell to `generic`, and the member read
 * "a technical problem prevented delivery" for an hour-long provider outage.
 * `tsc` could not see it, because both the composite and the token are strings.
 *
 * Two more call sites on that leg had the same shape. Typing the parameter makes
 * the compiler enumerate all of them, which is the only form of this fix that
 * cannot miss one — see `[[reference_shared_helper_stamps_one_callers_identity]]`.
 */
export type MemberFacingFailureReason =
  (typeof MEMBER_FACING_FAILURE_REASONS)[number];

export type BuildAudienceTickError =
  | { readonly kind: 'broadcast_not_found'; readonly broadcastId: string }
  | { readonly kind: 'broadcast_invalid_state_transition'; readonly observedStatus: string }
  /** Same two the single-tick path uses — these mean the same thing whichever
   *  way the audience is pushed, and forking them would fork the cron's switch
   *  and its alerting for no gain. */
  | { readonly kind: 'broadcast_audience_too_large'; readonly count: number; readonly cap: number }
  | { readonly kind: 'broadcast_audience_post_suppression_empty' }
  | {
      readonly kind: 'audience_import_failed';
      readonly reason: ImportFailureReason;
      /** `null` when the build died before an import job existed. */
      readonly importId: string | null;
      /** `null` for reasons that are not a count comparison. */
      readonly observed: number | null;
      readonly expected: number | null;
    }
  | { readonly kind: 'audience_import_stuck'; readonly importId: string; readonly ageMs: number }
  /**
   * Round 4 F5 — a 404 from Resend used to come back as `audience_import_failed`,
   * which the cron buckets `permanent_failed`, so `summary.resource_missing` was
   * STRUCTURALLY 0 on this leg while the legacy leg has a dedicated arm. A trace
   * read `permanent_failed=1, resource_missing=0` — "finished, nothing to do" —
   * for the one failure whose own docblock says it needs an admin to look at the
   * account. The audit event and the suppressed member email were already right;
   * only the kind the cron sees was not.
   */
  | {
      readonly kind: 'broadcast_resend_resource_missing';
      readonly resourceType: 'audience' | 'broadcast' | 'import';
      readonly resourceId: string;
    }
  | {
      readonly kind: 'dispatch.server_error';
      readonly message: string;
      /** Round 4 L3 — the loggable class; see `resolve.server_error`'s docblock. */
      readonly errClass?: string;
      /**
       * 2026-09-10 follow-up (5) — which step faulted; labels the route's
       * `dispatch_resolve_failed.total`. `gateway` is the one the live leg does
       * not have: a retryable Resend throw WITHIN the FR-021 budget is reported
       * here as `dispatch.server_error`, so without the label every 5xx read as
       * "could not build the audience". `standing` (F119 PR-A, shared with the
       * live leg) — the member-standing read failed and the gate was not
       * decided, so nothing was sent.
       */
      readonly phase:
        | 'gateway'
        | 'resolve'
        | 'terminal_write'
        | 'standing'
        /**
         * S8 — the inherited-id probe answered a status this build cannot
         * read: refused, the row stays `approved`, no FR-021 clock. The legacy
         * leg's phase of the same name.
         */
        | 'inherited_status'
        /** S8 — the pre-send `resend_broadcast_id` write faulted; nothing was sent. */
        | 'persist_broadcast_id';
    };

/**
 * What the resolver answers.
 *
 * This interface used to read `{recipients, estimatedCount}` with a docblock
 * saying "narrowed to what this use case reads". That narrowing was the review's
 * sharpest finding, and the subtlest: the resolver returns `orphans` and
 * `droppedByPreference` on every path, the legacy dispatch logs both per
 * broadcast, and `droppedByPreference` exists BECAUSE an earlier review round
 * added it to answer a member asking why their E-Blast reached 40 people instead
 * of 55. Narrowing the type deleted that answer without deleting a single line
 * of the code that computes it — so no diff of the two paths and no grep for the
 * log name could find it.
 *
 * Keep the shape as wide as the resolver's. "Take only what you need" is the
 * right instinct for a REQUIREMENT and the wrong one for a RETURN value.
 */
export interface ResolvedAudience {
  readonly recipients: readonly string[];
  readonly estimatedCount: number;
  /**
   * Members in the segment with no usable primary contact email. Typed from the
   * resolver rather than flattened to a count here: this use case only needs
   * `.length`, but declaring the narrower shape is exactly the move that lost
   * these fields in the first place.
   */
  readonly orphans: ReadonlyArray<ResolvedOrphan>;
  /** Addresses removed by a per-contact marketing opt-out or suppression. */
  readonly droppedByPreference: number;
}

/**
 * What `deps.resolveRecipients` can answer with.
 *
 * **Round 3 finding 3-2 — this used to end in `| { readonly kind: string }`,
 * and that open member is what let the bug below typecheck.** With it present,
 * comparing `e.kind` against ANY string literal compiles, so
 * `mapResolveError` matched `broadcast_audience_post_suppression_empty` — a
 * kind the resolver never returns, produced only by
 * `dispatchScheduledBroadcast` as its OUTPUT — and the resolver's real
 * `broadcast_empty_segment_blocked` fell through to `dispatch.server_error`.
 * The cron then classified an emptied audience as transient and re-claimed the
 * row every five minutes for ever, with no terminal state, no audit row and no
 * member email: verbatim the defect `onResolveFailure`'s docblock says it
 * removed. It was removed for `too_large` only.
 *
 * It is now the resolver's OWN union plus the one kind the composition root
 * adds, so `tsc` enumerates the arms again and an impossible comparison is a
 * compile error. Same class as `return _exhaustive` — an escape hatch that
 * stops the compiler being the thing that finds this.
 */
export type ResolveAudienceError =
  | ResolveSegmentError
  /** Added by the composition root when the row's own `segment_params` will not parse. */
  | { readonly kind: 'malformed_segment' };

export interface BuildAudienceTickDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: BroadcastsRepo;
  readonly broadcastsGateway: BroadcastsGatewayPort;
  /**
   * F119 T031 (FR-041c) — the tenant's brand chrome, read LIVE at dispatch
   * and handed to the gateway so the delivered email equals the preview.
   * REQUIRED: a composition that forgot it would ship every E-Blast without
   * the postal address FR-041c requires, silently. The cron composes
   * `brandChromePort` (the seam lives in `src/lib`, so the module's deps
   * factory returns this type without it). A read FAULT degrades to no
   * chrome (fail-soft, metered) — a brand outage must never fail a send.
   */
  readonly brandChrome: BrandChromePort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  readonly fromEmail: string;
  readonly tenantDisplayName: string;
  readonly locale: 'en' | 'th' | 'sv';
  /**
   * Injected rather than composed here. The resolver's own dependency graph
   * (members bridge, unsubscribes, attendees, plans) is large and already wired
   * at the composition root; this use case needs only the ANSWER, and keeping
   * it that way is what makes the completion rule readable in one screen.
   */
  readonly resolveRecipients: (
    broadcast: Broadcast,
  ) => Promise<Result<ResolvedAudience, ResolveAudienceError>>;
  /**
   * FR-021 / AS2 — needed to tell the originating member their broadcast died.
   * Absent until 108 Phase 9 review round 1, which is why every terminal failure
   * on this path was silent: the row went to `failed_to_dispatch` and nobody was
   * told, while `broadcast-audience-build.md` § C.4 said "the member gets the
   * FR-021 notification".
   */
  readonly membersBridge: MembersBridgePort;
  readonly emailTransactional: EmailTransactionalPort;
  /**
   * AS5 / T171 — the forensic row written when the sender's plan changed between
   * approve and send. Also absent, which made the check unrepresentable rather
   * than merely omitted: an entitlement question about a quota'd paid benefit
   * with no evidence on the record.
   */
  readonly plansBridge: PlansBridgePort;
  /**
   * F119 PR-A — the member-standing reads (the F7 halt list + F8 membership
   * access) re-applied at SEND time, exactly as the legacy leg applies them.
   * REQUIRED for the same reason: a composition that forgot it would send for
   * a halted or ended membership, silently.
   */
  readonly sendStanding: DispatchStandingDeps;
}

export interface BuildAudienceTickInput {
  readonly broadcastId: BroadcastId;
}

export async function buildAudienceTick(
  deps: BuildAudienceTickDeps,
  input: BuildAudienceTickInput,
): Promise<Result<BuildAudienceTickOutput, BuildAudienceTickError>> {
  const now = deps.clock.now();
  const tenantSlug = deps.tenant.slug;

  // Step 1 — lock and verify eligibility. Same shape as the single-tick path:
  // the row must still be `approved` when we act on it, or a concurrent cancel
  // has already won.
  const loaded = await deps.broadcastsRepo.withTx(async (tx) => {
    const status = await deps.broadcastsRepo.lockForUpdate(tx, tenantSlug, input.broadcastId);
    if (status === null) return { kind: 'not_found' as const };
    if (status !== 'approved') return { kind: 'wrong_status' as const, status };
    const row = await deps.broadcastsRepo.findByIdInTx(tx, tenantSlug, input.broadcastId);
    if (row === null) return { kind: 'not_found' as const };
    return { kind: 'ok' as const, broadcast: row };
  });

  if (loaded.kind === 'not_found') {
    return err({ kind: 'broadcast_not_found', broadcastId: input.broadcastId as unknown as string });
  }
  if (loaded.kind === 'wrong_status') {
    return err({ kind: 'broadcast_invalid_state_transition', observedStatus: loaded.status });
  }
  const broadcast = loaded.broadcast;

  // Step 1a (S8) — the inherited-id probe, BEFORE the standing gate and before
  // anything else touches Resend: the legacy leg's Step 1b, the same answers.
  //
  // `resend_broadcast_id` is persisted BEFORE the send on this leg now
  // (`persistBroadcastIdBeforeSend`), so an id on the row no longer means "an
  // earlier tick sent": that tick may have died between the persist and
  // `sendBroadcast`, or the send may have failed. Reading presence as "sent"
  // would skip the standing gate for mail nobody sent; reading absence as
  // "unsent" was the double-send — the next tick minted a SECOND resource and
  // sent to everyone again. So ask Resend.
  //
  //   queued / sending / sent → handed: the mail is out. Skip the standing gate
  //     (refusing would record `failed_to_dispatch` for a delivered broadcast,
  //     free its quota slot and email the member that it did not go out), the
  //     hold's abandon, and the whole import poll / count / drift check (a
  //     `count_mismatch` now would be the same false failure) — and catch the
  //     row up with the post-send writes (`advanceToSending`).
  //   draft / cancelled → never handed: proceed as normal; `confirmImport`
  //     reuses the id (no second `createBroadcast`) and sends it with the same
  //     idempotency key. Logged, because the fall-through is a decision.
  //   not_found → proceed; the send's 404 reaches the `resource_missing` arm.
  //   unknown → REFUSE (fail closed): the row stays `approved`, no FR-021
  //     clock (a clock would turn "unknown whether sent" into "failed, member
  //     told"). Recovery: teach the adapter the status, or delete the resource
  //     at Resend so the probe answers `not_found`.
  //
  // Any inherited id is probed, including a LEGACY-leg row carried across a
  // flag flip (its id from that leg's own pre-send attach, no import id): R5
  // gated such a row because this leg had no probe and its send was
  // unknowable here; with the probe it is knowable, so a carry-over the legacy
  // leg already sent is caught up instead of refused or re-sent. An EMPTY id
  // is not an id (R8.5): not probed, the row is gated.
  const inheritedBroadcastId = broadcast.resendBroadcastId ?? '';
  let probe: InheritedProbe | null = null;
  if (inheritedBroadcastId !== '') {
    const probed = await probeInheritedBroadcast(deps, input, broadcast, inheritedBroadcastId);
    if ('stop' in probed) return probed.stop;
    probe = probed.probe;
  }
  if (probe !== null && probe.handed) {
    // The recipient count: the legacy leg re-resolves even on this path and
    // writes the FRESH count; this leg skips the resolve (a refusal from it
    // could change nothing — the mail is out), so the honest number in hand is
    // the row's frozen estimate, which is what the legacy leg writes when its
    // own re-resolve is refused. Neither is "the count that was sent"; the
    // webhook-fed delivery aggregate is. The attribution fields are `null`:
    // nothing resolved them on this tick.
    return advanceToSending(deps, input, broadcast, now, {
      resendBroadcastId: inheritedBroadcastId,
      audienceId: broadcast.resendAudienceId ?? '',
      importId: broadcast.audienceImportId,
      recipientCount: broadcast.estimatedRecipientCount,
      orphanCount: null,
      droppedByPreference: null,
      handedOnPriorTick: { status: probe.status, sentAt: probe.sentAt },
      observedResendStatus: probe.status,
    });
  }

  // Step 1b (F119 PR-A) — the member's standing, re-read at SEND time, BEFORE
  // the submit/confirm branch so it covers both ticks: a member halted, or
  // whose membership ended, between tick 1 (import submitted) and tick 2 (send)
  // is refused on tick 2; a `suspended` membership (awaiting payment) is HELD
  // on either tick (R1). Outside every transaction — the lock tx above has
  // committed.
  //
  // A refusal goes through `failTerminally` and nothing else: the terminal
  // transition is what makes a tick-1 Resend audience a `cleanup-audiences`
  // candidate (terminal status + `resend_audience_id` + no
  // `audience_deleted_at`), and the Free plan holds three. A HOLD on tick 2
  // instead ABANDONS the pending import (`abandonPendingImportOnHold`): it
  // deletes that audience itself (and a pre-send broadcast the probe said was
  // never handed to `/send`) and detaches the columns, so the row resumes with
  // a fresh tick 1 against the audience as it is then — never a stale import,
  // never a false stuck alarm while held. A hold returns BEFORE
  // `confirmImport`, so neither the 30-minute stuck rule nor the FR-021 budget
  // runs while held.
  //
  // Reached only when nothing was handed to `/send`: the probe above returned
  // for a handed row.
  const refused = await applySendStanding(deps, input, broadcast);
  if (refused !== null) return refused;

  return broadcast.audienceImportId === null
    ? submitImport(deps, input, broadcast)
    : confirmImport(deps, input, broadcast, broadcast.audienceImportId, now, {
        resendBroadcastId: inheritedBroadcastId,
        observedResendStatus: probe === null ? null : probe.status,
      });
}

/**
 * What the inherited-id probe learned. `handed` is a POSITIVE test over the
 * three statuses that mean Resend accepted the send — the legacy leg's lesson:
 * a negative `!== 'draft'` read `cancelled` and every unrecognised status as
 * "already sent". `status: null` on the not-handed arm is `not_found`.
 */
type InheritedProbe =
  | { readonly handed: true; readonly status: 'queued' | 'sending' | 'sent'; readonly sentAt: string | null }
  | { readonly handed: false; readonly status: 'draft' | 'cancelled' | null };

/**
 * S8 — ask Resend what became of the broadcast resource an earlier tick
 * persisted. `{ stop }` is the tick's answer; `{ probe }` carries on.
 *
 * - A RETRYABLE throw is retried next tick and never budgeted, nor stamped —
 *   the legacy leg's F119 PR-E M1 reasoning: an unanswered probe cannot say
 *   whether the mail already went out. On the clock, "first blip → the send
 *   succeeds but the `sending` flip faults for an hour → one probe blip" would
 *   become `retry_budget_exhausted`: a false member email and a released quota
 *   slot for mail that went out. The operator signal for a probe that never
 *   answers is `broadcasts_approved_overdue_count` + the
 *   `inherited_probe_retryable` warn repeating for the row.
 * - Any other throw follows this leg's ordinary gateway-failure rules.
 * - `unknown` refuses with phase `inherited_status`, never budgeted.
 */
async function probeInheritedBroadcast(
  deps: BuildAudienceTickDeps,
  input: BuildAudienceTickInput,
  broadcast: Broadcast,
  resendBroadcastId: string,
): Promise<
  | { readonly stop: Result<BuildAudienceTickOutput, BuildAudienceTickError> }
  | { readonly probe: InheritedProbe }
> {
  const ids = {
    tenantId: deps.tenant.slug,
    broadcastId: input.broadcastId as unknown as string,
    resendBroadcastId,
    importId: broadcast.audienceImportId,
  };
  const retrieved = await viaGateway(() => deps.broadcastsGateway.retrieveBroadcast(resendBroadcastId));
  if (!retrieved.ok) {
    if (retrieved.error.retryable) {
      logger.warn(
        { ...ids, subKind: retrieved.error.subKind ?? 'unclassified' },
        'broadcasts.audience_import.inherited_probe_retryable',
      );
      return { stop: err({ kind: 'dispatch.server_error', message: retrieved.error.message, phase: 'gateway' }) };
    }
    return { stop: await onGatewayFailure(deps, input, broadcast, retrieved.error, broadcast.audienceImportId) };
  }
  if (retrieved.value.kind === 'not_found') {
    logger.warn({ ...ids, observedResendStatus: 'not_found' }, 'broadcasts.audience_import.inherited_broadcast_send_attempted');
    return { probe: { handed: false, status: null } };
  }
  const { status, sentAt } = retrieved.value.resource;
  if (status === 'queued' || status === 'sending' || status === 'sent') {
    logger.warn({ ...ids, observedResendStatus: status }, 'broadcasts.audience_import.inherited_broadcast_already_handed_to_send');
    return { probe: { handed: true, status, sentAt } };
  }
  if (status === 'draft' || status === 'cancelled') {
    logger.warn({ ...ids, observedResendStatus: status }, 'broadcasts.audience_import.inherited_broadcast_send_attempted');
    return { probe: { handed: false, status } };
  }
  // `unknown`, and any status a later adapter adds without this function
  // learning it: FAIL CLOSED. Re-sending risks a second delivery to the whole
  // audience; skipping risks recording a send that never happened — both
  // unmeasured. A stuck broadcast is recoverable by a human; a duplicate send
  // to every member is not.
  logger.error(
    { ...ids, observedResendStatus: status, severity: 'critical' },
    'broadcasts.audience_import.inherited_resource_unrecognised_status',
  );
  return {
    stop: err({
      kind: 'dispatch.server_error',
      message: 'inherited_resource_unrecognised_status',
      errClass: 'gate',
      phase: 'inherited_status',
    }),
  };
}

/**
 * F119 PR-A — apply the send-time standing gate (`_dispatch-standing-gate.ts`,
 * shared with the legacy leg). `null` means "in good standing, carry on";
 * anything else is the tick's answer.
 *
 * - `hold` (R1, a `suspended` membership) — `dispatch_held_member_suspended`:
 *   nothing sent, nobody told, no audit. Two best-effort writes, each in its
 *   own tx: the FR-021 retry-clock reset (F119 PR-E, review H1 — a stamped row
 *   only), so a failure before a days-long hold cannot make the first blip
 *   after it terminal; and, on tick 2, abandoning the pending import
 *   (`abandonPendingImportOnHold`). The next tick asks again.
 * - `refuse` (halted, or the membership ENDED) — PERMANENT, and writes BOTH
 *   audit rows in the terminal transaction: the `broadcast_failed_to_dispatch`
 *   row every terminal failure writes, and the standing refusal under submit's
 *   own event types (`surface: 'dispatch'`), so "why was this member's E-Blast
 *   refused" stays one query across every surface.
 * - anything else — a read that FAILED decides nothing: `dispatch.server_error`
 *   with phase `standing`, the row stays `approved` and the next tick asks
 *   again. Fail CLOSED: an unknown decision lands here too, never at the send.
 */
async function applySendStanding(
  deps: BuildAudienceTickDeps,
  input: BuildAudienceTickInput,
  broadcast: Broadcast,
): Promise<Result<BuildAudienceTickOutput, BuildAudienceTickError> | null> {
  const standing = await decideDispatchStanding(
    deps.sendStanding,
    deps.tenant,
    broadcast.requestedByMemberId,
  );
  if (standing.kind === 'send') return null;
  if (standing.kind === 'hold') {
    recordDispatchHold(deps.tenant.slug, input.broadcastId as unknown as string, 'import');
    // Outside every tx: the Step-1 lock tx has committed.
    await resetDispatchRetryClock(deps, input.broadcastId, 'broadcasts.audience_import.retry_clock_clear_failed');
    await abandonPendingImportOnHold(deps, input, broadcast);
    return ok({ kind: 'dispatch_held_member_suspended' });
  }
  if (standing.kind === 'refuse') {
    return failTerminally(
      deps,
      input,
      broadcast,
      {
        kind: 'audience_import_failed',
        reason: standing.reason,
        importId: broadcast.audienceImportId,
        observed: null,
        expected: null,
      },
      {
        extraAudit: standingRefusalAuditEvent({
          refusal: standing.refusal,
          surface: 'dispatch',
          tenantSlug: deps.tenant.slug,
          memberId: broadcast.requestedByMemberId,
          broadcastId: input.broadcastId as unknown as string,
          actorUserId: 'system:cron',
          actorRole: null,
          requestId: null,
        }),
      },
    );
  }
  return err({
    kind: 'dispatch.server_error',
    message: standing.message,
    errClass: standing.errClass,
    phase: 'standing',
  });
}

/**
 * A HOLD on tick 2 — abandon the pending import, best-effort. Left in place,
 * a held import counted in `audience_import_stuck_count` for the whole hold (a
 * false "Resend import stuck" alarm), went stale while the audience changed
 * (the resumed send then failed `count_mismatch` / `audience_membership_drift`),
 * and made `hasDispatchBegun` read the row as handed over, so staff could
 * neither cancel nor re-time it.
 *
 * Reached only for a row nothing was handed to Resend for SENDING: the
 * inherited-id probe returns before the standing gate for a row whose broadcast
 * Resend reports `queued` / `sending` / `sent`, and the completion stamp lands
 * only after the send. A tick-1 hold (no import) has nothing to abandon;
 * neither has an import with no audience id (unreachable — tick 1 attaches the
 * audience before it submits).
 *
 * 1. Reclaim the pre-send broadcast, when the row carries one — the probe
 *    answered `draft`, `cancelled` or `not_found` THIS tick (the port's
 *    `deleteBroadcast` exception; 404 answers as success). A FAILURE keeps
 *    every column and the next held tick retries: detaching first would leave
 *    a resource holding the body and the member's name that no row points at
 *    and the retention sweep cannot find.
 * 2. Delete the tick-1 audience — outside every tx (a network call). The
 *    adapter answers 404 / 410 as success. A FAILURE leaves the columns as
 *    they are and the next held tick retries: detaching without the delete
 *    would leave the audience, and any erased member's address in it, where
 *    no row points at it and the erasure derivation cannot find it.
 * 3. Detach the columns — its own short tx, a CAS on all three ids. A lost
 *    CAS means another writer moved the row; the resources are gone either
 *    way. A THROW is retried in-tick, up to `DETACH_ATTEMPTS` times, each in
 *    a fresh tx: by now both deletes have happened, so the row points at
 *    resources that no longer exist (residual (a), below).
 *
 * Residual (a), bounded but not closed: a detach that fails every attempt
 * leaves the row `approved` on dead ids. While the hold lasts the next held
 * tick repairs it (the probe answers `not_found`, both deletes answer 404 as
 * success, the CAS runs again). If the member pays first, the resumed tick
 * polls a stale import against a deleted audience and fails terminally — how
 * is NOT MEASURED: `getContactImport` for an import whose audience was deleted
 * has never been probed, and a `createBroadcast` 404 cannot classify as
 * `resource_missing` (the adapter passes no resource id, so it lands as
 * `gateway_permanent` → `failed_to_dispatch`, member told), while a row still
 * carrying a broadcast id sends it, 404s, and lands in `resource_missing` (no
 * member email). A false failure the member resubmits — never a double send,
 * never a privacy leak. NOT reordered to detach-first: `reclaim-orphaned-
 * audiences` only reclaims an audience whose broadcast ROW is gone, so an
 * audience orphaned on a live approved row would never be swept.
 *
 * Never fails the tick: the hold is already the decided answer.
 */
async function abandonPendingImportOnHold(
  deps: BuildAudienceTickDeps,
  input: BuildAudienceTickInput,
  broadcast: Broadcast,
): Promise<void> {
  const importId = broadcast.audienceImportId;
  const resendAudienceId = broadcast.resendAudienceId;
  if (importId === null || !resendAudienceId) return;
  // Raw, so the CAS compares what the row holds — an empty string included.
  const resendBroadcastId = broadcast.resendBroadcastId ?? null;
  const ids = {
    tenantId: deps.tenant.slug,
    broadcastId: input.broadcastId as unknown as string,
    importId,
    resendAudienceId,
    resendBroadcastId,
  };
  if (resendBroadcastId !== null && resendBroadcastId !== '') {
    try {
      await deps.broadcastsGateway.deleteBroadcast(resendBroadcastId);
    } catch (e) {
      logger.warn({ err: errKind(e), ...ids, step: 'delete_broadcast' }, 'broadcasts.audience_import.hold_abandon_failed');
      return;
    }
  }
  try {
    await deps.broadcastsGateway.deleteAudience(resendAudienceId);
  } catch (e) {
    logger.warn({ err: errKind(e), ...ids, step: 'delete_audience' }, 'broadcasts.audience_import.hold_abandon_failed');
    return;
  }
  let detached: boolean | null = null;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= DETACH_ATTEMPTS && detached === null; attempt += 1) {
    try {
      detached = await deps.broadcastsRepo.withTx((tx) =>
        deps.broadcastsRepo.detachPendingAudienceImport(tx, deps.tenant.slug, input.broadcastId, {
          importId,
          resendAudienceId,
          resendBroadcastId,
        }),
      );
    } catch (e) {
      lastErr = e;
    }
  }
  if (detached === null) {
    logger.warn(
      { err: errKind(lastErr), ...ids, step: 'detach', attempts: DETACH_ATTEMPTS },
      'broadcasts.audience_import.hold_abandon_failed',
    );
    return;
  }
  if (!detached) {
    logger.info(ids, 'broadcasts.audience_import.hold_abandon_lost');
    return;
  }
  broadcastsMetrics.audienceImportAbandonedOnHold(deps.tenant.slug);
  logger.info(ids, 'broadcasts.audience_import.abandoned_on_hold');
}

/**
 * Residual (a) — how many times a hold tries the detach before leaving it to
 * the next held tick. Each attempt is a fresh `withTx` (a new pool
 * connection), which is what a Neon or pooler blip needs; no backoff, because
 * the tick shares one 300 s budget with every other row.
 */
const DETACH_ATTEMPTS = 3;

/**
 * A classified gateway outcome. `retryable` is the adapter's own word for
 * 5xx / 429 / network; everything else is a statement that the next tick gets
 * the same answer.
 */
type GatewayFailure =
  | {
      readonly retryable: true;
      readonly message: string;
      /**
       * The adapter's transport class (`classifyResendError` tags every
       * `retryable` throw with `network` / `server_5xx` / `api`). Carried so the
       * FR-021 budget can report the class actually observed instead of a
       * plausible one — the same reason the non-retryable arm carries `kind`.
       */
      readonly subKind?: 'network' | 'timeout' | 'server_5xx' | 'api' | undefined;
    }
  | {
      readonly retryable: false;
      readonly reason: Extract<ImportFailureReason, 'gateway_permanent' | 'gateway_unknown'>;
      readonly message: string;
      /**
       * Round 3 finding 3-3 — the adapter's classification, carried through
       * rather than flattened away.
       *
       * `classifyResendError` distinguishes four kinds, and the legacy path
       * routes two of them SPECIALLY: `idempotency_conflict` (409) is a success
       * replay that advances the row to `sending`, and `resource_missing` (404)
       * gets its own audit event and deliberately does NOT email the member,
       * because it is "an ops-side issue requiring admin action". Collapsing all
       * of them to a boolean sent both down the `failed_to_dispatch` path: a
       * false row in an append-only table, a member told their E-Blast did not
       * go out, and — since `countForMemberQuota` excludes `failed_to_dispatch`
       * — a refunded quota slot for a broadcast that was delivered.
       */
      readonly kind: string;
      readonly resourceType?: 'audience' | 'broadcast' | 'import' | undefined;
      readonly resourceId?: string | undefined;
      /**
       * The adapter's `code` — `err.name` from Resend, or `http_<status>`.
       * Carried for the failure METRIC only (round 3 finding 3-12): without it
       * every terminal import failure was counted `app_error`, so the runbook's
       * "group by failure_reason to identify the dominant cause" step had one
       * bucket. Never logged — it is provider free text.
       */
      readonly code?: string | undefined;
    };

/**
 * Run a gateway call so a throw becomes a DECISION instead of an escape.
 *
 * Before this existed the file had zero `catch` blocks against the legacy path's
 * eighteen. Every Resend failure — including the measured Free-plan contact cap,
 * which `resend-contact-import.test.ts` pins as `{kind:'permanent'}` — reached
 * the cron's per-row catch as `uncaught_error`, the bucket reserved for
 * programming bugs, and left the row `approved`. The next tick then re-uploaded
 * the entire member email list to the processor. Every five minutes. Indefinitely.
 */
async function viaGateway<T>(fn: () => Promise<T>): Promise<Result<T, GatewayFailure>> {
  try {
    return ok(await fn());
  } catch (e) {
    const shape = classifyThrown(e);
    const message = shape.reason ?? shape.kind;
    if (isRetryableThrow(shape.kind)) {
      const sub = shape.subKind;
      return err({
        retryable: true,
        message,
        subKind:
          sub === 'network' || sub === 'timeout' || sub === 'server_5xx' || sub === 'api'
            ? sub
            : undefined,
      });
    }
    return err({
      retryable: false,
      // `unknown` means the throw carried no `kind` at all — not a gateway
      // error but a fault in our own code. Kept distinct in the audit row so an
      // operator is not sent to look at Resend's status page for our bug.
      reason: shape.kind === 'unknown' ? 'gateway_unknown' : 'gateway_permanent',
      message,
      kind: shape.kind,
      resourceType: shape.resourceType,
      resourceId: shape.resourceId,
      code: shape.code,
    });
  }
}

/**
 * Round 2 R2-1 / round 3 finding 3-13 — the repo's compare-and-set throws when
 * a concurrent tick attached a different audience or import. Neither CAS call in
 * `submitImport` sat inside `viaGateway` or any try/catch, so that throw escaped
 * this use case entirely and the cron counted it `uncaught_error` — the bucket
 * that means "a fault in our own code", for a benign, self-healing race the CAS
 * was ADDED to make survivable.
 *
 * Deliberately NOT folded into `viaGateway`: these are repo faults, not gateway
 * faults, and routing them through the gateway classifier would put a Resend
 * failure reason on a Postgres event. Both kinds map to error variants the cron
 * now buckets as `concurrent_skip`.
 *
 * Anything else rethrows — a serialization failure or a statement timeout is
 * not a lost race, and swallowing it here would hide it behind a benign name.
 */
async function viaRepoConcurrency<T>(
  broadcastId: BroadcastId,
  fn: () => Promise<T>,
): Promise<Result<T, BuildAudienceTickError>> {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof BroadcastConcurrentMutationError) {
      return err({
        kind: 'broadcast_invalid_state_transition',
        observedStatus: e.observedStatus,
      });
    }
    if (e instanceof BroadcastNotFoundError) {
      return err({
        kind: 'broadcast_not_found',
        broadcastId: broadcastId as unknown as string,
      });
    }
    throw e;
  }
}

/**
 * Round 3 finding 3-12 — what `broadcasts.failed_to_dispatch.count`'s
 * `failure_reason` dimension should say.
 *
 * The import path passed the literal `'app_error'` for every terminal failure,
 * where the legacy path calls `phaseToFailureReason(phase)`. So
 * `docs/runbooks/broadcasts-dispatch-failure.md`'s "group `failure_reason` to
 * identify the dominant cause" step could only ever return one bucket, and the
 * two paths' series were not comparable across a flag move.
 *
 * Deliberately conservative. The closed union offers `resend_403`, which is
 * exactly the measured Free-plan contact cap, and `timeout`, which is exactly
 * the 30-minute stuck rule — those two are mapped. Everything else stays
 * `app_error` rather than being guessed into a plausible-looking HTTP bucket: a
 * `gateway_permanent` may be a 422 as easily as a 403, and a metric that asserts
 * a status nobody observed is the same class of defect as an audit row that
 * asserts a role nobody held.
 */
/**
 * Round 4 F7 — the observed transport class, expressed in the failure-metric
 * union without guessing.
 *
 * A separate named helper rather than a ternary chain: CLAUDE.md forbids nested
 * ternaries, and the sibling helper below carries a comment saying a previous
 * 4-level chain was replaced for exactly that reason.
 *
 * `network`, `api` and `unclassified` deliberately stay `app_error`. The union
 * has no member for them, and inventing an HTTP bucket nobody observed is the
 * defect being fixed one dimension over — see the sibling's docblock.
 */
function budgetSubKindToFailureMetric(
  subKind: 'network' | 'timeout' | 'server_5xx' | 'api' | 'unclassified',
): FailureMetricLabel {
  if (subKind === 'server_5xx') return 'resend_5xx';
  if (subKind === 'timeout') return 'timeout';
  return 'app_error';
}

/**
 * The `failure_reason` label set of `broadcasts.failed_to_dispatch.count` —
 * the same closed union the legacy leg's `DispatchFailureReason` spells.
 * `member_ineligible` (F119 PR-A) is a decision about the member, not a fault,
 * so it is counted apart from `app_error`, which the dispatch alert reads.
 */
type FailureMetricLabel = 'resend_5xx' | 'resend_429' | 'resend_403' | 'app_error' | 'timeout' | 'member_ineligible';

function importReasonToFailureMetric(
  reason: ImportFailureReason | 'audience_import_stuck',
  code: string | undefined,
): FailureMetricLabel {
  if (reason === 'member_halted' || reason === 'member_not_in_good_standing') return 'member_ineligible';
  if (reason === 'audience_import_stuck') return 'timeout';
  if (code === 'http_403') return 'resend_403';
  if (code === 'http_429') return 'resend_429';
  return 'app_error';
}

/**
 * FR-021 / AS2 — the same 1-hour wall-clock budget the single-tick path enforces
 * (`dispatch-scheduled-broadcast.ts:77`).
 *
 * **Round 3 finding 3-7 — this path had no budget at all.** The only time bound
 * on it was `IMPORT_STUCK_AFTER_MS`, and that is evaluated ONLY inside the
 * `job.status !== 'completed'` branch, which requires a SUCCESSFUL poll. A Resend
 * 5xx / 429 / network failure on `createAudience` or `createContactImport`, or a
 * `resolve.server_error` from a Neon or RLS blip, returned
 * `dispatch.server_error` every tick for ever: never terminal, member never
 * told, and — because a tick-1 failure never persists `audience_import_id` —
 * invisible to BOTH the T106 gauge and the documented rollback drain, which are
 * the same shape and require `audience_import_id IS NOT NULL`.
 *
 * `dispatchBudgetExhausted` is the metric whose steady state is 0 and whose
 * non-zero rate pages on-call (`docs/observability.md` § F7 alerts). With the
 * flag on it could never fire.
 *
 * F119 PR-E (migration 0311) — the epoch is the FIRST retryable gateway failure
 * of the current attempt (`dispatchRetryEpoch`, shared with the legacy leg), not
 * `scheduledFor ?? approvedAt ?? createdAt`. That epoch killed a row resumed an
 * hour late (a hold, the read-only freeze) on its first blip; the send-now
 * fallback it needed is gone with it, because every row's clock now starts at
 * its failure — a send-now row is bounded like any other.
 */

/**
 * A retryable failure, decided: retry on the next tick, or stop because the
 * budget is spent. Returns the caller's Result either way.
 *
 * `source` is not decoration. The budget is shared by two very different
 * failures — the provider refusing, and our own storage refusing — and the
 * terminal record of each is read by a member (the FR-021 email) and by on-call
 * (`dispatch_budget_exhausted{sub_kind}`). Collapsing them told a member their
 * email provider was down when Neon was, and put a DB fault on a provider
 * transport class.
 */
async function onRetryable(
  deps: BuildAudienceTickDeps,
  input: BuildAudienceTickInput,
  broadcast: Broadcast,
  message: string,
  importId: string | null,
  /**
   * Round 4 F3 — `source: 'gateway' | 'resolve'` is gone with the resolve-side
   * budget it existed to label. Only the gateway reaches this function now, the
   * same shape the live leg has always had, so the parameter had one possible
   * value and the ternary it fed had one reachable arm.
   */
  subKind: 'network' | 'timeout' | 'server_5xx' | 'api' | 'unclassified',
): Promise<Result<BuildAudienceTickOutput, BuildAudienceTickError>> {
  const now = deps.clock.now();
  const epoch = await dispatchRetryEpoch(
    deps,
    input.broadcastId,
    broadcast,
    now,
    'broadcasts.audience_import.retry_epoch_stamp_failed',
  );
  if (epoch === null) {
    // Review L3 — the stamp matched no `approved` row: another writer moved it
    // since Step 1. No attempt is left to fail, so no terminal write, nobody
    // told; the cron buckets this as a concurrent skip.
    return err({ kind: 'broadcast_invalid_state_transition', observedStatus: 'unknown_or_already_processed' });
  }
  const elapsedMs = now.getTime() - epoch.getTime();
  if (elapsedMs <= RETRY_BUDGET_MS) {
    return err({ kind: 'dispatch.server_error', message, phase: 'gateway' });
  }

  logger.error(
    {
      tenantId: deps.tenant.slug,
      broadcastId: input.broadcastId,
      importId,
      elapsedMs,
      epochForBudget: epoch.toISOString(),
      sendMode: broadcast.scheduledFor === null ? 'send_now' : 'scheduled',
      subKind,
      severity: 'critical',
    },
    'broadcasts.audience_import.retry_budget_exhausted',
  );
  // The AS2 alert trigger, carrying the class actually observed rather than a
  // plausible one.
  broadcastsMetrics.dispatchBudgetExhausted(deps.tenant.slug, subKind);

  return failTerminally(
    deps,
    input,
    broadcast,
    {
      kind: 'audience_import_failed',
      reason: 'retry_budget_exhausted',
      importId,
      observed: elapsedMs,
      expected: RETRY_BUDGET_MS,
    },
    {
      // Round 4 F7 — the two series used to disagree about one failure.
      // `dispatchBudgetExhausted` carried the OBSERVED transport class while
      // `failedToDispatchCount` fell to `importReasonToFailureMetric`, which has
      // no case for `retry_budget_exhausted` and returned `app_error` — so an
      // hour of Resend 5xx was filed under "our application" on the series
      // `broadcasts-dispatch-failure.md` tells an operator to group by.
      //
      // Only the two classes the union can express WITHOUT guessing are mapped,
      // which is that helper's own stated principle: `server_5xx` is exactly
      // `resend_5xx`, `timeout` is exactly `timeout`. `network`, `api` and
      // `unclassified` stay `app_error` because the union has no member for them
      // and inventing an HTTP bucket nobody observed is the defect this is
      // fixing, one dimension over.
      failureMetric: budgetSubKindToFailureMetric(subKind),
    },
  );
}

/**
 * Route a classified gateway failure: retry next tick, or stop for good.
 *
 * Round 3 finding 3-3 — `resource_missing` is NOT "the broadcast failed". The
 * legacy path has treated it apart since its own review rounds: the audience or
 * broadcast resource is gone at Resend, which needs an admin to look at the
 * account, and the member is deliberately not told because there is nothing they
 * can do and nothing they did wrong. Folding it into `failed_to_dispatch` put a
 * sentence in an append-only row and in a member's inbox that neither the
 * operator nor the member could act on.
 */
async function onGatewayFailure(
  deps: BuildAudienceTickDeps,
  input: BuildAudienceTickInput,
  broadcast: Broadcast,
  failure: GatewayFailure,
  importId: string | null,
): Promise<Result<BuildAudienceTickOutput, BuildAudienceTickError>> {
  if (failure.retryable) {
    return onRetryable(
      deps,
      input,
      broadcast,
      failure.message,
      importId,
      // Round 4 F8 — was `?? 'api'`, against the gateway port's own docblock:
      // making `subKind` required on a retryable throw "removes the
      // `subKind ?? 'api'` default that masked classifier bugs". The Application
      // layer had added it straight back, and `dispatch_budget_exhausted` is a
      // page-on-call series — attributing an unclassified fault to a real
      // transport class is the `?? 'admin'` shape in a metric dimension.
      //
      // Unreachable today (`GatewayThrowable` requires `subKind` on retryable),
      // but `viaGateway` narrows against four hardcoded literals and maps
      // anything else to `undefined`, so a FIFTH sub-kind would land here with
      // no compiler signal. `'unclassified'` makes that visible on the
      // dashboard instead of hiding it inside `api`.
      failure.subKind ?? 'unclassified',
    );
  }

  if (failure.kind === 'resource_missing') {
    logger.error(
      {
        tenantId: deps.tenant.slug,
        broadcastId: input.broadcastId,
        importId,
        resourceType: failure.resourceType ?? 'broadcast',
        resourceId: failure.resourceId ?? (input.broadcastId as unknown as string),
      },
      'broadcasts.audience_import.resend_resource_missing',
    );
    return failTerminally(
      deps,
      input,
      broadcast,
      {
        kind: 'audience_import_failed',
        reason: failure.reason,
        importId,
        observed: null,
        expected: null,
      },
      {
        auditEventType: 'broadcast_resend_resource_missing',
        notifyMember: false,
        failureMetric: importReasonToFailureMetric(failure.reason, failure.code),
        resourceMissing: {
          resourceType: failure.resourceType ?? 'broadcast',
          resourceId: failure.resourceId ?? (input.broadcastId as unknown as string),
        },
      },
    );
  }

  return failTerminally(
    deps,
    input,
    broadcast,
    {
      kind: 'audience_import_failed',
      reason: failure.reason,
      importId,
      observed: null,
      expected: null,
    },
    { failureMetric: importReasonToFailureMetric(failure.reason, failure.code) },
  );
}

/** Tick 1 — hand the audience over. Sends nothing. */
async function submitImport(
  deps: BuildAudienceTickDeps,
  input: BuildAudienceTickInput,
  broadcast: Broadcast,
): Promise<Result<BuildAudienceTickOutput, BuildAudienceTickError>> {
  const resolved = await deps.resolveRecipients(broadcast);
  if (!resolved.ok) return onResolveFailure(deps, input, broadcast, resolved.error);

  // Orphan-audience prevention, the same rule the single-tick path follows: a
  // retry after a downstream failure must REUSE the audience a previous attempt
  // created. On Resend Free three audiences is the entire allowance, and a
  // leaked one is not reclaimed until `cleanup-audiences` reaps it.
  let audienceId = broadcast.resendAudienceId ?? '';
  if (audienceId === '') {
    const created = await viaGateway(() =>
      deps.broadcastsGateway.createAudience(
        `broadcast-${deps.tenant.slug}-${input.broadcastId as unknown as string}`,
      ),
    );
    if (!created.ok) return onGatewayFailure(deps, input, broadcast, created.error, null);
    audienceId = created.value.audienceId;
    const attached = await viaRepoConcurrency(input.broadcastId, () =>
      deps.broadcastsRepo.withTx(async (tx) => {
        await deps.broadcastsRepo.attachAudienceId(
          tx,
          deps.tenant.slug,
          input.broadcastId,
          audienceId,
        );
      }),
    );
    if (!attached.ok) return err(attached.error);
  }

  // S48 — time the one call the whole design rests on. Nothing measured it
  // before, so neither the ~412 ms it is sized against nor the 30-minute stuck
  // threshold derived from it was checkable in production.
  const submitStartedAt = Date.now();
  const submitted = await viaGateway(() =>
    deps.broadcastsGateway.createContactImport(audienceId, resolved.value.recipients),
  );
  broadcastsMetrics.audienceImportSubmitMs(
    deps.tenant.slug,
    Date.now() - submitStartedAt,
    submitted.ok ? 'ok' : 'failed',
  );
  if (!submitted.ok) return onGatewayFailure(deps, input, broadcast, submitted.error, null);

  const attachedImport = await viaRepoConcurrency(input.broadcastId, () =>
    deps.broadcastsRepo.withTx(async (tx) => {
      await deps.broadcastsRepo.attachAudienceImport(
        tx,
        deps.tenant.slug,
        input.broadcastId,
        submitted.value.importId,
      );
    }),
  );
  if (!attachedImport.ok) return err(attachedImport.error);

  logger.info(
    {
      tenantId: deps.tenant.slug,
      broadcastId: input.broadcastId,
      importId: submitted.value.importId,
      recipientCount: resolved.value.recipients.length,
      // Carried through from the resolver now that the port no longer discards
      // them. These are the numbers behind "why did this reach 40 of 55?".
      orphanCount: resolved.value.orphans.length,
      droppedByPreference: resolved.value.droppedByPreference,
    },
    'broadcasts.audience_import.submitted',
  );

  return ok({
    kind: 'import_submitted',
    importId: submitted.value.importId,
    recipientCount: resolved.value.recipients.length,
  });
}

/** Tick 2+ — poll, apply the completion rule, and only then send. */
async function confirmImport(
  deps: BuildAudienceTickDeps,
  input: BuildAudienceTickInput,
  broadcast: Broadcast,
  importId: string,
  now: Date,
  /**
   * S8 — what Step 1a learned about a broadcast id an earlier tick persisted.
   * `resendBroadcastId` is `''` when the row carries none (a fresh mint). A
   * non-empty one was probed NOT handed to `/send` (draft / cancelled /
   * not_found), so it is reused — never minted twice.
   */
  inherited: {
    readonly resendBroadcastId: string;
    readonly observedResendStatus: 'draft' | 'cancelled' | null;
  },
): Promise<Result<BuildAudienceTickOutput, BuildAudienceTickError>> {
  const polled = await viaGateway(() => deps.broadcastsGateway.getContactImport(importId));
  if (!polled.ok) return onGatewayFailure(deps, input, broadcast, polled.error, importId);
  const job = polled.value;

  if (job.status !== 'completed') {
    // The provider's own verdict, which used to be thrown away: anything that
    // was not `completed` was treated as "still working". An explicit `failed`
    // was therefore polled for another 29 minutes and then recorded as `stuck` —
    // the wrong cause, in an append-only table.
    // Round 2 R2-21 asked for this set to be INVERTED — allowlist the in-flight
    // statuses, default to terminal — so a status Resend adds later is not polled
    // for 30 minutes and then recorded as `stuck`, the wrong cause in an
    // append-only table.
    //
    // **Only half of that is done here, deliberately.** Resend's import-status
    // vocabulary is UNVERIFIED: `research.md` § R9 and
    // `contracts/broadcast-audience.md` document only `completed`, and
    // `failed`/`canceled` were inferred. An allowlist built on a guess turns a
    // genuinely in-flight status into an immediate terminal failure — a LOST
    // SEND — whereas the defect it fixes is a wrong cause recorded after 30
    // minutes, with the send already gone. That asymmetry decides it.
    //
    // What IS safe: `'unknown'` is not a provider status at all — it is the
    // gateway's own sentinel for a response with no `status` field
    // (`resend-broadcasts-gateway.ts:765`), so treating it as in-flight means
    // polling a reply we could not read. It is terminal now.
    //
    // TODO(measure): capture the real status strings on the first production
    // import and invert this properly. Until then the 30-minute rule is the bound.
    if (job.status === 'failed' || job.status === 'canceled' || job.status === 'unknown') {
      logger.error(
        {
          tenantId: deps.tenant.slug,
          broadcastId: input.broadcastId,
          importId,
          providerStatus: job.status,
        },
        'broadcasts.audience_import.provider_failed',
      );
      return failTerminally(deps, input, broadcast, {
        kind: 'audience_import_failed',
        reason: 'provider_failed',
        importId,
        observed: null,
        expected: null,
      });
    }

    const submittedAt = broadcast.audienceImportSubmittedAt;
    // FAIL CLOSED on `(import_id set, submitted_at NULL)`. That row used to
    // compute `ageMs = 0` — never older than the threshold — while the stuck
    // gauge could not see it either, because `NULL < now() - interval` is false.
    // Invisible in both places at once. A state that cannot legally exist is
    // stuck by definition, not brand new.
    //
    // Round 4 F11 — the reason given here was "`0298`'s coherence CHECK is an
    // implication rather than an iff, so it admits that pair", written in the
    // present tense. Migration `0299`, on this branch, made it an iff, so the
    // database now rejects the pair. The fail-closed handling stays — a
    // constraint can be dropped, a row can predate it, and the cost of the safe
    // answer is one wasted poll — but the reason is HISTORY, not a live property.
    // The claim, not the code, was the stale part.
    const ageMs =
      submittedAt === null
        ? Number.POSITIVE_INFINITY
        : now.getTime() - submittedAt.getTime();
    // Nothing else records what the provider actually said, so log it here or
    // an operator debugging a slow import has only "not completed" to go on.
    logger.info(
      {
        tenantId: deps.tenant.slug,
        broadcastId: input.broadcastId,
        importId,
        providerStatus: job.status,
        ageMs: Number.isFinite(ageMs) ? ageMs : null,
      },
      'broadcasts.audience_import.pending',
    );
    if (ageMs > IMPORT_STUCK_AFTER_MS) {
      // Terminal rather than polled forever. The provider has had the job for
      // half an hour; a broadcast that keeps being re-polled with no signal is
      // indistinguishable from a healthy one until someone notices by hand.
      return failTerminally(deps, input, broadcast, {
        kind: 'audience_import_stuck',
        importId,
        ageMs,
      });
    }
    return ok({ kind: 'import_pending', importId });
  }

  const { total, created, updated, skipped, failed } = job.counts;

  if (failed > 0) {
    return failTerminally(deps, input, broadcast, {
      kind: 'audience_import_failed',
      reason: 'failed_rows',
      importId,
      observed: failed,
      expected: 0,
    });
  }

  const parts = created + updated + skipped;
  if (parts !== total) {
    return failTerminally(deps, input, broadcast, {
      kind: 'audience_import_failed',
      reason: 'counts_incoherent',
      importId,
      observed: parts,
      expected: total,
    });
  }

  // Re-resolve: `total` is only meaningful against the set we believe we are
  // sending to. This is also the drift guard — an audience that changed between
  // the submit tick and this one refuses rather than delivering to a different
  // set of people (FR-044 a).
  const resolved = await deps.resolveRecipients(broadcast);
  if (!resolved.ok) return onResolveFailure(deps, input, broadcast, resolved.error);
  const resolvedCount = resolved.value.recipients.length;

  if (total !== resolvedCount) {
    // Covers the measured `completed / failed:0 / total:0` case, which reads as
    // success on `status` alone and would send to an empty audience.
    return failTerminally(deps, input, broadcast, {
      kind: 'audience_import_failed',
      reason: 'count_mismatch',
      importId,
      observed: total,
      expected: resolvedCount,
    });
  }

  const audienceId = broadcast.resendAudienceId ?? '';

  // ## Round 3 finding 3-5 — verify the AUDIENCE, not just the import job
  //
  // Every clause of the completion rule above compares numbers reported by the
  // import JOB. None of them looks at what the audience actually holds, and the
  // two can differ: `submitImport` deliberately REUSES
  // `broadcast.resendAudienceId`, `createContactImport` posts
  // `on_conflict=upsert`, and nothing anywhere removes a contact —
  // `unsubscribe-recipient.ts` writes only `marketing_unsubscribes` and makes NO
  // gateway call, so Resend still holds the contact as subscribed.
  //
  // Reachable without anything exotic: tick 1 creates the audience and imports
  // {A,B,C}, then dies before `attachAudienceImport` commits. C unsubscribes.
  // Tick 2 re-runs `submitImport`, importing {A,B} into the SAME audience, which
  // still holds C: failed=0, parts==total==2, total==resolvedCount==2 — every
  // clause passes — and the send reaches all three. GDPR Art. 21 / PDPA s.32.
  //
  // **Round 4 F1 — the comparison is `>`, not `!==`, and that is the whole
  // difference between a guard and an outage.**
  //
  // This check shipped in round 3 refusing on ANY inequality, under a comment
  // claiming the legacy leg "has used it for exactly this … with the same two
  // outcomes: a MISMATCH refuses". Every clause of that was false, and reading
  // the legacy source says so in its own words:
  //   - legacy calls this ONLY in the idempotency-conflict replay arm, never on
  //     the normal path;
  //   - legacy on mismatch STILL ADVANCES to `sending` — "the drift is a
  //     forensic record, not a blocker";
  //   - and the number is `sdk.contacts.list({audienceId}).data.length`, where
  //     the SDK sends NO query parameter at all (`resend/dist/index.js`), so it
  //     is ONE PAGE of an unknown page size. The method's own comment admits it:
  //     "(paginated). For MVP we list and return `data.length`".
  //
  // So `!==` fired on the happy path for any audience larger than a page —
  // SweCham's 150 members against a typical 100-row page — killing the
  // broadcast permanently and telling the member it was not sent.
  //
  // `>` is safe in a way `!==` can never be, because a truncated page can only
  // UNDERCOUNT. If the observed count still EXCEEDS what we resolved, then the
  // true audience is at least that large and genuinely holds contacts we did
  // not put there — no pagination can manufacture that. A shortfall, by
  // contrast, is indistinguishable from truncation, so it proceeds on the
  // record.
  //
  // That keeps the guard pointed at the harm it was built for — the carried-over
  // contact above, who unsubscribed and would otherwise receive the send (GDPR
  // Art. 21 / PDPA s.32) — and removes the false-refusal direction entirely.
  //
  // RESIDUAL, stated rather than implied: a carried-over contact can still be
  // MISSED when the page truncates below `resolvedCount`. Closing that needs a
  // paginating count, which `getAudienceContactCount` is not. False negatives
  // here are the same exposure as the `unverifiable` branch below and are the
  // right trade for a check that can kill a send; false positives were not.
  const audienceCount = await viaGateway(() =>
    deps.broadcastsGateway.getAudienceContactCount(audienceId),
  );
  // Round 4 F1 residual, CLOSED as far as one call can close it. The refusal
  // below is safe on a truncated page (an excess cannot be manufactured by
  // truncation), but "we compared and it matched" was NOT: a short page landing
  // at or below `resolvedCount` was indistinguishable from a verified-clean
  // audience. `complete` now carries Resend's own `has_more`, so a count we
  // could not finish reading falls to the unverifiable branch instead of being
  // reported as a clean check.
  //
  // 2026-09-10 — the `kind === 'present'` term that used to sit in here is
  // gone with the `not_found` arm it narrowed on: the list endpoint never 404s
  // (MEASURED), so a "missing audience" reaches this function only as a THROW,
  // which `viaGateway` has already turned into `!audienceCount.ok` below.
  const countIsUsable =
    audienceCount.ok &&
    (audienceCount.value.complete || audienceCount.value.count > resolvedCount);

  if (countIsUsable && audienceCount.ok) {
    if (audienceCount.value.count > resolvedCount) {
      return failTerminally(deps, input, broadcast, {
        kind: 'audience_import_failed',
        reason: 'audience_membership_drift',
        importId,
        observed: audienceCount.value.count,
        expected: resolvedCount,
      });
    }
  } else {
    // A transport failure, or a page we could not finish reading. (Not a 404:
    // the list endpoint answers a missing audience with `200` + empty list,
    // MEASURED 2026-09-10, and that lands in `countIsUsable` as a complete
    // zero, which the `>` above then treats as no excess.) Proceeding is the
    // lesser harm — refusing here would kill a legitimate send on a Resend
    // blip — but it goes on the record, because this is the one check that
    // can see a carried-over contact.
    logger.warn(
      {
        tenantId: deps.tenant.slug,
        broadcastId: input.broadcastId,
        importId,
        audienceId,
        expectedRecipientCount: resolvedCount,
      },
      'broadcasts.audience_import.membership_unverifiable',
    );
    // Round 4 (reliability I-2, fourth strand) — the legacy leg emits this at
    // its own unverifiable branch with a comment saying the catalogued alert at
    // `observability.md` § 22.3 (`drift_check_unverifiable > 1 / 1h`) needs a
    // data source. This leg had the log and not the metric, so that alert was
    // blind here — and this is the branch a Resend blip lands in, on the leg
    // that a flag flip makes live.
    broadcastsMetrics.driftCheckUnverifiable(deps.tenant.slug);
  }

  // S8 — the double-send window, closed the way the legacy leg closed it (F4).
  //
  // `createBroadcast` mints a Resend resource and carries no idempotency key
  // (`Idempotency-Key` is MEASURED inert on `POST /broadcasts`, 2026-09-09). Its
  // id used to reach the row only AFTER `sendBroadcast`, so a tick dying
  // between the send and that write re-entered with no id, minted a SECOND
  // resource and sent to everyone again — a different resource, where no key
  // can dedupe. Now the minted id is persisted BEFORE the send, in its own tx
  // (`persistBroadcastIdBeforeSend`), and a re-entered tick probes it at Step
  // 1a: handed → caught up without a send; never handed → reused here.
  let resendBroadcastId = inherited.resendBroadcastId;
  if (resendBroadcastId === '') {
    // F119 T031 — read outside the gateway retry wrapper: a brand read is not a
    // provider call and must not be classified as one.
    const brand = await loadBrandChrome(deps.brandChrome, deps.tenant, 'audience_tick');
    const createdRb = await viaGateway(() =>
      deps.broadcastsGateway.createBroadcast({
        audienceId,
        subject: broadcast.subject,
        htmlBody: broadcast.bodyHtml,
        fromName: broadcast.fromName,
        fromEmail: deps.fromEmail,
        replyToEmail: broadcast.replyToEmail,
        broadcastNameForResendDashboard: `${deps.tenantDisplayName} — ${broadcast.subject}`,
        tenantDisplayName: deps.tenantDisplayName,
        locale: deps.locale,
        brand,
      }),
    );
    if (!createdRb.ok) return onGatewayFailure(deps, input, broadcast, createdRb.error, importId);
    resendBroadcastId = createdRb.value.broadcastId;
    const persistRefused = await persistBroadcastIdBeforeSend(deps, input, resendBroadcastId, audienceId, importId);
    if (persistRefused !== null) return persistRefused;
  }
  const sendId = resendBroadcastId;

  // Same idempotency key shape the single-tick path uses, and the SAME key on
  // a re-entered tick that reuses an inherited id. Round 3 finding 3-1:
  // `resend@4.8.0`'s `broadcasts.send` dropped the key, so the gateway sends it
  // via `post()`'s third argument — which makes a WITHIN-TICK replay
  // (`withRetry` re-firing after a lost response) safe and the 409 arm below
  // reachable. Whether `/send` honours the key ACROSS ticks is UNMEASURED
  // (probing it sends real mail); the probe at Step 1a is what this leg relies
  // on instead.
  const sent = await viaGateway(() =>
    deps.broadcastsGateway.sendBroadcast(
      sendId,
      `broadcast-${deps.tenant.slug}-${input.broadcastId as unknown as string}`,
    ),
  );
  // A 409 on the SEND means Resend already accepted this exact dispatch — the
  // mail is out. The legacy path has treated that as a success replay since
  // 2026-05-02; failing terminally here would write `failed_to_dispatch` for a
  // delivered broadcast, email the member that it did not go out, and refund the
  // quota slot (`countForMemberQuota` excludes `failed_to_dispatch`).
  //
  // Only on the send, and only with a broadcast id in hand: a 409 raised earlier
  // leaves nothing to advance to, which is exactly the distinction
  // `idempotency_conflict_pre_send` draws on the legacy leg.
  const sentOrReplayed =
    sent.ok || (!sent.error.retryable && sent.error.kind === 'idempotency_conflict');
  if (!sentOrReplayed) {
    return onGatewayFailure(deps, input, broadcast, sent.error as GatewayFailure, importId);
  }
  if (!sent.ok) {
    logger.warn(
      {
        tenantId: deps.tenant.slug,
        broadcastId: input.broadcastId,
        resendBroadcastId: sendId,
        importId,
      },
      'broadcasts.audience_import.send_idempotency_replay',
    );
  }

  return advanceToSending(deps, input, broadcast, now, {
    resendBroadcastId: sendId,
    audienceId,
    importId,
    recipientCount: resolvedCount,
    orphanCount: resolved.value.orphans.length,
    droppedByPreference: resolved.value.droppedByPreference,
    handedOnPriorTick: null,
    observedResendStatus: inherited.observedResendStatus,
  });
}

/**
 * S8 — persist the id `createBroadcast` just minted, BEFORE the send, in its
 * OWN tx and its own try/catch (the legacy leg's F4 block, the same arms).
 * `null` = persisted, send it; anything else is the tick's answer, and on
 * every one of them NOTHING is sent.
 *
 * - `BroadcastConcurrentMutationError` — a sibling tick attached its own id
 *   first, or the row left `approved` since Step 1 (withdrawn, cancelled,
 *   re-opened). Reclaim the resource we minted (the CAS refused OUR id, so it
 *   is orphaned by construction) and stop.
 * - `BroadcastNotFoundError` — the row is gone; reclaim and stop. No code path
 *   in `src/` produces it today (defence in depth, as on the legacy leg).
 * - Anything else — a DB fault, BEFORE any mail went out, so the safe answer
 *   is the transient one (`persist_broadcast_id`, not budgeted — a DB fault is
 *   budgeted on neither leg). The throw cannot say whether the write landed (a
 *   commit whose ack was lost on the pooler looks identical), so the row is
 *   read back first: landed → KEEP the resource (the next tick inherits and
 *   probes it); absent → reclaim; read-back failed → keep (a junk draft in the
 *   dashboard is the cheaper wrong).
 */
async function persistBroadcastIdBeforeSend(
  deps: BuildAudienceTickDeps,
  input: BuildAudienceTickInput,
  resendBroadcastId: string,
  audienceId: string,
  importId: string,
): Promise<Result<BuildAudienceTickOutput, BuildAudienceTickError> | null> {
  try {
    await deps.broadcastsRepo.withTx(async (tx) => {
      await deps.broadcastsRepo.attachBroadcastId(tx, deps.tenant.slug, input.broadcastId, resendBroadcastId);
    });
    return null;
  } catch (persistErr) {
    const reclaim = (why: 'attach_lost' | 'row_vanished' | 'persist_failed', observedStatus?: string) =>
      reclaimMintedBroadcast(deps, input, resendBroadcastId, audienceId, {
        why,
        logPrefix: 'broadcasts.audience_import',
        ...(observedStatus === undefined ? {} : { observedStatus }),
      });
    if (persistErr instanceof BroadcastConcurrentMutationError) {
      await reclaim('attach_lost', persistErr.observedStatus);
      return err({ kind: 'broadcast_invalid_state_transition', observedStatus: persistErr.observedStatus });
    }
    if (persistErr instanceof BroadcastNotFoundError) {
      await reclaim('row_vanished');
      return err({ kind: 'broadcast_not_found', broadcastId: input.broadcastId as unknown as string });
    }
    const ids = {
      tenantId: deps.tenant.slug,
      broadcastId: input.broadcastId as unknown as string,
      resendBroadcastId,
      importId,
    };
    // NOT `reason` — that key is in `REDACT_PATHS`.
    const persistFailureKind =
      (persistErr as { code?: string } | null)?.code === '23505'
        ? 'duplicate_resend_broadcast_id'
        : 'attach_broadcast_id_failed';
    logger.error(
      { ...ids, err: errKind(persistErr), persistFailureKind, severity: 'critical' },
      'broadcasts.audience_import.attach_broadcast_id_failed',
    );
    let idLanded: boolean | null = null;
    try {
      const readBack = await deps.broadcastsRepo.findById(deps.tenant.slug, input.broadcastId);
      idLanded = readBack?.resendBroadcastId === resendBroadcastId;
    } catch (readErr) {
      logger.warn({ ...ids, err: errKind(readErr) }, 'broadcasts.audience_import.persist_read_back_failed_resource_kept');
    }
    if (idLanded === false) {
      await reclaim('persist_failed');
    } else if (idLanded === true) {
      logger.warn(ids, 'broadcasts.audience_import.persist_ack_lost_id_kept');
    }
    return err({
      kind: 'dispatch.server_error',
      message: persistFailureKind,
      errClass: errKind(persistErr),
      phase: 'persist_broadcast_id',
    });
  }
}

/** What the post-send writes need to know about the send they record. */
interface SendHandOff {
  readonly resendBroadcastId: string;
  readonly audienceId: string;
  /** `null` for a legacy-leg carry-over the probe found already sent. */
  readonly importId: string | null;
  readonly recipientCount: number;
  /** `null` when nothing resolved the audience on this tick (the handed path). */
  readonly orphanCount: number | null;
  readonly droppedByPreference: number | null;
  /** Set when an EARLIER tick handed the send to Resend (the probe said so). */
  readonly handedOnPriorTick: {
    readonly status: 'queued' | 'sending' | 'sent';
    readonly sentAt: string | null;
  } | null;
  /** What the probe answered, or `null` when nothing was probed / `not_found`. */
  readonly observedResendStatus: 'draft' | 'cancelled' | 'queued' | 'sending' | 'sent' | null;
}

/**
 * The post-send writes — reached from TWO places: right after THIS tick's
 * send (or its 409 replay), and from Step 1a when the probe found an earlier
 * tick's send already handed to Resend. Either way the provider has the mail,
 * so everything here is a record of a delivery, never a reason to undo one.
 */
async function advanceToSending(
  deps: BuildAudienceTickDeps,
  input: BuildAudienceTickInput,
  broadcast: Broadcast,
  now: Date,
  sent: SendHandOff,
): Promise<Result<BuildAudienceTickOutput, BuildAudienceTickError>> {
  const { resendBroadcastId, audienceId, importId, recipientCount } = sent;
  const handedOnPriorTick = sent.handedOnPriorTick !== null;
  // F119 PR-E (review M1) — the provider has the mail: nothing is left to
  // budget, so reset the FR-021 clock before the writes below that may fail.
  // A stamp surviving a delivered send would otherwise be inherited by any
  // later budgeted failure on the row; the probe's retryable throw is kept off
  // the clock for the same reason. Own tx, best-effort (never throws).
  await resetDispatchRetryClock(deps, input.broadcastId, 'broadcasts.audience_import.retry_clock_clear_failed');

  // ## Round 3 finding 3-6 — the cancel window, and why the ids ride their own tx
  //
  // Nothing holds a lock across the send. `lockForUpdate` takes
  // `pg_advisory_xact_lock`, but its tx commits at the top of the tick, before
  // every gateway call — so the window spans a `getContactImport` round trip, a
  // full `resolveRecipients` re-walk, `createBroadcast` and `sendBroadcast`
  // (each up to 6 `withRetry` attempts). `cancelBroadcast` accepts `approved`,
  // so an admin cancel can land inside it: the mail is out and the row says
  // `cancelled` — an unpleasant state no code here can undo.
  //
  // The broadcast id that makes the webhooks resolvable is already COMMITTED
  // by now — `persistBroadcastIdBeforeSend` wrote it before the send, and on
  // the handed path an earlier tick did. So `attachResendIds` below re-writes
  // values the row already holds (it has no CAS and sets the same pair, so it
  // is idempotent); it stays as the "row gone" detector and the parity write
  // the legacy leg makes. It keeps its OWN tx, separate from the transition:
  // when both shared one, a cancel made the transition match 0 rows, roll the
  // id write back with it and escape as `uncaught_error`, and every later
  // delivery / bounce / complaint webhook failed to resolve the broadcast.
  const idsAttached = await viaRepoConcurrency(input.broadcastId, () =>
    deps.broadcastsRepo.withTx(async (tx) => {
      await deps.broadcastsRepo.attachResendIds(
        tx,
        deps.tenant.slug,
        input.broadcastId,
        audienceId,
        resendBroadcastId,
      );
    }),
  );
  if (!idsAttached.ok) {
    // The row is gone (erasure cascade). The mail is out and there is nothing
    // left to attach it to — log at critical and let the cron count it a
    // concurrent skip rather than a programming fault.
    logger.error(
      {
        tenantId: deps.tenant.slug,
        broadcastId: input.broadcastId,
        resendBroadcastId,
        importId,
        severity: 'critical',
      },
      'broadcasts.audience_import.sent_but_row_unattachable',
    );
    return err(idsAttached.error);
  }

  const transitioned = await viaRepoConcurrency(input.broadcastId, () =>
    deps.broadcastsRepo.withTx(async (tx) => {
      await deps.broadcastsRepo.applyTransition(
        tx,
        deps.tenant.slug,
        input.broadcastId,
        'sending',
      // `estimatedRecipientCount` is re-stamped with the count actually sent to.
      // Without it the row keeps its SUBMIT-time estimate as its only durable
      // number, which can be days stale by the time a tick reads it. (On the
      // handed path that estimate IS the number in hand — see Step 1a.)
        { sendingStartedAt: now, estimatedRecipientCount: recipientCount },
        'approved',
      );
    }),
  );
  if (!transitioned.ok) {
    // A cancel (or another worker) won the race while the send was in flight.
    // The mail IS out and the ids ARE persisted, so webhooks still resolve and
    // bounces still reach the suppression list. Critical-severity log because a
    // delivered broadcast whose row says `cancelled` needs a human to reconcile
    // — but NOT `uncaught_error`, which would page on-call for a race the
    // system handled as well as it can be handled.
    logger.error(
      {
        tenantId: deps.tenant.slug,
        broadcastId: input.broadcastId,
        resendBroadcastId,
        importId,
        recipientCount,
        severity: 'critical',
      },
      'broadcasts.audience_import.sent_but_transition_lost',
    );
    return err(transitioned.error);
  }

  // Round 7 M-1 (the legacy leg's rule) — `now` is the send time only when
  // THIS tick sent. On the handed path the mail went out on an earlier tick,
  // and only `'sent'` carries a meaningful provider `sent_at` (`queued` /
  // `sending` are accepted, not yet gone). PARSED, not trusted: an unparseable
  // value would make `.toISOString()` throw, so it degrades to `null`. Unknown
  // send time means unknown delay.
  let actualSendAt: Date | null = now;
  if (sent.handedOnPriorTick !== null) {
    const { status, sentAt } = sent.handedOnPriorTick;
    const providerSentAt = status === 'sent' && sentAt !== null ? new Date(sentAt) : null;
    actualSendAt = providerSentAt !== null && !Number.isNaN(providerSentAt.getTime()) ? providerSentAt : null;
  }
  const delaySeconds =
    broadcast.scheduledFor !== null && broadcast.scheduledFor !== undefined && actualSendAt !== null
      ? Math.round((actualSendAt.getTime() - broadcast.scheduledFor.getTime()) / 1000)
      : null;

  // The Art. 30 record that N addresses were disclosed to a processor at a given
  // time. This path wrote NOTHING on success — the staff timeline jumped from
  // approve straight to the first delivery webhook, and the emission-site parity
  // guard could not see the gap because the legacy path still emits it. Same
  // event type and same payload shape as the legacy path on purpose: a reader
  // comparing before and after a flag move wants the two indistinguishable.
  //
  // **Round 3 finding 3-8 — this INSERT used to run inside the transaction
  // above, through `safeAuditEmit`, which swallows.** `withTx` is a real
  // `db.transaction` on postgres.js, so a failed INSERT leaves the transaction
  // in 25P02: the swallow let the callback resolve, COMMIT returned a ROLLBACK
  // tag Drizzle does not inspect, and `attachResendIds` + the transition to
  // `sending` were silently discarded while this function returned
  // `ok({kind:'sent'})` — after the mail had gone out. The next tick then found
  // the row still `approved` and sent the whole broadcast again.
  //
  // It is NOT moved into the tx as a raw emit either (the rule stated at
  // `manage-image-allowlist.ts:122`, where a failed emit MUST tear the mutation
  // down). That rule is for a mutation nothing external has observed. Here the
  // mail is already delivered: rolling `sending` back to `approved` schedules a
  // SECOND send. Between losing an audit row and sending a chamber's whole list
  // twice, the audit row is the recoverable one — and its loss is logged and
  // counted rather than silent.
  //
  // Its own `withTx`, never `tx = null`: the adapter needs a tenant-bound
  // transaction, and a null tx would take a pool connection with no
  // `app.current_tenant` GUC, where RLS silently writes nothing.
  try {
    await deps.broadcastsRepo.withTx(async (tx) => {
      // RAW emit, not `safeAuditEmit`: this call site needs to KNOW whether the
      // row was written, because the counter below claims it was.
      await deps.audit.emit(tx, {
        eventType: 'broadcast_send_started',
        tenantId: deps.tenant.slug,
        actorUserId: 'system:cron',
        summary: `Broadcast ${input.broadcastId as unknown as string} sending to ${recipientCount} recipients`,
        payload: {
          broadcastId: input.broadcastId as unknown as string,
          resendAudienceId: audienceId,
          resendBroadcastId,
          recipientCount,
          importId,
          // The attribution the narrowed port used to discard. This is the
          // record that answers "why did this reach 40 people instead of 55?" —
          // a member question a previous review round added the fields for.
          // `null` on the handed path: nothing resolved them on this tick.
          orphanCount: sent.orphanCount,
          droppedByPreference: sent.droppedByPreference,
          sendingStartedAt: now.toISOString(),
          // S8 — the legacy payload's two replay fields: the row says for
          // itself whether THIS tick sent, and what Resend answered.
          handedToSendOnPriorTick: handedOnPriorTick,
          observedResendStatus: sent.observedResendStatus,
          // Round 3, below-cap sweep — AS1's spec-required fields, as on the
          // legacy payload (its E1 closure). `actualSendAt` is AS1's second
          // name for the send moment (`null` when an earlier tick sent and
          // Resend reports no `sent_at`), and `delaySeconds` answers "how late
          // did the cron fire" — `null` for a send-now row or an unknown time.
          scheduledFor: broadcast.scheduledFor?.toISOString() ?? null,
          actualSendAt: actualSendAt === null ? null : actualSendAt.toISOString(),
          delaySeconds,
        },
        requestId: null,
      });
    });
    // Only now. Round 3's second half of 3-8: this counter fired
    // UNCONDITIONALLY on the next line, so whenever the swallow ate a failed
    // INSERT the audit-volume series still reported a row that did not exist,
    // while `audit_emit_failed` reported the loss on a DIFFERENT series. The
    // extraction had quietly changed this metric's meaning from "rows written"
    // to "emits attempted".
    broadcastsMetrics.auditEmitCount(deps.tenant.slug, 'broadcast_send_started');
  } catch (auditErr) {
    // A wiring bug must still surface — the fail-soft envelope is for transient
    // storage hiccups (`_safe-audit-emit.ts` draws the same line).
    if (auditErr instanceof AuditPortInvariantError) throw auditErr;
    logger.error(
      {
        err: errKind(auditErr),
        tenantId: deps.tenant.slug,
        broadcastId: input.broadcastId,
        resendBroadcastId,
        importId,
        recipientCount,
        severity: 'critical',
      },
      'broadcasts.audience_import.send_record_lost',
    );
    broadcastsMetrics.auditEmitFailed('broadcast_send_started', deps.tenant.slug);
  }

  // ## Round 3 finding 3-9 — the completion stamp goes HERE, after the send
  //
  // It used to commit in its own transaction BEFORE `createBroadcast`, so it
  // certified work that had not happened yet. A retryable failure on
  // `createBroadcast` or `sendBroadcast` then left the row `approved` WITH
  // `audience_import_completed_at` set, and that combination is invisible to
  // both operator predicates: the T106 gauge
  // (`broadcasts-gauges/route.ts`) and the documented flag-rollback drain
  // (`feature-flags.ts`) are the same shape and both require
  // `audience_import_completed_at IS NULL`.
  //
  // So an operator following the runbook's drain query saw ZERO rows in flight,
  // flipped the flag off, and handed the row to `dispatchScheduledBroadcast` —
  // which never reads `audience_import_*` but DOES reuse `resend_audience_id`.
  // That is the "deliver to a half-built audience" outcome the runbook warns
  // about, reached BY FOLLOWING the runbook.
  //
  // Stamping after the transition makes the column mean what both predicates
  // assume: this import has been consumed, and the row is no longer claimable.
  // Best-effort — the send has happened and the row already says `sending`, so a
  // failure here is an observability loss, not a delivery one, and must not be
  // reported as a dispatch failure. Skipped for a legacy-leg carry-over: there
  // is no import to have consumed.
  if (importId !== null) {
    try {
      await deps.broadcastsRepo.withTx(async (tx) => {
        await deps.broadcastsRepo.markAudienceImportCompleted(
          tx,
          deps.tenant.slug,
          input.broadcastId,
        );
      });
    } catch (stampErr) {
      logger.error(
        {
          err: errKind(stampErr),
          tenantId: deps.tenant.slug,
          broadcastId: input.broadcastId,
          importId,
        },
        'broadcasts.audience_import.completion_stamp_failed',
      );
    }
  }

  // Throughput. Without it the dispatch dashboard reads zero sends while sends
  // are happening.
  broadcastsMetrics.cronDispatchedCount(deps.tenant.slug);

  // AS5 / T171 — best-effort, outside the send tx, exactly as the legacy path
  // does it. The broadcast still goes out (that is the AS5 decision); what this
  // adds is evidence, so an admin auditing "this member sent an E-Blast as if
  // they still held the lower tier" finds something on the record.
  await emitExpiredPlanAuditIfApplicable({ deps, broadcast });

  logger.info(
    {
      tenantId: deps.tenant.slug,
      broadcastId: input.broadcastId,
      importId,
      recipientCount,
      handedToSendOnPriorTick: handedOnPriorTick,
    },
    'broadcasts.audience_import.sent',
  );

  return ok({ kind: 'sent', resendBroadcastId, recipientCount });
}

/**
 * A terminal import failure: the row moves to `failed_to_dispatch` so it is not
 * re-polled forever, and the reason survives in the audit trail. Deliberately
 * NOT a retry — every reason here is a statement about a job that already
 * finished, and re-polling it produces the same answer.
 */
async function failTerminally(
  deps: BuildAudienceTickDeps,
  input: BuildAudienceTickInput,
  broadcast: Broadcast,
  error: Extract<
    BuildAudienceTickError,
    { kind: 'audience_import_failed' } | { kind: 'audience_import_stuck' }
  >,
  /**
   * Round 3 finding 3-3. Two of the four gateway kinds are not "this broadcast
   * failed" in the sense the member email describes, and one of them needs its
   * own event type so an operator grouping the audit log can see it at all.
   *
   * Defaults reproduce the previous behaviour exactly, so every existing caller
   * is unchanged.
   */
  opts: {
    readonly auditEventType?: 'broadcast_failed_to_dispatch' | 'broadcast_resend_resource_missing';
    readonly notifyMember?: boolean;
    /** Round 3 finding 3-12 — see `importReasonToFailureMetric`. */
    readonly failureMetric?: FailureMetricLabel;
    /**
     * F119 PR-A — a second audit row that must commit WITH the terminal
     * transition or not at all (the standing refusal's own event). Written in
     * the same tx: separately, a lost transition (a concurrent cancel won)
     * would still leave a refusal row for a broadcast that was cancelled.
     */
    readonly extraAudit?: AuditEmitInput;
    /**
     * Round 4 F5 — set on the 404 path so the RETURNED kind is
     * `broadcast_resend_resource_missing` and the cron buckets it the way the
     * legacy leg does. The recorded terminal state, the audit event and the
     * suppressed member email are unchanged; this only stops the cron reporting
     * an account problem as `permanent_failed`.
     */
    readonly resourceMissing?: {
      readonly resourceType: 'audience' | 'broadcast' | 'import';
      readonly resourceId: string;
    };
  } = {},
): Promise<Result<BuildAudienceTickOutput, BuildAudienceTickError>> {
  const auditEventType = opts.auditEventType ?? 'broadcast_failed_to_dispatch';
  const notifyMember = opts.notifyMember ?? true;
  const now = deps.clock.now();
  const reason =
    error.kind === 'audience_import_failed' ? error.reason : 'audience_import_stuck';
  // `ageMs` is Infinity for the impossible `(import_id set, submitted_at NULL)`
  // row. JSON.stringify turns Infinity into `null`, so normalise here rather
  // than writing a silently-null number into an append-only payload.
  const ageMsOrNull =
    error.kind === 'audience_import_stuck' && Number.isFinite(error.ageMs)
      ? error.ageMs
      : null;

  logger.error(
    {
      tenantId: deps.tenant.slug,
      broadcastId: input.broadcastId,
      importId: error.importId,
      errorKind: error.kind,
      // NOT `reason` (round 3 finding 3-12). `'reason'` and `'*.reason'` are in
      // `logger.ts` REDACT_PATHS, deliberately broad because a Stripe SDK error
      // spreads free text into that key — so this line printed
      // `reason:"[REDACTED]"` and the taxonomy reached no surface a human
      // watches. The remedy is the one that file prescribes: "Operational
      // `reason` fields that are genuinely safe to display should be renamed to
      // a non-`reason` key (e.g. `dispatchFailureKind` already used in the
      // webhook route)." This value is a CLOSED UNION — no free text, no PII,
      // nothing to redact, which is what makes the rename safe here and unsafe
      // on the legacy leg, where the same key carries `e.message` (round 4 L3).
      //
      // Round 4 D8 — the count is deliberately not written here any more. It
      // said "nine" while the union held 13, then F3 deleted one and it is 12;
      // a number restated beside its own definition is a number that will
      // disagree with it. `MEMBER_FACING_FAILURE_REASONS` is the count, and
      // `broadcast-failed-to-dispatch-email.test.ts` iterates it rather than a
      // copy, so adding a member without its three locales fails a test.
      dispatchFailureKind: reason,
      observed: error.kind === 'audience_import_failed' ? error.observed : ageMsOrNull,
      expected: error.kind === 'audience_import_failed' ? error.expected : IMPORT_STUCK_AFTER_MS,
    },
    'broadcasts.audience_import.failed',
  );

  try {
    await deps.broadcastsRepo.withTx(async (tx) => {
      await deps.broadcastsRepo.applyTransition(
        tx,
        deps.tenant.slug,
        input.broadcastId,
        'failed_to_dispatch',
        // `failureReason` was missing, so all four reasons landed as NULL and the
        // FR-021 email — which renders it — had nothing to say. The reason existed
        // only inside an audit payload and a pino line.
        { failedToDispatchAt: now, failureReason: reason },
        'approved',
      );
      // RAW emit, not `safeAuditEmit` — the opposite call from the send path
      // above, for the opposite reason (round 3 finding 3-8). NOTHING has been
      // sent here, so a terminal state without its audit row is the worse
      // outcome: `safeAuditEmit` swallowed the failure, the aborted tx committed
      // as a rollback, the transition was discarded, and the member was emailed
      // that their broadcast failed while the row sat `approved`. A throw now
      // reaches the catch below, which reports `terminal_write_failed` and tells
      // nobody anything.
      await deps.audit.emit(tx, {
        eventType: auditEventType,
        tenantId: deps.tenant.slug,
        // The cron is the actor. `system:cron` is the same literal the
        // single-tick path stamps, so the two paths are indistinguishable in the
        // audit trail — which is what a reader wants when the flag has moved.
        actorUserId: 'system:cron',
        summary: `Broadcast ${input.broadcastId as unknown as string} audience import failed (${reason})`,
        payload: {
          broadcastId: input.broadcastId as unknown as string,
          importId: error.importId,
          reason,
          failedAt: now.toISOString(),
        },
        requestId: null,
      });
      if (opts.extraAudit !== undefined) {
        await deps.audit.emit(tx, opts.extraAudit);
      }
    });
  } catch (cleanupErr) {
    // Mirrors the single-tick path: if the transition itself failed, a concurrent
    // cancel probably won. Log loudly and do NOT notify — telling a member their
    // broadcast failed when it was cancelled is worse than silence.
    logger.error(
      {
        err: errKind(cleanupErr),
        tenantId: deps.tenant.slug,
        broadcastId: input.broadcastId,
        dispatchFailureKind: reason,
      },
      'broadcasts.audience_import.cleanup_failed',
    );
    // Round 3 finding 3-15 — this used to return `err(error)`, i.e. the SAME
    // value as the success path below, so no caller could tell a recorded
    // terminal state from one that never committed. The cron counts every
    // terminal kind as `permanent_failed` — the bucket meaning "finished,
    // nothing left to do", so no alert fires — while the row was still
    // `approved` and re-refused every five minutes.
    //
    // `dispatch.server_error` is the honest answer: the write did not land, the
    // row is where it was, and the next tick should try again. If a concurrent
    // cancel is what actually won, that next tick reads a non-`approved` status
    // and reports `concurrent_skip`, which costs one wasted poll and lies to
    // nobody.
    return err({
      kind: 'dispatch.server_error',
      message: 'terminal_write_failed',
      phase: 'terminal_write',
    });
  }

  // Counted only once the tx has COMMITTED (F119 PR-A R4). These sat inside
  // it, before the standing refusal's own audit INSERT, so a refusal whose
  // second row failed — rolling the whole tx back — still counted a failure
  // and an audit row that never existed.
  //
  // Without the failure count the failure rate reads 0 through a total outage
  // and the dispatch dashboard shows nothing happening while broadcasts die.
  //
  // Round 4 F6 — GATED on the audit event type, which is what the legacy leg
  // does (`dispatch-scheduled-broadcast.ts`: `if (eventType ===
  // 'broadcast_failed_to_dispatch')`). Emitting unconditionally counted a
  // Resend 404 toward `broadcasts.failed_to_dispatch.count` on this leg while
  // the other leg deliberately excludes it, so the § 22.3 alert on that
  // series (>10% over send_started) changed meaning at a flag flip. A flag
  // flip must not redefine an alert.
  if (auditEventType === 'broadcast_failed_to_dispatch') {
    broadcastsMetrics.failedToDispatchCount(
      deps.tenant.slug,
      opts.failureMetric ?? importReasonToFailureMetric(reason, undefined),
    );
  }
  broadcastsMetrics.auditEmitCount(deps.tenant.slug, auditEventType);
  if (opts.extraAudit !== undefined) {
    broadcastsMetrics.auditEmitCount(deps.tenant.slug, opts.extraAudit.eventType);
  }

  // FR-021 / AS2, after the tx commits. Best-effort by design — a bounced
  // notification must not roll back a recorded terminal state.
  //
  // Suppressed for `resource_missing`: the legacy path states the rule as
  // "resource_missing is an ops-side issue requiring admin action, not member
  // notification", and telling a member their E-Blast failed for a reason they
  // cannot act on is worse than silence — the same judgement the cleanup-failed
  // branch above already makes.
  if (notifyMember) {
    await enqueueDispatchFailureNotification({ deps, broadcast, reason, now });
  }

  // Round 4 F5 — the recorded state is the same either way; only the kind the
  // CRON reads differs, so it can bucket an account problem as such.
  return err(
    opts.resourceMissing === undefined
      ? error
      : {
          kind: 'broadcast_resend_resource_missing',
          resourceType: opts.resourceMissing.resourceType,
          resourceId: opts.resourceMissing.resourceId,
        },
  );
}

/**
 * A resolver refusal is a DECISION, not something to hand upward untouched.
 *
 * The cron counts `too_large` and `post_suppression_empty` as `permanent_failed`
 * under a comment stating this use case has already moved the row and audited
 * it. That was false for both: they returned a bare `err(...)`, the row stayed
 * `approved`, and it was re-claimed every tick for ever while the counter that
 * means "finished, nothing to do" ticked up beside it — so no alert could fire.
 *
 * `malformed_segment` is the third: it fell through to `dispatch.server_error`,
 * which the cron classifies as transient. The single-tick path made exactly this
 * terminal on 2026-09-07 with a comment naming the symptom, and this file's own
 * comment claimed parity with it while doing the opposite.
 */
async function onResolveFailure(
  deps: BuildAudienceTickDeps,
  input: BuildAudienceTickInput,
  broadcast: Broadcast,
  e: ResolveAudienceError,
): Promise<Result<BuildAudienceTickOutput, BuildAudienceTickError>> {
  const mapped = mapResolveError(e);

  if (
    mapped.kind === 'broadcast_audience_too_large' ||
    mapped.kind === 'broadcast_audience_post_suppression_empty'
  ) {
    // Keep the caller-visible KIND — the cron's switch and its alerts read it —
    // but make the STATE terminal and leave a trail on the way out. The audit
    // reason names the actual cause; routing both through one reason would put a
    // sentence in an append-only row that is not true of the broadcast.
    const terminal = await failTerminally(deps, input, broadcast, {
      kind: 'audience_import_failed',
      reason:
        mapped.kind === 'broadcast_audience_too_large'
          ? 'audience_too_large'
          : 'audience_post_suppression_empty',
      importId: broadcast.audienceImportId,
      observed: mapped.kind === 'broadcast_audience_too_large' ? mapped.count : null,
      expected: mapped.kind === 'broadcast_audience_too_large' ? mapped.cap : null,
    });
    // Round 3 finding 3-15 — this used to `await failTerminally(...)` and DISCARD
    // its Result while the `malformed_segment` arm below `return`ed it: two arms
    // of one function disagreeing about whether the terminal write may fail
    // silently. When it fails (a serialization failure, a statement timeout, an
    // aborted audit INSERT) `failTerminally` logs `cleanup_failed` and returns
    // `err`. Discarding that reported `broadcast_audience_too_large` anyway,
    // which the cron counts as `permanent_failed` — the bucket meaning "finished,
    // nothing left to do", so no alert can fire — while the row was still
    // `approved` and re-refused every five minutes.
    //
    // The caller-visible kind is still `mapped` on SUCCESS, because the cron's
    // arms and alerts read it; only a FAILED terminal write now surfaces as
    // itself.
    if (!terminal.ok && terminal.error.kind === 'dispatch.server_error') return terminal;
    return err(mapped);
  }

  if (e.kind === 'malformed_segment') {
    return failTerminally(deps, input, broadcast, {
      kind: 'audience_import_failed',
      reason: 'malformed_segment',
      importId: broadcast.audienceImportId,
      observed: null,
      expected: null,
    });
  }

  // Everything else — a members-bridge throw, Neon, RLS — is genuinely
  // transient. The row stays `approved` and the next tick retries.
  //
  // **Round 4 F3 — the FR-021 budget was extended to cover THIS path in round 3
  // (finding 3-7) and that extension is deleted here, not repaired.** Three
  // reasons, in order of weight:
  //
  //  1. It killed broadcasts that had never failed twice. `budgetEpoch` is
  //     `scheduledFor ?? approvedAt ?? createdAt` — it measures from the EPOCH,
  //     not from the first failure, and there is no consecutive-failure counter.
  //     An `approved` row more than an hour past its epoch (cron paused, a late
  //     approval, the flag enabled retroactively — and setting the env var on
  //     this repo IS a production deploy, so cold starts cluster exactly there)
  //     died on its FIRST `resolve.server_error`, with a member email and a
  //     paging metric, never having had a second attempt.
  //  2. It forked the two legs. `dispatchScheduledBroadcast` deliberately does
  //     not budget resolve failures (`route.ts`: "the counter is the alarm"),
  //     so the same fault became terminal on one leg and retryable on the other
  //     — decided by a flag, which is what a flag flip must never change.
  //  3. Its terminal record blamed the wrong party. One reason and one metric
  //     sub-kind covered both the provider refusing and Neon refusing.
  //
  // What 3-7 correctly identified — "transient without a bound is how a
  // broadcast sits `approved` for ever with nobody told" — is real and is NOT
  // closed by this. It is answered the way the live leg answers it:
  // `broadcasts.dispatch_resolve_failed.total` alarms at >0 sustained 15 min,
  // and since round 4 L4 both legs also log `cron.broadcasts.dispatch
  // .server_error` with a bounded `errClass`. F119 PR-E (0311) added the
  // first-failure anchor that reason 1 asked for, but only the GATEWAY budget
  // reads it: reasons 2 and 3 still hold for a resolver fault (the legs would
  // fork, and the member email names the provider), so this stays unbudgeted.
  return err(mapped);
}

/**
 * The resolver's refusals keep the meaning they already have. `too_large` and
 * `post_suppression_empty` are facts about the audience, not about how it is
 * pushed, so the cron's existing arms and alerts keep working unchanged.
 */
function mapResolveError(e: ResolveAudienceError): BuildAudienceTickError {
  switch (e.kind) {
    case 'broadcast_audience_too_large':
      return { kind: 'broadcast_audience_too_large', count: e.count, cap: e.cap };
    case 'broadcast_empty_segment_blocked':
      // The resolver's INPUT kind maps to the legacy path's OUTPUT kind on
      // purpose: the cron's switch and its alerts read the latter, and forking
      // them would fork the alerting for no gain. What was wrong before was
      // comparing the input against the output.
      return { kind: 'broadcast_audience_post_suppression_empty' };
    case 'resolve.server_error':
      // Round 4 L3 — forward the class alongside the message. The message is
      // redacted in logs; the class is what the cron can actually print.
      return {
        kind: 'dispatch.server_error',
        message: e.message,
        ...(e.errClass === undefined ? {} : { errClass: e.errClass }),
        phase: 'resolve',
      };
    case 'malformed_segment':
      return { kind: 'dispatch.server_error', message: 'malformed_segment', phase: 'resolve' };
    default: {
      // `void`, never `return _exhaustive` — that idiom returns the VALUE at
      // runtime, which is truthy, so a genuinely new kind would be silently
      // treated as a real error object. The safe answer here is the transient
      // one: the row stays `approved` rather than reaching a terminal state
      // nobody chose.
      //
      // Round 4 F11 — this used to add "and a human sees the unrouted kind in
      // the cron's `unknown_error` log". Neither half was true.
      // `dispatch.server_error` lands in the cron's RETRYABLE arm, not
      // `unknown_error`, and the literal `'unrouted_resolve_error'` was logged
      // nowhere at all — a new resolver kind would have been invisible.
      //
      // It IS visible now, and by the route this comment should have named from
      // the start: round 4 L4 gave the retryable arm a log line, so an unrouted
      // kind surfaces as `cron.broadcasts.dispatch.server_error` with
      // `errClass: 'unclassified'`, and `dispatch_resolve_failed.total` alarms
      // if it persists. (The claim about the FR-021 budget turning this terminal
      // after an hour went with the resolve-side budget in F3.)
      const _exhaustive: never = e;
      void _exhaustive;
      return { kind: 'dispatch.server_error', message: 'unrouted_resolve_error', phase: 'resolve' };
    }
  }
}
