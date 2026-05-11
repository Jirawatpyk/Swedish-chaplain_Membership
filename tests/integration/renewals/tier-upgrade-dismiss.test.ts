/**
 * F8 Phase 7 / Round 6 review-fix F-002 — `dismissTierUpgrade` integration tests.
 *
 * Closes the AS3 (Admin Dismiss) coverage gap flagged by the staff
 * review:
 *
 *   AS3: "Given an admin clicks Dismiss on a suggestion, When they
 *   confirm with an optional reason, Then the suggestion's status
 *   becomes `dismissed`, `suppressed_until` is set to `today + 90d`,
 *   audit event `tier_upgrade_dismissed` is emitted with the reason,
 *   and the cron will not re-suggest the same upgrade for that member
 *   for 90 days."
 *
 * Phase 7's Round 1–5 review cycles only verified the suppression-side
 * branch (a pre-seeded `dismissed` row hides the member from the cron's
 * candidate query). The `dismissTierUpgrade` use-case itself — the
 * `open` → `dismissed` transition + `suppressed_until` write + audit
 * emit — was untested at integration layer.
 *
 * Test scope:
 *   1. Dismiss happy path — open suggestion → dismissed, audit emitted
 *      with member_id + suggestion_id + suppressed_until.
 *   2. Dismiss with reason — reason persisted in `dismissed_reason`
 *      column and in the audit payload.
 *   3. Re-dismiss attempt — second `dismissTierUpgrade` on the same
 *      suggestion returns `suggestion_not_open` (the row is no longer
 *      `open` after the first dismiss).
 *   4. Suppression window ≈ 90d from now.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { tierUpgradeSuggestions } from '@/modules/renewals/infrastructure/schema-tier-upgrade-suggestions';
import {
  dismissTierUpgrade,
  makeRenewalsDeps,
  parseSuggestionId,
  type SuggestionId,
} from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface SeededState {
  readonly memberId: string;
  readonly suggestionId: SuggestionId;
}

async function seedOpenSuggestion(
  tenant: TestTenant,
): Promise<SeededState> {
  const memberId = randomUUID();
  const suggestionUuid = randomUUID();

  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      companyName: 'Dismiss Probe Co',
      country: 'TH',
      planId: 'regular',
      planYear: 2026,
      turnoverThb: 120_000_000,
    });
    await tx.insert(tierUpgradeSuggestions).values({
      tenantId: tenant.ctx.slug,
      suggestionId: suggestionUuid,
      memberId,
      fromPlanId: 'regular',
      toPlanId: 'premium',
      reasonCode: 'declared_turnover_above_threshold',
      evidenceJsonb: {
        reasonCode: 'declared_turnover_above_threshold',
        turnoverThb: 120_000_000,
        thresholdMetAt: new Date().toISOString(),
      },
      status: 'open',
    });
  });

  const idResult = parseSuggestionId(suggestionUuid);
  if (!idResult.ok) throw new Error('seeded suggestion id failed parse');
  return { memberId, suggestionId: idResult.value };
}

async function clearTenant(tenant: TestTenant): Promise<void> {
  for (const tableQuery of [
    db
      .delete(tierUpgradeSuggestions)
      .where(eq(tierUpgradeSuggestions.tenantId, tenant.ctx.slug)),
    db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)),
    db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)),
  ]) {
    await tableQuery.catch(() => {});
  }
}

describe('F8 dismissTierUpgrade — integration (Round 6 F-002)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
  }, 180_000);

  afterAll(async () => {
    await clearTenant(tenant).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  beforeEach(async () => {
    await clearTenant(tenant).catch(() => {});
  });

  it('AS3 happy path — dismiss without reason transitions open → dismissed + sets suppressed_until ≈ today+90d + emits audit', async () => {
    const seeded = await seedOpenSuggestion(tenant);
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const before = Date.now();

    const result = await dismissTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      suggestionId: seeded.suggestionId,
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.suggestionId).toBe(seeded.suggestionId);

    const suppressedUntilMs = new Date(result.value.suppressedUntil).getTime();
    const target = before + 90 * MS_PER_DAY;
    // Allow 5-second slack for clock + tx commit.
    expect(suppressedUntilMs).toBeGreaterThanOrEqual(target - 5_000);
    expect(suppressedUntilMs).toBeLessThanOrEqual(target + 60_000);

    // Row state pinned.
    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(tierUpgradeSuggestions)
        .where(eq(tierUpgradeSuggestions.suggestionId, seeded.suggestionId)),
    );
    expect(row?.status).toBe('dismissed');
    expect(row?.suppressedUntil).not.toBeNull();
    // Domain encodes "no reason given" as the empty string (see
    // `dismiss-tier-upgrade.ts:84-90` — `dismissedReason: ''` when input
    // reason is undefined).
    expect(row?.dismissedReason).toBe('');
    expect(row?.closedAt).not.toBeNull();

    // Audit row asserts the canonical event type + member_id + null
    // reason in payload.
    const audits = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.eventType, 'tier_upgrade_dismissed')),
    );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const payload = audits[0]?.payload as Record<string, unknown>;
    expect(payload?.suggestion_id).toBe(seeded.suggestionId);
    expect(payload?.member_id).toBe(seeded.memberId);
    expect(payload?.reason).toBeNull();
  }, 60_000);

  it('AS3 with reason — reason persisted in dismissed_reason + audit payload', async () => {
    const seeded = await seedOpenSuggestion(tenant);
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const reason = 'Member already declined the upsell on a Q3 phone call.';

    const result = await dismissTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      suggestionId: seeded.suggestionId,
      reason,
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(result.ok).toBe(true);

    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(tierUpgradeSuggestions)
        .where(eq(tierUpgradeSuggestions.suggestionId, seeded.suggestionId)),
    );
    expect(row?.dismissedReason).toBe(reason);

    const audits = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.eventType, 'tier_upgrade_dismissed')),
    );
    const payload = audits[0]?.payload as Record<string, unknown>;
    expect(payload?.reason).toBe(reason);
  }, 60_000);

  it('Re-dismiss attempt — second call on same suggestion returns suggestion_not_open + B row unchanged', async () => {
    const seeded = await seedOpenSuggestion(tenant);
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    const first = await dismissTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      suggestionId: seeded.suggestionId,
      reason: 'first dismiss',
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(first.ok).toBe(true);

    const second = await dismissTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      suggestionId: seeded.suggestionId,
      reason: 'second dismiss attempt',
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.kind).toBe('suggestion_not_open');

    // First reason persists; second attempt did NOT overwrite the row.
    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(tierUpgradeSuggestions)
        .where(eq(tierUpgradeSuggestions.suggestionId, seeded.suggestionId)),
    );
    expect(row?.dismissedReason).toBe('first dismiss');

    // Exactly one `tier_upgrade_dismissed` audit row, not two.
    const audits = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.eventType, 'tier_upgrade_dismissed')),
    );
    expect(audits).toHaveLength(1);
  }, 60_000);
});
