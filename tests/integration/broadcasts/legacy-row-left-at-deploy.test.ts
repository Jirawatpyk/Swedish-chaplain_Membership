/**
 * Spec 140 s4 (plan review, row 7) — a row the deleted legacy dispatch leg left
 * behind at deploy, worked by the import tick on live Postgres (Neon `dev`)
 * through the REAL composition root (`makeBuildAudienceTickDeps`: the real
 * repo, the real standing reads) with only Resend faked.
 *
 * The shape: `approved`, the requester in good standing, the legacy leg's
 * `resend_audience_id` (its own audience, filled by the per-contact push) and,
 * in the second case, the pre-send `resend_broadcast_id` it persisted — but no
 * import columns. The tick must not import into that audience (its contacts may
 * be stale): it finishes the teardown at Resend, releases both columns by CAS
 * on the real row, leaves the row `approved`, and the next tick runs a fresh
 * tick 1.
 *
 * Characterisation: this is the existing stale-audience path, so the cases
 * passed the first time they ran. They pin what the deletion relies on, against
 * the real `releaseResendAudience` CAS rather than a double.
 *
 * PR #756 review round 1 (code-review #6) — the third shape: the legacy leg had
 * already HANDED the broadcast to `/send` before the deploy. Its inherited probe
 * reads `sent` / `queued`, so the tick catches the row up to `sending` through
 * the real `advanceToSending` CAS, with no second `/send`, no
 * `failed_to_dispatch` and no member email. Also characterisation: it passed
 * the first time it ran.
 *
 * **The gateway is a recording fake, never real Resend**: dev and prod share the
 * Resend Broadcasts key.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { asBroadcastId } from '@/modules/broadcasts';
import { buildAudienceTick } from '@/modules/broadcasts/application/use-cases/build-audience-tick';
import type { BroadcastsGatewayPort } from '@/modules/broadcasts/application/ports/broadcasts-gateway-port';
import { makeBuildAudienceTickDeps } from '@/modules/broadcasts/infrastructure/broadcasts-deps';
import { broadcasts, type NewBroadcastRow } from '@/modules/broadcasts/infrastructure/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { seedLiveRequester } from '../helpers/seed-live-requester';

const NO_BRAND = { load: async () => ({ primaryColor: null, postalAddress: null, logoUrl: null }) };

/** Answers the named methods and records every call; any other method throws. */
function recordingGateway(answers: Partial<Record<keyof BroadcastsGatewayPort, unknown>>): {
  calls: Array<{ method: string; args: unknown[] }>;
  port: BroadcastsGatewayPort;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const port = new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === 'then'
          ? undefined
          : async (...args: unknown[]) => {
              calls.push({ method: String(prop), args });
              if (!(String(prop) in answers)) throw new Error(`gateway.${String(prop)} must not be called here`);
              return answers[String(prop) as keyof BroadcastsGatewayPort];
            },
    },
  ) as BroadcastsGatewayPort;
  return { calls, port };
}

