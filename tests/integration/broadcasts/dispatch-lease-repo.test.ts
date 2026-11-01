/**
 * Spec 140 s2b — the dispatch lease on the Drizzle broadcasts repo, live Neon.
 *
 * The import tick CLAIMS an `approved` row (a fencing token + an expiry), checks
 * the lease before every irreversible Resend call, carries the token in every
 * write it makes, and releases it at the end. Migration 0322 holds the columns.
 *
 * State-table rows (plan.md § Slice 2, the state table):
 *   1   claim on an unleased approved row returns a token
 *   2   claim takes over an expired lease (a new token)
 *   3   (repo half) claim on a live foreign lease answers null — `lease_held`
 *   4   claim refuses a non-approved row
 *   7   a stale holder: every writer refuses its token, each with its own
 *       lost-signal (A3), and no column moves (DL2)
 *   14  release clears only my token, at any status; 0 rows is not an error
 *   20  a non-holder status change (`applyTransition` with `lease: null`)
 *       clears the lease
 *   21  a same-status write (a re-time) keeps it
 * plus the pre-call check (`held` / `expiring` / `lost`), the legacy leg's
 * live-lease read (cell 23's repo half), and DL4: two tenants holding the SAME
 * broadcast uuid — claim and release touch only their own row through the
 * repo (as `chamber_app`), and the statement builders on the BYPASSRLS owner
 * prove the application predicate alone keeps tenant B out.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, runInTenant } from '@/lib/db';
import { asBroadcastId, type BroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { BroadcastConcurrentMutationError } from '@/modules/broadcasts/application/ports/broadcasts-repo';
import {
  checkDispatchLeaseStatement,
  claimDispatchLeaseStatement,
  hasLiveDispatchLeaseStatement,
  makeDrizzleBroadcastsRepo,
  releaseDispatchLeaseStatement,
} from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { broadcasts, type NewBroadcastRow } from '@/modules/broadcasts/infrastructure/schema';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

const TTL_MS = 330_000;
const SEED_AT = new Date('2026-10-01T03:00:00Z');

type Row = typeof broadcasts.$inferSelect;

describe('spec 140 s2b — the dispatch lease on the broadcasts repo (live Neon)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  beforeAll(async () => {
    const t = await createTwoTestTenants();
    tenantA = t.a;
    tenantB = t.b;
  });

  afterAll(async () => {
    await tenantA?.cleanup().catch(() => {});
    await tenantB?.cleanup().catch(() => {});
  });

  async function seed(tenant: TestTenant, patch: Partial<NewBroadcastRow> = {}): Promise<BroadcastId> {
    const broadcastId = patch.broadcastId ?? randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(broadcasts).values({
        tenantId: tenant.ctx.slug,
        broadcastId,
        requestedByMemberId: randomUUID(),
        requestedByMemberPlanIdSnapshot: 'plan-140-s2b',
        submittedByUserId: randomUUID(),
        actorRole: 'admin_proxy',
        subject: '140 s2b lease',
        bodyHtml: '<p>x</p>',
        bodySource: 'x',
        fromName: 'Chamber',
        replyToEmail: 'reply@example.com',
        segmentType: 'all_members',
        estimatedRecipientCount: 1,
        status: 'approved',
        submittedAt: SEED_AT,
        approvedAt: SEED_AT,
        scheduledFor: SEED_AT,
        ...patch,
      }),
    );
    return asBroadcastId(broadcastId);
  }

  /** A live lease held by someone else (`expires` in the future), or an expired one. */
  const foreignLease = (msFromNow: number) => ({
    dispatchLeaseToken: randomUUID(),
    dispatchLeaseExpiresAt: new Date(Date.now() + msFromNow),
  });

  const readRow = (tenant: TestTenant, id: BroadcastId): Promise<Row> =>
    runInTenant(tenant.ctx, async (tx) =>
      (await tx
        .select()
        .from(broadcasts)
        .where(and(eq(broadcasts.tenantId, tenant.ctx.slug), eq(broadcasts.broadcastId, id))))[0]!,
    );

  const repoA = () => makeDrizzleBroadcastsRepo(tenantA.ctx.slug);

  describe('claim', () => {
    it('row 1 — an unleased approved row: a token, and an expiry about TTL from now', async () => {
      const id = await seed(tenantA);
      const before = Date.now();
      const token = await repoA().withTx((tx) => repoA().claimDispatchLease(tx, tenantA.ctx.slug, id, TTL_MS));
      expect(token).toMatch(/^[0-9a-f-]{36}$/);
      const row = await readRow(tenantA, id);
      expect(row.dispatchLeaseToken).toBe(token);
      const expires = row.dispatchLeaseExpiresAt!.getTime();
      expect(expires).toBeGreaterThan(before + TTL_MS - 10_000);
      expect(expires).toBeLessThan(Date.now() + TTL_MS + 10_000);
    });

    it('row 2 — an expired lease is taken over with a NEW token', async () => {
      const stale = foreignLease(-60_000);
      const id = await seed(tenantA, stale);
      const token = await repoA().withTx((tx) => repoA().claimDispatchLease(tx, tenantA.ctx.slug, id, TTL_MS));
      expect(token).not.toBeNull();
      expect(token).not.toBe(stale.dispatchLeaseToken);
      expect((await readRow(tenantA, id)).dispatchLeaseToken).toBe(token);
    });

    it('row 3 (repo half) — a live foreign lease answers null and the lease is untouched', async () => {
      const live = foreignLease(120_000);
      const id = await seed(tenantA, live);
      const before = await readRow(tenantA, id);
      const token = await repoA().withTx((tx) => repoA().claimDispatchLease(tx, tenantA.ctx.slug, id, TTL_MS));
      expect(token).toBeNull();
      expect(await readRow(tenantA, id)).toEqual(before);
    });

    it('row 4 — a non-approved row is never claimed', async () => {
      const id = await seed(tenantA, { status: 'cancelled', cancelledAt: SEED_AT });
      const token = await repoA().withTx((tx) => repoA().claimDispatchLease(tx, tenantA.ctx.slug, id, TTL_MS));
      expect(token).toBeNull();
      expect((await readRow(tenantA, id)).dispatchLeaseToken).toBeNull();
    });
  });

  describe('the pre-call check', () => {
    it('held when the token is mine and the lease outlives the headroom; expiring inside it; lost on another token or none', async () => {
      const id = await seed(tenantA);
      const repo = repoA();
      const token = (await repo.withTx((tx) => repo.claimDispatchLease(tx, tenantA.ctx.slug, id, 60_000)))!;
      const check = (lease: string, headroomMs: number) =>
        repo.withTx((tx) => repo.checkDispatchLease(tx, tenantA.ctx.slug, id, lease as never, headroomMs));
      expect(await check(token, 25_000)).toBe('held');
      expect(await check(token, 90_000)).toBe('expiring');
      expect(await check(randomUUID(), 25_000)).toBe('lost');
      await repo.withTx((tx) => repo.releaseDispatchLease(tx, tenantA.ctx.slug, id, token));
      expect(await check(token, 25_000)).toBe('lost');
    });

    // Review round 1 (reliability L2) — the check waits at most
    // `CHECK_LOCK_TIMEOUT_MS` (E + 5 s) for the row lock; lowered here so the
    // test does not wait 28 s. A timeout throws, which the tick answers as
    // `lease_check_failed` (retryable, no call).
    it('a check behind a lock held longer than its lock_timeout fails (55P03), so the tick answers lease_check_failed', async () => {
      const id = await seed(tenantA, foreignLease(120_000));
      const repo = repoA();
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      let markLocked!: () => void;
      const locked = new Promise<void>((r) => (markLocked = r));
      const holder = repo.withTx(async (tx) => {
        await repo.lockForUpdate(tx, tenantA.ctx.slug, id);
        markLocked();
        await released;
      });
      await locked;
      try {
        const started = Date.now();
        const thrown = await runInTenant(tenantA.ctx, (tx) =>
          checkDispatchLeaseStatement(tx as never, tenantA.ctx.slug, id, randomUUID() as never, 25_000, 500),
        ).then(
          () => null,
          (e: unknown) => e,
        );
        expect(thrown).not.toBeNull();
        expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object)) + String((thrown as { cause?: unknown }).cause?.toString?.())).toMatch(/55P03|lock timeout/i);
        expect(Date.now() - started).toBeLessThan(10_000);
      } finally {
        release();
        await holder;
      }
    });

    it('a row that is gone reads lost', async () => {
      const repo = repoA();
      const gone = asBroadcastId(randomUUID());
      expect(await repo.withTx((tx) => repo.checkDispatchLease(tx, tenantA.ctx.slug, gone, randomUUID() as never, 25_000))).toBe('lost');
    });
  });

  describe('release', () => {
    // Review round 2 (reliability LOW-1) — the release waits at most
    // `CHECK_LOCK_TIMEOUT_MS` for the row lock (lowered here to 500 ms); a
    // 55P03 is the tick's existing `lease_release_failed`, and the lease then
    // expires on its own. Bounded at 8 s: the dev branch has no
    // statement_timeout, so a release with no lock_timeout would hang.
    it('a release behind a held lock fails as lease_release_failed within its lock_timeout', async () => {
      const token = randomUUID();
      const id = await seed(tenantA, { dispatchLeaseToken: token, dispatchLeaseExpiresAt: new Date(Date.now() + 120_000) });
      const repo = repoA();
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      let markLocked!: () => void;
      const locked = new Promise<void>((r) => (markLocked = r));
      const holder = repo.withTx(async (tx) => {
        await repo.lockForUpdate(tx, tenantA.ctx.slug, id);
        markLocked();
        await released;
      });
      await locked;
      try {
        const outcome = await Promise.race([
          runInTenant(tenantA.ctx, (tx) =>
            (releaseDispatchLeaseStatement as unknown as (...a: unknown[]) => Promise<boolean>)(tx, tenantA.ctx.slug, id, token, 500),
          ).then(
            (v) => ({ kind: 'resolved' as const, v }),
            (e: unknown) => ({ kind: 'rejected' as const, e }),
          ),
          new Promise<{ kind: 'hung' }>((r) => setTimeout(() => r({ kind: 'hung' }), 8_000)),
        ]);
        expect(outcome.kind).toBe('rejected');
        const e = (outcome as { e?: unknown }).e;
        expect(JSON.stringify(e, Object.getOwnPropertyNames(e as object)) + String((e as { cause?: unknown })?.cause)).toMatch(/55P03|lock timeout/i);
      } finally {
        release();
        await holder;
      }
      // The lease is untouched; it expires on its own.
      expect((await readRow(tenantA, id)).dispatchLeaseToken).toBe(token);
    });


    it('row 14 — clears MY token at any status; a stale token is 0 rows (false), not an error, and leaves the holder alone', async () => {
      const repo = repoA();
      const mine = randomUUID();
      const sending = await seed(tenantA, {
        status: 'sending',
        sendingStartedAt: SEED_AT,
        dispatchLeaseToken: mine,
        dispatchLeaseExpiresAt: new Date(Date.now() + 60_000),
      });
      expect(await repo.withTx((tx) => repo.releaseDispatchLease(tx, tenantA.ctx.slug, sending, mine as never))).toBe(true);
      const released = await readRow(tenantA, sending);
      expect(released.dispatchLeaseToken).toBeNull();
      expect(released.dispatchLeaseExpiresAt).toBeNull();

      const theirs = foreignLease(60_000);
      const held = await seed(tenantA, theirs);
      const before = await readRow(tenantA, held);
      expect(await repo.withTx((tx) => repo.releaseDispatchLease(tx, tenantA.ctx.slug, held, randomUUID() as never))).toBe(false);
      expect(await readRow(tenantA, held)).toEqual(before);
    });
  });

  describe('the legacy leg reads a live lease (cell 23, repo half)', () => {
    it('live → true; expired or none → false', async () => {
      const repo = repoA();
      const live = await seed(tenantA, foreignLease(60_000));
      const expired = await seed(tenantA, foreignLease(-60_000));
      const none = await seed(tenantA);
      const has = (id: BroadcastId) => repo.withTx((tx) => repo.hasLiveDispatchLease(tx, tenantA.ctx.slug, id));
      expect(await has(live)).toBe(true);
      expect(await has(expired)).toBe(false);
      expect(await has(none)).toBe(false);
    });
  });

  /**
   * Row 7 / DL2 — a stale holder (its lease expired and was taken over). Each
   * writer is called twice: with a stale token (it must refuse, in its own way,
   * and move nothing — `updated_at` included) and, as the positive control,
   * with the live holder's token (it must land). Without the control a writer
   * that refused for another reason would pass the stale case.
   */
  describe('row 7 / DL2 — every writer refuses a stale token with its own signal (A3)', () => {
    type Signal = 'throws_lease_lost' | 'null' | 'false' | 'zero_rows';
    type Case = {
      readonly name: string;
      readonly seed: Partial<NewBroadcastRow>;
      readonly signal: Signal;
      readonly call: (tx: unknown, id: BroadcastId, lease: string) => Promise<unknown>;
      /** What the positive control must have written. */
      readonly landed: (row: Row) => void;
    };
    const AUD = 'aud-140-s2b';
    const IMP = 'imp-140-s2b';
    const CASES: readonly Case[] = [
      {
        name: 'attachAudienceId',
        seed: {},
        signal: 'throws_lease_lost',
        call: (tx, id, lease) => repoA().attachAudienceId(tx, tenantA.ctx.slug, id, AUD, lease as never),
        landed: (row) => expect(row.resendAudienceId).toBe(AUD),
      },
      {
        name: 'attachAudienceImport',
        seed: { resendAudienceId: AUD },
        signal: 'throws_lease_lost',
        call: (tx, id, lease) =>
          repoA().attachAudienceImport(tx, tenantA.ctx.slug, id, IMP, lease as never, { expectedResendAudienceId: AUD }),
        landed: (row) => expect(row.audienceImportId).toBe(IMP),
      },
      {
        name: 'attachBroadcastId',
        seed: {},
        signal: 'throws_lease_lost',
        call: (tx, id, lease) => repoA().attachBroadcastId(tx, tenantA.ctx.slug, id, `rb-${id}`, lease as never),
        landed: (row) => expect(row.resendBroadcastId).toBe(`rb-${row.broadcastId}`),
      },
      {
        name: 'attachResendIds',
        seed: {},
        signal: 'throws_lease_lost',
        call: (tx, id, lease) => repoA().attachResendIds(tx, tenantA.ctx.slug, id, AUD, `rb-${id}`, lease as never),
        landed: (row) => expect(row.resendBroadcastId).toBe(`rb-${row.broadcastId}`),
      },
      {
        name: "applyTransition('sending')",
        seed: {},
        signal: 'throws_lease_lost',
        call: (tx, id, lease) =>
          repoA().applyTransition(tx, tenantA.ctx.slug, id, 'sending', { sendingStartedAt: new Date() }, 'approved', lease as never),
        landed: (row) => expect(row.status).toBe('sending'),
      },
      {
        name: "applyTransition('failed_to_dispatch')",
        seed: {},
        signal: 'throws_lease_lost',
        call: (tx, id, lease) =>
          repoA().applyTransition(
            tx,
            tenantA.ctx.slug,
            id,
            'failed_to_dispatch',
            { failedToDispatchAt: new Date(), failureReason: 'provider_failed' },
            'approved',
            lease as never,
          ),
        landed: (row) => expect(row.status).toBe('failed_to_dispatch'),
      },
      {
        name: 'markAudienceImportCompleted',
        seed: { resendAudienceId: AUD, audienceImportId: IMP, audienceImportSubmittedAt: SEED_AT },
        signal: 'throws_lease_lost',
        call: (tx, id, lease) => repoA().markAudienceImportCompleted(tx, tenantA.ctx.slug, id, lease as never),
        landed: (row) => expect(row.audienceImportCompletedAt).not.toBeNull(),
      },
      {
        name: 'markDispatchRetryStarted',
        seed: {},
        signal: 'null',
        call: (tx, id, lease) => repoA().markDispatchRetryStarted(tx, tenantA.ctx.slug, id, new Date(), lease as never),
        landed: (row) => expect(row.dispatchFirstFailedAt).not.toBeNull(),
      },
      {
        name: 'releaseAudienceImport',
        seed: { resendAudienceId: AUD, audienceImportId: IMP, audienceImportSubmittedAt: SEED_AT },
        signal: 'false',
        call: (tx, id, lease) =>
          repoA().releaseAudienceImport(
            tx,
            tenantA.ctx.slug,
            id,
            { importId: IMP, resendAudienceId: AUD, resendBroadcastId: null },
            lease as never,
          ),
        landed: (row) => expect(row.audienceImportId).toBeNull(),
      },
      {
        name: 'releaseResendAudience',
        seed: { resendAudienceId: AUD },
        signal: 'false',
        call: (tx, id, lease) =>
          repoA().releaseResendAudience(tx, tenantA.ctx.slug, id, { resendAudienceId: AUD, resendBroadcastId: null }, lease as never),
        landed: (row) => expect(row.resendAudienceId).toBeNull(),
      },
      {
        name: 'clearDispatchRetryClock',
        seed: { dispatchFirstFailedAt: SEED_AT },
        signal: 'zero_rows',
        call: (tx, id, lease) => repoA().clearDispatchRetryClock(tx, tenantA.ctx.slug, id, lease as never),
        landed: (row) => expect(row.dispatchFirstFailedAt).toBeNull(),
      },
    ];

    it.each(CASES)('$name — a stale token is refused ($signal) and moves nothing; the holder\'s token lands', async (c) => {
      const holder = randomUUID();
      const lease = { dispatchLeaseToken: holder, dispatchLeaseExpiresAt: new Date(Date.now() + 120_000) };
      const id = await seed(tenantA, { ...c.seed, ...lease });
      const before = await readRow(tenantA, id);

      const stale = repoA().withTx((tx) => c.call(tx, id, randomUUID()));
      if (c.signal === 'throws_lease_lost') {
        const thrown = await stale.then(
          () => null,
          (e: unknown) => e,
        );
        expect(thrown).toBeInstanceOf(BroadcastConcurrentMutationError);
        expect((thrown as BroadcastConcurrentMutationError).observedStatus).toBe('lease_lost');
        // Review round 1 (CR#1) — and the status the probe read on the row.
        expect((thrown as BroadcastConcurrentMutationError).rowStatus).toBe(c.seed.status ?? 'approved');
      } else if (c.signal === 'null') {
        expect(await stale).toBeNull();
      } else if (c.signal === 'false') {
        expect(await stale).toBe(false);
      } else {
        await expect(stale).resolves.toBeUndefined();
      }
      expect(await readRow(tenantA, id)).toEqual(before);

      // Positive control: the live holder's token lands.
      await repoA().withTx((tx) => c.call(tx, id, holder));
      c.landed(await readRow(tenantA, id));
    });

    it('a stale holder whose row was ALSO cancelled still reads lease_lost (a cancel clears the token in the same UPDATE)', async () => {
      const id = await seed(tenantA, foreignLease(120_000));
      // A non-holder cancel (lease: null) — row 20's write.
      await repoA().withTx((tx) =>
        repoA().applyTransition(
          tx,
          tenantA.ctx.slug,
          id,
          'cancelled',
          { cancelledAt: new Date(), cancelledByUserId: null, cancellationReason: 'staff' },
          'approved',
          null,
        ),
      );
      const thrown = await repoA()
        .withTx((tx) => repoA().attachAudienceId(tx, tenantA.ctx.slug, id, AUD, randomUUID() as never))
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect((thrown as BroadcastConcurrentMutationError).observedStatus).toBe('lease_lost');
      expect((thrown as BroadcastConcurrentMutationError).rowStatus).toBe('cancelled');
    });
  });

  // Review round 1 (CR#2, reliability L1) — the completion stamp runs after
  // `/send`: the mail is out, so the token guards nothing once the row says so.
  // A webhook's `sending → sent` (a non-holder status change) clears the lease
  // before the stamp; the stamp must still land.
  describe('the completion stamp after /send', () => {
    it.each([
      ['sent', { status: 'sent' as const, sendingStartedAt: SEED_AT, sentAt: SEED_AT, quotaYearConsumed: 2026, quotaConsumedAt: SEED_AT }],
      ['sending', { status: 'sending' as const, sendingStartedAt: SEED_AT }],
      // Review round 2 (spec L-e) — the fence admits every SENDING_STARTED status.
      ['partially_sent', { status: 'partially_sent' as const, sendingStartedAt: SEED_AT }],
      ['partial_delivery_accepted', { status: 'partial_delivery_accepted' as const, sendingStartedAt: SEED_AT, quotaYearConsumed: 2026, quotaConsumedAt: SEED_AT, partialDeliveryAcceptedAt: SEED_AT }],
    ])('a webhook %s-transition before the stamp still lets the stamp land (no lease on the row)', async (_label, statusPatch) => {
      const id = await seed(tenantA, {
        ...statusPatch,
        resendAudienceId: 'aud-stamp',
        audienceImportId: 'imp-stamp',
        audienceImportSubmittedAt: SEED_AT,
      });
      await repoA().withTx((tx) => repoA().markAudienceImportCompleted(tx, tenantA.ctx.slug, id, randomUUID() as never));
      expect((await readRow(tenantA, id)).audienceImportCompletedAt).not.toBeNull();
    });
  });

  describe('non-holder writes', () => {
    it('row 20 — a status change with lease: null clears both lease columns', async () => {
      const id = await seed(tenantA, foreignLease(120_000));
      await repoA().withTx((tx) =>
        repoA().applyTransition(
          tx,
          tenantA.ctx.slug,
          id,
          'cancelled',
          { cancelledAt: new Date(), cancelledByUserId: null, cancellationReason: 'staff' },
          'approved',
          null,
        ),
      );
      const row = await readRow(tenantA, id);
      expect(row.status).toBe('cancelled');
      expect(row.dispatchLeaseToken).toBeNull();
      expect(row.dispatchLeaseExpiresAt).toBeNull();
    });

    it('row 21 — a same-status write without scheduledFor keeps the lease', async () => {
      const lease = foreignLease(120_000);
      const id = await seed(tenantA, lease);
      await repoA().withTx((tx) =>
        repoA().applyTransition(tx, tenantA.ctx.slug, id, 'approved', { estimatedRecipientCount: 2 }, 'approved', null),
      );
      const row = await readRow(tenantA, id);
      expect(row.dispatchLeaseToken).toBe(lease.dispatchLeaseToken);
      expect(row.dispatchLeaseExpiresAt).toEqual(lease.dispatchLeaseExpiresAt);
    });

    // Review round 2 (reliability MED-1; supersedes round 1's "a re-time
    // clears the lease") — a re-time cannot land while a tick holds the row:
    // the holder may already have sent at the old time. A held row answers
    // 0 rows (the caller's concurrent-mutation answer); once the lease has
    // expired the re-time is admitted and leaves the (dead) lease alone.
    it('a same-status re-time is refused while a live lease is held, and allowed once it expired', async () => {
      const later = new Date(Date.now() + 3_600_000);
      const live = foreignLease(120_000);
      const held = await seed(tenantA, live);
      const before = await readRow(tenantA, held);
      const thrown = await repoA()
        .withTx((tx) => repoA().applyTransition(tx, tenantA.ctx.slug, held, 'approved', { scheduledFor: later }, 'approved', null))
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(thrown).toBeInstanceOf(BroadcastConcurrentMutationError);
      expect(await readRow(tenantA, held)).toEqual(before);

      const dead = foreignLease(-60_000);
      const expired = await seed(tenantA, dead);
      await repoA().withTx((tx) =>
        repoA().applyTransition(tx, tenantA.ctx.slug, expired, 'approved', { scheduledFor: later }, 'approved', null),
      );
      const row = await readRow(tenantA, expired);
      expect(row.scheduledFor).toEqual(later);
      expect(row.dispatchLeaseToken).toBe(dead.dispatchLeaseToken);
    });

    // Review round 3 (code-review #2, #3) — the refusal names itself, so a
    // caller can tell "a tick is at work" from status drift.
    it('a refused re-time reports observedStatus lease_held; status drift keeps the status it expected', async () => {
      const later = new Date(Date.now() + 3_600_000);
      const held = await seed(tenantA, foreignLease(120_000));
      const refused = await repoA()
        .withTx((tx) => repoA().applyTransition(tx, tenantA.ctx.slug, held, 'approved', { scheduledFor: later }, 'approved', null))
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect((refused as BroadcastConcurrentMutationError).observedStatus).toBe('lease_held');
      expect((refused as BroadcastConcurrentMutationError).rowStatus).toBe('approved');
    });

    // Review round 4 (reliability LOW-2) — drift names the status the probe
    // READ, not the one the caller expected.
    it('a real drift reports the probed status', async () => {
      const later = new Date(Date.now() + 3_600_000);
      const drifted = await seed(tenantA, {});
      const drift = await repoA()
        .withTx((tx) =>
          repoA().applyTransition(tx, tenantA.ctx.slug, drifted, 'member_approved', { scheduledFor: later }, 'member_approved', null),
        )
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(drift).toBeInstanceOf(BroadcastConcurrentMutationError);
      expect((drift as BroadcastConcurrentMutationError).observedStatus).toBe('approved');
    });
  });

  describe('DL4 — two tenants, one broadcast uuid', () => {
    it('claim and release through the repo (chamber_app) touch only their own tenant\'s row', async () => {
      const shared = randomUUID();
      const idA = await seed(tenantA, { broadcastId: shared });
      const theirs = foreignLease(120_000);
      const idB = await seed(tenantB, { broadcastId: shared, ...theirs });
      const beforeB = await readRow(tenantB, idB);

      const token = await repoA().withTx((tx) => repoA().claimDispatchLease(tx, tenantA.ctx.slug, idA, TTL_MS));
      expect(token).not.toBeNull();
      expect(await readRow(tenantB, idB)).toEqual(beforeB);

      // Tenant A releasing with B's token reaches nothing (its own row holds A's).
      expect(
        await repoA().withTx((tx) => repoA().releaseDispatchLease(tx, tenantA.ctx.slug, idA, theirs.dispatchLeaseToken as never)),
      ).toBe(false);
      expect(await repoA().withTx((tx) => repoA().releaseDispatchLease(tx, tenantA.ctx.slug, idA, token!))).toBe(true);
      expect(await readRow(tenantB, idB)).toEqual(beforeB);
    });

    it('the statement builders on the BYPASSRLS owner: the tenant predicate alone keeps tenant B\'s row out', async () => {
      const shared = randomUUID();
      const idA = await seed(tenantA, { broadcastId: shared });
      const idB = await seed(tenantB, { broadcastId: shared });
      const token = await claimDispatchLeaseStatement(db as never, tenantA.ctx.slug, idA, TTL_MS);
      expect(token).not.toBeNull();
      expect((await readRow(tenantB, idB)).dispatchLeaseToken).toBeNull();

      // B's row, leased with A's token value (as if the token leaked), is not
      // released by tenant A's statement.
      await db.execute(sql`
        UPDATE broadcasts SET dispatch_lease_token = ${token}::uuid, dispatch_lease_expires_at = now() + interval '2 minutes'
         WHERE tenant_id = ${tenantB.ctx.slug} AND broadcast_id = ${shared}::uuid
      `);
      expect(await releaseDispatchLeaseStatement(db as never, tenantA.ctx.slug, idA, token!)).toBe(true);
      expect((await readRow(tenantB, idB)).dispatchLeaseToken).toBe(token);
      expect((await readRow(tenantA, idA)).dispatchLeaseToken).toBeNull();
    });

    // Review round 1 (security L4) — the check and the legacy leg's live-lease
    // read, on the BYPASSRLS owner too: the tenant predicate alone keeps
    // tenant B's leased row (same broadcast uuid) out.
    it('the check and hasLive statement builders on the BYPASSRLS owner read only tenant A’s row', async () => {
      const shared = randomUUID();
      const idA = await seed(tenantA, { broadcastId: shared });
      const theirs = foreignLease(120_000);
      await seed(tenantB, { broadcastId: shared, ...theirs });
      // B's token, read through tenant A's predicate: A's row holds none.
      expect(await checkDispatchLeaseStatement(db as never, tenantA.ctx.slug, idA, theirs.dispatchLeaseToken as never, 25_000)).toBe('lost');
      expect(await hasLiveDispatchLeaseStatement(db as never, tenantA.ctx.slug, idA)).toBe(false);
      // Positive control: tenant B's own predicate does see its live lease.
      expect(await checkDispatchLeaseStatement(db as never, tenantB.ctx.slug, idA, theirs.dispatchLeaseToken as never, 25_000)).toBe('held');
      expect(await hasLiveDispatchLeaseStatement(db as never, tenantB.ctx.slug, idA)).toBe(true);
    });
  });
});
