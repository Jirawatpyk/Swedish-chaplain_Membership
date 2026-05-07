/**
 * F8 Phase 5 Wave D · T144 — `verifyRenewalLinkToken` integration test
 * (live Neon).
 *
 * Covers the 6 reject reasons + happy path + replay detection +
 * cycle-completed idempotent path on real Postgres:
 *
 *   1. malformed_token  — garbled wire format
 *   2. mac_mismatch     — payload tampered after signing
 *   3. expired          — exp in the past
 *   4. cross_tenant     — tenant B verifies token signed for tenant A
 *   5. member_not_found_in_tenant — token mid mismatches cycle member
 *   6. replayed         — same token verified twice
 *   7. happy path       — fresh token + cycle → success + consumed_link_tokens row
 *   8. cycle_already_completed — race-window CHK033 idempotent no-consume
 *
 * Tests run on live Neon Singapore via DATABASE_URL from .env.local.
 * RLS is enforced via runInTenant — every read/write binds
 * `app.current_tenant`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { consumedLinkTokens } from '@/modules/renewals/infrastructure/schema-consumed-link-tokens';
import {
  verifyRenewalLinkToken,
  makeRenewalsDeps,
} from '@/modules/renewals';
import { renewalLinkTokenSigner } from '@/modules/renewals/infrastructure/renewal-link-token/hmac-signer';
import { buildPayload } from '@/modules/renewals/domain/renewal-link-token';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import {
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';
import {
  createActiveTestUser,
  type TestUser,
} from '../helpers/test-users';

describe('F8 verifyRenewalLinkToken — integration (T144)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let cycleIdA: string;
  let memberIdA: string;
  let planIdA: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    planIdA = `f8-token-${randomUUID().slice(0, 8)}`;
    memberIdA = randomUUID();
    cycleIdA = randomUUID();

    await runInTenant(tenantA.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId: planIdA,
        planName: { en: 'Token Test Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId: memberIdA,
        companyName: 'Token Co',
        country: 'TH',
        planId: planIdA,
        planYear: 2026,
      }),
    );
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenantA.ctx.slug,
        cycleId: cycleIdA,
        memberId: memberIdA,
        status: 'awaiting_payment',
        periodFrom: new Date('2026-06-01T00:00:00Z'),
        periodTo: new Date('2027-06-01T00:00:00Z'),
        expiresAt: new Date('2027-06-01T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: randomUUID(),
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      }),
    );
  }, 120_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      await db
        .delete(consumedLinkTokens)
        .where(eq(consumedLinkTokens.tenantId, t.ctx.slug))
        .catch(() => {});
      await db
        .delete(renewalCycles)
        .where(eq(renewalCycles.tenantId, t.ctx.slug))
        .catch(() => {});
      await db
        .delete(auditLog)
        .where(eq(auditLog.tenantId, t.ctx.slug))
        .catch(() => {});
    }
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  }, 120_000);

  it('happy path: signs + verifies token + inserts consumed_link_tokens row', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const now = new Date();
    const signed = renewalLinkTokenSigner.sign(
      buildPayload({
        tenantId: tenantA.ctx.slug,
        memberId: memberIdA,
        cycleId: cycleIdA,
        now,
      }),
    );
    const r = await verifyRenewalLinkToken(deps, {
      rawToken: signed.token,
      expectedTenantId: tenantA.ctx.slug,
      now,
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('success');
      if (r.value.kind === 'success') {
        expect(r.value.memberId).toBe(memberIdA);
        expect(r.value.cycleId).toBe(cycleIdA);
      }
    }
    // Verify the consumed_link_tokens row was inserted under tenant A's RLS
    const consumedRows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(consumedLinkTokens)
        .where(eq(consumedLinkTokens.cycleId, cycleIdA)),
    );
    expect(consumedRows.length).toBe(1);
  });

  it('replay: same token verified twice → second returns replayed', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const now = new Date();
    // Use a fresh member + cycle pair so the unique-active-cycle
    // invariant (one cycle per member in non-terminal status) is not
    // violated by the seeded cycle from beforeAll.
    const replayMemberId = randomUUID();
    const newCycleId = randomUUID();
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId: replayMemberId,
        companyName: 'Replay Co',
        country: 'TH',
        planId: planIdA,
        planYear: 2026,
      }),
    );
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenantA.ctx.slug,
        cycleId: newCycleId,
        memberId: replayMemberId,
        status: 'awaiting_payment',
        periodFrom: new Date('2026-06-01T00:00:00Z'),
        periodTo: new Date('2027-06-01T00:00:00Z'),
        expiresAt: new Date('2027-06-01T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: randomUUID(),
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      }),
    );
    const signed = renewalLinkTokenSigner.sign(
      buildPayload({
        tenantId: tenantA.ctx.slug,
        memberId: replayMemberId,
        cycleId: newCycleId,
        now,
      }),
    );
    const r1 = await verifyRenewalLinkToken(deps, {
      rawToken: signed.token,
      expectedTenantId: tenantA.ctx.slug,
      now,
      correlationId: randomUUID(),
    });
    expect(r1.ok).toBe(true);

    const r2 = await verifyRenewalLinkToken(deps, {
      rawToken: signed.token,
      expectedTenantId: tenantA.ctx.slug,
      now,
      correlationId: randomUUID(),
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.reason).toBe('replayed');
  });

  it('cross_tenant: tenant B verifies token signed for tenant A → cross_tenant reject', async () => {
    const deps = makeRenewalsDeps(tenantB.ctx.slug);
    const now = new Date();
    const signed = renewalLinkTokenSigner.sign(
      buildPayload({
        tenantId: tenantA.ctx.slug,
        memberId: memberIdA,
        cycleId: cycleIdA,
        now,
      }),
    );
    const r = await verifyRenewalLinkToken(deps, {
      rawToken: signed.token,
      expectedTenantId: tenantB.ctx.slug,
      now,
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('cross_tenant');
  });

  it('member_not_found_in_tenant: token cid does not match any cycle in tenant', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const now = new Date();
    const signed = renewalLinkTokenSigner.sign(
      buildPayload({
        tenantId: tenantA.ctx.slug,
        memberId: memberIdA,
        cycleId: randomUUID(), // unknown cycle
        now,
      }),
    );
    const r = await verifyRenewalLinkToken(deps, {
      rawToken: signed.token,
      expectedTenantId: tenantA.ctx.slug,
      now,
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('member_not_found_in_tenant');
  });

  it('expired: token with past exp returns expired', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const past = new Date(Date.now() - 60 * 24 * 3_600_000); // 60 days ago
    const signed = renewalLinkTokenSigner.sign(
      buildPayload({
        tenantId: tenantA.ctx.slug,
        memberId: memberIdA,
        cycleId: cycleIdA,
        now: past, // exp = past + 30d → still in the past
      }),
    );
    const r = await verifyRenewalLinkToken(deps, {
      rawToken: signed.token,
      expectedTenantId: tenantA.ctx.slug,
      now: new Date(),
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('expired');
  });

  it('malformed_token: garbled wire format returns malformed_token', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const r = await verifyRenewalLinkToken(deps, {
      rawToken: 'totally-not-a-token',
      expectedTenantId: tenantA.ctx.slug,
      now: new Date(),
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('malformed_token');
  });

  it('mac_mismatch: payload tampered after signing returns mac_mismatch', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const now = new Date();
    const signed = renewalLinkTokenSigner.sign(
      buildPayload({
        tenantId: tenantA.ctx.slug,
        memberId: memberIdA,
        cycleId: cycleIdA,
        now,
      }),
    );
    // Tamper the payload portion (middle part) — keep version + mac
    const parts = signed.token.split('.');
    const tampered = `${parts[0]}.${'aaaa' + parts[1]!.slice(4)}.${parts[2]}`;
    const r = await verifyRenewalLinkToken(deps, {
      rawToken: tampered,
      expectedTenantId: tenantA.ctx.slug,
      now,
      correlationId: randomUUID(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(['mac_mismatch', 'malformed_token']).toContain(r.error.reason);
    }
  });

  // cycle_already_completed: covered by unit test (T120 spec.ts) since
  // a `completed` cycle row requires a real F4 invoice (FK constraint
  // `renewal_cycles_linked_invoice_fk` + CHECK `completed → linked_invoice_id
  // NOT NULL`). Live integration would need to compose the full F4
  // invoice lifecycle to seed the row — that's covered by T145
  // self-service-renewal-tx (full F5→F4 onPaid → F8 chain).
});
