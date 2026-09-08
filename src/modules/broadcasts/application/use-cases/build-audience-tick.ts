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
import { logger } from '@/lib/logger';
import { broadcastsMetrics } from '@/lib/metrics';
import { safeAuditEmit } from './_safe-audit-emit';
import { classifyThrown, isRetryableThrow } from './_classify-thrown';
import { enqueueDispatchFailureNotification } from './_enqueue-dispatch-failure-notification';
import { emitExpiredPlanAuditIfApplicable } from './_expired-plan-audit';
import type { TenantContext } from '@/modules/tenants';
import type { Broadcast, BroadcastId } from '../../domain/broadcast';
import type { AuditPort } from '../ports/audit-port';
import type { BroadcastsGatewayPort } from '../ports/broadcasts-gateway-port';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import type { ClockPort } from '../ports/clock-port';
import type { MembersBridgePort } from '../ports/members-bridge-port';
import type { PlansBridgePort } from '../ports/plans-bridge-port';
import type { EmailTransactionalPort } from '../ports/email-transactional-port';
import type { ResolvedOrphan } from './resolve-segment-recipients';

/**
 * FR-044 (f). Measured from the SUBMIT, not from `scheduled_for`: a broadcast
 * can sit approved for hours before a tick picks it up, and the question here
 * is only "has the provider taken too long with the job we gave it".
 */
export const IMPORT_STUCK_AFTER_MS = 30 * 60 * 1_000;

export type BuildAudienceTickOutput =
  | { readonly kind: 'import_submitted'; readonly importId: string; readonly recipientCount: number }
  | { readonly kind: 'import_pending'; readonly importId: string }
  | { readonly kind: 'sent'; readonly resendBroadcastId: string; readonly recipientCount: number };

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
export type ImportFailureReason =
  | 'failed_rows'
  | 'counts_incoherent'
  | 'count_mismatch'
  /** The provider itself reported the job failed — do not wait out the 30 min. */
  | 'provider_failed'
  /** A 4xx from Resend. The measured instance is the Free plan's contact cap. */
  | 'gateway_permanent'
  /** A throw carrying no `kind`: not a gateway error, a programming fault. */
  | 'gateway_unknown'
  /** The row's own `segment_params` cannot be parsed. Retrying cannot fix data. */
  | 'malformed_segment'
  /** The audience grew past the accepted ceiling between submit and this tick. */
  | 'audience_too_large'
  /** Everyone in the audience is suppressed or opted out — nothing to send to. */
  | 'audience_post_suppression_empty';

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
  | { readonly kind: 'dispatch.server_error'; readonly message: string };

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

export type ResolveAudienceError =
  | { readonly kind: 'broadcast_audience_too_large'; readonly count: number; readonly cap: number }
  | { readonly kind: 'broadcast_audience_post_suppression_empty' }
  | { readonly kind: string };

export interface BuildAudienceTickDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: BroadcastsRepo;
  readonly broadcastsGateway: BroadcastsGatewayPort;
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

  return broadcast.audienceImportId === null
    ? submitImport(deps, input, broadcast)
    : confirmImport(deps, input, broadcast, broadcast.audienceImportId, now);
}

/**
 * A classified gateway outcome. `retryable` is the adapter's own word for
 * 5xx / 429 / network; everything else is a statement that the next tick gets
 * the same answer.
 */
type GatewayFailure =
  | { readonly retryable: true; readonly message: string }
  | {
      readonly retryable: false;
      readonly reason: Extract<ImportFailureReason, 'gateway_permanent' | 'gateway_unknown'>;
      readonly message: string;
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
    if (isRetryableThrow(shape.kind)) return err({ retryable: true, message });
    return err({
      retryable: false,
      // `unknown` means the throw carried no `kind` at all — not a gateway
      // error but a fault in our own code. Kept distinct in the audit row so an
      // operator is not sent to look at Resend's status page for our bug.
      reason: shape.kind === 'unknown' ? 'gateway_unknown' : 'gateway_permanent',
      message,
    });
  }
}

