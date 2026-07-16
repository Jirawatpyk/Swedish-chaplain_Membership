/**
 * F8 Phase 4 Wave I2c · T088 — `dispatch-renewal-cycle` use-case.
 *
 * Daily cron entry per FR-010: iterate every active member's eligible
 * renewal cycle, run the per-cycle decision tree (`dispatchOneCycle`),
 * tally outcomes into a structured summary returned to the caller
 * (cron route handler at T104, Wave I5 / coordinator at T103).
 *
 * Idempotency (FR-011): re-running the cron the same day produces zero
 * new dispatches. Guaranteed by the unique
 * `renewal_reminder_events_idem_idx (tenant, cycle, step_id, year_in_cycle)`
 * primitive — `dispatchOneCycle` returns `skipped: 'already_sent'` on
 * replay.
 *
 * Performance budget (FR-017 / SC-005): per-tenant cron pass MUST
 * complete within 60 seconds for a tenant with up to 5,000 active
 * members. Cursor-paginated candidate fetch + per-cycle gateway calls
 * are the dominant cost; profile in Wave I8 integration tests.
 *
 * Companion surfaces (live in sibling files):
 *   - 24h retry-budget orchestration — `retry-failed-reminders.ts`
 *     (Pass 1 re-attempts + Pass 2 exhaustion + audit cycling).
 *   - `cron_dispatch_orchestrated` audit — emitted by the
 *     `/api/cron/renewals/dispatch-coordinator` route after fan-out;
 *     this use-case returns the summary metrics the coordinator
 *     aggregates per tenant.
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { renewalsTracer, withActiveSpan } from '@/lib/otel-tracer';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import {
  dispatchOneCycle,
  type DispatchContext,
  type SkipReason,
  SKIP_REASONS,
} from './_lib/dispatch-one-cycle';
import { dispatchDueTrackCycle } from './_lib/dispatch-due-track';

/**
 * F8 Phase 4 Wave I2e/F1 — bucket count for k-anonymity in span
 * attributes. Mirrors load-pipeline.ts bucketing so APM operators
 * can't infer per-tenant scale from exact counters.
 */
type CountBucket =
  | 'invalid'
  | '0_10'
  | '11_50'
  | '51_200'
  | '201_1000'
  | '1001+';
function bucketCount(n: number): CountBucket {
  if (!Number.isFinite(n) || n < 0) return 'invalid';
  if (n <= 10) return '0_10';
  if (n <= 50) return '11_50';
  if (n <= 200) return '51_200';
  if (n <= 1000) return '201_1000';
  return '1001+';
}

/**
 * Maximum negative offset across all 5 tier-bucket schedule policies.
 * Default 120 days mirrors the partnership tier T-120 step (the longest
 * lookback any policy has). The cron coordinator overrides this per
 * tenant when a tenant ships a custom schedule with a longer step.
 */
export const DEFAULT_MAX_OFFSET_DAYS = 120 as const;

/** Page size for the candidate fetch loop. Tunable per FR-017 budget. */
export const DEFAULT_PAGE_SIZE = 200 as const;

/**
 * Bounded concurrency for per-cycle dispatch within a page. Each
 * `dispatchOneCycle` call issues 1–3 SQL roundtrips (pause check +
 * idempotency insert + audit emit). Sequential dispatch on Neon
 * Singapore from a Vercel `sin1` function is ~30 ms/cycle, which
 * blows the FR-017 / SC-005 60s budget at 5,000 candidates without
 * fan-out.
 *
 * `Promise.all` over the whole page would saturate Neon's per-pool
 * connection slots and queue inside the postgres driver. A small
 * fan-out (10) keeps each candidate's tx short while letting the
 * cron amortise round-trip latency.
 *
 * The chosen `10` is the value where the SC-005 budget held with
 * headroom on the 5k benchmark; re-measure via
 * `tests/integration/perf/renewals-cron-5k.test.ts` (RUN_PERF=1)
 * after any infra change (Neon plan tier, page-size, region) and
 * re-tune if needed. Avoid pinning specific cold/warm timings here
 * — they rot every time the benchmark or seed shape changes.
 *
 * Safe under Constitution Principle VIII: each `runInTenant` opens
 * its own tx; concurrent emits to `audit_log` use independent INSERTs
 * (no shared serialisable conflicts). The unique idempotency primitive
 * on `renewal_reminder_events (tenant, cycle, step, year)` defends
 * against any duplicate dispatch even under concurrent retries.
 */
