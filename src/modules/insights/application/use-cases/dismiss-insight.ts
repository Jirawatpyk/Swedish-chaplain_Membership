/**
 * F9 `dismissInsight` use-case (US1 / FR-004 / contracts application-ports).
 *
 * Records a staff dismissal of a smart insight for the current cycle. Insights
 * are STAFF-FACING (FR-007a) → only admin + manager may dismiss; members are
 * forbidden. Idempotent (the repo dedupes on the unique key). Emits
 * `smart_insight_dismissed` atomically with the write.
 *
 * Application layer: orchestrates Domain + ports via `runInTenant`; no ORM /
 * framework imports beyond the shared `@/lib/db` composition helpers
 * (Constitution Principle III).
 */
import { runInTenant } from '@/lib/db';
import { ok, err, type Result } from '@/lib/result';
import { insightsMetrics } from '@/lib/metrics';
import type { TenantContext } from '@/modules/tenants';
import { cycleKeyFor } from '../../domain/insight-cycle-key';
import { isInsightKey, type InsightKey } from '../../domain/smart-insight';
import type { InsightsAuditPort } from '../ports/audit-port';
import type { InsightDismissalRepo } from '../ports/insight-dismissal-repo';

export type InsightsActorRole = 'admin' | 'manager' | 'member';

export interface DismissInsightInput {
  readonly insightKey: string;
  /** Optional member/segment ref the insight referenced; '' sentinel = tenant-wide. */
  readonly scopeRef?: string;
}

export interface DismissInsightMeta {
  readonly actorUserId: string;
  readonly actorRole: InsightsActorRole;
  readonly requestId: string;
}

export interface ClockPort {
  now(): Date;
}

export interface DismissInsightDeps {
  readonly dismissalRepo: InsightDismissalRepo;
  readonly audit: InsightsAuditPort;
  readonly clock: ClockPort;
  /** Tenant IANA timezone — drives the cycle-key year/week boundary. */
  readonly tenantTimezone: string;
}

export type DismissInsightError = 'forbidden' | 'invalid_insight_key';

export async function dismissInsight(
  input: DismissInsightInput,
  meta: DismissInsightMeta,
  ctx: TenantContext,
  deps: DismissInsightDeps,
): Promise<Result<void, DismissInsightError>> {
  // FR-007a — insights are staff-only; members cannot dismiss org insights.
  if (meta.actorRole === 'member') return err('forbidden');
  if (!isInsightKey(input.insightKey)) return err('invalid_insight_key');

  const insightKey: InsightKey = input.insightKey;
  const scopeRef = input.scopeRef ?? '';
  const cycleKey = cycleKeyFor(insightKey, deps.clock.now(), deps.tenantTimezone);

  await runInTenant(ctx, async (tx) => {
    const inserted = await deps.dismissalRepo.dismissInTx(tx, {
      insightKey,
      scopeRef,
      cycleKey,
      dismissedBy: meta.actorUserId,
    });
    await deps.audit.recordInTx(tx, {
      tenantId: ctx.slug,
      requestId: meta.requestId,
      eventType: 'smart_insight_dismissed',
      actorUserId: meta.actorUserId,
      retentionYears: 5,
      summary: `insight ${insightKey} dismissed for cycle ${cycleKey}${inserted ? '' : ' (idempotent replay)'}`,
      payload: { insight_key: insightKey, scope_ref: scopeRef, cycle_key: cycleKey },
    });
  });

  insightsMetrics.insightDismissed(insightKey, ctx.slug);
  return ok(undefined);
}
