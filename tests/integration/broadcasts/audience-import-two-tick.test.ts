// @vitest-environment node
/**
 * T087 — the two-tick import build end to end on live Neon.
 *
 * The unit tests drive the completion rule against stubs; this drives the same
 * use case against the real Drizzle repo, so the parts a stub cannot answer are
 * exercised: the 0298 columns round-trip, the coherence CHECK tolerates the
 * pair the use case actually writes, `broadcasts_immutable_after_submit_fn`
 * permits both writes on an `approved` row, and the status transitions land.
 *
 * **The gateway is a recording fake, never real Resend.** Dev and prod share
 * `RESEND_BROADCASTS_API_KEY` and `BROADCASTS_FROM_EMAIL`, so a live call here
 * would create audiences on the production account — which is on the Free plan
 * (1,000 contacts, 3 audiences) — and a send would reach real addresses. The
 * fake also lets the assertions count calls exactly, which is the point: what
 * must be proved is that NOTHING is sent on tick 1 and nothing is sent when the
 * completion rule refuses.
 *
 * What this does NOT prove: that Resend's own import behaves as measured. That
 * was established directly against the API (research § R9 V2 + V4) and is not
 * re-litigated here.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { ok } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { buildAudienceTick } from '@/modules/broadcasts/application/use-cases/build-audience-tick';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { f7AuditAdapter } from '@/modules/broadcasts/infrastructure/audit-adapter';
import { systemClock } from '@/modules/broadcasts/infrastructure/broadcasts-deps';

const RUN_INTEGRATION = Boolean(process.env.DATABASE_URL);
const TEST_TENANT = 'swecham';
const CREATED: string[] = [];

/** Synthetic and unroutable (RFC 2606) — nothing here can reach a person. */
const RECIPIENTS = ['t087-a@example.com', 't087-b@example.com', 't087-c@example.com'];

interface FakeGateway {
  readonly calls: string[];
  readonly imports: Array<{ audienceId: string; emails: readonly string[] }>;
  readonly sends: string[];
  readonly port: unknown;
}

function makeFakeGateway(counts: {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}): FakeGateway {
  const calls: string[] = [];
  const imports: Array<{ audienceId: string; emails: readonly string[] }> = [];
  const sends: string[] = [];
  return {
    calls,
    imports,
    sends,
    port: {
      async createAudience(name: string) {
        calls.push('createAudience');
        return { audienceId: `aud-${name.slice(-8)}` };
      },
      async createContactImport(audienceId: string, emails: readonly string[]) {
        calls.push('createContactImport');
        imports.push({ audienceId, emails });
        return { importId: 'imp-live-test' };
      },
      async getContactImport() {
        calls.push('getContactImport');
        return { status: 'completed', counts };
      },
      async createBroadcast() {
        calls.push('createBroadcast');
        return { broadcastId: 'rb-live-test' };
      },
      async sendBroadcast(id: string) {
        calls.push('sendBroadcast');
        sends.push(id);
      },
    },
  };
}

function makeDeps(gateway: FakeGateway): unknown {
  return {
    tenant: asTenantContext(TEST_TENANT),
    broadcastsRepo: makeDrizzleBroadcastsRepo(TEST_TENANT),
    broadcastsGateway: gateway.port,
    audit: f7AuditAdapter,
    clock: systemClock,
    fromEmail: 'noreply@swecham.example',
    tenantDisplayName: 'Test Chamber',
    locale: 'en' as const,
    // The resolver is injected, so this file tests the tick, not the audience
    // query — which has its own suites. `orphans` + `droppedByPreference` are
    // part of the answer now: the port used to discard them, which is how the
    // per-broadcast attribution a previous review round added went missing.
    resolveRecipients: async () =>
      ok({
        recipients: RECIPIENTS,
        estimatedCount: RECIPIENTS.length,
        orphans: [],
        droppedByPreference: 0,
      }),
    // Wired so a terminal failure can tell the member (FR-021) and so the AS5
    // forensic row is reachable. These are stubs, not the real bridges — this
    // file proves the tick against live Postgres, and the notification and plan
    // paths have their own coverage in the unit suite.
    membersBridge: {
      getMemberPrimaryContact: async () => null,
      getMemberPreferredLocale: async () => 'en' as const,
    },
    emailTransactional: { sendMemberEmail: async () => undefined },
    plansBridge: { getPlanForMember: async () => ok({ planId: 'plan-unchanged' }) },
  };
}

