/**
 * COMP-1 US3-D — `erasureEvidenceReadAdapter.readForMember` live-Neon crux.
 *
 * The SECURITY-CRITICAL reader (PERMISSIVE-RLS tenant-NULL `user_erased`
 * union). Tested against live Neon with TWO real tenants because the whole
 * hazard is cross-tenant: `audit_log_tenant_isolation` is PERMISSIVE, so
 * tenant-NULL rows are DB-visible to every tenant and the only wall is the
 * app-layer predicate this reader deliberately removes for one event.
 *
 * Seeding: audit rows are inserted via raw `db.insert(auditLog)` (the
 * append-only trigger blocks DELETE/UPDATE, NOT INSERT; owner role bypasses
 * RLS+FORCE for the seed). The tenant-scoped arm rows carry `tenant_id =
 * <slug>` + `payload->>'member_id'`; the `user_erased` rows carry
 * `tenant_id = NULL` + `target_user_id = <uuid>` (mirrors the F1 use case).
 *
 * Cases (plan Task 2 Step 2):
 *  1. Union — tenant-scoped lifecycle ∪ tenant-NULL user_erased.
 *  2. Lifecycle (H-1) — invoice + credit-note + subprocessor arms all surface.
 *  3. FIX-1 — empty linked-users drops the user_erased arm (no leak).
 *  4. Cross-tenant (Principle-I) — tenant-B's events never returned for A.
 *  5. FIX-2 (defensive) — A's DPO sees the shared user_erased but never B's
 *     tenant-scoped events.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { erasureEvidenceReadAdapter } from '@/modules/auth/infrastructure/db/erasure-evidence-repo';
import {
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';

// Track every audit row we seed so we don't lean on the (no-op) audit cleanup;
// the append-only trigger blocks DELETE, so we instead keep seeded ids unique
// per-run (randomUUID member ids + tenant slugs) — pollution is harmless and
// scoped. We DO still run the tenant cleanup for any non-audit rows.
const tenants: TestTenant[] = [];

afterEach(async () => {
  for (const t of tenants.splice(0)) await t.cleanup();
});

/** Insert a tenant-scoped audit row carrying `payload.member_id`. */
async function seedTenantAudit(input: {
  tenantId: string;
  eventType: string;
  memberId: string;
  actorUserId?: string;
  payload?: Record<string, unknown>;
}) {
  await db.insert(auditLog).values({
    eventType: input.eventType as never,
    actorUserId: input.actorUserId ?? `actor-${randomUUID()}`,
    summary: `${input.eventType} ${input.memberId}`,
    requestId: `it-us3d-${randomUUID()}`,
    tenantId: input.tenantId,
    payload: { member_id: input.memberId, ...(input.payload ?? {}) },
  });
}

/** Insert a tenant-NULL `user_erased` row keyed by `target_user_id`. */
async function seedUserErased(input: {
  targetUserId: string;
  actorUserId?: string;
}) {
  await db.insert(auditLog).values({
    eventType: 'user_erased' as never,
    actorUserId: input.actorUserId ?? `actor-${randomUUID()}`,
    targetUserId: input.targetUserId,
    summary: `user_erased ${input.targetUserId}`,
    requestId: `it-us3d-${randomUUID()}`,
    tenantId: null,
  });
}

