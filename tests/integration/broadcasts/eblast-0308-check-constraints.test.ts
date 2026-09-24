/**
 * PR #392 review C8 — migration 0308's CHECK constraints, run against real
 * Postgres. The Domain validates the same bounds first (a 422, never a 500),
 * but only the DB proves the two agree AT the boundary:
 *
 *   broadcast_member_decisions_reason_check   approved: NULL or 1–500;
 *                                             other two: NOT NULL, 1–2,000
 *   broadcast_versions_subject_length         char_length 1–200
 *   broadcast_versions_note_to_member_length  NULL or char_length ≤ 1,000
 *   broadcasts_member_reminder_stage_check    0–3
 *
 * `char_length` counts CODE POINTS; JS `.length` counts UTF-16 units. The
 * Domain's reason bounds count code points (`[...reason].length`,
 * `member-decision.ts`), so the discriminating boundary is an emoji — one code
 * point, two units: 500 of them are a legal note to both sides, 501 to
 * neither. Thai combining marks are separate code points in BOTH
 * `[...s]` and `char_length` (and single UTF-16 units), so the Thai case is a
 * consistency check, not a discriminator.
 *
 * Each probe runs as `chamber_app` inside `runInTenant` (RLS passes, so the
 * CHECK is what answers) in a savepoint that is always rolled back — a
 * refused statement never poisons the tenant tx, and the only rows left are
 * the seeded parents, which `tenant.cleanup()` removes (the E-Blast's
 * ON DELETE CASCADE reaches the version).
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInTenant } from '@/lib/db';
import { errorChainMessage } from '@/lib/db-errors';
import { validateDecisionReason } from '@/modules/broadcasts/domain/approval/member-decision';
import {
  broadcastMemberDecisions,
  broadcasts,
  broadcastVersions,
} from '@/modules/broadcasts/infrastructure/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

type Tx = Parameters<Parameters<typeof runInTenant>[1]>[0];
type DecisionInsert = typeof broadcastMemberDecisions.$inferInsert;
type VersionInsert = typeof broadcastVersions.$inferInsert;

const SEED_AT = new Date('2026-10-01T03:00:00Z');
const EMOJI = '\u{1F600}'; // one code point, two UTF-16 units
/** 'กี่' is three code points (ก + ี + ่); 166 of them + 'กข' = exactly 500. */
const THAI_500 = 'กี่'.repeat(166) + 'กข';

class Rollback extends Error {}

