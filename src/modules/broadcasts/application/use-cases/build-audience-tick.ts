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
import { safeAuditEmit } from './_safe-audit-emit';
import type { TenantContext } from '@/modules/tenants';
import type { Broadcast, BroadcastId } from '../../domain/broadcast';
import type { AuditPort } from '../ports/audit-port';
import type { BroadcastsGatewayPort } from '../ports/broadcasts-gateway-port';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import type { ClockPort } from '../ports/clock-port';

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

export type ImportFailureReason = 'failed_rows' | 'counts_incoherent' | 'count_mismatch';

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
      readonly importId: string;
      readonly observed: number;
      readonly expected: number;
    }
  | { readonly kind: 'audience_import_stuck'; readonly importId: string; readonly ageMs: number }
  | { readonly kind: 'dispatch.server_error'; readonly message: string };

/** What the resolver answers, narrowed to what this use case reads. */
export interface ResolvedAudience {
  readonly recipients: readonly string[];
  readonly estimatedCount: number;
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

/** Tick 1 — hand the audience over. Sends nothing. */
async function submitImport(
  deps: BuildAudienceTickDeps,
  input: BuildAudienceTickInput,
  broadcast: Broadcast,
): Promise<Result<BuildAudienceTickOutput, BuildAudienceTickError>> {
  const resolved = await deps.resolveRecipients(broadcast);
  if (!resolved.ok) return err(mapResolveError(resolved.error));

  // Orphan-audience prevention, the same rule the single-tick path follows: a
  // retry after a downstream failure must REUSE the audience a previous attempt
  // created. On Resend Free three audiences is the entire allowance, and a
  // leaked one is not reclaimed until `cleanup-audiences` reaps it.
  let audienceId = broadcast.resendAudienceId ?? '';
  if (audienceId === '') {
    const created = await deps.broadcastsGateway.createAudience(
      `broadcast-${deps.tenant.slug}-${input.broadcastId as unknown as string}`,
    );
    audienceId = created.audienceId;
    await deps.broadcastsRepo.withTx(async (tx) => {
      await deps.broadcastsRepo.attachAudienceId(tx, deps.tenant.slug, input.broadcastId, audienceId);
    });
  }

  const submitted = await deps.broadcastsGateway.createContactImport(
    audienceId,
    resolved.value.recipients,
  );

  await deps.broadcastsRepo.withTx(async (tx) => {
    await deps.broadcastsRepo.attachAudienceImport(
      tx,
      deps.tenant.slug,
      input.broadcastId,
      submitted.importId,
    );
  });

  logger.info(
    {
      tenantId: deps.tenant.slug,
      broadcastId: input.broadcastId,
      importId: submitted.importId,
      recipientCount: resolved.value.recipients.length,
    },
    'broadcasts.audience_import.submitted',
  );

  return ok({
    kind: 'import_submitted',
    importId: submitted.importId,
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
  const job = await deps.broadcastsGateway.getContactImport(importId);

  if (job.status !== 'completed') {
    const submittedAt = broadcast.audienceImportSubmittedAt;
    const ageMs = submittedAt === null ? 0 : now.getTime() - submittedAt.getTime();
    if (ageMs > IMPORT_STUCK_AFTER_MS) {
      // Terminal rather than polled forever. The provider has had the job for
      // half an hour; a broadcast that keeps being re-polled with no signal is
      // indistinguishable from a healthy one until someone notices by hand.
      return failTerminally(deps, input, {
        kind: 'audience_import_stuck',
        importId,
        ageMs,
      });
    }
    return ok({ kind: 'import_pending', importId });
  }

  const { total, created, updated, skipped, failed } = job.counts;

  if (failed > 0) {
    return failTerminally(deps, input, {
      kind: 'audience_import_failed',
      reason: 'failed_rows',
      importId,
      observed: failed,
      expected: 0,
    });
  }

  const parts = created + updated + skipped;
  if (parts !== total) {
    return failTerminally(deps, input, {
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
  if (!resolved.ok) return err(mapResolveError(resolved.error));
  const resolvedCount = resolved.value.recipients.length;

  if (total !== resolvedCount) {
    // Covers the measured `completed / failed:0 / total:0` case, which reads as
    // success on `status` alone and would send to an empty audience.
    return failTerminally(deps, input, {
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
  const rb = await deps.broadcastsGateway.createBroadcast({
    audienceId,
    subject: broadcast.subject,
    htmlBody: broadcast.bodyHtml,
    fromName: broadcast.fromName,
    fromEmail: deps.fromEmail,
    replyToEmail: broadcast.replyToEmail,
    broadcastNameForResendDashboard: `${deps.tenantDisplayName} — ${broadcast.subject}`,
    tenantDisplayName: deps.tenantDisplayName,
    locale: deps.locale,
  });
  // Same idempotency key shape the single-tick path uses, so a replayed tick
  // cannot double-send: Resend rejects the second call with a 409 the caller
  // already knows how to read.
  await deps.broadcastsGateway.sendBroadcast(
    rb.broadcastId,
    `broadcast-${deps.tenant.slug}-${input.broadcastId as unknown as string}`,
  );

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
      { sendingStartedAt: now },
      'approved',
    );
  });

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
  error: Extract<
    BuildAudienceTickError,
    { kind: 'audience_import_failed' } | { kind: 'audience_import_stuck' }
  >,
): Promise<Result<BuildAudienceTickOutput, BuildAudienceTickError>> {
  const now = deps.clock.now();
  logger.error(
    {
      tenantId: deps.tenant.slug,
      broadcastId: input.broadcastId,
      importId: error.importId,
      errorKind: error.kind,
      reason: error.kind === 'audience_import_failed' ? error.reason : 'stuck',
      observed: error.kind === 'audience_import_failed' ? error.observed : error.ageMs,
      expected: error.kind === 'audience_import_failed' ? error.expected : IMPORT_STUCK_AFTER_MS,
    },
    'broadcasts.audience_import.failed',
  );

  await deps.broadcastsRepo.withTx(async (tx) => {
    await deps.broadcastsRepo.applyTransition(
      tx,
      deps.tenant.slug,
      input.broadcastId,
      'failed_to_dispatch',
      { failedToDispatchAt: now },
      'approved',
    );
    const reason =
      error.kind === 'audience_import_failed' ? error.reason : 'audience_import_stuck';
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
  });

  return err(error);
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