describe('erasureEvidenceReadAdapter.readForMember (live Neon, 2 tenants)', () => {
  it('Case 1 — UNIONs tenant-scoped lifecycle with the tenant-NULL user_erased', async () => {
    const { a, b } = await createTwoTestTenants();
    tenants.push(a, b);

    const memberId = randomUUID();
    const linkedUserId = randomUUID();

    await seedTenantAudit({
      tenantId: a.ctx.slug,
      eventType: 'member_erasure_requested',
      memberId,
      payload: { reason: 'gdpr_art17', identity_verified: true },
    });
    await seedTenantAudit({
      tenantId: a.ctx.slug,
      eventType: 'member_erased',
      memberId,
      payload: { reason: 'gdpr_art17', re_drive: false },
    });
    await seedUserErased({ targetUserId: linkedUserId });

    const rows = await erasureEvidenceReadAdapter.readForMember(
      a.ctx,
      memberId,
      [linkedUserId],
    );

    const types = rows.map((r) => r.eventType).sort();
    expect(types).toEqual(
      ['member_erased', 'member_erasure_requested', 'user_erased'].sort(),
    );
    // The user_erased row is matched by target_user_id (not payload.member_id).
    const userErased = rows.find((r) => r.eventType === 'user_erased');
    expect(userErased?.targetUserId).toBe(linkedUserId);
    // The tenant-scoped rows carry the member_id discriminator.
    const requested = rows.find(
      (r) => r.eventType === 'member_erasure_requested',
    );
    expect(requested?.payload?.member_id).toBe(memberId);
  });

  it('Case 2 — surfaces invoice + credit-note redaction + subprocessor (H-1 lifecycle)', async () => {
    const { a } = await createTwoTestTenants();
    tenants.push(a);

    const memberId = randomUUID();

    await seedTenantAudit({
      tenantId: a.ctx.slug,
      eventType: 'event_buyer_pii_redacted',
      memberId,
      payload: {
        invoice_id: randomUUID(),
        document_kind: 'invoice',
        invoice_subject: 'membership',
      },
    });
    await seedTenantAudit({
      tenantId: a.ctx.slug,
      eventType: 'event_buyer_pii_redacted',
      memberId,
      payload: {
        invoice_id: randomUUID(),
        document_kind: 'credit_note',
        original_invoice_id: randomUUID(),
      },
    });
    await seedTenantAudit({
      tenantId: a.ctx.slug,
      eventType: 'subprocessor_erasure_propagated',
      memberId,
      payload: { reason: 'gdpr_art17', resend_outcome: 'ok' },
    });

    const rows = await erasureEvidenceReadAdapter.readForMember(
      a.ctx,
      memberId,
      [],
    );

    const redactions = rows.filter(
      (r) => r.eventType === 'event_buyer_pii_redacted',
    );
    const kinds = redactions.map((r) => r.payload?.document_kind).sort();
    expect(kinds).toEqual(['credit_note', 'invoice']);
    expect(
      rows.some((r) => r.eventType === 'subprocessor_erasure_propagated'),
    ).toBe(true);
    // All three lifecycle rows present (2 redaction + 1 subprocessor).
    expect(rows).toHaveLength(3);
  });

  it('Case 3 — FIX-1: empty linked-users returns ONLY tenant-scoped rows (no user_erased leak)', async () => {
    const { a } = await createTwoTestTenants();
    tenants.push(a);

    const memberId = randomUUID();
    const unrelatedUserId = randomUUID();

    await seedTenantAudit({
      tenantId: a.ctx.slug,
      eventType: 'member_erasure_requested',
      memberId,
      payload: { reason: 'pdpa_s33' },
    });
    // An UNRELATED tenant-NULL user_erased that MUST NOT leak.
    await seedUserErased({ targetUserId: unrelatedUserId });

    const rows = await erasureEvidenceReadAdapter.readForMember(
      a.ctx,
      memberId,
      [],
    );

    expect(rows.every((r) => r.eventType !== 'user_erased')).toBe(true);
    expect(rows.map((r) => r.eventType)).toEqual(['member_erasure_requested']);
    // Belt-and-suspenders: the unrelated user's id appears nowhere.
    expect(
      rows.some((r) => r.targetUserId === unrelatedUserId),
    ).toBe(false);
  });

  it('Case 4 — cross-tenant: tenant-B erasure events are NOT returned for tenant-A', async () => {
    const { a, b } = await createTwoTestTenants();
    tenants.push(a, b);

    const memberA = randomUUID();
    const memberB = randomUUID();

    await seedTenantAudit({
      tenantId: a.ctx.slug,
      eventType: 'member_erased',
      memberId: memberA,
    });
    // tenant-B's erasure for a DIFFERENT member — must be invisible to A.
    await seedTenantAudit({
      tenantId: b.ctx.slug,
      eventType: 'member_erased',
      memberId: memberB,
    });

    const rows = await erasureEvidenceReadAdapter.readForMember(
      a.ctx,
      memberA,
      [],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload?.member_id).toBe(memberA);
    expect(
      rows.some((r) => r.payload?.member_id === memberB),
    ).toBe(false);
  });

  it('Case 5 — FIX-2 (defensive): A sees the shared user_erased but NEVER B tenant-scoped events', async () => {
    // NOTE: the cross-tenant-shared-login premise (a single user_erased target
    // bound to a member in BOTH tenants) CANNOT occur in prod — each users.id
    // belongs to ONE member's contact lineage (US2a) and `lower(email)` is
    // globally unique on `users`. This is a defensive regression pin.
    const { a, b } = await createTwoTestTenants();
    tenants.push(a, b);

    const memberA = randomUUID();
    const memberB = randomUUID();
    const sharedUserId = randomUUID();

    // The tenant-NULL user_erased for the shared user.
    await seedUserErased({ targetUserId: sharedUserId });
    // tenant-B's tenant-SCOPED member_erased for member-B.
    await seedTenantAudit({
      tenantId: b.ctx.slug,
      eventType: 'member_erased',
      memberId: memberB,
    });

    // tenant-A's DPO reads member-A's evidence, binding the shared user id.
    const rows = await erasureEvidenceReadAdapter.readForMember(
      a.ctx,
      memberA,
      [sharedUserId],
    );

    // A SEES the shared user_erased (the target_user_id bound matches).
    const userErased = rows.find((r) => r.eventType === 'user_erased');
    expect(userErased?.targetUserId).toBe(sharedUserId);
    // A NEVER sees B's tenant-scoped member_erased (tenant arm pins tenant_id=A).
    expect(
      rows.some((r) => r.payload?.member_id === memberB),
    ).toBe(false);
  });
});
