/**
 * F119 T036 — FR-012a: `broadcasts_immutable_after_submit_fn` amended by
 * migration 0305 (data-model § 8.3). A direct DB `UPDATE` outside the
 * application must still be refused with `broadcast_immutable_after_submit`
 * on every non-exempt transition and on a no-status-change write in each new
 * stage; exactly two new exemptions exist:
 *
 *   E1  `member_approved → approved`                       releases subject / body_html / body_source
 *   E2  `member_approved|approved → approved|changes_requested|in_design`  releases scheduled_for
 *
 * plus today's `submitted → approved` scheduled_for exemption, kept verbatim.
 * `proposed_send_at` (F1) and the audience (`segment_type`, `segment_params`,
 * `custom_recipient_emails` — FR-005) are refused on EVERY post-draft write,
 * the two exempt edges included.
 *
 * Every probe runs in a SAVEPOINT that is always rolled back, so one seeded
 * row per status serves the whole matrix, and a probe that matched no row is
 * a failure (never a false "ok"). Each refusal is classified by its message,
 * so a state-machine or CHECK raise can never pass for an immutability raise.
 *
 * A second describe pins the two child tables' triggers: a sent version is
 * read-only (including `authored_by_role`), a decision refuses a direct
 * DELETE, and the E-Blast's ON DELETE CASCADE still reaches both — the
 * append-only trigger admits a DELETE only at `pg_trigger_depth() > 1`.
 *
 * T166 — the erasure GUC (`app.allow_broadcast_redaction = 'on'`) arms, run
 * as `chamber_app` inside `runInTenant` so RLS passes and the trigger is the
 * thing that answers. Each probe targets ONE line of an arm in
 * `0305_eblast_member_approval.sql`, and each has a positive control showing
 * the GUC really took effect (a whitelisted column still moves), so "refused"
 * cannot come from a GUC that was never set:
 *
 *   broadcasts        GUC arm :425–472 — the six 0305 columns (:466–471)
 *                     → `broadcast_redaction_only_pii_cols`; control: subject.
 *   broadcast_versions GUC arm :182–195 — version_no / authored_by_* /
 *                     sent_to_member_at (:186–189) → `…_immutable_after_send`;
 *                     control: subject.
 *   broadcast_member_decisions :300–314 — without the GUC every UPDATE falls
 *                     to the RAISE; with it, `decision` / `round` break the
 *                     `IS NOT DISTINCT FROM` conjuncts (:307–308); control:
 *                     reason only.
 */
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, runInTenant } from '@/lib/db';
import { errorChainMessage } from '@/lib/db-errors';
import {
  broadcastMemberDecisions,
  broadcasts,
  broadcastVersions,
  type NewBroadcastRow,
} from '@/modules/broadcasts/infrastructure/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

type Status = NonNullable<NewBroadcastRow['status']>;
type Tx = Parameters<Parameters<typeof runInTenant>[1]>[0];
type Patch = Partial<NewBroadcastRow>;

const ALL_STATUSES: readonly Status[] = [
  'draft', 'submitted', 'approved', 'sending', 'sent', 'rejected', 'cancelled',
  'failed_to_dispatch', 'partially_sent', 'partial_delivery_accepted',
  'in_design', 'awaiting_member_approval', 'changes_requested', 'member_approved',
  'expired_no_member_response',
];
const NEW_STAGES: readonly Status[] = [
  'in_design', 'awaiting_member_approval', 'changes_requested', 'member_approved',
  'expired_no_member_response',
];