export const DISPATCH_CONCURRENCY = 10 as const;

export const dispatchRenewalCycleInputSchema = z.object({
  tenantId: z.string().min(1),
  correlationId: z.string().min(1),
  requestId: z.string().nullable().optional(),
  /** Override `now` for tests + replays. Default: real-time at call. */
  nowIso: z.string().datetime().optional(),
  /** Page size for the candidate fetch loop. */
  pageSize: z.number().int().min(1).max(1000).optional(),
  /** Max offset days the dispatcher considers (lookback bound). */
  maxOffsetDays: z.number().int().min(1).max(365).optional(),
});

export type DispatchRenewalCycleInput = z.infer<
  typeof dispatchRenewalCycleInputSchema
>;

export interface DispatchRenewalCycleSummary {
  readonly candidatesProcessed: number;
  readonly emailsSent: number;
  /**
   * 066 §3.2(2) — subset of `emailsSent` that were DUE-TRACK warnings
   * (`due+7.email` / `due+30.email`). Broken out so the cron JSON can
   * show the statutory-warning volume the dormancy guard depends on.
   */
  readonly dueTrackEmailsSent: number;
  readonly tasksCreated: number;
  readonly skipped: Readonly<Record<SkipReason, number>>;
  readonly failedTransient: number;
  readonly failedPermanent: number;
  readonly durationMs: number;
}

export interface DispatchRenewalCycleOutput {
  readonly summary: DispatchRenewalCycleSummary;
}

export type DispatchRenewalCycleError = {
  readonly kind: 'invalid_input';
  readonly message: string;
};

function emptySkipCounts(): Record<SkipReason, number> {
  const init = {} as Record<SkipReason, number>;
  for (const r of SKIP_REASONS) init[r] = 0;
  return init;
}

export async function dispatchRenewalCycle(
  deps: RenewalsDeps,
  rawInput: DispatchRenewalCycleInput,
): Promise<
  Result<DispatchRenewalCycleOutput, DispatchRenewalCycleError>
