/**
 * Spec 140 s1 (US1, ED1–ED3, ED5) — the erasure cascade reaches the Resend
 * drafts its TERMINAL rows still point to, on live Postgres (Neon `dev`)
 * through the real repo and the real cascade. Only Resend is a fake, and it
 * models what was MEASURED on the live account (2026-10-29/30, `research.md`):
 *
 *   - `DELETE /broadcasts/{id}` succeeds only on a draft; a canceled, queued or
 *     sent broadcast answers 403;
 *   - after a DELETE, GET answers 404;
 *   - a cancelled queued broadcast reads `canceled` (the reader maps it to our
 *     `cancelled`).
 *
 * The row is terminal, so no dispatch tick works it and the pass takes no row
 * lock (plan.md § Complexity Tracking). The cascade is called directly in its
 * erasure mode (`onDispatchBegun: 'delete_then_cancel'`), as DE3 does; that
 * `member_erased` carries the two counts and is withheld on an unexpected
 * answer is pinned in the members unit suite (`erase-member.test.ts`), so this
 * file stops at the cascade's output (plan.md § Evidence notes).
 *
 * The cross-tenant case seeds tenant B's terminal row for the SAME member uuid
 * and the SAME broadcast uuid: the list under tenant A must not see it, and its
 * draft must not be deleted. `neondb_owner` has BYPASSRLS, so what this proves
 * is the method's explicit `tenant_id` predicate.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, runInTenant } from '@/lib/db';
import {
  asBroadcastId,
  cancelInFlightBroadcastsForMember,
  makeCancelInFlightBroadcastsForMemberDeps,
} from '@/modules/broadcasts';
import { asMemberId } from '@/modules/members';
import type { BroadcastsGatewayPort } from '@/modules/broadcasts/application/ports/broadcasts-gateway-port';
import { BroadcastConcurrentMutationError } from '@/modules/broadcasts/application/ports/broadcasts-repo';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { broadcasts, type NewBroadcastRow } from '@/modules/broadcasts/infrastructure/schema';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

type ResendState = 'draft' | 'canceled' | 'queued' | 'deleted';

/**
 * Resend, as MEASURED. `retryableDeletes` answers that many DELETEs
 * `retryable` before behaving (a 5xx / the 10 s timeout).
 */
function fakeResend(opts: { retryableDeletes?: number } = {}) {
  const state = new Map<string, ResendState>();
  const deletes: string[] = [];
  const probes: string[] = [];
  let retryable = opts.retryableDeletes ?? 0;
  const port = {
    async deleteBroadcastOnce(id: string) {
      deletes.push(id);
      if (retryable > 0) {
        retryable -= 1;
        return { kind: 'retryable' as const };
      }
      const s = state.get(id);
      if (s === undefined || s === 'deleted') return { kind: 'absent' as const };
      if (s !== 'draft') return { kind: 'forbidden' as const };
      state.set(id, 'deleted');
      return { kind: 'deleted' as const };
    },
    async retrieveBroadcastOnce(id: string) {
      probes.push(id);
      const s = state.get(id);
      if (s === undefined || s === 'deleted') return { kind: 'not_found' as const };
      // The reader maps Resend's one-L `canceled` to our `cancelled`.
      return { kind: 'present' as const, status: s === 'canceled' ? ('cancelled' as const) : s };
    },
  } satisfies Pick<BroadcastsGatewayPort, 'deleteBroadcastOnce' | 'retrieveBroadcastOnce'>;
  return { port, state, deletes, probes };
}