/** data-model § 8.2 — the legal edges out of every row 0305 touches. */
const EDGES: ReadonlyArray<readonly [Status, Status]> = [
  ['submitted', 'approved'], ['submitted', 'rejected'], ['submitted', 'cancelled'],
  ['submitted', 'in_design'],
  ['in_design', 'awaiting_member_approval'], ['in_design', 'rejected'], ['in_design', 'cancelled'],
  ['awaiting_member_approval', 'member_approved'],
  ['awaiting_member_approval', 'changes_requested'],
  ['awaiting_member_approval', 'rejected'], ['awaiting_member_approval', 'cancelled'],
  ['awaiting_member_approval', 'expired_no_member_response'],
  ['changes_requested', 'in_design'], ['changes_requested', 'rejected'],
  ['changes_requested', 'cancelled'],
  ['member_approved', 'approved'], ['member_approved', 'changes_requested'],
  ['member_approved', 'in_design'], ['member_approved', 'rejected'],
  ['member_approved', 'cancelled'],
  ['approved', 'sending'], ['approved', 'cancelled'], ['approved', 'failed_to_dispatch'],
  ['approved', 'changes_requested'], ['approved', 'in_design'],
];

const isE1 = (from: Status, to: Status) => from === 'member_approved' && to === 'approved';
const releasesSchedule = (from: Status, to: Status) =>
  (from === 'submitted' && to === 'approved') ||
  ((from === 'member_approved' || from === 'approved') &&
    (to === 'approved' || to === 'changes_requested' || to === 'in_design'));

const SEED_AT = new Date('2026-10-01T03:00:00Z');
const LATER = new Date('2026-10-05T03:00:00Z');

const CONTENT: ReadonlyArray<readonly [string, Patch]> = [
  ['subject', { subject: 'changed subject' }],
  ['body_html', { bodyHtml: '<p>changed</p>' }],
  ['body_source', { bodySource: 'changed' }],
];
const AUDIENCE: ReadonlyArray<readonly [string, Patch]> = [
  ['segment_type', { segmentType: 'tier' }],
  ['segment_params', { segmentParams: { tierCodes: ['other'] } }],
  ['custom_recipient_emails', { customRecipientEmails: ['someone@example.com'] }],
];

class Rollback extends Error {}

type Want = 'ok' | 'immutable' | 'redaction';
const REDACTION_GUC = sql`SET LOCAL app.allow_broadcast_redaction = 'on'`;

