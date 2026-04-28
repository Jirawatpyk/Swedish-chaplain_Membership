/**
 * T133 — Test/live environment mismatch enforced (FR-010).
 *
 * Spec authority: spec.md FR-010. The webhook route MUST reject events
 * whose `livemode` does not match `env.stripe.liveMode`. Rejection semantics:
 *
 *   - HTTP 200 (Stripe acknowledged) so no retry
 *   - `processor_events` row with `outcome='rejected_environment_mismatch'`
 *   - `audit_log` row of type `payment_environment_mismatch`
 *   - Use-case dispatch is NOT invoked → no payment / refund state change
 *
 * Route enforcement: `src/app/api/webhooks/stripe/route.ts` step 4
 * (line 315+ — `if (evLivemode !== env.stripe.liveMode)`).
 *
 * Asserts (lean variant — full route-level coverage in
 * `tests/contract/payments/post-webhooks-stripe-events.contract.test.ts § (c)`):
 *
 *   (a) `processor_events` table accepts `outcome='rejected_environment_mismatch'`.
 *
 *   (b) Repo round-trips an env-mismatch row with NULL tenant_id and
 *       livemode=true (event from prod) when our env says test-mode.
 *
 *   (c) Source-code invariant: the route compares `evLivemode` against
 *       `env.stripe.liveMode` and emits `payment_environment_mismatch`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '@/lib/db';
import { makeDrizzleProcessorEventsRepo } from '@/modules/payments/infrastructure/repos/drizzle-processor-events-repo';
import { processorEvents } from '@/modules/payments/infrastructure/schema';

function makeEventId(): string {
  return `evt_envmm_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function makePayloadSha(): string {
  return createHash('sha256').update(randomUUID()).digest('hex');
}

describe('T133 webhook livemode/environment mismatch enforced (FR-010)', () => {
  const repo = makeDrizzleProcessorEventsRepo();
  const insertedIds: string[] = [];

  afterAll(async () => {
    if (insertedIds.length === 0) return;
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE neondb_owner`);
      for (const id of insertedIds) {
        await tx.delete(processorEvents).where(eq(processorEvents.id, id));
      }
    });
  });

  it('(a)+(b) repo round-trips rejected_environment_mismatch (live event hitting test endpoint)', async () => {
    const id = makeEventId();
    insertedIds.push(id);
    const input = {
      id,
      tenantId: null,
      eventType: 'payment_intent.succeeded',
      apiVersion: '2024-06-20',
      livemode: true, // event-side: live; our env: test
      processorAccountId: 'acct_live_attacker',
      outcome: 'rejected_environment_mismatch' as const,
      payloadSha256: makePayloadSha(),
      correlationId: `corr-envmm-${randomUUID().slice(0, 8)}`,
      receivedAt: new Date(),
    };
    const result = await repo.insertIfNew(null, input);
    expect(result.inserted).toBe(true);

    const rows = await db
      .select()
      .from(processorEvents)
      .where(eq(processorEvents.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('rejected_environment_mismatch');
    expect(rows[0]!.tenantId).toBeNull();
    expect(rows[0]!.livemode).toBe(true);
  });

  it('(c) route source enforces livemode segregation before downstream dispatch', () => {
    const path = join(
      process.cwd(),
      'src/app/api/webhooks/stripe/route.ts',
    );
    const src = readFileSync(path, 'utf-8');

    // Comparison present
    expect(src).toMatch(/evLivemode\s*!==?\s*env\.stripe\.liveMode/);
    // Audit event emitted
    expect(src).toMatch(/['"]payment_environment_mismatch['"]/);
    // Rejection outcome captured
    expect(src).toMatch(/['"]rejected_environment_mismatch['"]/);
    // 200 response (Stripe doesn't retry)
    expect(src).toMatch(/jsonOk\s*\(\s*correlationId\s*\)/);
  });

  it('(c) livemode check runs BEFORE api_version check (defense-in-depth)', () => {
    const path = join(
      process.cwd(),
      'src/app/api/webhooks/stripe/route.ts',
    );
    const src = readFileSync(path, 'utf-8');

    // Order invariant: livemode comparison appears before the
    // api_version comparison in the source. If a refactor reorders
    // these two checks the env-segregation guarantee weakens (a
    // wrong-env event with a coincidentally-pinned api_version could
    // sneak through under a single-check regression).
    const livemodeIdx = src.indexOf('evLivemode !== env.stripe.liveMode');
    const apiVerIdx = src.indexOf('evApiVersion !== env.stripe.apiVersion');
    expect(livemodeIdx).toBeGreaterThan(0);
    expect(apiVerIdx).toBeGreaterThan(0);
    expect(
      livemodeIdx,
      'livemode check must run before api_version check',
    ).toBeLessThan(apiVerIdx);
  });
});
