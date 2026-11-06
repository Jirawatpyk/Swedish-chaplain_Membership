/**
 * PR #756 review rounds 2 and 3 — the `broadcast_resend_drift_check_unverifiable`
 * row on live Postgres (Neon `dev`). The maintainer's /verify could not force a
 * failed audience count on the Resend sink, so until this file the row had only
 * unit evidence.
 *
 * `buildAudienceTick` runs through the REAL composition root
 * (`makeBuildAudienceTickDeps`: the real repo, the real F7 audit adapter, the
 * real send-standing reads) on a row already at tick 2: `approved`, its audience
 * built and its import submitted. Three deps are replaced:
 *
 *   - the gateway, a recording fake (never real Resend: dev and prod share the
 *     Resend Broadcasts key): the import is `completed` with counts that match,
 *     the audience COUNT throws a retryable `server_5xx` `GatewayThrowable`,
 *     and `sendBroadcast` succeeds (case 1) or throws retryable (case 2);
 *   - `resolveRecipients`, so the counts can match without seeding contacts
 *     (the audience query has its own suites);
 *   - `brandChrome`, a no-brand stub.
 *
 * Since round 3 the row is written BEFORE `/send`, once per broadcast (the
 * first failed attempt), with the real `EXISTS` dedupe read on `audit_log`:
 *
 *   - case 1: the send goes out → one row naming the id that was sent,
 *     `errorReason: 'server_5xx'`, no provider text; the row reaches `sending`;
 *   - case 2: the send fails retryably → still one row (the attempt happened);
 *   - case 3: two ticks whose counts both fail → one row.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, runInTenant } from '@/lib/db';
import { ok } from '@/lib/result';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { asBroadcastId } from '@/modules/broadcasts';
import { buildAudienceTick } from '@/modules/broadcasts/application/use-cases/build-audience-tick';
import type { BroadcastsGatewayPort } from '@/modules/broadcasts/application/ports/broadcasts-gateway-port';
import { makeBuildAudienceTickDeps } from '@/modules/broadcasts/infrastructure/broadcasts-deps';
import { GatewayThrowable } from '@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway';
import { broadcasts } from '@/modules/broadcasts/infrastructure/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { seedLiveRequester } from '../helpers/seed-live-requester';

const NO_BRAND = { load: async () => ({ primaryColor: null, postalAddress: null, logoUrl: null }) };
/** Synthetic and unroutable (RFC 2606). */
const RECIPIENTS = ['unverifiable-a@example.com', 'unverifiable-b@example.com'];

function fakeGateway(send: 'ok' | 'retryable'): { calls: string[]; sends: string[]; port: BroadcastsGatewayPort } {
  const calls: string[] = [];
  const sends: string[] = [];
  const port = {
    async getContactImport() {
      calls.push('getContactImport');
      return { status: 'completed', counts: { total: RECIPIENTS.length, created: RECIPIENTS.length, updated: 0, skipped: 0, failed: 0 } };
    },
    async getAudienceContactCount() {
      calls.push('getAudienceContactCount');
      throw new GatewayThrowable({ kind: 'retryable', subKind: 'server_5xx', reason: 'resend 503 for unverifiable-a@example.com' });
    },
    async createBroadcast() {
      calls.push('createBroadcast');
      return { broadcastId: `rb-unverifiable-${randomUUID()}` };
    },
    // A later tick inherits the persisted draft: Resend reports it `draft`, so
    // the tick reuses it rather than minting (round 4: the two-tick case must
    // reach the send on BOTH ticks, not stop at an unanswered probe).
    async retrieveBroadcast(id: string) {
      calls.push('retrieveBroadcast');
      return { kind: 'present', resource: { id, status: 'draft', sentAt: null } };
    },
    async sendBroadcast(id: string) {
      calls.push('sendBroadcast');
      sends.push(id);
      if (send === 'retryable') {
        throw new GatewayThrowable({ kind: 'retryable', subKind: 'server_5xx', reason: 'resend 503 on send' });
      }
    },
  };
  // Any other method throws, so an unexpected call fails the case by itself.
  const guarded = new Proxy(port, {
    get: (target, prop) =>
      prop in target || prop === 'then'
        ? (target as Record<string | symbol, unknown>)[prop]
        : async () => {
            calls.push(String(prop));
            throw new Error(`gateway.${String(prop)} must not be called here`);
          },
  }) as unknown as BroadcastsGatewayPort;
  return { calls, sends, port: guarded };
}

