/**
 * F8 Phase 3 Wave H2 · T056 — `load-pipeline` use-case.
 *
 * Server-side pagination + filter + DB-side urgency derivation for the
 * `/admin/renewals` dashboard (US1 / FR-046 / SC-003 — p95 <500ms @
 * 5,000 active members + 600 visible).
 *
 * Use-case orchestrates `cyclesRepo.loadPipelinePage` (Drizzle adapter
 * H1 T060) which already performs the composite query + summary
 * aggregation inside one `runInTenant` block. This file is a thin
 * input-validation + Result-mapping wrapper so the API route handler
 * stays Clean-Architecture compliant (Presentation → Application →
 * Infrastructure).
 *
 * Tenant isolation: Postgres RLS on `renewal_cycles` enforces visibility;
 * cross-tenant queries return zero rows + are auto-audited at the use-
 * case layer when probe semantics matter (cycle detail, cancel, mark-paid;
 * the pipeline list itself returns an empty page rather than emitting an
 * audit because list operations don't carry user-targeted intent).
 */
import { z } from 'zod';
import { ok, type Result } from '@/lib/result';
import { renewalsTracer, withActiveSpan } from '@/lib/otel-tracer';
import { renewalsMetrics } from '@/lib/metrics';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import type {
  PipelineQueryResult,
  UrgencyBucket,
} from '../ports/renewal-cycle-repo';
import { TIER_BUCKETS } from '../../domain/value-objects/tier-bucket';
import { parseMonthParam } from '../../domain/renewal-month-bucket';

const URGENCY_BUCKETS: ReadonlyArray<UrgencyBucket> = [
  't-90',
  't-60',
  't-30',
  't-14',
  't-7',
  't-0',
  'grace',
  'lapsed',
];

export const loadPipelineInputSchema = z.object({
  tenantId: z.string().min(1),
  tier: z.enum(TIER_BUCKETS).optional(),
  urgency: z
    .enum(URGENCY_BUCKETS as readonly [UrgencyBucket, ...UrgencyBucket[]])
    .optional(),
  // Renewals-by-month lens. Kept loose (raw string) so an invalid value is
  // treated as ABSENT (→ urgency still applies), not a hard 400.
  month: z.string().optional(),
  nowIso: z.string().datetime().optional(),
  cursor: z.string().nullable().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export type LoadPipelineInput = z.infer<typeof loadPipelineInputSchema>;

export type LoadPipelineError = {
  readonly kind: 'invalid_input';
  readonly issues: ReadonlyArray<{ path: string; message: string }>;
};

export async function loadPipeline(
  deps: RenewalsDeps,
  rawInput: LoadPipelineInput,
): Promise<Result<PipelineQueryResult, LoadPipelineError>> {
  const parsed = loadPipelineInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        kind: 'invalid_input',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
    };
  }
  const input = parsed.data;
  // F6 — validate month precedence in the use-case (not SQL). A present +
  // VALID month wins and urgency is ignored; an invalid month string is
  // treated as absent so a valid urgency still applies. The month path needs
  // `nowIso` for the BKK boundaries; without it, fall back to urgency.
  const monthFilter =
    input.nowIso !== undefined ? parseMonthParam(input.month) : null;
  // Phase 3.5 S-06 — wrap the composite-query repo call in an OTel
  // span so the SLO alerting on SC-003 (p95<500ms) has a named hop in
  // Vercel Observability traces. Auto-instrumented Drizzle child
  // queries (summary GROUP BY, lapsed count, page query) parent under
  // this span via `startActiveSpan`.
  const result = await withActiveSpan(
    renewalsTracer(),
    'admin_pipeline_load',
    {
      'tenant.id': input.tenantId,
      'renewals.tier_filter': input.tier ?? 'all',
      'renewals.urgency_filter': input.urgency ?? 'all',
      'renewals.page_limit': input.limit ?? 50,
    },
    async (span) => {
      const r = await deps.cyclesRepo.loadPipelinePage(input.tenantId, {
        ...(input.tier !== undefined ? { tier: input.tier } : {}),
        // Mutually-exclusive lenses: month wins, else urgency. The guard
        // `monthFilter !== null && input.nowIso !== undefined` lets TS
        // narrow both to `string` inside this branch — no `as string`.
        ...(monthFilter !== null && input.nowIso !== undefined
          ? { monthFilter, nowIso: input.nowIso }
          : input.urgency !== undefined
            ? { urgency: input.urgency }
            : {}),
        ...(input.cursor !== undefined && input.cursor !== null
          ? { cursor: input.cursor }
          : {}),
        limit: input.limit ?? 50,
      });
      // Round 9 W-R8-4 — bucket exact counts to coarse ranges. Combined
      // with `tenant.id` already on the parent span, exact counts would
      // let an APM operator infer per-tenant membership scale (LINDDUN
      // Detectability/Linkability). Bucketed values preserve SLO +
      // capacity-planning signal without leaking commercial-scale
      // metadata. `page_size` (max 50) is low-sensitivity and stays
      // exact for SLO debugging.
      span.setAttribute(
        'renewals.total_in_window_bucket',
        bucketCount(r.summary.totalInWindow),
      );
      span.setAttribute(
        'renewals.lapsed_count_bucket',
        bucketCount(r.summary.lapsedCount),
      );
      span.setAttribute('renewals.page_size', r.rows.length);
      // T4 fix-wave — under the month lens the urgency filter above is
      // reported as 'all' even though it was dropped in favour of the
      // month lens (mutually-exclusive), which hid which lens actually ran.
      // Surface the month filter explicitly so an APM operator can tell.
      // Does NOT carry an exact member count (bucketed counts above cover
      // that; this is just the lens key, e.g. '2026-07' / 'overdue' / 'later').
      span.setAttribute('renewals.month_filter', monthFilter ?? 'none');

      // W0-09: § 23.1.1 pipeline.row_count gauge = rows returned for the CURRENT
      // page (bounded ≤ page-size 50), matching the instrument name + doc. MUST be
      // r.rows.length, NOT r.summary.totalInWindow — emitting the raw in-window total
      // as a metric value (with the tenant_id label) would re-introduce the per-tenant
      // membership-scale leak the span deliberately BUCKETS above
      // (renewals.total_in_window_bucket, LINDDUN W-R8-4). Label = active urgency filter.
      renewalsMetrics.pipelineRowCount(
        input.tenantId,
        input.urgency ?? 'all',
        r.rows.length,
      );

      return r;
    },
  );
  return ok(result);
}

/**
 * Round 9 W-R8-4 — Coarse range bucketing for OTel span attributes.
 *
 * Boundaries are chosen for k-anonymity against the LINDDUN
 * Detectability/Linkability concern documented at the call site:
 * combined with `tenant.id` already on the parent span, exact counts
 * would let an APM operator infer per-tenant scale. Each bucket
 * contains enough plausible peer tenants that an integer membership
 * count cannot identify a single tenant by size alone.
 *
 * Round 10 S1 + S3 — adds NaN/negative guard returning explicit
 * `'invalid'` sentinel (vs prior silent-misclassification as
 * `'1001+'`) + tightens return type to a literal union so callers
 * have an exhaustive enum for compile-time `assertNever` fallthrough.
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