describe('spec 140 s1 — the erasure cascade deletes the drafts its terminal rows point to (live Neon)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  beforeAll(async () => {
    const t = await createTwoTestTenants();
    tenantA = t.a;
    tenantB = t.b;
  }, 120_000);

  afterAll(async () => {
    await tenantA?.cleanup().catch(() => {});
    await tenantB?.cleanup().catch(() => {});
  }, 120_000);

  async function seed(tenant: TestTenant, row: Partial<NewBroadcastRow> & { memberId: string; broadcastId?: string }): Promise<string> {
    const { memberId, broadcastId = randomUUID(), ...patch } = row;
    const sent = patch.status === 'sent';
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(broadcasts).values({
        tenantId: tenant.ctx.slug,
        broadcastId,
        requestedByMemberId: memberId,
        requestedByMemberPlanIdSnapshot: 'plan-test',
        submittedByUserId: randomUUID(),
        actorRole: 'member_self_service',
        subject: 'Pre-scrub subject',
        bodyHtml: '<p>Pre-scrub body</p>',
        bodySource: 'plain',
        fromName: 'ED Co via Test Chamber',
        replyToEmail: 'reply@example.com',
        segmentType: 'all_members',
        estimatedRecipientCount: 1,
        status: 'failed_to_dispatch',
        submittedAt: new Date(Date.now() - 86_400_000),
        // The broadcasts_quota_year_only_on_sent CHECK: non-null iff `sent`.
        ...(sent ? { quotaYearConsumed: new Date().getFullYear(), quotaConsumedAt: new Date() } : {}),
        ...patch,
      }),
    );
    return broadcastId;
  }

  const readRow = (tenant: TestTenant, id: string) =>
    runInTenant(tenant.ctx, async (tx) =>
      (await tx.select().from(broadcasts).where(and(eq(broadcasts.tenantId, tenant.ctx.slug), eq(broadcasts.broadcastId, id))))[0]!,
    );

  const eraseCascade = (tenant: TestTenant, memberId: string, gateway: ReturnType<typeof fakeResend>['port']) =>
    cancelInFlightBroadcastsForMember(
      { ...makeCancelInFlightBroadcastsForMemberDeps(tenant.ctx.slug), broadcastsGateway: gateway },
      {
        tenant: tenant.ctx,
        memberId: asMemberId(memberId),
        cancellationReason: 'gdpr_erasure_request',
        requestId: `ed-${randomUUID()}`,
        onDispatchBegun: 'delete_then_cancel',
      },
    );

  it("ED1 — an erased member's failed_to_dispatch draft is deleted and counted", async () => {
    const memberId = randomUUID();
    const resend = fakeResend();
    const draftId = `rb-ed1-${randomUUID()}`;
    resend.state.set(draftId, 'draft');
    const broadcastId = await seed(tenantA, { memberId, resendBroadcastId: draftId });
    // Not listed: `sent` (excluded on purpose), an empty id (not an id).
    const sentId = `rb-ed1-sent-${randomUUID()}`;
    resend.state.set(sentId, 'queued');
    await seed(tenantA, { memberId, status: 'sent', resendBroadcastId: sentId, sentAt: new Date() });
    await seed(tenantA, { memberId, status: 'rejected', resendBroadcastId: '' });

    const result = await eraseCascade(tenantA, memberId, resend.port);

    expect(result).toEqual({
      ok: true,
      value: {
        cancelledCount: 0,
        skippedConcurrentCount: 0,
        unexpectedErrorCount: 0,
        alreadySentCount: 0,
        resendDraftsCleared: 1,
        resendCopiesRetained: 0,
      },
    });
    expect(resend.deletes).toEqual([draftId]);
    // The draft answers 404 at Resend afterwards.
    expect(await resend.port.retrieveBroadcastOnce(draftId)).toEqual({ kind: 'not_found' });
    // Our row is untouched: the id stays, the status stays.
    expect(await readRow(tenantA, broadcastId)).toMatchObject({ status: 'failed_to_dispatch', resendBroadcastId: draftId });
  });

  it('ED2 — a 403 + canceled copy is counted as retained, not as already sent', async () => {
    const memberId = randomUUID();
    const resend = fakeResend();
    const canceledId = `rb-ed2-${randomUUID()}`;
    resend.state.set(canceledId, 'canceled');
    const broadcastId = await seed(tenantA, { memberId, status: 'cancelled', cancelledAt: new Date(), resendBroadcastId: canceledId });

    const result = await eraseCascade(tenantA, memberId, resend.port);

    expect(result).toEqual({
      ok: true,
      value: {
        cancelledCount: 0,
        skippedConcurrentCount: 0,
        unexpectedErrorCount: 0,
        alreadySentCount: 0,
        resendDraftsCleared: 0,
        resendCopiesRetained: 1,
      },
    });
    expect(resend.probes).toEqual([canceledId]);
    // No `already_sent` evidence row: broadcasts_already_sent_count does not move.
    const evidence = (await db.execute(sql`
      SELECT 1 FROM audit_log
       WHERE tenant_id = ${tenantA.ctx.slug}
         AND event_type = 'broadcast_concurrent_action_blocked'
         AND payload->>'broadcastId' = ${broadcastId}
    `)) as unknown as unknown[];
    expect(evidence).toHaveLength(0);
  });

  it('ED3 — a retryable answer withholds member_erased and the re-drive clears it', async () => {
    const memberId = randomUUID();
    const resend = fakeResend({ retryableDeletes: 1 });
    const draftId = `rb-ed3-${randomUUID()}`;
    resend.state.set(draftId, 'draft');
    await seed(tenantA, { memberId, resendBroadcastId: draftId });

    const first = await eraseCascade(tenantA, memberId, resend.port);
    // `unexpectedErrorCount > 0` → the adapter answers `cascade_partial_failure`
    // and `erase-member` withholds `member_erased` (members unit suite).
    expect(first).toMatchObject({ ok: true, value: { unexpectedErrorCount: 1, resendDraftsCleared: 0 } });
    expect(resend.state.get(draftId)).toBe('draft');

    const redrive = await eraseCascade(tenantA, memberId, resend.port);
    expect(redrive).toMatchObject({ ok: true, value: { unexpectedErrorCount: 0, resendDraftsCleared: 1 } });
    expect(resend.state.get(draftId)).toBe('deleted');

    // Idempotent: a third run meets the deleted draft as `absent` → cleared again.
    const again = await eraseCascade(tenantA, memberId, resend.port);
    expect(again).toMatchObject({ ok: true, value: { unexpectedErrorCount: 0, resendDraftsCleared: 1 } });
  });

  it("cross-tenant — tenant B's terminal row (same member uuid, same broadcast uuid) is neither listed nor deleted", async () => {
    const memberId = randomUUID();
    const broadcastId = randomUUID();
    const resend = fakeResend();
    const draftA = `rb-xt-a-${randomUUID()}`;
    const draftB = `rb-xt-b-${randomUUID()}`;
    resend.state.set(draftA, 'draft');
    resend.state.set(draftB, 'draft');
    await seed(tenantA, { memberId, broadcastId, resendBroadcastId: draftA });
    await seed(tenantB, { memberId, broadcastId, resendBroadcastId: draftB });

    const listed = await makeDrizzleBroadcastsRepo(tenantA.ctx.slug).listTerminalWithResendIdOwnedByMember(
      tenantA.ctx.slug,
      asMemberId(memberId),
    );
    expect(listed.map((b) => [b.tenantId, b.resendBroadcastId])).toEqual([[tenantA.ctx.slug, draftA]]);

    const result = await eraseCascade(tenantA, memberId, resend.port);
    expect(result).toMatchObject({ ok: true, value: { resendDraftsCleared: 1, unexpectedErrorCount: 0 } });
    expect(resend.deletes).toEqual([draftA]);
    expect(resend.state.get(draftB)).toBe('draft');
    expect(await readRow(tenantB, broadcastId)).toMatchObject({ status: 'failed_to_dispatch', resendBroadcastId: draftB });
  });

  it('ED5 — a non-approved row is not written by a stale attachResendIds', async () => {
    const memberId = randomUUID();
    const broadcastId = await seed(tenantA, { memberId, status: 'cancelled', cancelledAt: new Date(), resendBroadcastId: null });
    const repo = makeDrizzleBroadcastsRepo(tenantA.ctx.slug);

    const thrown = await repo
      .withTx((tx) => repo.attachResendIds(tx, tenantA.ctx.slug, asBroadcastId(broadcastId), 'aud-ed5', 'rb-ed5'))
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(BroadcastConcurrentMutationError);
    expect((thrown as BroadcastConcurrentMutationError).observedStatus).toBe('cancelled');
    expect(await readRow(tenantA, broadcastId)).toMatchObject({ status: 'cancelled', resendBroadcastId: null, resendAudienceId: null });
  });
});