describe('PR #756 rounds 2–4 — the unverifiable-count audit row (live Neon)', () => {
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

  async function seedTick2Row(): Promise<string> {
    const broadcastId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(broadcasts).values({
        tenantId: tenant.ctx.slug,
        broadcastId,
        requestedByMemberId: requester.memberId,
        requestedByMemberPlanIdSnapshot: requester.planId,
        submittedByUserId: randomUUID(),
        actorRole: 'member_self_service',
        subject: 'Unverifiable count',
        bodyHtml: '<p>Body</p>',
        bodySource: 'plain',
        fromName: 'Unverifiable Co via Test Chamber',
        replyToEmail: 'reply@example.com',
        segmentType: 'all_members',
        estimatedRecipientCount: RECIPIENTS.length,
        status: 'approved',
        submittedAt: new Date(Date.now() - 86_400_000),
        approvedAt: new Date(Date.now() - 3_600_000),
        scheduledFor: new Date(Date.now() - 60_000),
        resendAudienceId: randomUUID(),
        audienceImportId: `imp-unverifiable-${randomUUID()}`,
        audienceImportSubmittedAt: new Date(Date.now() - 300_000),
      }),
    );
    return broadcastId;
  }

  const tick = async (id: string, gateway: BroadcastsGatewayPort) =>
    buildAudienceTick(
      {
        ...(await makeBuildAudienceTickDeps(tenant.ctx.slug, { tickStartedAt: Date.now() })),
        broadcastsGateway: gateway,
        brandChrome: NO_BRAND,
        resolveRecipients: async () =>
          ok({ recipients: RECIPIENTS, estimatedCount: RECIPIENTS.length, orphans: [], droppedByPreference: 0 }),
      },
      { broadcastId: asBroadcastId(id) },
    );

  const unverifiableRows = (id: string) =>
    db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          // A DB_ONLY_AUDIT_EVENT_TYPES value: the auth pgEnum tuple does not list
          // it, so the literal is cast (the value is in the live enum).
          eq(auditLog.eventType, 'broadcast_resend_drift_check_unverifiable' as never),
          sql`${auditLog.payload}->>'broadcastId' = ${id}`,
        ),
      );

  const readRow = (id: string) =>
    runInTenant(tenant.ctx, async (tx) =>
      (await tx.select().from(broadcasts).where(and(eq(broadcasts.tenantId, tenant.ctx.slug), eq(broadcasts.broadcastId, id))))[0]!,
    );

  it('a failed count and a send that went out → one row naming the sent id, errorReason server_5xx, the row sending', async () => {
    const id = await seedTick2Row();
    const gw = fakeGateway('ok');

    const r = await tick(id, gw.port);

    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(gw.sends).toHaveLength(1);
    const sentId = gw.sends[0]!;
    expect(gw.calls).toEqual(['getContactImport', 'getAudienceContactCount', 'createBroadcast', 'sendBroadcast']);
    expect(await readRow(id)).toMatchObject({ status: 'sending', resendBroadcastId: sentId });

    const rows = await unverifiableRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({
      broadcastId: id,
      resendBroadcastId: sentId,
      errorReason: 'server_5xx',
      expectedRecipientCount: RECIPIENTS.length,
    });
    // The exact provider text, never a bare '503': that is a random UUID's hex
    // about 2 % of the time (round 3, reliability M).
    expect(JSON.stringify(rows[0]!.payload)).not.toContain('resend 503 for unverifiable-a@example.com');
    expect(JSON.stringify(rows[0]!.payload)).not.toContain('example.com');
  });

  it('a failed count and a send that failed retryably → one row (the attempt), the row still approved', async () => {
    const id = await seedTick2Row();
    const gw = fakeGateway('retryable');

    const r = await tick(id, gw.port);

    expect(r.ok).toBe(false);
    expect(gw.sends).toHaveLength(1);
    const rows = await unverifiableRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ errorReason: 'server_5xx', resendBroadcastId: gw.sends[0] });
    expect(rows[0]!.summary).toMatch(/membership check could not be read on a dispatch attempt/);
    expect((await readRow(id)).status).toBe('approved');
  });

  it('two ticks whose counts both fail on the same draft → one row for it', async () => {
    const id = await seedTick2Row();
    const first = fakeGateway('retryable');
    const second = fakeGateway('retryable');

    await tick(id, first.port);
    await tick(id, second.port);

    // Both ticks reached `/send` with the same draft: the second one reused it.
    expect(first.sends).toHaveLength(1);
    expect(second.sends).toEqual(first.sends);
    const rows = await unverifiableRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ resendBroadcastId: first.sends[0] });
  });
});
