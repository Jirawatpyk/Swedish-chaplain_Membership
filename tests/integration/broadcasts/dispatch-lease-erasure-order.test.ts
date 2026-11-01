/**
 * Spec 140 s2b, DL3 — the dispatch lease against the erasure cascade's row
 * lock (D-040), on live Postgres (Neon `dev`) as `chamber_app` (the repo runs
 * every statement inside `runInTenant`).
 *
 * The cascade takes `lockForUpdate` (the `broadcasts:` advisory lock and the
 * row's `FOR UPDATE`), decides at Resend for up to `ERASURE_ROW_LOCK_HOLD_MS`,
 * and cancels through `applyTransition` with `lease: null` — which clears any
 * lease on the row. Here a plain repo tx plays the cascade's lock-then-cancel,
 * so the ORDER is exact without a fake Resend driving it.
 *
 *   row 16 — the claim waits behind the lock, then reads `cancelled`: a
 *            `wrong_status` skip, no Resend call, no lease ever written.
 *   row 17 — a tick mid-way (it holds the lease) reaches its pre-call check
 *            before `createBroadcast`; the check (`SELECT … FOR UPDATE`) waits
 *            behind the lock, then reads the cleared lease: no call is made.
 *
 * Every wait is bounded: the dev branch has `statement_timeout = 0`.
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
import { broadcasts, type NewBroadcastRow } from '@/modules/broadcasts/infrastructure/schema';
import { makeFakeSendStanding } from '../../helpers/eblast-approval-fakes';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const RECIPIENTS = ['dl3-a@example.com'];
const NO_BRAND = { load: async () => ({ primaryColor: null, postalAddress: null, logoUrl: null }) };

function gate(): { readonly reached: Promise<void>; readonly open: () => void; readonly wait: () => Promise<void> } {
  let reach!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((r) => (reach = r));
  const opened = new Promise<void>((r) => (open = r));
  return { reached, open, wait: async () => { reach(); await opened; } };
}

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out: ${what}`)), ms))]);
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('spec 140 s2b DL3 — the dispatch lease behind the erasure cascade\'s row lock (live Neon, chamber_app)', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
  });

  afterAll(async () => {
    await tenant?.cleanup().catch(() => {});
  });

  async function seed(patch: Partial<NewBroadcastRow> = {}): Promise<string> {
    const broadcastId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(broadcasts).values({
        tenantId: tenant.ctx.slug,
        broadcastId,
        requestedByMemberId: randomUUID(),
        requestedByMemberPlanIdSnapshot: 'plan-dl3',
        submittedByUserId: randomUUID(),
        actorRole: 'admin_proxy',
        subject: 'DL3 order',
        bodyHtml: '<p>x</p>',
        bodySource: 'x',
        fromName: 'DL3 Test',
        replyToEmail: 'reply@example.com',
        segmentType: 'all_members',
        estimatedRecipientCount: RECIPIENTS.length,
        status: 'approved',
        submittedAt: new Date(Date.now() - 86_400_000),
        approvedAt: new Date(Date.now() - 3_600_000),
        scheduledFor: new Date(Date.now() - 60_000),
        ...patch,
      }),
    );
    return broadcastId;
  }

  const readRow = (id: string) =>
    runInTenant(tenant.ctx, async (tx) =>
      (await tx.select().from(broadcasts).where(and(eq(broadcasts.tenantId, tenant.ctx.slug), eq(broadcasts.broadcastId, id))))[0]!,
    );

  function recordingResend(park: { readonly method: string; readonly gate: ReturnType<typeof gate> } | null = null) {
    const calls: string[] = [];
    const call = async (method: string) => {
      calls.push(method);
      if (park !== null && park.method === method) await park.gate.wait();
    };
    const port = {
      async createAudience() { await call('createAudience'); return { audienceId: `aud-dl3-${randomUUID().slice(0, 8)}` }; },
      async createContactImport() { await call('createContactImport'); return { importId: `imp-dl3-${randomUUID().slice(0, 8)}` }; },
      async getContactImport() {
        await call('getContactImport');
        return { status: 'completed', counts: { total: RECIPIENTS.length, created: RECIPIENTS.length, updated: 0, skipped: 0, failed: 0 } };
      },
      async getAudienceContactCount() { await call('getAudienceContactCount'); return { count: RECIPIENTS.length, complete: true }; },
      async createBroadcast() { await call('createBroadcast'); return { broadcastId: `rb-dl3-${randomUUID()}` }; },
      async sendBroadcast() { await call('sendBroadcast'); },
      async deleteBroadcast() { await call('deleteBroadcast'); },
      async deleteAudience() { await call('deleteAudience'); },
    };
    return { port, calls };
  }

  const depsFor = (gateway: unknown) => ({
    tenant: tenant.ctx,
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenant.ctx.slug),
    broadcastsGateway: gateway,
    audit: f7AuditAdapter,
    clock: { now: () => new Date() },
    tickBudget: { tickStartedAt: Date.now() },
    fromEmail: 'noreply@test.invalid-but-test-only',
    tenantDisplayName: 'Test Chamber',
    locale: 'en' as const,
    resolveRecipients: async () => ok({ recipients: RECIPIENTS, estimatedCount: RECIPIENTS.length, orphans: [], droppedByPreference: 0 }),
    membersBridge: { getMemberPrimaryContact: async () => null, getMemberPreferredLocale: async () => 'en' as const },
    emailTransactional: { sendMemberEmail: async () => undefined },
    plansBridge: { getPlanForMember: async () => ok({ planId: 'plan-dl3', planCode: 'REG', eblastPerYear: 4 }) },
    sendStanding: makeFakeSendStanding(),
    brandChrome: NO_BRAND,
    pauseBeforeReprobe: async () => {},
  });

  /**
   * The cascade's lock-then-cancel: lock the row (the same `lockForUpdate`),
   * report the lock is held, wait for `release`, then cancel as a NON-holder
   * (`lease: null`) and commit.
   */
  function cascadeHoldingTheRow(id: string, mode: 'cancel' | 'undecided' = 'cancel') {
    let markLocked!: () => void;
    const locked = new Promise<void>((r) => (markLocked = r));
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);
    const done = repo.withTx(async (tx) => {
      await repo.lockForUpdate(tx, tenant.ctx.slug, asBroadcastId(id));
      markLocked();
      await released;
      // An undecided cascade (cell 18) writes nothing and lets the lock go.
      if (mode === 'undecided') return;
      await repo.applyTransition(
        tx,
        tenant.ctx.slug,
        asBroadcastId(id),
        'cancelled',
        { cancelledAt: new Date(), cancelledByUserId: null, cancellationReason: 'gdpr_erasure_request' },
        'approved',
        null,
      );
    });
    return { locked, release, done };
  }

  it('row 16 — the claim waits behind an erasure\'s row lock, then skips the cancelled row: no lease, no Resend call', async () => {
    const id = await seed();
    const cascade = cascadeHoldingTheRow(id);
    await within(cascade.locked, 20_000, 'the cascade taking the row lock');
    const resend = recordingResend();

    let tickDone = false;
    const tickP = buildAudienceTick(depsFor(resend.port) as never, { broadcastId: asBroadcastId(id) }).then((r) => {
      tickDone = true;
      return r;
    });
    await pause(750);
    expect(tickDone).toBe(false);
    cascade.release();
    await within(cascade.done, 20_000, 'the cascade committing');
    const tick = await within(tickP, 20_000, 'the tick after the cascade');

    expect(tick).toEqual({ ok: false, error: { kind: 'broadcast_invalid_state_transition', observedStatus: 'cancelled' } });
    expect(resend.calls).toEqual([]);
    const row = await readRow(id);
    expect(row.status).toBe('cancelled');
    expect(row.dispatchLeaseToken).toBeNull();
  });

  // Spec 140 s2b review round 1 (spec L3) — cell 16 with a live FOREIGN lease
  // on the row: the claim still waits behind the lock, reads `cancelled`, and
  // the cancel (a non-holder status change) cleared the foreign lease.
  it('row 16, live-other — a row an earlier tick holds: the claim waits behind the erasure lock, then skips the cancelled row', async () => {
    const id = await seed({ dispatchLeaseToken: randomUUID(), dispatchLeaseExpiresAt: new Date(Date.now() + 120_000) });
    const cascade = cascadeHoldingTheRow(id);
    await within(cascade.locked, 20_000, 'the cascade taking the row lock');
    const resend = recordingResend();
    let tickDone = false;
    const tickP = buildAudienceTick(depsFor(resend.port) as never, { broadcastId: asBroadcastId(id) }).then((r) => {
      tickDone = true;
      return r;
    });
    await pause(750);
    expect(tickDone).toBe(false);
    cascade.release();
    await within(cascade.done, 20_000, 'the cascade committing');
    const tick = await within(tickP, 20_000, 'the tick after the cascade');
    expect(tick).toEqual({ ok: false, error: { kind: 'broadcast_invalid_state_transition', observedStatus: 'cancelled' } });
    expect(resend.calls).toEqual([]);
    const row = await readRow(id);
    expect(row.status).toBe('cancelled');
    expect(row.dispatchLeaseToken).toBeNull();
  });

  // Spec 140 s2b review round 1 (spec M2) — cell 18: a cascade that decides
  // nothing (undecided at Resend) writes nothing; the holder's lease is
  // untouched, its check waits behind the lock and then holds, and it goes on.
  it('cell 18 — an undecided cascade leaves the lease and the holder continues', async () => {
    const id = await seed({
      resendAudienceId: `aud-dl3-${randomUUID().slice(0, 8)}`,
      audienceImportId: `imp-dl3-${randomUUID().slice(0, 8)}`,
      audienceImportSubmittedAt: new Date(Date.now() - 120_000),
    });
    const parkPoll = gate();
    const resend = recordingResend({ method: 'getContactImport', gate: parkPoll });
    const tickP = buildAudienceTick(depsFor(resend.port) as never, { broadcastId: asBroadcastId(id) });
    await within(parkPoll.reached, 20_000, 'the tick reaching its poll');
    const claimed = (await readRow(id)).dispatchLeaseToken;
    expect(claimed).not.toBeNull();

    const cascade = cascadeHoldingTheRow(id, 'undecided');
    await within(cascade.locked, 20_000, 'the cascade taking the row lock');
    parkPoll.open();
    await pause(1_500);
    expect(resend.calls).not.toContain('createBroadcast');
    // Under the cascade's lock the lease is still the holder's (a plain read).
    expect((await readRow(id)).dispatchLeaseToken).toBe(claimed);
    cascade.release();
    await within(cascade.done, 20_000, 'the cascade committing');
    const tick = await within(tickP, 20_000, 'the tick after the cascade');

    expect(tick.ok ? tick.value.kind : tick.error).toBe('sent');
    expect(resend.calls).toContain('createBroadcast');
    expect(resend.calls).toContain('sendBroadcast');
    const row = await readRow(id);
    expect(row.status).toBe('sending');
    expect(row.dispatchLeaseToken).toBeNull();
  });

  it('row 17 — a cascade cancel mid-tick ends the holder: its pre-call check waits behind the lock, reads the lease cleared, and makes no call', async () => {
    const id = await seed({
      resendAudienceId: `aud-dl3-${randomUUID().slice(0, 8)}`,
      audienceImportId: `imp-dl3-${randomUUID().slice(0, 8)}`,
      audienceImportSubmittedAt: new Date(Date.now() - 120_000),
    });
    const parkPoll = gate();
    const resend = recordingResend({ method: 'getContactImport', gate: parkPoll });

    // The tick claims (its step-1 tx commits) and parks on its first poll.
    const tickP = buildAudienceTick(depsFor(resend.port) as never, { broadcastId: asBroadcastId(id) });
    await within(parkPoll.reached, 20_000, 'the tick reaching its poll');
    expect((await readRow(id)).dispatchLeaseToken).not.toBeNull();

    // The cascade locks the row while the tick is mid-way.
    const cascade = cascadeHoldingTheRow(id);
    await within(cascade.locked, 20_000, 'the cascade taking the row lock');
    parkPoll.open();
    // The tick polls, re-resolves, counts, and reaches its check before
    // createBroadcast — which waits on the cascade's row lock.
    await pause(1_500);
    expect(resend.calls).not.toContain('createBroadcast');
    cascade.release();
    await within(cascade.done, 20_000, 'the cascade committing');
    const tick = await within(tickP, 20_000, 'the tick after the cascade');

    expect(tick).toEqual({ ok: false, error: { kind: 'broadcast_invalid_state_transition', observedStatus: 'lease_lost' } });
    expect(resend.calls).not.toContain('createBroadcast');
    expect(resend.calls).not.toContain('sendBroadcast');
    const row = await readRow(id);
    expect(row.status).toBe('cancelled');
    expect(row.dispatchLeaseToken).toBeNull();
    expect(row.resendBroadcastId).toBeNull();
  });
});
