/**
 * T154a Layer 2 deep verify — F8 recompute for L2 evidence member.
 *
 * Manually triggers the F8 `recomputeAtRiskScoresBatch` use-case
 * against the SweCham tenant so the L2-evidence member (seeded by
 * `scripts/seed-f6-layer2-evidence.ts`) gets an at-risk score row
 * that reflects the synthetic F6 attendance data inserted earlier.
 *
 * Pre-requisites:
 *   1. `scripts/seed-f6-layer2-evidence.ts` has run successfully
 *      (1 event + 2 attendances persisted for some SweCham member)
 *   2. `FEATURE_F6_EVENTCREATE=true` in env (so the F8 composition
 *      root selects `drizzleEventAttendeesAdapter` not stub)
 *   3. Member meets F8 tenure threshold (minTenureDaysForAtRisk
 *      from tenant_renewal_settings — default 60d)
 *
 * Pass criteria:
 *   - exit code 0
 *   - `recomputeAtRiskScoresBatch` returns `ok: true` with
 *     `membersRecomputed > 0`
 *   - At least one row in `at_risk_scores` exists for the tenant
 *     with `factor_breakdown.eventAttendance.skipped` NOT equal
 *     to true (= F6 bridge IS feeding F8 with real data)
 *
 * Safe to re-run: the batch is idempotent (upsert on
 * (tenant_id, member_id)).
 */
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import {
  recomputeAtRiskScoresBatch,
  makeRenewalsDeps,
} from '@/modules/renewals';

async function main(): Promise<void> {
  const tenantSlug = env.tenant.slug;

  console.log('');
  console.log('=== T154a Layer 2 — F8 recompute for L2 evidence ===');
  console.log('');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Tenant: ${tenantSlug}`);
  console.log(`FEATURE_F6_EVENTCREATE: ${env.features.f6EventCreate}`);
  console.log(`FEATURE_F8_RENEWALS: ${(env.features as { f8Renewals?: boolean }).f8Renewals ?? '(default false)'}`);
  console.log('');

  // 1. Trigger F8 batch recompute for the SweCham tenant.
  const deps = makeRenewalsDeps(tenantSlug);
  const correlationId = `t154a-layer2-${Date.now()}`;
  const out = await recomputeAtRiskScoresBatch(deps, {
    tenantId: tenantSlug,
    correlationId,
    requestId: correlationId,
  });

  if (!out.ok) {
    console.error('❌ recomputeAtRiskScoresBatch failed:', out.error);
    process.exit(1);
  }

  console.log('recomputeAtRiskScoresBatch output:');
  console.log(`  membersTotal: ${out.value.membersTotal}`);
  console.log(`  membersRecomputed: ${out.value.membersRecomputed}`);
  console.log(`  membersSkippedBelowTenure: ${out.value.membersSkippedBelowTenure}`);
  console.log(`  membersFailed: ${out.value.membersFailed}`);
  console.log(`  durationMs: ${out.value.durationMs}`);
  console.log('');

  // 2. Probe at_risk_scores for any row with eventAttendance factor populated.
  //    The factor JSONB shape (per src/modules/renewals/domain) is:
  //      eventAttendance: { skipped: boolean, value?: number, weight?: number, ... }
  //    For the L2-evidence member, skipped should be FALSE because the
  //    F6 bridge port returns 2 attendance records → factor is computed.
  const probeRows = await db.execute<{
    member_id: string;
    risk_band: string;
    event_attendance_skipped: boolean | null;
    event_attendance_value: number | null;
  }>(sql`
    SELECT
      member_id::text AS member_id,
      risk_band,
      (factor_breakdown->'eventAttendance'->>'skipped')::boolean AS event_attendance_skipped,
      (factor_breakdown->'eventAttendance'->>'value')::numeric AS event_attendance_value
    FROM at_risk_scores
    WHERE tenant_id = ${tenantSlug}
    ORDER BY computed_at DESC
    LIMIT 10
  `);

  console.log(`at_risk_scores probe — most recent 10 rows for tenant '${tenantSlug}':`);
  if (probeRows.length === 0) {
    console.log('  (no rows — possibly no members met tenure threshold)');
  } else {
    for (const row of probeRows) {
      const idMask = `${row.member_id.slice(0, 8)}…${row.member_id.slice(-4)}`;
      console.log(`  ${idMask}  band=${row.risk_band}  evt-skipped=${row.event_attendance_skipped}  evt-value=${row.event_attendance_value ?? '(null)'}`);
    }
  }
  console.log('');

  const livePopulated = probeRows.filter(
    (r) => r.event_attendance_skipped === false,
  );

  if (out.value.membersRecomputed > 0 && livePopulated.length > 0) {
    console.log('✅ T154a Layer 2 deep verify — PASS');
    console.log(`   F8 recompute produced ${out.value.membersRecomputed} score row(s)`);
    console.log(`   ${livePopulated.length} row(s) have eventAttendance.skipped=false`);
    console.log('   → F6 → F8 bridge is delivering real data end-to-end in production');
    process.exit(0);
  }

  console.error('❌ T154a Layer 2 deep verify — INCONCLUSIVE');
  console.error(`   membersRecomputed: ${out.value.membersRecomputed}`);
  console.error(`   rows with eventAttendance.skipped=false: ${livePopulated.length}`);
  console.error('   Possible causes:');
  console.error('     - seeded member is BELOW minTenureDaysForAtRisk threshold');
  console.error('     - FEATURE_F8_RENEWALS=false (whole-F8 dark)');
  console.error('     - tenant_renewal_settings missing for tenant');
  process.exit(1);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('');
  console.error('Recompute script crashed:', message);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
