/**
 * F6 Phase 10 T139 — attendee fuzzy match perf bench.
 *
 * Measures p50/p95/p99 latency of `matchAttendeeToMember` at 5k-member
 * fixture per round-1 E12. Target: <50ms p95 per ingest. If fail,
 * decision is pg_trgm fallback (per spec round-1 P12).
 *
 * Run:
 *   FEATURE_F6_EVENTCREATE=true pnpm tsx scripts/perf/eventcreate-attendee-fuzzy-match.ts
 */
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { asTenantContext } from '@/modules/tenants';
import { eq } from 'drizzle-orm';
import { matchAttendeeToMember } from '@/modules/events';
import { makeDrizzleAttendeeMatcher } from '@/modules/events/infrastructure/drizzle-attendee-matcher';

const MEMBER_COUNT = Number(process.env.PERF_MEMBER_COUNT ?? 500);
const ITERATIONS = Number(process.env.PERF_ITERATIONS ?? 200);
const TENANT_SLUG = `perf-fuzzy-${Date.now()}`;
const STRICT = process.env.STRICT === '1';
const P95_TARGET_MS = 50;

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))]!;
}

async function main() {
  const ctx = asTenantContext(TENANT_SLUG);

  // Seed N members + contacts
  await runInTenant(ctx, async (tx) => {
    const memberRows = Array.from({ length: MEMBER_COUNT }, (_, i) => ({
      tenantId: TENANT_SLUG,
      memberId: randomUUID(),
      companyName: `Perf Member Co ${i}`,
      country: 'TH',
      status: 'active',
    }));
    await tx.insert(members).values(memberRows as unknown as Array<typeof members.$inferInsert>);

    const contactRows = memberRows.map((m, i) => ({
      tenantId: TENANT_SLUG,
      contactId: randomUUID(),
      memberId: m.memberId,
      firstName: `Person`,
      lastName: `${i}`,
      email: `person${i}@perfco${i % 50}.example.com`,
      isPrimary: true,
    }));
    await tx.insert(contacts).values(contactRows as unknown as Array<typeof contacts.$inferInsert>);
  });

  const latencies: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const seed = i % 100;
    const email =
      seed < 30
        ? `person${seed}@perfco${seed % 50}.example.com`
        : seed < 60
        ? `unknown-${seed}@external.com`
        : `person${seed}@othercompany.example.com`;
    const start = performance.now();
    await runInTenant(ctx, async (tx) => {
      const matcher = makeDrizzleAttendeeMatcher(tx);
      await matchAttendeeToMember(
        {
          tenantId: TENANT_SLUG as never,
          attendeeEmail: email as never,
          attendeeCompany: `Perf Member Co ${seed % MEMBER_COUNT}`,
        },
        { matcher },
      ).catch(() => null);
    }).catch(() => null);
    latencies.push(performance.now() - start);
  }

  // Cleanup
  try {
    await runInTenant(ctx, async (tx) => {
      await tx.delete(contacts).where(eq(contacts.tenantId, TENANT_SLUG));
      await tx.delete(members).where(eq(members.tenantId, TENANT_SLUG));
    });
  } catch {}

  const sorted = [...latencies].sort((a, b) => a - b);
  const report = {
    bench: 'attendee-fuzzy-match',
    memberCount: MEMBER_COUNT,
    iterations: ITERATIONS,
    p50Ms: Math.round(percentile(sorted, 0.5) * 100) / 100,
    p95Ms: Math.round(percentile(sorted, 0.95) * 100) / 100,
    p99Ms: Math.round(percentile(sorted, 0.99) * 100) / 100,
    p95TargetMs: P95_TARGET_MS,
    p95UnderTarget: percentile(sorted, 0.95) < P95_TARGET_MS,
    fallbackRecommendation:
      percentile(sorted, 0.95) >= P95_TARGET_MS
        ? 'pg_trgm migration recommended per spec round-1 P12'
        : 'in-memory match acceptable',
    timestamp: new Date().toISOString(),
  };
  console.log(JSON.stringify(report, null, 2));
  if (STRICT && !report.p95UnderTarget) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
