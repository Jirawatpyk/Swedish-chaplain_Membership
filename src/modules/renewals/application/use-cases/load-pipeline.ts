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
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import type {
  PipelineQueryResult,
  UrgencyBucket,
} from '../ports/renewal-cycle-repo';
import { TIER_BUCKETS } from '../../domain/value-objects/tier-bucket';

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
  const result = await deps.cyclesRepo.loadPipelinePage(input.tenantId, {
    ...(input.tier !== undefined ? { tier: input.tier } : {}),
    ...(input.urgency !== undefined ? { urgency: input.urgency } : {}),
    ...(input.cursor !== undefined && input.cursor !== null
      ? { cursor: input.cursor }
      : {}),
    limit: input.limit ?? 50,
  });
  return ok(result);
}
