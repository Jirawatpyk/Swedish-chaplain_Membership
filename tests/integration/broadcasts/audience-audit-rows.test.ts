/**
 * Spec 139 slice 2 (DA1–DA3) — the audience audit rows on live Postgres (Neon
 * `dev`).
 *
 * The two repo reads every delete site depends on:
 *
 *   - `hasAudienceDeletedAuditInTx` — the dedupe of `broadcast_audience_deleted`
 *     on the segment id, under the `broadcasts-audience-audit:` advisory lock,
 *     so a segment gets one row;
 *   - `findAudienceDisclosureInTx` — the `broadcast_audience_disclosed` row
 *     `reclaim-orphaned-audiences` copies its broadcast and requester from.
 *
 * Tenant scoping is two-layer (Principle I): `runInTenant` (FORCE RLS) AND an
 * explicit `tenant_id` predicate. The explicit one is load-bearing: the
 * `audit_log` policy also admits `tenant_id IS NULL` rows, so the NULL-tenant
 * cases fail without it; another tenant's row is hidden by RLS as well, and a
 * tx bound to another tenant is refused (`assertTenantBoundTx`).
 *
 * Fixture rows are inserted with the bare owner connection (it bypasses RLS,
 * so it can write any tenant's row and a NULL-tenant one); `audit_log` is
 * append-only, so each run leaves its rows on the dev branch (the same litter
 * class as `already-sent-evidence.test.ts`, summary `spec 139 s2 fixture`).
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
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { broadcasts } from '@/modules/broadcasts/infrastructure/schema';
import { asTenantContext } from '@/modules/tenants';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { seedLiveRequester } from '../helpers/seed-live-requester';

type AudienceEvent = 'broadcast_audience_disclosed' | 'broadcast_audience_deleted';

/** One fixture row, written with the bare owner connection (any tenant, or none). */
async function insertRow(tenantSlug: string | null, eventType: AudienceEvent, payload: Record<string, unknown>): Promise<void> {
  await db.execute(sql`
    INSERT INTO audit_log (event_type, actor_user_id, summary, request_id, payload, tenant_id, retention_years)
    VALUES (${eventType}::audit_event_type, 'system:cron', 'spec 139 s2 fixture', 'no-request-id',
            ${JSON.stringify(payload)}::jsonb, ${tenantSlug}, 5)
  `);
}

const disclosedPayload = (audienceId: string, broadcastId: string, memberId: string) => ({
  broadcast_id: broadcastId,
  related_member_id: memberId,
  resend_audience_id: audienceId,
  recipient_count: 2,
  leg: 'import',
  actor_role: 'system',
});

const deletedPayload = (audienceId: string, broadcastId: string, memberId: string) => ({
  broadcast_id: broadcastId,
  related_member_id: memberId,
  resend_audience_id: audienceId,
  reason: 'terminal_cleanup',
  leg: 'import',
  actor_role: 'system',
});

/** Synthetic and unroutable (RFC 2606). */
const RECIPIENTS = ['audience-audit-a@example.com', 'audience-audit-b@example.com'];
const NO_BRAND = { load: async () => ({ primaryColor: null, postalAddress: null, logoUrl: null }) };