/** Route a classified gateway failure: retry next tick, or stop for good. */
async function onGatewayFailure(
  deps: BuildAudienceTickDeps,
  input: BuildAudienceTickInput,
  broadcast: Broadcast,
  failure: GatewayFailure,
  importId: string | null,
): Promise<Result<BuildAudienceTickOutput, BuildAudienceTickError>> {
  if (failure.retryable) {
    return err({ kind: 'dispatch.server_error', message: failure.message });
  }
  return failTerminally(deps, input, broadcast, {
    kind: 'audience_import_failed',
    reason: failure.reason,
    importId,
    observed: null,
    expected: null,
  });
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
    await deps.broadcastsRepo.withTx(async (tx) => {
      await deps.broadcastsRepo.attachAudienceId(tx, deps.tenant.slug, input.broadcastId, audienceId);
    });
  }

  const submitted = await viaGateway(() =>
    deps.broadcastsGateway.createContactImport(audienceId, resolved.value.recipients),
  );
  if (!submitted.ok) return onGatewayFailure(deps, input, broadcast, submitted.error, null);

  await deps.broadcastsRepo.withTx(async (tx) => {
    await deps.broadcastsRepo.attachAudienceImport(
      tx,
      deps.tenant.slug,
      input.broadcastId,
      submitted.value.importId,
    );
  });

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
): Promise<Result<BuildAudienceTickOutput, BuildAudienceTickError>> {
  const polled = await viaGateway(() => deps.broadcastsGateway.getContactImport(importId));
  if (!polled.ok) return onGatewayFailure(deps, input, broadcast, polled.error, importId);
  const job = polled.value;

  if (job.status !== 'completed') {
    // The provider's own verdict, which used to be thrown away: anything that
    // was not `completed` was treated as "still working". An explicit `failed`
    // was therefore polled for another 29 minutes and then recorded as `stuck` —
    // the wrong cause, in an append-only table.
    if (job.status === 'failed' || job.status === 'canceled') {
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
    // FAIL CLOSED. `0298`'s coherence CHECK is an implication rather than an
    // iff, so it admits `(import_id set, submitted_at NULL)`. That row used to
    // compute `ageMs = 0` — never older than the threshold — while the stuck
    // gauge could not see it either, because `NULL < now() - interval` is false.
    // Invisible in both places at once. A state that cannot legally exist is
    // stuck by definition, not brand new.
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

  await deps.broadcastsRepo.withTx(async (tx) => {
    await deps.broadcastsRepo.markAudienceImportCompleted(tx, deps.tenant.slug, input.broadcastId);
  });

  const audienceId = broadcast.resendAudienceId ?? '';
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
    }),
  );
  if (!createdRb.ok) return onGatewayFailure(deps, input, broadcast, createdRb.error, importId);
  const rb = createdRb.value;

  // Same idempotency key shape the single-tick path uses, so a replayed tick
  // cannot double-send: Resend rejects the second call with a 409.
  //
  // ⚠️ KNOWN GAP, tracked as S8 in reviews/review-20260908-223000.md and
  // deliberately NOT closed here. Nothing in this file reads
  // `audience_import_completed_at` as a guard, and there is no
  // `idempotency_conflict` replay arm, so a crash between this call and the tx
  // below leaves the row `approved` with the mail already out. Persisting the
  // Resend broadcast id BEFORE the send changes the two-tick contract and
  // deserves its own review round rather than riding along with this one.
  const sent = await viaGateway(() =>
    deps.broadcastsGateway.sendBroadcast(
      rb.broadcastId,
      `broadcast-${deps.tenant.slug}-${input.broadcastId as unknown as string}`,
    ),
  );
  if (!sent.ok) return onGatewayFailure(deps, input, broadcast, sent.error, importId);

  await deps.broadcastsRepo.withTx(async (tx) => {
    await deps.broadcastsRepo.attachResendIds(
      tx,
      deps.tenant.slug,
      input.broadcastId,
      audienceId,
      rb.broadcastId,
    );
    await deps.broadcastsRepo.applyTransition(
      tx,
      deps.tenant.slug,
      input.broadcastId,
      'sending',
      // `estimatedRecipientCount` is re-stamped with the count actually sent to.
      // Without it the row keeps its SUBMIT-time estimate as its only durable
      // number, which can be days stale by the time a tick reads it.
      { sendingStartedAt: now, estimatedRecipientCount: resolvedCount },
      'approved',
    );
    // The Art. 30 record that N addresses were disclosed to a processor at a
    // given time. This path wrote NOTHING on success — the staff timeline jumped
    // from approve straight to the first delivery webhook, and the emission-site
    // parity guard could not see the gap because the legacy path still emits it.
    // Same event type and same payload shape as the legacy path on purpose: a
    // reader comparing before and after a flag move wants the two
    // indistinguishable.
    await safeAuditEmit(deps.audit, tx, {
      eventType: 'broadcast_send_started',
      tenantId: deps.tenant.slug,
      actorUserId: 'system:cron',
      summary: `Broadcast ${input.broadcastId as unknown as string} sending to ${resolvedCount} recipients`,
      payload: {
        broadcastId: input.broadcastId as unknown as string,
        resendAudienceId: audienceId,
        resendBroadcastId: rb.broadcastId,
        recipientCount: resolvedCount,
        importId,
        // The attribution the narrowed port used to discard. This is the record
        // that answers "why did this reach 40 people instead of 55?" — a member
        // question a previous review round added the fields for.
        orphanCount: resolved.value.orphans.length,
        droppedByPreference: resolved.value.droppedByPreference,
        sendingStartedAt: now.toISOString(),
      },
      requestId: null,
    });
    broadcastsMetrics.auditEmitCount(deps.tenant.slug, 'broadcast_send_started');
  });

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
      recipientCount: resolvedCount,
    },
    'broadcasts.audience_import.sent',
  );

  return ok({ kind: 'sent', resendBroadcastId: rb.broadcastId, recipientCount: resolvedCount });
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
): Promise<Result<BuildAudienceTickOutput, BuildAudienceTickError>> {
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
      reason,
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
      await safeAuditEmit(deps.audit, tx, {
        eventType: 'broadcast_failed_to_dispatch',
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
      // Without these the failure rate reads 0 through a total outage and the
      // dispatch dashboard shows nothing happening while broadcasts die.
      broadcastsMetrics.failedToDispatchCount(deps.tenant.slug, 'app_error');
      broadcastsMetrics.auditEmitCount(deps.tenant.slug, 'broadcast_failed_to_dispatch');
    });
  } catch (cleanupErr) {
    // Mirrors the single-tick path: if the transition itself failed, a concurrent
    // cancel probably won. Log loudly and do NOT notify — telling a member their
    // broadcast failed when it was cancelled is worse than silence.
    logger.error(
      {
        err: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        tenantId: deps.tenant.slug,
        broadcastId: input.broadcastId,
        reason,
      },
      'broadcasts.audience_import.cleanup_failed',
    );
    return err(error);
  }

  // FR-021 / AS2, after the tx commits. Best-effort by design — a bounced
  // notification must not roll back a recorded terminal state.
  await enqueueDispatchFailureNotification({ deps, broadcast, reason, now });

  return err(error);
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
    await failTerminally(deps, input, broadcast, {
      kind: 'audience_import_failed',
      reason:
        mapped.kind === 'broadcast_audience_too_large'
          ? 'audience_too_large'
          : 'audience_post_suppression_empty',
      importId: broadcast.audienceImportId,
      observed: mapped.kind === 'broadcast_audience_too_large' ? mapped.count : null,
      expected: mapped.kind === 'broadcast_audience_too_large' ? mapped.cap : null,
    });
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
  return err(mapped);
}

/**
 * The resolver's refusals keep the meaning they already have. `too_large` and
 * `post_suppression_empty` are facts about the audience, not about how it is
 * pushed, so the cron's existing arms and alerts keep working unchanged.
 */
function mapResolveError(e: ResolveAudienceError): BuildAudienceTickError {
  if (e.kind === 'broadcast_audience_too_large') {
    const t = e as { count: number; cap: number };
    return { kind: 'broadcast_audience_too_large', count: t.count, cap: t.cap };
  }
  if (e.kind === 'broadcast_audience_post_suppression_empty') {
    return { kind: 'broadcast_audience_post_suppression_empty' };
  }
  return { kind: 'dispatch.server_error', message: e.kind };
}