describe('F119 T036 — broadcasts_immutable_after_submit_fn after 0305 (FR-012a)', () => {
  let tenant: TestTenant;
  const ids = new Map<Status, string>();

  const seedRow = (status: Status): NewBroadcastRow => {
    const quota =
      status === 'sent' || status === 'partial_delivery_accepted'
        ? { quotaYearConsumed: 2026, quotaConsumedAt: SEED_AT }
        : {};
    return {
      tenantId: tenant.ctx.slug,
      broadcastId: randomUUID(),
      requestedByMemberId: randomUUID(),
      requestedByMemberPlanIdSnapshot: 'plan-t036',
      submittedByUserId: randomUUID(),
      actorRole: 'member_self_service',
      subject: `T036 ${status}`,
      bodyHtml: '<p>original</p>',
      bodySource: 'original',
      fromName: 'Chamber',
      replyToEmail: 'reply@example.com',
      segmentType: 'all_members',
      estimatedRecipientCount: 10,
      status,
      submittedAt: SEED_AT,
      scheduledFor: SEED_AT,
      proposedSendAt: SEED_AT,
      ...quota,
    };
  };

  /** One UPDATE in a savepoint that is always rolled back. */
  async function probe(tx: Tx, from: Status, to: Status, set: Patch): Promise<string> {
    const id = ids.get(from)!;
    try {
      await tx.transaction(async (sp) => {
        const rows = await sp
          .update(broadcasts)
          .set(to === from ? set : { ...set, status: to })
          .where(and(eq(broadcasts.tenantId, tenant.ctx.slug), eq(broadcasts.broadcastId, id)))
          .returning({ id: broadcasts.broadcastId });
        if (rows.length !== 1) throw new Error(`probe matched ${rows.length} rows`);
        throw new Rollback();
      });
    } catch (e) {
      if (e instanceof Rollback) return 'ok';
      const message = errorChainMessage(e);
      if (message.includes('broadcast_immutable_after_submit')) return 'immutable';
      if (message.includes('broadcast_redaction_only_pii_cols')) return 'redaction';
      return `other: ${message.slice(0, 160)}`;
    }
    return 'unreachable';
  }

  /**
   * Runs every case in one tenant tx; returns "from→to col: got X" for each
   * miss. `guc` sets the erasure GUC for that tx (SET LOCAL — it survives the
   * probes' savepoints).
   */
  async function sweep(
    cases: ReadonlyArray<readonly [Status, Status, string, Patch, Want]>,
    guc = false,
  ): Promise<string[]> {
    return runInTenant(tenant.ctx, async (tx) => {
      if (guc) await tx.execute(REDACTION_GUC);
      const misses: string[] = [];
      for (const [from, to, col, set, want] of cases) {
        const got = await probe(tx, from, to, set);
        if (got !== want) misses.push(`${from}→${to} ${col}: want ${want}, got ${got}`);
      }
      return misses;
    });
  }

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    const rows = ALL_STATUSES.map(seedRow);
    rows.forEach((r) => ids.set(r.status as Status, r.broadcastId!));
    await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(rows));
  });

  afterAll(async () => {
    if (tenant) await tenant.cleanup();
  });

  it('non-exempt transition → broadcast_immutable_after_submit', async () => {
    const cases: Array<readonly [Status, Status, string, Patch, 'ok' | 'immutable']> = [];
    for (const [from, to] of EDGES) {
      if (!isE1(from, to)) for (const [col, set] of CONTENT) cases.push([from, to, col, set, 'immutable']);
      if (!releasesSchedule(from, to)) {
        cases.push([from, to, 'scheduled_for', { scheduledFor: LATER }, 'immutable']);
      }
    }
    expect(await sweep(cases)).toEqual([]);
  });

  it.each(NEW_STAGES)('no-status-change update in `%s` → refused', async (stage) => {
    const cases: Array<readonly [Status, Status, string, Patch, 'ok' | 'immutable']> = [
      ...CONTENT.map(([col, set]) => [stage, stage, col, set, 'immutable'] as const),
      [stage, stage, 'scheduled_for', { scheduledFor: LATER }, 'immutable'],
    ];
    expect(await sweep(cases)).toEqual([]);
  });

  it('E1 `member_approved → approved` releases subject/body_html', async () => {
    const promotion: Patch = {
      subject: 'the approved version',
      bodyHtml: '<p>approved</p>',
      bodySource: 'approved',
    };
    expect(await sweep([['member_approved', 'approved', 'content', promotion, 'ok']])).toEqual([]);
  });

  it('E2 `member_approved|approved → approved|changes_requested|in_design` releases scheduled_for', async () => {
    const set: Patch = { scheduledFor: LATER };
    expect(
      await sweep([
        ['member_approved', 'approved', 'scheduled_for', set, 'ok'],
        ['member_approved', 'changes_requested', 'scheduled_for', set, 'ok'],
        ['member_approved', 'in_design', 'scheduled_for', set, 'ok'],
        ['approved', 'approved', 'scheduled_for', set, 'ok'],
        ['approved', 'changes_requested', 'scheduled_for', set, 'ok'],
        ['approved', 'in_design', 'scheduled_for', set, 'ok'],
        // today's exemption, kept verbatim
        ['submitted', 'approved', 'scheduled_for', set, 'ok'],
        // cancelling the time with NULL is the same release
        ['approved', 'changes_requested', 'scheduled_for=NULL', { scheduledFor: null }, 'ok'],
      ]),
    ).toEqual([]);
  });

  it('`proposed_send_at` is refused on every post-draft write', async () => {
    const set: Patch = { proposedSendAt: LATER };
    const cases: Array<readonly [Status, Status, string, Patch, 'ok' | 'immutable']> = [
      ...EDGES.map(([from, to]) => [from, to, 'proposed_send_at', set, 'immutable'] as const),
      ...ALL_STATUSES.filter((s) => s !== 'draft').map(
        (s) => [s, s, 'proposed_send_at', set, 'immutable'] as const,
      ),
      // positive control: the probe is not a blanket refusal — a draft may still move it
      ['draft', 'draft', 'proposed_send_at', set, 'ok'],
    ];
    expect(await sweep(cases)).toEqual([]);
  });

  it('`segment_type`, `segment_params` and `custom_recipient_emails` are refused on every post-draft write, including the two exempt edges', async () => {
    const writes: ReadonlyArray<readonly [Status, Status]> = [
      ...EDGES,
      ...ALL_STATUSES.filter((s) => s !== 'draft').map((s) => [s, s] as const),
    ];
    const cases = writes.flatMap(([from, to]) =>
      AUDIENCE.map(([col, set]) => [from, to, col, set, 'immutable'] as const),
    );
    // E1 and E2 are both in EDGES — assert it, so the claim in the title is load-bearing
    expect(EDGES.some(([f, t]) => isE1(f, t))).toBe(true);
    expect(EDGES.some(([f, t]) => f === 'approved' && t === 'in_design')).toBe(true);
    expect(await sweep(cases)).toEqual([]);
  });

  /**
   * T166 — the GUC arm's whitelist (0305 :466–471). The erasure scrub may
   * rewrite PII content, never move a row through the workflow: each of the six
   * 0305 columns is refused under the GUC, on a no-status-change write in four
   * post-draft stages. Remove any one of those lines and the arm falls through
   * to `RETURN NEW` — that probe reads 'ok' and the test fails. A random
   * `approved_version_id` would also trip the FK, but that check runs at
   * statement end, AFTER this BEFORE trigger: only the trigger can answer
   * 'redaction'.
   */
  it('under the erasure GUC, each of the six 0305 columns → broadcast_redaction_only_pii_cols; subject still moves (positive control)', async () => {
    const SIX: ReadonlyArray<readonly [string, Patch]> = [
      ['proposed_send_at', { proposedSendAt: LATER }],
      ['stage_entered_at', { stageEnteredAt: LATER }],
      ['current_round', { currentRound: 7 }],
      ['approved_version_id', { approvedVersionId: randomUUID() }],
      ['member_reminder_stage', { memberReminderStage: 2 }],
      ['member_expiry_notified_at', { memberExpiryNotifiedAt: LATER }],
    ];
    const stages: readonly Status[] = ['submitted', 'awaiting_member_approval', 'approved', 'sent'];
    const cases: Array<readonly [Status, Status, string, Patch, Want]> = [
      ...stages.flatMap((s) => SIX.map(([col, set]) => [s, s, col, set, 'redaction'] as const)),
      // positive control: the GUC is live — a whitelisted PII column moves
      ...stages.map((s) => [s, s, 'subject', { subject: 'redacted' }, 'ok'] as const),
    ];
    expect(await sweep(cases, true)).toEqual([]);
  });

  it('the GUC is what refuses the five new workflow columns: without it the non-GUC arm does not guard them (proposed_send_at excepted)', async () => {
    // Proves the case above measures the GUC arm and not the ordinary one:
    // outside the erasure path these five are ordinary workflow writes.
    const cases: Array<readonly [Status, Status, string, Patch, Want]> = [
      ['awaiting_member_approval', 'awaiting_member_approval', 'stage_entered_at', { stageEnteredAt: LATER }, 'ok'],
      ['awaiting_member_approval', 'awaiting_member_approval', 'current_round', { currentRound: 7 }, 'ok'],
      ['awaiting_member_approval', 'awaiting_member_approval', 'member_reminder_stage', { memberReminderStage: 2 }, 'ok'],
      ['awaiting_member_approval', 'awaiting_member_approval', 'member_expiry_notified_at', { memberExpiryNotifiedAt: LATER }, 'ok'],
      ['awaiting_member_approval', 'awaiting_member_approval', 'proposed_send_at', { proposedSendAt: LATER }, 'immutable'],
    ];
    expect(await sweep(cases)).toEqual([]);
  });

  // --- the two child tables' own triggers (data-model §§ 1–2) --------------
  describe('broadcast_versions + broadcast_member_decisions triggers', () => {
    /** One E-Blast awaiting the member, with a sent version and a decision on it. */
    async function seedChain(): Promise<{ broadcastId: string; versionId: string; decisionId: string }> {
      const chain = { broadcastId: randomUUID(), versionId: randomUUID(), decisionId: randomUUID() };
      await runInTenant(tenant.ctx, async (tx) => {
        await tx.insert(broadcasts).values({ ...seedRow('awaiting_member_approval'), broadcastId: chain.broadcastId });
        await tx.insert(broadcastVersions).values({
          tenantId: tenant.ctx.slug,
          id: chain.versionId,
          broadcastId: chain.broadcastId,
          versionNo: 1,
          subject: 'v1',
          bodyHtml: '<p>v1</p>',
          bodySource: 'v1',
          authoredByUserId: randomUUID(),
          authoredByRole: 'admin_proxy',
          sentToMemberAt: SEED_AT,
        });
        await tx.insert(broadcastMemberDecisions).values({
          tenantId: tenant.ctx.slug,
          id: chain.decisionId,
          broadcastId: chain.broadcastId,
          versionId: chain.versionId,
          round: 1,
          decision: 'changes_requested',
          reason: 'please shorten the subject',
          decidedByUserId: randomUUID(),
          decidedByContactId: randomUUID(),
        });
      });
      return chain;
    }

    async function refusal(fn: () => Promise<unknown>): Promise<string> {
      try {
        await fn();
      } catch (e) {
        return errorChainMessage(e);
      }
      return 'no error';
    }

    /**
     * One UPDATE as `chamber_app` inside `runInTenant` (RLS passes, so the
     * trigger is what answers), in a savepoint that is always rolled back.
     * 'ok' when exactly one row changed; otherwise the refusal's message.
     */
    async function attempt(guc: boolean, write: (tx: Tx) => Promise<unknown[]>): Promise<string> {
      return runInTenant(tenant.ctx, async (tx) => {
        if (guc) await tx.execute(REDACTION_GUC);
        try {
          await tx.transaction(async (sp) => {
            const rows = await write(sp);
            if (rows.length !== 1) throw new Error(`probe matched ${rows.length} rows`);
            throw new Rollback();
          });
        } catch (e) {
          if (e instanceof Rollback) return 'ok';
          return errorChainMessage(e);
        }
        return 'unreachable';
      });
    }

    const updateDecision = (decisionId: string, set: Partial<typeof broadcastMemberDecisions.$inferInsert>) => (tx: Tx) =>
      tx
        .update(broadcastMemberDecisions)
        .set(set)
        .where(and(eq(broadcastMemberDecisions.tenantId, tenant.ctx.slug), eq(broadcastMemberDecisions.id, decisionId)))
        .returning({ id: broadcastMemberDecisions.id });

    const updateVersion = (versionId: string, set: Partial<typeof broadcastVersions.$inferInsert>) => (tx: Tx) =>
      tx
        .update(broadcastVersions)
        .set(set)
        .where(and(eq(broadcastVersions.tenantId, tenant.ctx.slug), eq(broadcastVersions.id, versionId)))
        .returning({ id: broadcastVersions.id });

    it('a same-tenant UPDATE of a decision WITHOUT the redaction GUC → broadcast_decision_append_only (as chamber_app, RLS passing)', async () => {
      const { decisionId } = await seedChain();
      // Only the GUC arm (0305 :300–311) returns NEW; without it every UPDATE
      // falls to the RAISE (:314). Drop the no_update trigger and chamber_app's
      // UPDATE grant lets this through — 'ok', and the test fails.
      expect(await attempt(false, updateDecision(decisionId, { reason: 'rewritten after the fact' }))).toContain(
        'broadcast_decision_append_only',
      );
    });

    it('WITH the GUC, a reason-only change is admitted (positive control) but changing `decision` or `round` still → broadcast_decision_append_only', async () => {
      const { decisionId } = await seedChain();
      const got = {
        reasonOnly: await attempt(true, updateDecision(decisionId, { reason: '[redacted]' })),
        decision: await attempt(true, updateDecision(decisionId, { decision: 'approval_withdrawn' })),
        round: await attempt(true, updateDecision(decisionId, { round: 2 })),
      };
      expect(got.reasonOnly).toBe('ok');
      expect(got.decision).toContain('broadcast_decision_append_only');
      expect(got.round).toContain('broadcast_decision_append_only');
    });

    it('WITH the GUC, a sent version\'s subject may be redacted (positive control) but sent_to_member_at / version_no / authored_by_* still → broadcast_version_immutable_after_send', async () => {
      const { versionId } = await seedChain();
      const probes: ReadonlyArray<readonly [string, Partial<typeof broadcastVersions.$inferInsert>]> = [
        ['sent_to_member_at', { sentToMemberAt: LATER }],
        ['version_no', { versionNo: 9 }],
        ['authored_by_user_id', { authoredByUserId: randomUUID() }],
        ['authored_by_role', { authoredByRole: 'system' }],
      ];
      expect(await attempt(true, updateVersion(versionId, { subject: '[redacted]' }))).toBe('ok');
      const misses: string[] = [];
      for (const [col, set] of probes) {
        const got = await attempt(true, updateVersion(versionId, set));
        if (!got.includes('broadcast_version_immutable_after_send')) misses.push(`${col}: ${got.slice(0, 160)}`);
      }
      expect(misses).toEqual([]);
    });

    it('`authored_by_role` is refused after send → broadcast_version_immutable_after_send', async () => {
      const { versionId } = await seedChain();
      const message = await refusal(() =>
        runInTenant(tenant.ctx, (tx) =>
          tx
            .update(broadcastVersions)
            .set({ authoredByRole: 'system' })
            .where(and(eq(broadcastVersions.tenantId, tenant.ctx.slug), eq(broadcastVersions.id, versionId))),
        ),
      );
      expect(message).toContain('broadcast_version_immutable_after_send');
    });

    it('a direct DELETE of a decision → broadcast_decision_append_only', async () => {
      const { decisionId } = await seedChain();
      // The schema owner: chamber_app holds no DELETE grant, so only the
      // owner can even reach the trigger with a direct DELETE.
      const message = await refusal(() =>
        db
          .delete(broadcastMemberDecisions)
          .where(and(eq(broadcastMemberDecisions.tenantId, tenant.ctx.slug), eq(broadcastMemberDecisions.id, decisionId))),
      );
      expect(message).toContain('broadcast_decision_append_only');
    });

    it('deleting the E-Blast cascades through the append-only trigger to its versions and decisions', async () => {
      const chain = await seedChain();
      await runInTenant(tenant.ctx, (tx) =>
        tx
          .delete(broadcasts)
          .where(and(eq(broadcasts.tenantId, tenant.ctx.slug), eq(broadcasts.broadcastId, chain.broadcastId))),
      );
      const [versions, decisions] = await Promise.all([
        db.select().from(broadcastVersions).where(eq(broadcastVersions.broadcastId, chain.broadcastId)),
        db.select().from(broadcastMemberDecisions).where(eq(broadcastMemberDecisions.broadcastId, chain.broadcastId)),
      ]);
      expect({ versions: versions.length, decisions: decisions.length }).toEqual({ versions: 0, decisions: 0 });
    });
  });
});
