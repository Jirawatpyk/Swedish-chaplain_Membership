/**
 * T051 + T052 — F9 US3 unified multi-source timeline (live Neon).
 *
 * Authored RED before the repo swap (T054): the F3 repo read `audit_log`
 * only, so these multi-source + keyset-tiebreak assertions fail against it
 * and pass only once `drizzle-timeline-repo` queries `member_timeline_v`.
 *
 * T051 (AS-1/AS-5): a member with rows across all six sources (audit,
 * invoice, payment, event, broadcast, renewal) yields one reverse-chrono
 * stream tagged per `source`; absent sources contribute nothing (no error).
 *
 * T052 (R2-E7): two rows from DIFFERENT sources sharing an identical
 * `occurred_at` paginate across a page boundary with no loss / duplication
 * — proving the `(occurred_at DESC, ref_id DESC)` keyset tiebreak on the
 * TEXT `ref_id`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { timelineList } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { payments } from '@/modules/payments/infrastructure/schema';
import { events, eventRegistrations } from '@/modules/events/infrastructure/schema';
import { broadcasts } from '@/modules/broadcasts/infrastructure/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { drizzleTimelineRepo } from '@/modules/members/infrastructure/timeline/drizzle-timeline-repo';
import {
  createTestTenant,
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import {
  seedMemberAndRenewalCycle,
  type SeededRenewalCycle,
} from '../helpers/seed-renewal-cycle';

const PLAN_ID = 'regular'; // seedMemberAndRenewalCycle default plan id.

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'Timeline Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'tl@example.com',
};

/** Minimal issued/paid invoice row for a member (satisfies the F4 CHECKs). */
function invoiceRow(args: {
  tenantId: string;
  memberId: string;
  draftByUserId: string;
  seq: number;
  issueDate: string;
}) {
  return {
    tenantId: args.tenantId,
    invoiceId: randomUUID(),
    memberId: args.memberId,
    planYear: 2026,
    planId: PLAN_ID,
    draftByUserId: args.draftByUserId,
    status: 'issued' as const,
    fiscalYear: 2026,
    sequenceNumber: args.seq,
    documentNumber: `TL-2026-${String(args.seq).padStart(6, '0')}`,
    issueDate: args.issueDate,
    dueDate: '2026-12-31',
    subtotalSatang: 70_000n,
    vatRateSnapshot: '0.0000',
    vatSatang: 0n,
    totalSatang: 70_000n,
    creditedTotalSatang: 0n,
    proRatePolicySnapshot: 'monthly' as const,
    netDaysSnapshot: 30,
    tenantIdentitySnapshot: SNAP_TENANT,
    memberIdentitySnapshot: SNAP_MEMBER,
    pdfBlobKey: `invoicing/tl/2026/${args.seq}.pdf`,
    pdfSha256: 'a'.repeat(64),
    pdfTemplateVersion: 1,
  };
}

async function deleteSeededRows(tenantSlug: string): Promise<void> {
  await db.delete(eventRegistrations).where(eq(eventRegistrations.tenantId, tenantSlug)).catch(() => {});
  await db.delete(events).where(eq(events.tenantId, tenantSlug)).catch(() => {});
  await db.delete(payments).where(eq(payments.tenantId, tenantSlug)).catch(() => {});
  await db.delete(broadcasts).where(eq(broadcasts.tenantId, tenantSlug)).catch(() => {});
  await db.delete(invoices).where(eq(invoices.tenantId, tenantSlug)).catch(() => {});
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantSlug)).catch(() => {});
}

