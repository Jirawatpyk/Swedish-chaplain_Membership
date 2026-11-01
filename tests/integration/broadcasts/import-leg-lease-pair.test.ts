/**
 * Spec 140 s2b, DL1 — two concurrent import ticks on one `approved` row, on
 * live Postgres (Neon `dev`) through the real repo: the dispatch lease lets
 * exactly one of them work the row. Across both ticks of the build the row gets
 *   one audience, one import, one broadcast and one `/send`.
 *
 * The pair: the first tick claims the lease and is PARKED inside its first
 * irreversible Resend call (`createAudience` on tick 1, `createBroadcast` on
 * tick 2) — after its claim committed, holding no lock. The second tick then
 * runs its WHOLE tick: its claim finds a live lease, so it answers `lease_held`
 * having made no Resend call and written nothing. Only then is the first one
 * released. Both orders: either tick may be the one that claims first.
 *
 * Without the lease the second tick passes the same `approved` check and
 * creates a second audience (tick 1) or a second broadcast and a second `/send`
 * (tick 2) — the counts below are what goes red.
 *
 * Resend is a recording fake shared by both ticks (never the live account).
 * Every wait is bounded: the dev branch has `statement_timeout = 0`, so a lock
 * bug would hang rather than fail.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInTenant } from '@/lib/db';
import { ok } from '@/lib/result';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { buildAudienceTick } from '@/modules/broadcasts/application/use-cases/build-audience-tick';
import { f7AuditAdapter } from '@/modules/broadcasts/infrastructure/audit-adapter';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { broadcasts } from '@/modules/broadcasts/infrastructure/schema';
import { makeFakeSendStanding } from '../../helpers/eblast-approval-fakes';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const RECIPIENTS = ['dl1-a@example.com', 'dl1-b@example.com'];
const NO_BRAND = { load: async () => ({ primaryColor: null, postalAddress: null, logoUrl: null }) };

/** A gate a test opens by hand. */
function gate(): { readonly reached: Promise<void>; readonly open: () => void; readonly wait: () => Promise<void> } {
  let reach!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((r) => (reach = r));
  const opened = new Promise<void>((r) => (open = r));
  return {
    reached,
    open,
    wait: async () => {
      reach();
      await opened;
    },
  };
}

/** Bound a wait: a lock bug on the dev branch hangs instead of failing. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out: ${what}`)), ms))]);
}

/** One shared Resend: counts across both ticks; `park` holds the named create on the FIRST call only. */
function sharedResend(park: { readonly method: 'createAudience' | 'createBroadcast'; readonly gate: ReturnType<typeof gate> } | null) {
  const calls: Array<{ tick: string; method: string }> = [];
  let parked = false;
  const portFor = (tick: string) => {
    const call = async (method: string) => {
      calls.push({ tick, method });
      if (park !== null && park.method === method && !parked) {
        parked = true;
        await park.gate.wait();
      }
    };
    return {
      async createAudience(name: string) {
        await call('createAudience');
        return { audienceId: `aud-dl1-${name.slice(-8)}-${tick}` };
      },
      async createContactImport() {
        await call('createContactImport');
        return { importId: `imp-dl1-${tick}-${randomUUID().slice(0, 8)}` };
      },
      async getContactImport() {
        await call('getContactImport');
        return { status: 'completed', counts: { total: RECIPIENTS.length, created: RECIPIENTS.length, updated: 0, skipped: 0, failed: 0 } };
      },
      async getAudienceContactCount() {
        await call('getAudienceContactCount');
        return { count: RECIPIENTS.length, complete: true };
      },
      async createBroadcast() {
        await call('createBroadcast');
        return { broadcastId: `rb-dl1-${tick}-${randomUUID()}` };
      },
      async sendBroadcast() {
        await call('sendBroadcast');
      },
      async retrieveBroadcast(id: string) {
        await call('retrieveBroadcast');
        return { kind: 'present' as const, resource: { id, status: 'draft' as const, sentAt: null } };
      },
      async deleteBroadcast() {
        await call('deleteBroadcast');
      },
      async deleteAudience() {
        await call('deleteAudience');
      },
    };
  };
  const count = (method: string) => calls.filter((c) => c.method === method).length;
  return { calls, portFor, count };
}