describe('spec 139 s2 — the audience audit rows (live Neon)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let requester: { readonly memberId: string; readonly planId: string };

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
    tenantB = await createTestTenant('test-swecham');
    requester = await seedLiveRequester(tenantA.ctx, user.userId);
  }, 120_000);

  afterAll(async () => {
    await tenantA?.cleanup().catch(() => {});
    await tenantB?.cleanup().catch(() => {});
    if (user) await deleteTestUser(user).catch(() => {});
  }, 120_000);

  const deletedSeen = (tenant: TestTenant, audienceId: string) => {
    const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);
    return repo.withTx((tx) => repo.hasAudienceDeletedAuditInTx(tx, tenant.ctx.slug, audienceId));
  };
  const disclosureOf = (tenant: TestTenant, audienceId: string) => {
    const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);
    return repo.withTx((tx) => repo.findAudienceDisclosureInTx(tx, tenant.ctx.slug, audienceId));
  };

  describe('hasAudienceDeletedAuditInTx', () => {
    it("the tenant's own deleted row for the segment → seen; none yet → not seen", async () => {
      const audienceId = randomUUID();
      expect(await deletedSeen(tenantA, audienceId)).toBe(false);
      await insertRow(tenantA.ctx.slug, 'broadcast_audience_deleted', deletedPayload(audienceId, randomUUID(), randomUUID()));
      expect(await deletedSeen(tenantA, audienceId)).toBe(true);
    });

    it("another tenant's row, or a NULL-tenant row, with the same payload is not seen", async () => {
      const audienceId = randomUUID();
      await insertRow(tenantB.ctx.slug, 'broadcast_audience_deleted', deletedPayload(audienceId, randomUUID(), randomUUID()));
      await insertRow(null, 'broadcast_audience_deleted', deletedPayload(audienceId, randomUUID(), randomUUID()));
      expect(await deletedSeen(tenantA, audienceId)).toBe(false);
      expect(await deletedSeen(tenantB, audienceId)).toBe(true);
    });

    it("a disclosed row, or a deleted row for another segment, is not a deleted row for this one", async () => {
      const audienceId = randomUUID();
      await insertRow(tenantA.ctx.slug, 'broadcast_audience_disclosed', disclosedPayload(audienceId, randomUUID(), randomUUID()));
      await insertRow(tenantA.ctx.slug, 'broadcast_audience_deleted', deletedPayload(randomUUID(), randomUUID(), randomUUID()));
      expect(await deletedSeen(tenantA, audienceId)).toBe(false);
    });

    it('a second tx waits for the first to commit, so two sites write ONE deleted row', async () => {
      const audienceId = randomUUID();
      const repo = makeDrizzleBroadcastsRepo(tenantA.ctx.slug);
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      let firstRead!: () => void;
      const firstHasRead = new Promise<void>((r) => (firstRead = r));

      // Each site does what the delete sites do: read under the lock, insert
      // when nothing is recorded, on the same tx.
      const site = (hold: boolean) =>
        repo.withTx(async (tx) => {
          const seen = await repo.hasAudienceDeletedAuditInTx(tx, tenantA.ctx.slug, audienceId);
          if (hold) {
            firstRead();
            await released;
          }
          if (!seen) {
            await (tx as { execute: typeof db.execute }).execute(sql`
              INSERT INTO audit_log (event_type, actor_user_id, summary, request_id, payload, tenant_id, retention_years)
              VALUES ('broadcast_audience_deleted'::audit_event_type, 'system:cron', 'spec 139 s2 fixture', 'no-request-id',
                      ${JSON.stringify(deletedPayload(audienceId, randomUUID(), randomUUID()))}::jsonb, ${tenantA.ctx.slug}, 5)
            `);
          }
          return seen;
        });

      const first = site(true);
      await firstHasRead;
      let secondDone = false;
      const second = site(false).then((seen) => {
        secondDone = true;
        return seen;
      });
      // Short: the dev branch has statement_timeout = 0, so a wrong lock HANGS.
      await new Promise((r) => setTimeout(r, 750));
      const secondFinishedWhileFirstHeld = secondDone;
      release();
      const [firstSeen, secondSeen] = await Promise.all([first, second]);
      expect(secondFinishedWhileFirstHeld).toBe(false);
      expect(firstSeen).toBe(false);
      expect(secondSeen).toBe(true);
      const rows = (await db.execute(sql`
        SELECT count(*)::int AS n FROM audit_log
         WHERE tenant_id = ${tenantA.ctx.slug}
           AND event_type = 'broadcast_audience_deleted'::audit_event_type
           AND payload->>'resend_audience_id' = ${audienceId}
      `)) as unknown as Array<{ n: number }>;
      expect(rows[0]?.n).toBe(1);
    });
  });

  describe('findAudienceDisclosureInTx', () => {
    it("the tenant's own disclosed row → its broadcast and requester", async () => {
      const audienceId = randomUUID();
      const broadcastId = randomUUID();
      const memberId = randomUUID();
      expect(await disclosureOf(tenantA, audienceId)).toBeNull();
      await insertRow(tenantA.ctx.slug, 'broadcast_audience_disclosed', disclosedPayload(audienceId, broadcastId, memberId));
      expect(await disclosureOf(tenantA, audienceId)).toEqual({ broadcastId, relatedMemberId: memberId });
    });

    it("another tenant's, a NULL-tenant or a deleted row naming the segment is not a disclosure", async () => {
      const audienceId = randomUUID();
      await insertRow(tenantB.ctx.slug, 'broadcast_audience_disclosed', disclosedPayload(audienceId, randomUUID(), randomUUID()));
      await insertRow(null, 'broadcast_audience_disclosed', disclosedPayload(audienceId, randomUUID(), randomUUID()));
      await insertRow(tenantA.ctx.slug, 'broadcast_audience_deleted', deletedPayload(audienceId, randomUUID(), randomUUID()));
      expect(await disclosureOf(tenantA, audienceId)).toBeNull();
      expect(await disclosureOf(tenantB, audienceId)).not.toBeNull();
    });
  });

  it.each([
    ['hasAudienceDeletedAuditInTx', (repo: ReturnType<typeof makeDrizzleBroadcastsRepo>, tx: unknown, slug: never) =>
      repo.hasAudienceDeletedAuditInTx(tx, slug, randomUUID())],
    ['findAudienceDisclosureInTx', (repo: ReturnType<typeof makeDrizzleBroadcastsRepo>, tx: unknown, slug: never) =>
      repo.findAudienceDisclosureInTx(tx, slug, randomUUID())],
  ] as const)("cross-tenant: %s with a tx bound to tenant B refuses tenant A's read", async (_label, call) => {
    const repo = makeDrizzleBroadcastsRepo(tenantA.ctx.slug);
    const slug = tenantA.ctx.slug as never;
    await expect(runInTenant(asTenantContext(tenantB.ctx.slug), (tx) => call(repo, tx, slug))).rejects.toThrow(/tx tenant mismatch/);
  });

  describe('DA1 / DA2 through the real composition root', () => {
    async function seedApprovedRow(): Promise<string> {
      const broadcastId = randomUUID();
      await runInTenant(tenantA.ctx, (tx) =>
        tx.insert(broadcasts).values({
          tenantId: tenantA.ctx.slug,
          broadcastId,
          requestedByMemberId: requester.memberId,
          requestedByMemberPlanIdSnapshot: requester.planId,
          submittedByUserId: randomUUID(),
          actorRole: 'member_self_service',
          subject: 'Audience audit',
          bodyHtml: '<p>Body</p>',
          bodySource: 'plain',
          fromName: 'Audience Audit Co via Test Chamber',
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

    it('tick 1 writes one disclosed row (ids and the count, no address) under the tenant, before the import', async () => {
      const id = await seedApprovedRow();
      const audienceId = `aud-audit-${randomUUID()}`;
      const calls: string[] = [];
      const port = new Proxy(
        {
          async createAudience() {
            calls.push('createAudience');
            return { audienceId };
          },
          async createContactImport() {
            // The row must already be committed when the POST is made.
            const seen = await db
              .select({ n: sql<number>`count(*)::int` })
              .from(auditLog)
              .where(and(eq(auditLog.tenantId, tenantA.ctx.slug), sql`${auditLog.payload}->>'resend_audience_id' = ${audienceId}`));
            calls.push(`createContactImport:rows=${seen[0]?.n ?? 0}`);
            return { importId: `imp-audit-${randomUUID()}` };
          },
        },
        {
          get: (target, prop) =>
            prop in target || prop === 'then'
              ? (target as Record<string | symbol, unknown>)[prop]
              : async () => {
                  calls.push(String(prop));
                  throw new Error(`gateway.${String(prop)} must not be called here`);
                },
        },
      ) as unknown as BroadcastsGatewayPort;

      const r = await buildAudienceTick(
        {
          ...(await makeBuildAudienceTickDeps(tenantA.ctx.slug, { tickStartedAt: Date.now() })),
          broadcastsGateway: port,
          brandChrome: NO_BRAND,
          resolveRecipients: async () =>
            ok({ recipients: RECIPIENTS, estimatedCount: RECIPIENTS.length, orphans: [], droppedByPreference: 0 }),
        },
        { broadcastId: asBroadcastId(id) },
      );

      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(calls).toEqual(['createAudience', 'createContactImport:rows=1']);
      const rows = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.eventType, 'broadcast_audience_disclosed'), sql`${auditLog.payload}->>'resend_audience_id' = ${audienceId}`));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tenantId: tenantA.ctx.slug, actorUserId: 'system:cron' });
      expect(rows[0]!.payload).toEqual({
        broadcast_id: id,
        related_member_id: requester.memberId,
        resend_audience_id: audienceId,
        recipient_count: RECIPIENTS.length,
        leg: 'import',
        actor_role: 'system',
      });
      expect(JSON.stringify(rows[0])).not.toContain('@');
      expect(await disclosureOf(tenantA, audienceId)).toEqual({ broadcastId: id, relatedMemberId: requester.memberId });
    });

    it('a restart whose delete failed, then a second restart on the same segment: ONE deleted row (stale_audience)', async () => {
      const id = await seedApprovedRow();
      const audienceId = `aud-stale-${randomUUID()}`;
      await runInTenant(tenantA.ctx, (tx) =>
        tx.update(broadcasts).set({ resendAudienceId: audienceId }).where(and(eq(broadcasts.tenantId, tenantA.ctx.slug), eq(broadcasts.broadcastId, id))),
      );
      const deletes: string[] = [];
      const gateway = (failDelete: boolean) =>
        new Proxy(
          {
            async deleteAudience(audience: string) {
              deletes.push(audience);
              if (failDelete) throw Object.assign(new Error('timeout'), { kind: 'retryable', subKind: 'timeout', reason: 'aborted' });
            },
          },
          {
            get: (target, prop) =>
              prop in target || prop === 'then'
                ? (target as Record<string | symbol, unknown>)[prop]
                : async () => {
                    throw new Error(`gateway.${String(prop)} must not be called here`);
                  },
          },
        ) as unknown as BroadcastsGatewayPort;
      const tick = async (port: BroadcastsGatewayPort) =>
        buildAudienceTick(
          {
            ...(await makeBuildAudienceTickDeps(tenantA.ctx.slug, { tickStartedAt: Date.now() })),
            broadcastsGateway: port,
            brandChrome: NO_BRAND,
            resolveRecipients: async () =>
              ok({ recipients: RECIPIENTS, estimatedCount: RECIPIENTS.length, orphans: [], droppedByPreference: 0 }),
          },
          { broadcastId: asBroadcastId(id) },
        );

      const first = await tick(gateway(true));
      expect(first.ok).toBe(false);
      const second = await tick(gateway(false));
      expect(second, JSON.stringify(second)).toEqual({ ok: true, value: { kind: 'audience_restarted' } });
      expect(deletes).toEqual([audienceId, audienceId]);

      const rows = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.eventType, 'broadcast_audience_deleted'), sql`${auditLog.payload}->>'resend_audience_id' = ${audienceId}`));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tenantId: tenantA.ctx.slug, actorUserId: 'system:cron' });
      expect(rows[0]!.payload).toEqual({
        broadcast_id: id,
        related_member_id: requester.memberId,
        resend_audience_id: audienceId,
        reason: 'stale_audience',
        leg: 'import',
        actor_role: 'system',
      });
      expect(JSON.stringify(rows[0])).not.toContain('@');
    });
  });
});
