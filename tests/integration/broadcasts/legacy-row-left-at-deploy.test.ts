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
 * **The gateway is a recording fake, never real Resend**: dev and prod share the
 * Resend Broadcasts key.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInTenant } from '@/lib/db';
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

  const tick = async (id: string, gateway: BroadcastsGatewayPort) =>
    buildAudienceTick(
      {
        ...(await makeBuildAudienceTickDeps(tenant.ctx.slug, { tickStartedAt: Date.now() })),
        broadcastsGateway: gateway,
        brandChrome: NO_BRAND,
      },
      { broadcastId: asBroadcastId(id) },
    );

  it('audience id only → audience_restarted: the audience deleted, the column released, the row still approved, nothing imported', async () => {
    const audienceId = `aud-legacy-${randomUUID()}`;
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
    const audienceId = `aud-legacy-${randomUUID()}`;
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
});