describe('F9 US3 — multi-source timeline (T051, live Neon)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  let seeded: SeededRenewalCycle;
  let memberId: string;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    // member + plan + 1 renewal_cycle (renewal source).
    seeded = await seedMemberAndRenewalCycle({
      tenant: tenant.ctx,
      planIdAtCycleStart: PLAN_ID,
      tierAtCycleStart: 'regular',
    });
    memberId = seeded.memberId;

    const eventId = randomUUID();

    await runInTenant(tenant.ctx, async (tx) => {
      // invoice (occurred_at = issue_date 2026-06-01)
      await tx.insert(invoices).values(
        invoiceRow({
          tenantId: tenant.ctx.slug,
          memberId,
          draftByUserId: admin.userId,
          seq: 1,
          issueDate: '2026-06-01',
        }),
      );

      // event + registration (occurred_at = event start_date 2026-06-02)
      await tx.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        externalId: `ext-${randomUUID().slice(0, 8)}`,
        name: 'Networking Night',
        startDate: new Date('2026-06-02T10:00:00.000Z'),
        isCulturalEvent: true,
      });
      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        eventId,
        externalId: `reg-${randomUUID().slice(0, 8)}`,
        attendeeEmail: 'attendee@example.com',
        attendeeName: 'Anna Andersson',
        matchType: 'member_domain',
        matchedMemberId: memberId,
        countedAgainstCulturalQuota: true,
        registeredAt: new Date('2026-06-02T09:00:00.000Z'),
      });

      // payment referencing the invoice (occurred_at = completed_at 2026-06-03)
      const invForPayment = invoiceRow({
        tenantId: tenant.ctx.slug,
        memberId,
        draftByUserId: admin.userId,
        seq: 2,
        issueDate: '2026-05-15',
      });
      await tx.insert(invoices).values(invForPayment);
      await tx.insert(payments).values({
        id: randomUUID(),
        tenantId: tenant.ctx.slug,
        invoiceId: invForPayment.invoiceId,
        memberId,
        method: 'promptpay',
        status: 'succeeded',
        amountSatang: 70_000n,
        processorPaymentIntentId: `pi_${randomUUID().slice(0, 12)}`,
        processorEnvironment: 'test',
        initiatedAt: new Date('2026-06-03T09:59:00.000Z'),
        completedAt: new Date('2026-06-03T10:00:00.000Z'),
        actorUserId: admin.userId,
        correlationId: randomUUID(),
      });

      // broadcast (sent) (occurred_at = sent_at 2026-06-04)
      await tx.insert(broadcasts).values({
        tenantId: tenant.ctx.slug,
        broadcastId: randomUUID(),
        requestedByMemberId: memberId,
        requestedByMemberPlanIdSnapshot: PLAN_ID,
        submittedByUserId: admin.userId,
        actorRole: 'member_self_service',
        subject: 'Member newsletter',
        bodyHtml: '<p>body</p>',
        bodySource: 'body',
        fromName: 'Chamber',
        replyToEmail: 'reply@example.com',
        segmentType: 'all_members',
        segmentParams: null,
        customRecipientEmails: null,
        estimatedRecipientCount: 100,
        status: 'sent',
        submittedAt: new Date('2026-06-04T08:00:00.000Z'),
        sentAt: new Date('2026-06-04T10:00:00.000Z'),
        quotaYearConsumed: 2026,
        quotaConsumedAt: new Date('2026-06-04T10:00:00.000Z'),
      });
    });

    // audit row (occurred_at = timestamp 2026-06-05) — actor is a real
    // user uuid → actor_kind 'staff'.
    await db.insert(auditLog).values({
      eventType: 'member_updated',
      actorUserId: admin.userId,
      summary: 'synthetic member_updated',
      requestId: `tl-${randomUUID()}`,
      tenantId: tenant.ctx.slug,
      payload: { member_id: memberId, fields_changed: ['company_name'] },
      timestamp: new Date('2026-06-05T10:00:00.000Z'),
    });
  }, 180_000);

  afterAll(async () => {
    await deleteSeededRows(tenant.ctx.slug);
    await seeded.ownerCleanup().catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('AS-1 — merges all six sources into one reverse-chronological stream', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const r = await timelineList(
      { memberId, limit: 50 },
      { actorUserId: admin.userId, actorRole: 'admin', requestId: 'us3-1' },
      tenant.ctx,
      { memberRepo: deps.memberRepo, timeline: deps.timeline },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // seedMemberAndRenewalCycle direct-inserts the member (no member_created
    // audit), so the stream is exactly: 1 synthetic audit + 2 invoices +
    // 1 payment + 1 event + 1 broadcast + 1 renewal = 7.
    expect(r.value.events.length).toBeGreaterThanOrEqual(7);

    // All six sources present.
    const sources = new Set(r.value.events.map((e) => e.source));
    for (const s of ['audit', 'invoice', 'payment', 'event', 'broadcast', 'renewal'] as const) {
      expect(sources.has(s), `expected a '${s}' row in the stream`).toBe(true);
    }

    // Reverse-chronological (non-increasing occurred_at).
    for (let i = 0; i < r.value.events.length - 1; i++) {
      expect(r.value.events[i]!.timestamp.getTime()).toBeGreaterThanOrEqual(
        r.value.events[i + 1]!.timestamp.getTime(),
      );
    }

    // Per-source sanity: invoice carries its status; event carries event_id.
    const invoice = r.value.events.find((e) => e.source === 'invoice');
    expect(invoice?.payload?.status).toBe('issued');
    const event = r.value.events.find((e) => e.source === 'event');
    expect(event?.actorKind).toBe('member');
    expect(typeof event?.payload?.event_id).toBe('string');
    // Audit rows keep the enriched event_type (drives the i18n label).
    const audit = r.value.events.find((e) => e.source === 'audit');
    expect(audit?.eventType.length).toBeGreaterThan(0);
    expect(audit?.actorKind).toBe('staff');
  });

  it('AS-3 — source filter narrows to invoices only', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const r = await timelineList(
      { memberId, limit: 50, source: 'invoice' },
      { actorUserId: admin.userId, actorRole: 'admin', requestId: 'us3-2' },
      tenant.ctx,
      { memberRepo: deps.memberRepo, timeline: deps.timeline },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.events.length).toBe(2); // two invoices seeded
    for (const e of r.value.events) expect(e.source).toBe('invoice');
  });

  it('AS-3 — actorKind filter narrows to system rows', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const r = await timelineList(
      { memberId, limit: 50, actorKind: 'system' },
      { actorUserId: admin.userId, actorRole: 'admin', requestId: 'us3-3' },
      tenant.ctx,
      { memberRepo: deps.memberRepo, timeline: deps.timeline },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.events.length).toBeGreaterThan(0);
    for (const e of r.value.events) expect(e.actorKind).toBe('system');
    // payment + renewal are system-kind; no audit/staff rows leak through.
    expect(r.value.events.every((e) => e.source !== 'audit')).toBe(true);
  });

  it('AS-3 — date-range filter excludes out-of-window rows', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    // Window covering only the 2026-06-03 payment .. 2026-06-05 audit.
    const r = await timelineList(
      {
        memberId,
        limit: 50,
        from: '2026-06-03T00:00:00.000Z',
        to: '2026-06-05T23:59:59.999Z',
      },
      { actorUserId: admin.userId, actorRole: 'admin', requestId: 'us3-4' },
      tenant.ctx,
      { memberRepo: deps.memberRepo, timeline: deps.timeline },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const e of r.value.events) {
      expect(e.timestamp.getTime()).toBeGreaterThanOrEqual(
        new Date('2026-06-03T00:00:00.000Z').getTime(),
      );
      expect(e.timestamp.getTime()).toBeLessThanOrEqual(
        new Date('2026-06-05T23:59:59.999Z').getTime(),
      );
    }
    // The 2026-06-01 invoice + earlier renewal must be excluded.
    expect(r.value.events.some((e) => e.source === 'renewal')).toBe(false);
  });

  it('AS-5 — a member with no source rows yields an empty stream, no error', async () => {
    const bareMemberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId: bareMemberId,
        companyName: 'Bare Co',
        country: 'TH',
        planId: PLAN_ID,
        planYear: 2026,
      });
    });
    const deps = buildMembersDeps(tenant.ctx);
    const r = await timelineList(
      { memberId: bareMemberId, limit: 50 },
      { actorUserId: admin.userId, actorRole: 'admin', requestId: 'us3-as5' },
      tenant.ctx,
      { memberRepo: deps.memberRepo, timeline: deps.timeline },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.events).toEqual([]);
    expect(r.value.total).toBe(0);
  });
});