describe('spec 140 s4 — a row the legacy leg left behind at deploy (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let requester: { readonly memberId: string; readonly planId: string };

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    requester = await seedLiveRequester(tenant.ctx, user.userId);
  }, 120_000);

  afterAll(async () => {
    await tenant?.cleanup().catch(() => {});
    if (user) await deleteTestUser(user).catch(() => {});
  }, 120_000);

  async function seedLegacyRow(patch: Partial<NewBroadcastRow>): Promise<string> {
    const broadcastId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(broadcasts).values({
        tenantId: tenant.ctx.slug,
        broadcastId,
        requestedByMemberId: requester.memberId,
        requestedByMemberPlanIdSnapshot: requester.planId,
        submittedByUserId: randomUUID(),
        actorRole: 'member_self_service',
        subject: 'Left behind by the legacy leg',
        bodyHtml: '<p>Body</p>',
        bodySource: 'plain',
        fromName: 'Legacy Row Co via Test Chamber',
        replyToEmail: 'reply@example.com',
        segmentType: 'all_members',
        estimatedRecipientCount: 1,
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

  const tick = async (id: string, gateway: BroadcastsGatewayPort, extra: Record<string, unknown> = {}) =>
    buildAudienceTick(
      {
        ...(await makeBuildAudienceTickDeps(tenant.ctx.slug, { tickStartedAt: Date.now() })),
        broadcastsGateway: gateway,
        brandChrome: NO_BRAND,
        ...extra,
      },
      { broadcastId: asBroadcastId(id) },
    );

  it('audience id only → audience_restarted: the audience deleted, the column released, the row still approved, nothing imported', async () => {
    const audienceId = randomUUID();
    const id = await seedLegacyRow({ resendAudienceId: audienceId });
    const gw = recordingGateway({ deleteAudience: undefined });

    const r = await tick(id, gw.port);

    expect(r).toEqual({ ok: true, value: { kind: 'audience_restarted' } });
    expect(gw.calls).toEqual([{ method: 'deleteAudience', args: [audienceId] }]);
    expect(await readRow(id)).toMatchObject({
      status: 'approved',
      resendAudienceId: null,
      resendBroadcastId: null,
      audienceImportId: null,
      dispatchLeaseToken: null,
    });
  });

  it('audience id + a draft broadcast id → audience_restarted: probed draft, the draft deleted, then the audience, both columns released', async () => {
    const audienceId = randomUUID();
    const resendBroadcastId = `rb-legacy-${randomUUID()}`;
    const id = await seedLegacyRow({ resendAudienceId: audienceId, resendBroadcastId });
    const gw = recordingGateway({
      retrieveBroadcast: { kind: 'present', resource: { id: resendBroadcastId, status: 'draft', sentAt: null } },
      deleteBroadcast: undefined,
      deleteAudience: undefined,
    });

    const r = await tick(id, gw.port);

    expect(r).toEqual({ ok: true, value: { kind: 'audience_restarted' } });
    expect(gw.calls).toEqual([
      { method: 'retrieveBroadcast', args: [resendBroadcastId] },
      { method: 'deleteBroadcast', args: [resendBroadcastId] },
      { method: 'deleteAudience', args: [audienceId] },
    ]);
    expect(await readRow(id)).toMatchObject({
      status: 'approved',
      resendAudienceId: null,
      resendBroadcastId: null,
      audienceImportId: null,
      dispatchLeaseToken: null,
    });
  });

  it.each(['sent', 'queued'] as const)(
    'audience id + a broadcast id the legacy leg HANDED (probe %s) → caught up to sending: no second /send, no failure, no member email',
    async (status) => {
      const audienceId = randomUUID();
      const resendBroadcastId = randomUUID();
      const id = await seedLegacyRow({ resendAudienceId: audienceId, resendBroadcastId });
      const sentAt = status === 'sent' ? new Date(Date.now() - 300_000).toISOString() : null;
      // Any method but the probe throws, so a second `/send`, a mint or a
      // teardown fails the case by itself.
      const gw = recordingGateway({
        retrieveBroadcast: { kind: 'present', resource: { id: resendBroadcastId, status, sentAt } },
      });
      // Every transactional email (the member's failure notice included) is a
      // call on this port; none is allowed.
      const email = recordingGateway({});

      const r = await tick(id, gw.port, { emailTransactional: email.port });

      expect(r).toEqual({ ok: true, value: { kind: 'sent', resendBroadcastId, recipientCount: 1 } });
      expect(gw.calls).toEqual([{ method: 'retrieveBroadcast', args: [resendBroadcastId] }]);
      expect(email.calls).toEqual([]);
      expect(await readRow(id)).toMatchObject({
        status: 'sending',
        resendAudienceId: audienceId,
        resendBroadcastId,
        audienceImportId: null,
        failureReason: null,
        dispatchLeaseToken: null,
      });
      const rows = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, tenant.ctx.slug), sql`${auditLog.payload}->>'broadcastId' = ${id}`));
      expect(rows.map((a) => a.eventType)).toEqual(['broadcast_send_started']);
      expect(rows[0]?.payload).toMatchObject({ handedToSendOnPriorTick: true, observedResendStatus: status, importId: null });
    },
  );
});