describe('spec 140 s2b DL1 — two concurrent import ticks on one row (live Neon)', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
  });

  afterAll(async () => {
    await tenant?.cleanup().catch(() => {});
  });

  async function seedApproved(): Promise<string> {
    const broadcastId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(broadcasts).values({
        tenantId: tenant.ctx.slug,
        broadcastId,
        requestedByMemberId: randomUUID(),
        requestedByMemberPlanIdSnapshot: 'plan-dl1',
        submittedByUserId: randomUUID(),
        actorRole: 'admin_proxy',
        subject: 'DL1 pair',
        bodyHtml: '<p>x</p>',
        bodySource: 'x',
        fromName: 'DL1 Test',
        replyToEmail: 'reply@example.com',
        segmentType: 'all_members',
        estimatedRecipientCount: RECIPIENTS.length,
        status: 'approved',
        submittedAt: new Date(Date.now() - 86_400_000),
        approvedAt: new Date(Date.now() - 3_600_000),
        scheduledFor: new Date(Date.now() - 60_000),
      }),
    );
    return broadcastId;
  }

  const readRow = (id: string) =>
    runInTenant(tenant.ctx, async (tx) =>
      (await tx.select().from(broadcasts).where(and(eq(broadcasts.tenantId, tenant.ctx.slug), eq(broadcasts.broadcastId, id))))[0]!,
    );

  const depsFor = (gateway: unknown) => ({
    tenant: tenant.ctx,
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenant.ctx.slug),
    broadcastsGateway: gateway,
    audit: f7AuditAdapter,
    clock: { now: () => new Date() },
    tickBudget: { tickStartedAt: Date.now(), maxDurationMs: 300_000 },
    fromEmail: 'noreply@test.invalid-but-test-only',
    tenantDisplayName: 'Test Chamber',
    locale: 'en' as const,
    resolveRecipients: async () => ok({ recipients: RECIPIENTS, estimatedCount: RECIPIENTS.length, orphans: [], droppedByPreference: 0 }),
    membersBridge: { getMemberPrimaryContact: async () => null, getMemberPreferredLocale: async () => 'en' as const },
    emailTransactional: { sendMemberEmail: async () => undefined },
    plansBridge: { getPlanForMember: async () => ok({ planId: 'plan-dl1', planCode: 'REG', eblastPerYear: 4 }) },
    sendStanding: makeFakeSendStanding(),
    brandChrome: NO_BRAND,
    pauseBeforeReprobe: async () => {},
  });

  /**
   * One pair: `first` claims and parks in `park.method`; `second` runs its
   * whole tick meanwhile; then `first` is released. Returns both results.
   */
  async function pair(id: string, resend: ReturnType<typeof sharedResend>, park: ReturnType<typeof gate>, first: string, second: string) {
    const tick = (name: string) => buildAudienceTick(depsFor(resend.portFor(name)) as never, { broadcastId: asBroadcastId(id) });
    const firstP = tick(first);
    await within(park.reached, 20_000, `${first} reaching its parked call`);
    const secondResult = await within(tick(second), 20_000, `${second} running while ${first} is parked`);
    const secondCalls = resend.calls.filter((c) => c.tick === second);
    park.open();
    const firstResult = await within(firstP, 20_000, `${first} after release`);
    return { firstResult, secondResult, secondCalls };
  }

  it.each([
    ['A first', 'A', 'B'],
    ['B first', 'B', 'A'],
  ] as const)('%s — one audience, one import, one broadcast, one /send across both ticks', async (_label, first, second) => {
    const id = await seedApproved();

    // ── tick 1: the first tick parks inside createAudience ──────────────────
    const park1 = gate();
    const tick1 = sharedResend({ method: 'createAudience', gate: park1 });
    const t1 = await pair(id, tick1, park1, first, second);
    expect(t1.secondResult).toEqual({ ok: false, error: { kind: 'broadcast_invalid_state_transition', observedStatus: 'lease_held' } });
    expect(t1.secondCalls).toEqual([]);
    expect(t1.firstResult.ok ? t1.firstResult.value.kind : t1.firstResult.error).toBe('import_submitted');
    expect(tick1.count('createAudience')).toBe(1);
    expect(tick1.count('createContactImport')).toBe(1);
    let row = await readRow(id);
    expect(row.status).toBe('approved');
    expect(row.audienceImportId).not.toBeNull();
    // Released at the end of the first tick; the held one never touched it.
    expect(row.dispatchLeaseToken).toBeNull();

    // ── tick 2: the first tick parks inside createBroadcast ─────────────────
    const park2 = gate();
    const tick2 = sharedResend({ method: 'createBroadcast', gate: park2 });
    const t2 = await pair(id, tick2, park2, first, second);
    expect(t2.secondResult).toEqual({ ok: false, error: { kind: 'broadcast_invalid_state_transition', observedStatus: 'lease_held' } });
    expect(t2.secondCalls).toEqual([]);
    expect(t2.firstResult.ok ? t2.firstResult.value.kind : t2.firstResult.error).toBe('sent');
    expect(tick2.count('createBroadcast')).toBe(1);
    expect(tick2.count('sendBroadcast')).toBe(1);
    expect(tick2.count('createAudience') + tick2.count('createContactImport')).toBe(0);
    row = await readRow(id);
    expect(row.status).toBe('sending');
    expect(row.dispatchLeaseToken).toBeNull();
  });
});