describe('F9 US3 — keyset tiebreak on identical occurred_at (T052, live Neon)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  let ownerCleanup: () => Promise<void>;
  const memberId = randomUUID();
  // An invoice issue_date '2026-07-01' casts to 2026-07-01T00:00:00Z — the
  // audit row is stamped to the exact same instant so the two rows collide
  // on occurred_at and can only be separated by the ref_id tiebreak.
  const COLLISION = '2026-07-01T00:00:00.000Z';

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    // Reuse the renewal helper purely to seed the plan; then add our own
    // isolated member with exactly two same-instant rows.
    const seeded = await seedMemberAndRenewalCycle({
      tenant: tenant.ctx,
      planIdAtCycleStart: PLAN_ID,
      tierAtCycleStart: 'regular',
    });
    ownerCleanup = seeded.ownerCleanup;

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        companyName: 'Tiebreak Co',
        country: 'TH',
        planId: PLAN_ID,
        planYear: 2026,
      });
      await tx.insert(invoices).values(
        invoiceRow({
          tenantId: tenant.ctx.slug,
          memberId,
          draftByUserId: admin.userId,
          seq: 100,
          issueDate: '2026-07-01',
        }),
      );
    });

    await db.insert(auditLog).values({
      eventType: 'member_updated',
      actorUserId: admin.userId,
      summary: 'tiebreak audit',
      requestId: `tb-${randomUUID()}`,
      tenantId: tenant.ctx.slug,
      payload: { member_id: memberId, fields_changed: ['notes_meta'] },
      timestamp: new Date(COLLISION),
    });
  }, 180_000);

  afterAll(async () => {
    await deleteSeededRows(tenant.ctx.slug);
    await ownerCleanup().catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('paginates two identical-occurred_at rows across the boundary with no loss/dup', async () => {
    const deps = buildMembersDeps(tenant.ctx);

    const page1 = await timelineList(
      { memberId, limit: 1 },
      { actorUserId: admin.userId, actorRole: 'admin', requestId: 'tb-1' },
      tenant.ctx,
      { memberRepo: deps.memberRepo, timeline: deps.timeline },
    );
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    expect(page1.value.events).toHaveLength(1);
    expect(page1.value.nextCursor).not.toBeNull();

    const page2 = await timelineList(
      {
        memberId,
        limit: 1,
        ...(page1.value.nextCursor ? { cursor: page1.value.nextCursor } : {}),
      },
      { actorUserId: admin.userId, actorRole: 'admin', requestId: 'tb-2' },
      tenant.ctx,
      { memberRepo: deps.memberRepo, timeline: deps.timeline },
    );
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;
    expect(page2.value.events).toHaveLength(1);

    // Both rows share the collision instant…
    expect(page1.value.events[0]!.timestamp.toISOString()).toBe(COLLISION);
    expect(page2.value.events[0]!.timestamp.toISOString()).toBe(COLLISION);
    // …and are DISTINCT (no duplication across the page boundary).
    expect(page1.value.events[0]!.id).not.toBe(page2.value.events[0]!.id);
    // The two sources (audit + invoice) are exactly the seeded pair.
    const sources = [page1.value.events[0]!.source, page2.value.events[0]!.source].sort();
    expect(sources).toEqual(['audit', 'invoice']);
  });
});