> {
  const parsed = dispatchRenewalCycleInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return err({
      kind: 'invalid_input',
      message: parsed.error.issues[0]?.message ?? 'invalid input',
    });
  }
  const input = parsed.data;
  const startedAt = Date.now();
  const nowIso = input.nowIso ?? new Date().toISOString();
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxOffsetDays = input.maxOffsetDays ?? DEFAULT_MAX_OFFSET_DAYS;
  // Cutoff is `now + maxOffsetDays` so we include grace-period cycles
  // whose `expires_at` is already in the past but still within the
  // schedule's positive-offset steps (e.g., T+7).
  const cutoffMs = new Date(nowIso).getTime() + maxOffsetDays * 24 * 60 * 60 * 1000;
  const cutoffExpiresAt = new Date(cutoffMs).toISOString();

  const summary: DispatchRenewalCycleSummary = {
    candidatesProcessed: 0,
    emailsSent: 0,
    dueTrackEmailsSent: 0,
    tasksCreated: 0,
    skipped: emptySkipCounts(),
    failedTransient: 0,
    failedPermanent: 0,
    durationMs: 0,
  };

  // F8 Phase 4 Wave I9 prep / F1 fix — wrap the cron pass in a root
  // span (FR-055). Children: composite query + per-cycle dispatch
  // spans (auto-instrumented from inside dispatchOneCycle).
  return withActiveSpan(
    renewalsTracer(),
    'cron_renewal_dispatch',
    {
      'tenant.id': input.tenantId,
      'renewals.page_size': pageSize,
      'renewals.max_offset_days': maxOffsetDays,
      'renewals.now_iso': nowIso,
    },
    async (span) => {
      const out = await runDispatchLoop();
      // Bucketed outcome counters per W-R8-4 k-anonymity convention.
      span.setAttribute(
        'renewals.candidates_processed_bucket',
        bucketCount(out.summary.candidatesProcessed),
      );
      span.setAttribute(
        'renewals.emails_sent_bucket',
        bucketCount(out.summary.emailsSent),
      );
      span.setAttribute(
        'renewals.tasks_created_bucket',
        bucketCount(out.summary.tasksCreated),
      );
      span.setAttribute(
        'renewals.failed_transient_bucket',
        bucketCount(out.summary.failedTransient),
      );
      span.setAttribute(
        'renewals.failed_permanent_bucket',
        bucketCount(out.summary.failedPermanent),
      );
      span.setAttribute('renewals.duration_ms', out.summary.durationMs);
      return ok({ summary: out.summary });
    },
  );

  async function runDispatchLoop(): Promise<{
    summary: DispatchRenewalCycleSummary;
  }> {
  // FIX-6 (PR #173 review, 2026-07-09) — Gate 7.5's skip-set, computed
  // ONCE for the whole cron pass (was one SQL round-trip PER CANDIDATE).
  // Read before the page loop so every candidate — across every page —
  // shares the same tenant-wide snapshot. Inside the OTel span so its
  // latency is attributed to the cron pass.
  const unreconciledMemberIds =
    await deps.memberRenewalFlagsRepo.listMemberIdsWithUnreconciledPaidMembershipInvoice(
      input.tenantId,
    );
  // ------------------------------------------------------------------
  // 066 §3.2(2) — DUE-TRACK pass. Runs FIRST so the suppression set
  // (`dueTrackCycleIds`) exists before the main ladder pass: a cycle
  // served by the due-anchored dunning track must not ALSO receive the
  // expires_at-anchored t+N emails. The second candidate arm has NO
  // expires_at pre-filter (review C1 — born-awaiting cycles are ~12
  // months from expiry), so this pass is the only channel that reaches
  // that cohort before the due+60 termination clock.
  // ------------------------------------------------------------------
  const dueTrackCycleIds = new Set<string>();
  {
    const dueTrackCtx: DispatchContext = {
      tenantId: input.tenantId,
      actorUserId: null,
      actorRole: 'cron',
      correlationId: input.correlationId,
      requestId: input.requestId ?? null,
      nowIso,
      unreconciledMemberIds,
      dueTrackCycleIds: new Set<string>(), // unused inside the due pass
    };
    const counts = summary as {
      candidatesProcessed: number;
      emailsSent: number;
      dueTrackEmailsSent: number;
      skipped: Record<SkipReason, number>;
      failedTransient: number;
      failedPermanent: number;
    };
    let dueCursor: string | null = null;
    let duePages = 0;
    do {
      const page = await deps.dispatchCandidateRepo.listDueTrackCandidates(
        input.tenantId,
        { pageSize, cursor: dueCursor },
      );
      duePages += 1;
      for (let i = 0; i < page.items.length; i += DISPATCH_CONCURRENCY) {
        const chunk = page.items.slice(i, i + DISPATCH_CONCURRENCY);
        counts.candidatesProcessed += chunk.length;
        const outcomes = await Promise.all(
          chunk.map(async (candidate) => {
            dueTrackCycleIds.add(candidate.cycle.cycleId);
            try {
              return await dispatchDueTrackCycle(deps, candidate, dueTrackCtx);
            } catch (e) {
              // Same per-member fault isolation as the main loop.
              const errMsg = e instanceof Error ? e.message : String(e);
              logger.error(
                {
                  err: e instanceof Error ? e : new Error(String(e)),
                  cycleId: candidate.cycle.cycleId,
                  memberId: candidate.member.memberId,
                  tenantId: input.tenantId,
                  correlationId: input.correlationId,
                },
                'dispatchRenewalCycle: due-track per-cycle dispatch failed (isolated)',
              );
              // K1-C8 parity (T4-review M3) — the cron tally and the
              // audit_log forensic record must agree; a counted failure
              // with no audit row is Principle VIII drift. Fire-and-forget
              // emit (no tx open here); a probe-audit failure must not
              // break peer isolation.
              try {
                await deps.auditEmitter.emit(
                  {
                    type: 'renewal_reminder_send_failed',
                    payload: {
                      cycle_id: candidate.cycle.cycleId,
                      member_id: candidate.member.memberId,
                      failure_kind: 'dispatcher_crash',
                      failure_message: errMsg.slice(0, 200),
                      via_retry_pass: false,
                    },
                  },
                  {
                    tenantId: input.tenantId,
                    actorUserId: null,
                    actorRole: 'cron',
                    correlationId: input.correlationId,
                    requestId: null,
                  },
                );
              } catch (auditErr) {
                logger.error(
                  {
                    err:
                      auditErr instanceof Error
                        ? auditErr
                        : new Error(String(auditErr)),
                    cycleId: candidate.cycle.cycleId,
                    tenantId: input.tenantId,
                    correlationId: input.correlationId,
                  },
                  'dispatchRenewalCycle: due-track dispatcher_crash audit emit failed',
                );
              }
              return {
                kind: 'failed_transient' as const,
                reminderEventId: '',
                reason: `dispatcher_crash: ${errMsg.slice(0, 200)}`,
              };
            }
          }),
        );
        for (const outcome of outcomes) {
          switch (outcome.kind) {
            case 'sent':
              counts.emailsSent += 1;
              counts.dueTrackEmailsSent += 1;
              break;
            case 'skipped':
              counts.skipped[outcome.reason] += 1;
              break;
            case 'failed_transient':
              counts.failedTransient += 1;
              break;
            case 'failed_permanent':
              counts.failedPermanent += 1;
              break;
            case 'task_created':
              // Unreachable — the due track is email-only; tallied for
              // exhaustiveness.
              break;
            default: {
              const _exhaustive: never = outcome;
              void _exhaustive;
            }
          }
        }
      }
      dueCursor = page.nextCursor;
      if (duePages > 1000) {
        logger.error(
          { tenantId: input.tenantId, duePages, correlationId: input.correlationId },
          'dispatchRenewalCycle: due-track page-loop safety bound hit (>1000 pages) — aborting',
        );
        break;
      }
    } while (dueCursor);
  }

  const baseCtx: Omit<DispatchContext, 'nowIso'> = {
    tenantId: input.tenantId,
    actorUserId: null,
    actorRole: 'cron',
    correlationId: input.correlationId,
    requestId: input.requestId ?? null,
    unreconciledMemberIds,
    dueTrackCycleIds,
  };
  let cursor: string | undefined = undefined;
  let pages = 0;
  while (true) {
    const page = await deps.dispatchCandidateRepo.list(input.tenantId, {
      cutoffExpiresAt,
      maxOffsetDays,
      pageSize,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    pages += 1;
    const counts = summary as {
      candidatesProcessed: number;
      emailsSent: number;
      tasksCreated: number;
      skipped: Record<SkipReason, number>;
      failedTransient: number;
      failedPermanent: number;
      durationMs: number;
    };

    // Process the page in concurrency-bounded chunks (FR-017 perf).
    // Per-member fault isolation is preserved — each item's promise
    // catches its own exception and tallies to `failedTransient`
    // without affecting peers in the same chunk.
    const items = page.items;
    for (let i = 0; i < items.length; i += DISPATCH_CONCURRENCY) {
      const chunk = items.slice(i, i + DISPATCH_CONCURRENCY);
      counts.candidatesProcessed += chunk.length;
      const outcomes = await Promise.all(
        chunk.map(async (candidate) => {
          try {
            return await dispatchOneCycle(deps, candidate, {
              ...baseCtx,
              nowIso,
            });
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            logger.error(
              {
                err: e instanceof Error ? e : new Error(String(e)),
                cycleId: candidate.cycle.cycleId,
                memberId: candidate.member.memberId,
                tenantId: input.tenantId,
                correlationId: input.correlationId,
              },
              'dispatchRenewalCycle: per-cycle dispatch failed (isolated)',
            );
            // K1-C8: emit a per-cycle `renewal_reminder_send_failed`
            // audit BEFORE returning the synthetic outcome so the cron
            // summary count and the audit_log forensic record agree.
            // Without this emit the cron tally said "1 failure" but no
            // row existed in audit_log — operators querying
            // `audit_log WHERE type LIKE 'renewal_reminder_send_failed%'`
            // and the cron summary would mismatch. Principle VIII
            // state↔audit atomicity drift.
            //
            // Standalone (non-tx) emit because no tx is open here —
            // dispatchOneCycle's failure escaped its own runInTenant
            // boundary (typically Gate 12's insertIfAbsent never ran,
            // so no reminder_event row exists). The fire-and-forget
            // emit semantics are appropriate: a probe-audit emit
            // failure must NOT block the next cycle's processing.
            try {
              await deps.auditEmitter.emit(
                {
                  type: 'renewal_reminder_send_failed',
                  payload: {
                    cycle_id: candidate.cycle.cycleId,
                    member_id: candidate.member.memberId,
                    failure_kind: 'dispatcher_crash',
                    failure_message: errMsg.slice(0, 200),
                    via_retry_pass: false,
                  },
                },
                {
                  tenantId: input.tenantId,
                  actorUserId: null,
                  actorRole: 'cron',
                  correlationId: input.correlationId,
                  requestId: null,
                },
              );
            } catch (auditErr) {
              // Audit-emit failure on the failure path is itself a
              // failure — log loudly but do NOT throw (would break the
              // peer-isolation invariant of the chunk).
              logger.error(
                {
                  err:
                    auditErr instanceof Error
                      ? auditErr
                      : new Error(String(auditErr)),
                  cycleId: candidate.cycle.cycleId,
                  tenantId: input.tenantId,
                  correlationId: input.correlationId,
                },
                'dispatchRenewalCycle: dispatcher_crash audit emit failed',
              );
            }
            // J2-H8: conform to DispatchOneCycleOutcome.failed_transient
            // shape. Note: dispatchOneCycleInner's defensive cleanup
            // (J2-B2) also catches throws inside the inner dispatch
            // helpers, so this outer catch typically only fires for
            // throws BEFORE Gate 13's insertIfAbsent (no reminder_event
            // row exists yet → empty reminderEventId is correct).
            return {
              kind: 'failed_transient' as const,
              reminderEventId: '',
              reason: `dispatcher_crash: ${errMsg.slice(0, 200)}`,
            };
          }
        }),
      );
      for (const outcome of outcomes) {
        switch (outcome.kind) {
          case 'sent':
            counts.emailsSent += 1;
            break;
          case 'task_created':
            counts.tasksCreated += 1;
            break;
          case 'skipped':
            counts.skipped[outcome.reason] += 1;
            break;
          case 'failed_transient':
            counts.failedTransient += 1;
            break;
          case 'failed_permanent':
            counts.failedPermanent += 1;
            break;
          default: {
            // J6-H7 — exhaustiveness pin. If a future variant is added
            // to `DispatchOneCycleOutcome` without a matching case here,
            // the assignment below fails at compile time, preventing
            // the new variant from being silently dropped from cron
            // summary metrics + SLO calculations.
            const _exhaustive: never = outcome;
            void _exhaustive;
          }
        }
      }
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
    // Safety bound — should never be reached under normal load (5k
    // members / 200 page size = 25 pages). Defensive against runaway
    // cursor loops from a future RLS regression.
    if (pages > 1000) {
      logger.error(
        { tenantId: input.tenantId, pages, correlationId: input.correlationId },
        'dispatchRenewalCycle: page-loop safety bound hit (>1000 pages) — aborting',
      );
      break;
    }
  }
  (summary as { durationMs: number }).durationMs = Date.now() - startedAt;
  logger.info(
    {
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      candidatesProcessed: summary.candidatesProcessed,
      emailsSent: summary.emailsSent,
      tasksCreated: summary.tasksCreated,
      failedTransient: summary.failedTransient,
      failedPermanent: summary.failedPermanent,
      pages,
      durationMs: summary.durationMs,
    },
    'dispatchRenewalCycle: cron pass complete',
  );
  return { summary };
  }
}