async function seedApproved(): Promise<string> {
  const broadcastId = randomUUID();
  CREATED.push(broadcastId);
  await runInTenant(asTenantContext(TEST_TENANT), async (tx) => {
    await tx.execute(sql`
      INSERT INTO broadcasts (
        tenant_id, broadcast_id, status, requested_by_member_id,
        requested_by_member_plan_id_snapshot, submitted_by_user_id,
        actor_role, subject, body_html, body_source, from_name,
        reply_to_email, segment_type, segment_params,
        custom_recipient_emails, estimated_recipient_count,
        submitted_at, approved_at, scheduled_for
      ) VALUES (
        ${TEST_TENANT}, ${broadcastId}::uuid, 'approved',
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
        'admin_proxy', 'T087 two-tick', '<p>x</p>', '<p>x</p>',
        'T087 Test', 'noreply@swecham.example', 'all_members', NULL,
        NULL, ${RECIPIENTS.length}, now(), now(), now()
      )
    `);
  });
  return broadcastId;
}

async function readRow(raw: string): Promise<{
  status: string;
  audience_import_id: string | null;
  submitted: boolean;
  completed: boolean;
}> {
  const rows = (await runInTenant(asTenantContext(TEST_TENANT), async (tx) =>
    tx.execute(sql`
      SELECT status::text AS status,
             audience_import_id,
             audience_import_submitted_at IS NOT NULL AS submitted,
             audience_import_completed_at IS NOT NULL AS completed
      FROM broadcasts
      WHERE tenant_id = ${TEST_TENANT} AND broadcast_id = ${raw}::uuid
    `),
  )) as unknown as Array<{
    status: string;
    audience_import_id: string | null;
    submitted: boolean;
    completed: boolean;
  }>;
  return rows[0]!;
}

describe.runIf(RUN_INTEGRATION)('T087 — two-tick import build (live Neon)', () => {
  afterAll(async () => {
    await runInTenant(asTenantContext(TEST_TENANT), async (tx) => {
      for (const id of CREATED) {
        await tx.execute(sql`
          DELETE FROM broadcasts
          WHERE tenant_id = ${TEST_TENANT} AND broadcast_id = ${id}::uuid
        `);
      }
    });
  });

  it('tick 1 submits and sends NOTHING; tick 2 confirms and sends once', async () => {
    const raw = await seedApproved();
    const broadcastId = asBroadcastId(raw);
    const gw = makeFakeGateway({
      total: RECIPIENTS.length,
      created: RECIPIENTS.length,
      updated: 0,
      skipped: 0,
      failed: 0,
    });

    // ── tick 1 ────────────────────────────────────────────────────────────
    const first = await buildAudienceTick(makeDeps(gw) as never, { broadcastId });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value).toMatchObject({ kind: 'import_submitted' });

    expect(gw.imports).toHaveLength(1);
    expect(gw.imports[0]!.emails).toEqual(RECIPIENTS);
    // The whole safety property of tick 1, asserted on the gateway rather than
    // on the outcome: Resend has ACCEPTED a job, and nothing has gone out.
    expect(gw.sends).toEqual([]);
    expect(gw.calls).not.toContain('createBroadcast');

    let row = await readRow(raw);
    expect(row.audience_import_id).toBe('imp-live-test');
    expect(row.submitted).toBe(true);
    expect(row.completed).toBe(false);
    // Still approved — so a member or admin can still cancel it while the
    // import is in flight. This is why there is no `audience_building` status.
    expect(row.status).toBe('approved');

    // ── tick 2 ────────────────────────────────────────────────────────────
    const second = await buildAudienceTick(makeDeps(gw) as never, { broadcastId });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value).toMatchObject({ kind: 'sent' });

    // Exactly one import across BOTH ticks: the stored id is the idempotency
    // guard, and a second submit would create a second job whose counts could
    // not be checked against anything.
    expect(gw.imports).toHaveLength(1);
    expect(gw.sends).toEqual(['rb-live-test']);

    row = await readRow(raw);
    expect(row.completed).toBe(true);
    expect(row.status).toBe('sending');
  }, 60_000);

  it('a completed import that processed ZERO rows sends nothing and goes terminal', async () => {
    // The case measured in the wild: `completed`, `failed: 0`, `total: 0`, and
    // nothing attached. On `status` alone this is a send to an empty audience
    // reported as success.
    const raw = await seedApproved();
    const broadcastId = asBroadcastId(raw);
    const gw = makeFakeGateway({ total: 0, created: 0, updated: 0, skipped: 0, failed: 0 });

    await buildAudienceTick(makeDeps(gw) as never, { broadcastId });
    const second = await buildAudienceTick(makeDeps(gw) as never, { broadcastId });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toMatchObject({
      kind: 'audience_import_failed',
      reason: 'count_mismatch',
    });

    expect(gw.sends).toEqual([]);
    expect(gw.calls).not.toContain('createBroadcast');

    const row = await readRow(raw);
    // Terminal, not re-polled forever, and NOT stamped complete.
    expect(row.status).toBe('failed_to_dispatch');
    expect(row.completed).toBe(false);
  }, 60_000);
});