describe('F9 US3 — cross-tenant isolation of the UNION view (I4, live Neon)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let admin: TestUser;
  const cleanups: Array<() => Promise<void>> = [];
  const memberB = randomUUID();

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    // Seed a member + a NON-audit row (invoice) in tenant B only.
    const seeded = await seedMemberAndRenewalCycle({
      tenant: tenantB.ctx,
      memberId: memberB,
      planIdAtCycleStart: PLAN_ID,
      tierAtCycleStart: 'regular',
    });
    cleanups.push(seeded.ownerCleanup);
    await runInTenant(tenantB.ctx, async (tx) => {
      await tx.insert(invoices).values(
        invoiceRow({
          tenantId: tenantB.ctx.slug,
          memberId: memberB,
          draftByUserId: admin.userId,
          seq: 500,
          issueDate: '2026-08-01',
        }),
      );
    });
    // And an audit row for member B in tenant B.
    await db.insert(auditLog).values({
      eventType: 'member_updated',
      actorUserId: admin.userId,
      summary: 'tenantB audit',
      requestId: `xb-${randomUUID()}`,
      tenantId: tenantB.ctx.slug,
      payload: { member_id: memberB, fields_changed: ['notes'] },
      timestamp: new Date('2026-08-02T10:00:00.000Z'),
    });
  }, 180_000);

  afterAll(async () => {
    await deleteSeededRows(tenantB.ctx.slug);
    for (const c of cleanups) await c().catch(() => {});
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  }, 120_000);

  it('the security_invoker view leaks NO tenant-B rows (any source) to a tenant-A query', async () => {
    // Query the repo directly under tenant A for tenant B's member — the
    // use-case member-existence guard would short-circuit, so we probe the
    // view layer itself (Principle I, NON-NEGOTIABLE). RLS on every base table
    // must scope the UNION to tenant A → zero rows.
    const r = await drizzleTimelineRepo.listByMember(tenantA.ctx, {
      memberId: memberB,
      limit: 50,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.events).toEqual([]);
    expect(r.value.total).toBe(0);

    // Sanity: the same probe UNDER tenant B DOES see member B's rows (invoice
    // + audit) — proving the zero-result above is isolation, not a dead query.
    const own = await drizzleTimelineRepo.listByMember(tenantB.ctx, {
      memberId: memberB,
      limit: 50,
    });
    expect(own.ok).toBe(true);
    if (!own.ok) return;
    expect(own.value.total).toBeGreaterThanOrEqual(2);
    const sources = new Set(own.value.events.map((e) => e.source));
    expect(sources.has('invoice')).toBe(true);
    expect(sources.has('audit')).toBe(true);
  });
});