/** The SQLSTATE and constraint of the first Postgres error in the cause chain. */
function checkViolation(error: unknown): string | null {
  let cur: unknown = error;
  while (cur !== null && typeof cur === 'object') {
    const { code, constraint_name: constraint } = cur as { code?: unknown; constraint_name?: unknown };
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      return `${code} ${typeof constraint === 'string' ? constraint : '(no constraint)'}`;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

describe('PR #392 review C8 — 0308 CHECK constraints on real Postgres', () => {
  let tenant: TestTenant;
  const broadcastId = randomUUID();
  const versionId = randomUUID();

  /** One write in an always-rolled-back savepoint: 'ok', or `<SQLSTATE> <constraint>`. */
  async function attempt(write: (tx: Tx) => Promise<unknown[]>): Promise<string> {
    return runInTenant(tenant.ctx, async (tx) => {
      try {
        await tx.transaction(async (sp) => {
          const rows = await write(sp);
          if (rows.length !== 1) throw new Error(`probe matched ${rows.length} rows`);
          throw new Rollback();
        });
      } catch (e) {
        if (e instanceof Rollback) return 'ok';
        return checkViolation(e) ?? `other: ${errorChainMessage(e).slice(0, 160)}`;
      }
      return 'unreachable';
    });
  }

  const decision = (set: Pick<DecisionInsert, 'decision' | 'reason'>) => (tx: Tx) =>
    tx
      .insert(broadcastMemberDecisions)
      .values({
        tenantId: tenant.ctx.slug,
        broadcastId,
        versionId,
        round: 1,
        decidedByUserId: randomUUID(),
        decidedByContactId: randomUUID(),
        ...set,
      })
      .returning({ id: broadcastMemberDecisions.id });

  const version = (set: Pick<VersionInsert, 'subject'> & Partial<Pick<VersionInsert, 'noteToMember'>>) => (tx: Tx) =>
    tx
      .insert(broadcastVersions)
      .values({
        tenantId: tenant.ctx.slug,
        broadcastId,
        versionNo: 2,
        bodyHtml: '<p>v2</p>',
        bodySource: 'v2',
        authoredByUserId: randomUUID(),
        authoredByRole: 'admin_proxy',
        sentToMemberAt: SEED_AT,
        ...set,
      })
      .returning({ id: broadcastVersions.id });

  const reminderStage = (stage: number) => (tx: Tx) =>
    tx
      .update(broadcasts)
      .set({ memberReminderStage: stage })
      .where(and(eq(broadcasts.tenantId, tenant.ctx.slug), eq(broadcasts.broadcastId, broadcastId)))
      .returning({ id: broadcasts.broadcastId });

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(broadcasts).values({
        tenantId: tenant.ctx.slug,
        broadcastId,
        requestedByMemberId: randomUUID(),
        requestedByMemberPlanIdSnapshot: 'plan-c8',
        submittedByUserId: randomUUID(),
        actorRole: 'member_self_service',
        subject: 'C8 CHECK probe',
        bodyHtml: '<p>original</p>',
        bodySource: 'original',
        fromName: 'Chamber',
        replyToEmail: 'reply@example.com',
        segmentType: 'all_members',
        estimatedRecipientCount: 10,
        status: 'awaiting_member_approval',
        submittedAt: SEED_AT,
        currentRound: 1,
      });
      await tx.insert(broadcastVersions).values({
        tenantId: tenant.ctx.slug,
        id: versionId,
        broadcastId,
        versionNo: 1,
        subject: 'v1',
        bodyHtml: '<p>v1</p>',
        bodySource: 'v1',
        authoredByUserId: randomUUID(),
        authoredByRole: 'admin_proxy',
        sentToMemberAt: SEED_AT,
      });
    });
  });

  afterAll(async () => {
    if (tenant) await tenant.cleanup();
  });

  describe('broadcast_member_decisions_reason_check — the DB and the Domain agree at every boundary', () => {
    const REASON_CHECK = '23514 broadcast_member_decisions_reason_check';

    it.each([
      ['500 emoji (1,000 UTF-16 units) — exactly max', 'approved', EMOJI.repeat(500), 'ok'],
      ['501 emoji — max + 1', 'approved', EMOJI.repeat(501), REASON_CHECK],
      ['500 Thai code points with combining marks — exactly max', 'approved', THAI_500, 'ok'],
      ['501 Thai code points — max + 1', 'approved', `${THAI_500}ก`, REASON_CHECK],
      ['no note', 'approved', null, 'ok'],
      ['2,000 characters — exactly max', 'changes_requested', 'b'.repeat(2000), 'ok'],
      ['2,001 characters — max + 1', 'changes_requested', 'b'.repeat(2001), REASON_CHECK],
      ['2,001 characters — max + 1', 'approval_withdrawn', 'b'.repeat(2001), REASON_CHECK],
      ['a NULL reason', 'changes_requested', null, REASON_CHECK],
      ['a NULL reason', 'approval_withdrawn', null, REASON_CHECK],
    ] as const)('%s (%s)', async (_label, kind, reason, want) => {
      expect(await attempt(decision({ decision: kind, reason }))).toBe(want);
      // The Domain answers the same: what it accepts the DB stores, what it
      // refuses the DB refuses (a 422 up front, never a 500 from the CHECK).
      expect(validateDecisionReason(kind, reason).ok).toBe(want === 'ok');
    });

    it('the Thai probe is 500 code points and 500 UTF-16 units — a consistency check, not the discriminator', () => {
      expect([...THAI_500]).toHaveLength(500);
      expect(THAI_500).toHaveLength(500);
      expect(EMOJI.repeat(500)).toHaveLength(1000);
    });
  });

  describe('broadcast_versions', () => {
    const SUBJECT = '23514 broadcast_versions_subject_length';
    const NOTE = '23514 broadcast_versions_note_to_member_length';

    it.each([
      ['an empty subject', { subject: '' }, SUBJECT],
      ['a 201-character subject', { subject: 's'.repeat(201) }, SUBJECT],
      ['a 200-character subject (positive control)', { subject: 's'.repeat(200) }, 'ok'],
      ['a 1,001-character note to the member', { subject: 'v2', noteToMember: 'n'.repeat(1001) }, NOTE],
      ['a 1,000-character note to the member (positive control)', { subject: 'v2', noteToMember: 'n'.repeat(1000) }, 'ok'],
    ] as const)('%s', async (_label, set, want) => {
      expect(await attempt(version(set))).toBe(want);
    });
  });

  describe('broadcasts_member_reminder_stage_check', () => {
    it.each([
      [4, '23514 broadcasts_member_reminder_stage_check'],
      [-1, '23514 broadcasts_member_reminder_stage_check'],
      [3, 'ok'],
    ] as const)('member_reminder_stage = %i', async (stage, want) => {
      expect(await attempt(reminderStage(stage))).toBe(want);
    });
  });
});
