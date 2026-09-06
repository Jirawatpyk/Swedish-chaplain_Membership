/**
 * 108 PR-D T045 (US4 / FR-027, FR-030, FR-052, FR-053) — per-contact marketing
 * opt-out on live Neon.
 *
 * Part 1 — schema (migrations 0294 + 0295): the three nullable columns exist,
 * the correlated CHECK refuses a partial row, the source CHECK refuses an
 * unknown source, the partial index RESERVED for PR-C's audience resolver
 * exists with the expected definition (existence only — PR-D's own queries do
 * not use it; the 0294 header puts the `EXPLAIN` obligation on PR-C), and
 * the two audit enum values are registered.
 *
 * Part 2 — `setMarketingOptOutInTx` (row lock, same-state = unchanged, removed
 * = not_found), cross-tenant isolation through the real RLS (FR-052), and the
 * full `setContactMarketingOptOut` use case through the production composition
 * (`buildContactMarketingDeps`): audit row with ids + source and no address
 * (FR-053a); a suppressed address refuses "on" (FR-025).
 *
 * Simulated emails only — no real PII.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { ok, err } from '@/lib/result';
import { errorChainMessage } from '@/lib/db-errors';
import { buildContactMarketingDeps } from '@/lib/contact-marketing-deps';
import {
  asContactId,
  asMemberId,
  drizzleContactRepo,
  drizzleMemberRepo,
  getMemberPrimaryContact,
  setContactMarketingOptOut,
} from '@/modules/members';
import { RECEIVES_MARKETING } from '@/modules/members/domain/contact';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { marketingUnsubscribes } from '@/modules/broadcasts/infrastructure/schema';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { seedPortalMemberWithContact, seedPortalPlan } from '../helpers/portal-seed';

async function expectRefused(p: Promise<unknown>, token: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  expect(caught, 'expected the statement to be refused').toBeDefined();
  expect(errorChainMessage(caught)).toMatch(token);
}

describe('108 PR-D — contact marketing opt-out columns (migrations 0294 + 0295)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  let contactId: string;
  const planId = `mkt-${randomUUID().slice(0, 6)}`;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedPortalPlan(tenant.ctx.slug, admin.userId, planId);
    const seeded = await seedPortalMemberWithContact(tenant, planId);
    contactId = seeded.contactId;
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  }, 120_000);

  it('0294: the three nullable opt-out columns exist with the data-model types', async () => {
    const rows = await db.execute(sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'contacts'
        AND column_name IN ('marketing_opt_out_at', 'marketing_opt_out_source', 'marketing_opt_out_by_user_id')
      ORDER BY column_name
    `);
    const cols = rows.map((r) => r as { column_name: string; data_type: string; is_nullable: string });
    expect(cols.map((c) => c.column_name)).toEqual([
      'marketing_opt_out_at',
      'marketing_opt_out_by_user_id',
      'marketing_opt_out_source',
    ]);
    expect(cols.every((c) => c.is_nullable === 'YES')).toBe(true);
    expect(cols.map((c) => c.data_type)).toEqual([
      'timestamp with time zone',
      'uuid',
      'text',
    ]);
  });

  it('0294: a fully-set opt-out row is accepted and reads back', async () => {
    await runInTenant(tenant.ctx, (tx) =>
      tx.execute(sql`
        UPDATE contacts
        SET marketing_opt_out_at = now(),
            marketing_opt_out_source = 'staff',
            marketing_opt_out_by_user_id = ${admin.userId}::uuid
        WHERE contact_id = ${contactId}::uuid
      `),
    );
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx.execute(sql`
        SELECT marketing_opt_out_source AS source, marketing_opt_out_by_user_id AS by_user_id
        FROM contacts WHERE contact_id = ${contactId}::uuid
      `),
    );
    const row = rows[0] as { source: string; by_user_id: string };
    expect(row.source).toBe('staff');
    expect(row.by_user_id).toBe(admin.userId);
    // Reset to "receives" for the next cases.
    await runInTenant(tenant.ctx, (tx) =>
      tx.execute(sql`
        UPDATE contacts
        SET marketing_opt_out_at = NULL, marketing_opt_out_source = NULL, marketing_opt_out_by_user_id = NULL
        WHERE contact_id = ${contactId}::uuid
      `),
    );
  });

  it('0294: the correlated CHECK refuses a partial row (timestamp without source/actor)', async () => {
    await expectRefused(
      runInTenant(tenant.ctx, (tx) =>
        tx.execute(sql`
          UPDATE contacts SET marketing_opt_out_at = now()
          WHERE contact_id = ${contactId}::uuid
        `),
      ),
      /contacts_marketing_opt_out_correlated/,
    );
  });

  it('0294: the correlated CHECK refuses source + actor without a timestamp', async () => {
    await expectRefused(
      runInTenant(tenant.ctx, (tx) =>
        tx.execute(sql`
          UPDATE contacts
          SET marketing_opt_out_source = 'self', marketing_opt_out_by_user_id = ${admin.userId}::uuid
          WHERE contact_id = ${contactId}::uuid
        `),
      ),
      /contacts_marketing_opt_out_correlated/,
    );
  });

  it('0294: the source CHECK refuses anything but staff | self', async () => {
    await expectRefused(
      runInTenant(tenant.ctx, (tx) =>
        tx.execute(sql`
          UPDATE contacts
          SET marketing_opt_out_at = now(),
              marketing_opt_out_source = 'import',
              marketing_opt_out_by_user_id = ${admin.userId}::uuid
          WHERE contact_id = ${contactId}::uuid
        `),
      ),
      /contacts_marketing_opt_out_source_check/,
    );
  });

  it('0294: the partial recipients index exists on (tenant_id, member_id, contact_id) WHERE live AND not opted out', async () => {
    const rows = await db.execute(sql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'contacts'
        AND indexname = 'contacts_marketing_recipients_idx'
    `);
    expect(rows).toHaveLength(1);
    const def = (rows[0] as { indexdef: string }).indexdef;
    expect(def).toMatch(/\(tenant_id, member_id, contact_id\)/);
    expect(def).toMatch(/removed_at IS NULL/);
    expect(def).toMatch(/marketing_opt_out_at IS NULL/);
  });

  it('0296: the NON-partial carry-forward index exists on (tenant_id, lower(email), created_at DESC)', async () => {
    // Round-2 review finding 11. `findCarriedSelfOptOut` must see REMOVED
    // rows, so neither partial lower(email) index (0009, 0182) can serve it;
    // without this one every contact INSERT scans the tenant. A migration that
    // drops or renames it would silently restore that scan — so it is pinned.
    const rows = await db.execute(sql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'contacts'
        AND indexname = 'contacts_tenant_lower_email_all_idx'
    `);
    expect(rows).toHaveLength(1);
    const def = (rows[0] as { indexdef: string }).indexdef;
    expect(def).toMatch(/\(tenant_id, lower\(email\), created_at DESC\)/);
    expect(def).not.toMatch(/WHERE/);
  });

  it('0295: both contact-marketing audit event types are registered', async () => {
    const rows = await db.execute(sql`
      SELECT enumlabel FROM pg_enum e
      JOIN pg_type t ON e.enumtypid = t.oid
      WHERE t.typname = 'audit_event_type'
        AND enumlabel IN ('contact_marketing_opted_out', 'contact_marketing_opted_in')
      ORDER BY enumlabel
    `);
    expect(rows.map((r) => (r as { enumlabel: string }).enumlabel)).toEqual([
      'contact_marketing_opted_in',
      'contact_marketing_opted_out',
    ]);
  });
});

describe('108 PR-D — setMarketingOptOutInTx + setContactMarketingOptOut (live Neon)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let admin: TestUser;
  let memberId: string;
  let contactId: string;
  let removedContactId: string;
  let suppressedContactId: string;
  const planId = `mkt2-${randomUUID().slice(0, 6)}`;
  const suppressedEmail = `sim-unsub-${randomUUID().slice(0, 8)}@example.test`;
  const primaryEmail = `sim-primary-${randomUUID().slice(0, 8)}@example.test`;
  const STAFF_2 = randomUUID();

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
    tenantB = await createTestTenant('test-swecham');
    await seedPortalPlan(tenantA.ctx.slug, admin.userId, planId);
    const seeded = await seedPortalMemberWithContact(tenantA, planId, { contactEmail: primaryEmail });
    memberId = seeded.memberId;
    contactId = seeded.contactId;
    removedContactId = randomUUID();
    suppressedContactId = randomUUID();
    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(contacts).values([
        {
          tenantId: tenantA.ctx.slug,
          contactId: removedContactId,
          memberId,
          firstName: 'Gone',
          lastName: 'Contact',
          email: `gone-${randomUUID().slice(0, 8)}@example.test`,
          preferredLanguage: 'en',
          isPrimary: false,
          removedAt: new Date('2026-05-01T00:00:00Z'),
        },
        {
          tenantId: tenantA.ctx.slug,
          contactId: suppressedContactId,
          memberId,
          firstName: 'Unsub',
          lastName: 'Scribed',
          email: suppressedEmail,
          preferredLanguage: 'en',
          isPrimary: false,
        },
      ]);
      await tx.insert(marketingUnsubscribes).values({
        tenantId: tenantA.ctx.slug,
        emailLower: suppressedEmail.toLowerCase(),
        memberId: null,
        reason: 'recipient_initiated',
        reasonText: null,
        sourceBroadcastId: null,
        sourceTokenHash: null,
      });
    });
  }, 120_000);

  afterAll(async () => {
    await db
      .delete(marketingUnsubscribes)
      .where(eq(marketingUnsubscribes.tenantId, tenantA.ctx.slug))
      .catch(() => {});
    await db.delete(auditLog).where(eq(auditLog.tenantId, tenantA.ctx.slug)).catch(() => {});
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  }, 120_000);

  it('off → changed; the three columns land together', async () => {
    const at = new Date('2026-09-06T01:00:00Z');
    const r = await runInTenant(tenantA.ctx, (tx) =>
      drizzleContactRepo.setMarketingOptOutInTx(tx, asContactId(contactId), { kind: 'off', actor: 'staff', byUserId: admin.userId as never, at: at }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.outcome).toBe('changed');
    if (r.value.outcome === 'refused_self_opted_out') return;
    expect(r.value.contact.marketing).toEqual({
      optedOutAt: at,
      source: 'staff',
      byUserId: admin.userId,
    });
    const read = await drizzleContactRepo.findById(tenantA.ctx, asContactId(contactId));
    expect(read.ok && read.value.marketing.source).toBe('staff');
  });

  it('off again (another STAFF actor) → unchanged; the ORIGINAL actor + timestamp are kept', async () => {
    const r = await runInTenant(tenantA.ctx, (tx) =>
      drizzleContactRepo.setMarketingOptOutInTx(tx, asContactId(contactId), { kind: 'off', actor: 'staff', byUserId: STAFF_2 as never, at: new Date('2026-09-06T02:00:00Z') }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.outcome).toBe('unchanged');
    if (r.value.outcome === 'refused_self_opted_out') return;
    expect(r.value.contact.marketing).toMatchObject({ source: 'staff', byUserId: admin.userId });
  });

  it('on → changed; all three columns are cleared', async () => {
    const r = await runInTenant(tenantA.ctx, (tx) =>
      drizzleContactRepo.setMarketingOptOutInTx(tx, asContactId(contactId), { kind: 'on', actor: 'staff' }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.outcome).toBe('changed');
    if (r.value.outcome === 'refused_self_opted_out') return;
    expect(r.value.contact.marketing).toEqual({ optedOutAt: null, source: null, byUserId: null });
  });

  it('repo: self "off" over a staff "off" is CHANGED — the person\'s objection replaces the staff record', async () => {
    // Arrange: staff off.
    await runInTenant(tenantA.ctx, (tx) =>
      drizzleContactRepo.setMarketingOptOutInTx(tx, asContactId(contactId), { kind: 'off', actor: 'staff', byUserId: admin.userId as never, at: new Date('2026-09-06T03:00:00Z') }),
    );
    const r = await runInTenant(tenantA.ctx, (tx) =>
      drizzleContactRepo.setMarketingOptOutInTx(tx, asContactId(contactId), { kind: 'off', actor: 'self', byUserId: STAFF_2 as never, at: new Date('2026-09-06T04:00:00Z') }),
    );
    expect(r.ok && r.value.outcome).toBe('changed');
    expect(
      r.ok && r.value.outcome !== 'refused_self_opted_out' && r.value.contact.marketing,
    ).toMatchObject({ source: 'self', byUserId: STAFF_2 });

    // …and a later staff "off" over the self record is UNCHANGED (the objection stays).
    const again = await runInTenant(tenantA.ctx, (tx) =>
      drizzleContactRepo.setMarketingOptOutInTx(tx, asContactId(contactId), { kind: 'off', actor: 'staff', byUserId: admin.userId as never, at: new Date('2026-09-06T05:00:00Z') }),
    );
    expect(again.ok && again.value.outcome).toBe('unchanged');
    expect(
      again.ok &&
        again.value.outcome !== 'refused_self_opted_out' &&
        again.value.contact.marketing.source,
    ).toBe('self');

    // Reset to on for the following cases.
    await runInTenant(tenantA.ctx, (tx) =>
      drizzleContactRepo.setMarketingOptOutInTx(tx, asContactId(contactId), { kind: 'on', actor: 'self' }),
    );
  });

  it('on when already on → unchanged', async () => {
    const r = await runInTenant(tenantA.ctx, (tx) =>
      drizzleContactRepo.setMarketingOptOutInTx(tx, asContactId(contactId), { kind: 'on', actor: 'staff' }),
    );
    expect(r.ok && r.value.outcome).toBe('unchanged');
  });

  it('a removed contact → repo.not_found (no marketing state to set)', async () => {
    const r = await runInTenant(tenantA.ctx, (tx) =>
      drizzleContactRepo.setMarketingOptOutInTx(tx, asContactId(removedContactId), { kind: 'off', actor: 'staff', byUserId: admin.userId as never, at: new Date() }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('repo.not_found');
  });

  it('FR-052: tenant B cannot reach tenant A\'s contact through the write (RLS → not_found)', async () => {
    const r = await runInTenant(tenantB.ctx, (tx) =>
      drizzleContactRepo.setMarketingOptOutInTx(tx, asContactId(contactId), { kind: 'off', actor: 'staff', byUserId: admin.userId as never, at: new Date() }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('repo.not_found');
    // …and the row in tenant A is untouched.
    const read = await drizzleContactRepo.findById(tenantA.ctx, asContactId(contactId));
    expect(read.ok && read.value.marketing.optedOutAt).toBeNull();
  });

  it('use case (production composition): staff off → audit row with ids + source, no address', async () => {
    const deps = buildContactMarketingDeps(tenantA.ctx);
    const requestId = `req-${randomUUID().slice(0, 8)}`;
    const r = await setContactMarketingOptOut(
      {
        contactId: asContactId(contactId),
        state: 'off',
        actor: { userId: admin.userId, role: 'admin', source: 'staff' },
        requestId,
      },
      deps,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.outcome).toBe('changed');

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantA.ctx.slug), eq(auditLog.requestId, requestId)));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.eventType).toBe('contact_marketing_opted_out');
    expect(row.actorUserId).toBe(admin.userId);
    expect(row.payload).toMatchObject({
      // Staff action → `related_member_id` (no last_activity_at bump).
      related_member_id: memberId,
      contact_id: contactId,
      source: 'staff',
      actor_role: 'admin',
    });
    expect(row.payload).not.toHaveProperty('member_id');
    expect(JSON.stringify(row.payload) + row.summary).not.toContain('@');
  });

  it('security MEDIUM-1: a STAFF toggle does not bump members.last_activity_at; a SELF toggle does', async () => {
    const deps = buildContactMarketingDeps(tenantA.ctx);
    const readLastActivity = async (): Promise<Date | null> => {
      const rows = await db
        .select({ at: members.lastActivityAt })
        .from(members)
        .where(and(eq(members.tenantId, tenantA.ctx.slug), eq(members.memberId, memberId)));
      return rows[0]?.at ?? null;
    };
    // Baseline: pin a known old value so "unchanged" is provable.
    const anchor = new Date('2026-01-01T00:00:00Z');
    await db
      .update(members)
      .set({ lastActivityAt: anchor })
      .where(and(eq(members.tenantId, tenantA.ctx.slug), eq(members.memberId, memberId)));
    // Make sure the contact is ON so the staff "off" below is a real change.
    await runInTenant(tenantA.ctx, (tx) =>
      drizzleContactRepo.setMarketingOptOutInTx(tx, asContactId(contactId), { kind: 'on', actor: 'self' }),
    );

    const staff = await setContactMarketingOptOut(
      {
        contactId: asContactId(contactId),
        state: 'off',
        actor: { userId: admin.userId, role: 'admin', source: 'staff' },
        requestId: `req-${randomUUID().slice(0, 8)}`,
      },
      deps,
    );
    expect(staff.ok && staff.value.outcome).toBe('changed');
    expect((await readLastActivity())?.toISOString()).toBe(anchor.toISOString());

    // The contact objects themself over the staff record → recorded AND it is member activity.
    const self = await setContactMarketingOptOut(
      {
        contactId: asContactId(contactId),
        state: 'off',
        actor: { userId: admin.userId, role: 'member', source: 'self' },
        requestId: `req-${randomUUID().slice(0, 8)}`,
      },
      deps,
    );
    expect(self.ok && self.value.outcome).toBe('changed');
    const after = await readLastActivity();
    expect(after).not.toBeNull();
    expect(after!.getTime()).toBeGreaterThan(anchor.getTime());

    // Back to ON via the contact themself (staff cannot, see the case below),
    // then staff OFF again so the next case ("same state again") sees a
    // staff record, as it did before this guard was inserted.
    await setContactMarketingOptOut(
      {
        contactId: asContactId(contactId),
        state: 'on',
        actor: { userId: admin.userId, role: 'member', source: 'self' },
        requestId: `req-${randomUUID().slice(0, 8)}`,
      },
      deps,
    );
    await setContactMarketingOptOut(
      {
        contactId: asContactId(contactId),
        state: 'off',
        actor: { userId: admin.userId, role: 'admin', source: 'staff' },
        requestId: `req-${randomUUID().slice(0, 8)}`,
      },
      deps,
    );
  });

  it('use case: same state again → unchanged and NO second audit row', async () => {
    const deps = buildContactMarketingDeps(tenantA.ctx);
    const requestId = `req-${randomUUID().slice(0, 8)}`;
    const r = await setContactMarketingOptOut(
      {
        contactId: asContactId(contactId),
        state: 'off',
        actor: { userId: admin.userId, role: 'admin', source: 'staff' },
        requestId,
      },
      deps,
    );
    expect(r.ok && r.value.outcome).toBe('unchanged');
    const rows = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantA.ctx.slug), eq(auditLog.requestId, requestId)));
    expect(rows).toHaveLength(0);
  });

  it('use case: on → opted_in audit row; the member page reads the contact back as receiving', async () => {
    const deps = buildContactMarketingDeps(tenantA.ctx);
    const requestId = `req-${randomUUID().slice(0, 8)}`;
    const r = await setContactMarketingOptOut(
      {
        contactId: asContactId(contactId),
        state: 'on',
        actor: { userId: admin.userId, role: 'admin', source: 'staff' },
        requestId,
      },
      deps,
    );
    expect(r.ok && r.value.outcome).toBe('changed');
    const rows = await db
      .select({ eventType: auditLog.eventType })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantA.ctx.slug), eq(auditLog.requestId, requestId)));
    expect(rows.map((x) => x.eventType)).toEqual(['contact_marketing_opted_in']);
  });

  it('use case: "on" for a suppressed address → suppressed (FR-025), nothing written', async () => {
    const deps = buildContactMarketingDeps(tenantA.ctx);
    const r = await setContactMarketingOptOut(
      {
        contactId: asContactId(suppressedContactId),
        state: 'on',
        actor: { userId: admin.userId, role: 'admin', source: 'staff' },
        requestId: `req-${randomUUID().slice(0, 8)}`,
      },
      deps,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.type).toBe('suppressed');
  });

  it('FR-033: the PRIMARY switching marketing off (self) leaves the money-email recipient untouched', async () => {
    // US6 AS4 — the primary contact opts out of marketing in the portal; the
    // invoice / receipt path resolves the recipient from `is_primary` alone,
    // so it still finds them. `getMemberPrimaryContact` is the read that path
    // goes through.
    const deps = buildContactMarketingDeps(tenantA.ctx);
    const r = await setContactMarketingOptOut(
      {
        contactId: asContactId(contactId), // the seeded PRIMARY
        state: 'off',
        actor: { userId: admin.userId, role: 'member', source: 'self' },
        requestId: `req-${randomUUID().slice(0, 8)}`,
      },
      deps,
    );
    expect(r.ok).toBe(true);
    // The money path's recipient read (PR-A) — resolves by `is_primary` only.
    const primary = await getMemberPrimaryContact(
      { tenant: tenantA.ctx, memberRepo: drizzleMemberRepo },
      asMemberId(memberId),
    );
    expect(primary.ok).toBe(true);
    if (!primary.ok) return;
    expect(primary.value).toBe(primaryEmail);
    const read = await drizzleContactRepo.findById(tenantA.ctx, asContactId(contactId));
    expect(read.ok && read.value.marketing.source).toBe('self');
  });

  it('use case: staff cannot switch marketing back on after the contact opted out themself (FR-025 amendment)', async () => {
    const deps = buildContactMarketingDeps(tenantA.ctx);
    // The seeded PRIMARY is currently self-off from the FR-033 case above.
    const read = await drizzleContactRepo.findById(tenantA.ctx, asContactId(contactId));
    expect(read.ok && read.value.marketing.source).toBe('self');

    const staffOn = await setContactMarketingOptOut(
      {
        contactId: asContactId(contactId),
        state: 'on',
        actor: { userId: admin.userId, role: 'admin', source: 'staff' },
        requestId: `req-${randomUUID().slice(0, 8)}`,
      },
      deps,
    );
    expect(staffOn.ok).toBe(false);
    if (staffOn.ok) return;
    expect(staffOn.error.type).toBe('self_opted_out');

    // The contact themself lifts it.
    const selfOn = await setContactMarketingOptOut(
      {
        contactId: asContactId(contactId),
        state: 'on',
        actor: { userId: admin.userId, role: 'member', source: 'self' },
        requestId: `req-${randomUUID().slice(0, 8)}`,
      },
      deps,
    );
    expect(selfOn.ok && selfOn.value.outcome).toBe('changed');
  });

  it('use case: "off" for a suppressed address still records the staff opt-out', async () => {
    const deps = buildContactMarketingDeps(tenantA.ctx);
    const r = await setContactMarketingOptOut(
      {
        contactId: asContactId(suppressedContactId),
        state: 'off',
        actor: { userId: admin.userId, role: 'admin', source: 'staff' },
        requestId: `req-${randomUUID().slice(0, 8)}`,
      },
      deps,
    );
    expect(r.ok && r.value.outcome).toBe('changed');
  });
});

describe('108 PR-D — the opt-out and its audit row are one transaction (live Neon)', () => {
  // Review tests HIGH-1: the unit test for this stubs `runInTenant`, so it
  // proves the use case RETURNS server_error, not that Postgres rolled the
  // write back. FR-053 requires the audit trail to explain every state, so an
  // opt-out that committed without its audit row would be unexplainable.
  let tenant: TestTenant;
  let admin: TestUser;
  let contactId: string;
  const planId = `mkt-tx-${randomUUID().slice(0, 6)}`;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedPortalPlan(tenant.ctx.slug, admin.userId, planId);
    contactId = (await seedPortalMemberWithContact(tenant, planId)).contactId;
  }, 120_000);

  afterAll(async () => {
    await tenant?.cleanup().catch(() => {});
    if (admin) await deleteTestUser(admin).catch(() => {});
  });

  it('audit write fails → the contact row is NOT opted out (the tx rolled back)', async () => {
    const deps = {
      ...buildContactMarketingDeps(tenant.ctx),
      audit: {
        record: async () => ok(undefined),
        recordInTx: async () => err({ code: 'repo.unexpected' as const, cause: new Error('audit down') }),
      },
    } as unknown as Parameters<typeof setContactMarketingOptOut>[1];

    const r = await setContactMarketingOptOut(
      {
        contactId: asContactId(contactId),
        state: 'off',
        actor: { userId: admin.userId, role: 'admin', source: 'staff' },
        requestId: `req-${randomUUID().slice(0, 8)}`,
      },
      deps,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.type).toBe('server_error');

    const after = await drizzleContactRepo.findById(tenant.ctx, asContactId(contactId));
    if (!after.ok) throw new Error('expected the contact');
    expect(after.value.marketing.optedOutAt).toBeNull();
    expect(after.value.marketing.source).toBeNull();
  });
});

describe('108 PR-D — a self opt-out survives remove → re-add of the same address (live Neon)', () => {
  // Review code H1: the spec calls a self opt-out "the same objection as the
  // unsubscribe link" (GDPR Art. 21(3)). The unsubscribe list is address-keyed
  // and survives anything; this preference lived on the contact ROW, so
  // deleting the contact and adding the same person back silently restored
  // marketing — and SweCham's secondary-contact import is exactly that shape.
  let tenant: TestTenant;
  let admin: TestUser;
  let memberId: string;
  const planId = `mkt-re-${randomUUID().slice(0, 6)}`;
  const email = `readd-${randomUUID().slice(0, 8)}@example.test`;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedPortalPlan(tenant.ctx.slug, admin.userId, planId);
    const seeded = await seedPortalMemberWithContact(tenant, planId);
    memberId = seeded.memberId;
  }, 120_000);

  afterAll(async () => {
    await tenant?.cleanup().catch(() => {});
    if (admin) await deleteTestUser(admin).catch(() => {});
  });

  async function addContactWith(address: string): Promise<string> {
    const contactId = randomUUID();
    const added = await runInTenant(tenant.ctx, (tx) =>
      drizzleContactRepo.addInTx(tx, {
        tenantId: tenant.ctx.slug,
        contactId: asContactId(contactId),
        memberId: asMemberId(memberId),
        firstName: 'Re',
        lastName: 'Added',
        email: address as never,
        phone: null,
        roleTitle: null,
        preferredLanguage: 'en',
        dateOfBirth: null,
        linkedUserId: null,
        inviteBouncedAt: null,
        art14AttestedAt: null,
        isPrimary: false,
        removedAt: null,
      } as never),
    );
    if (!added.ok) throw new Error(`add failed: ${added.error.code}`);
    return contactId;
  }

  it("the person's OWN objection is carried onto the new row; a staff opt-out is not", async () => {
    // 1. self opt-out, then remove
    const first = await addContactWith(email);
    await runInTenant(tenant.ctx, (tx) =>
      drizzleContactRepo.setMarketingOptOutInTx(
        tx,
        asContactId(first),
        { kind: 'off', actor: 'self', byUserId: admin.userId as never, at: new Date('2026-09-06T07:00:00Z') },
      ),
    );
    await runInTenant(tenant.ctx, (tx) => drizzleContactRepo.removeInTx(tx, asContactId(first)));

    // 2. the same address comes back (import, or staff re-adding the person)
    const second = await addContactWith(email);
    const back = await drizzleContactRepo.findById(tenant.ctx, asContactId(second));
    if (!back.ok) throw new Error('expected the contact');
    expect(back.value.marketing.source).toBe('self');
    expect(back.value.marketing.optedOutAt).not.toBeNull();

  });

  it('a STAFF opt-out does NOT follow the address — it is a setting on a row, not an objection', async () => {
    // A separate address: the self case above must not bleed into this one.
    const staffEmail = `staffoff-${randomUUID().slice(0, 8)}@example.test`;
    const first = await addContactWith(staffEmail);
    await runInTenant(tenant.ctx, (tx) =>
      drizzleContactRepo.setMarketingOptOutInTx(tx, asContactId(first), {
        kind: 'off',
        actor: 'staff',
        byUserId: admin.userId as never,
        at: new Date('2026-09-06T08:00:00Z'),
      }),
    );
    await runInTenant(tenant.ctx, (tx) => drizzleContactRepo.removeInTx(tx, asContactId(first)));

    const second = await addContactWith(staffEmail);
    const fresh = await drizzleContactRepo.findById(tenant.ctx, asContactId(second));
    if (!fresh.ok) throw new Error('expected the contact');
    expect(fresh.value.marketing).toEqual(RECEIVES_MARKETING);
  });

  it('a DIFFERENT address is unaffected', async () => {
    const other = await addContactWith(`other-${randomUUID().slice(0, 6)}@example.test`);
    const r = await drizzleContactRepo.findById(tenant.ctx, asContactId(other));
    if (!r.ok) throw new Error('expected the contact');
    expect(r.value.marketing).toEqual(RECEIVES_MARKETING);
  });

  // Staff review C2. The first version selected the latest row *carrying* a
  // self opt-out, so an opt-IN cleared only the current row and a long-removed
  // one resurrected the withdrawn objection on the next re-add — silently
  // discarding the person's own decision (FR-032). The LATEST row for the
  // address decides, whatever it says.
  it('an objection the person WITHDREW is not resurrected by a later re-add', async () => {
    const address = `withdrawn-${randomUUID().slice(0, 8)}@example.test`;

    // 1. off (self) → removed. This row is the one that used to haunt the address.
    const first = await addContactWith(address);
    await runInTenant(tenant.ctx, (tx) =>
      drizzleContactRepo.setMarketingOptOutInTx(tx, asContactId(first), {
        kind: 'off',
        actor: 'self',
        byUserId: admin.userId as never,
        at: new Date('2026-09-06T09:00:00Z'),
      }),
    );
    await runInTenant(tenant.ctx, (tx) => drizzleContactRepo.removeInTx(tx, asContactId(first)));

    // 2. re-added (carries, correctly) → the person switches marketing back ON
    //    → removed again. The live row now says "on".
    const second = await addContactWith(address);
    const carried = await drizzleContactRepo.findById(tenant.ctx, asContactId(second));
    if (!carried.ok) throw new Error('expected the contact');
    expect(carried.value.marketing.source).toBe('self');
    await runInTenant(tenant.ctx, (tx) =>
      drizzleContactRepo.setMarketingOptOutInTx(tx, asContactId(second), {
        kind: 'on',
        actor: 'self',
      }),
    );
    await runInTenant(tenant.ctx, (tx) => drizzleContactRepo.removeInTx(tx, asContactId(second)));

    // 3. re-added once more: the withdrawal is the person's latest word.
    const third = await addContactWith(address);
    const fresh = await drizzleContactRepo.findById(tenant.ctx, asContactId(third));
    if (!fresh.ok) throw new Error('expected the contact');
    expect(fresh.value.marketing).toEqual(RECEIVES_MARKETING);
  });

  // Round-2 review finding 12: `created_at` defaults to now() = the TRANSACTION
  // timestamp, so rows for one address written in ONE transaction tie, and
  // `LIMIT 1` over a tie is arbitrary — it could resurrect a withdrawn objection
  // or drop a live one. The tie-break is deliberate: a `self` opt-out wins when
  // the record cannot say which row came last. Proved here by building the
  // exact tie the import path can create.
  it('two rows for one address in ONE transaction tie on created_at; the self opt-out wins the tie', async () => {
    const address = `tie-${randomUUID().slice(0, 8)}@example.test`;
    const draftFor = (id: string) =>
      ({
        tenantId: tenant.ctx.slug,
        contactId: asContactId(id),
        memberId: asMemberId(memberId),
        firstName: 'Tie',
        lastName: 'Break',
        email: address as never,
        phone: null,
        roleTitle: null,
        preferredLanguage: 'en',
        dateOfBirth: null,
        linkedUserId: null,
        inviteBouncedAt: null,
        art14AttestedAt: null,
        isPrimary: false,
        removedAt: null,
      }) as never;
    const a = randomUUID();
    const b = randomUUID();

    // One transaction: A (self-off, then removed) and B (carried, then switched
    // back ON by the person, then removed). Both rows now share created_at, and
    // they disagree — A says "objected", B says "on".
    await runInTenant(tenant.ctx, async (tx) => {
      const addedA = await drizzleContactRepo.addInTx(tx, draftFor(a));
      if (!addedA.ok) throw new Error(`add A failed: ${addedA.error.code}`);
      await drizzleContactRepo.setMarketingOptOutInTx(tx, asContactId(a), {
        kind: 'off',
        actor: 'self',
        byUserId: admin.userId as never,
        at: new Date('2026-09-06T13:00:00Z'),
      });
      await drizzleContactRepo.removeInTx(tx, asContactId(a));
      const addedB = await drizzleContactRepo.addInTx(tx, draftFor(b));
      if (!addedB.ok) throw new Error(`add B failed: ${addedB.error.code}`);
      await drizzleContactRepo.setMarketingOptOutInTx(tx, asContactId(b), { kind: 'on', actor: 'self' });
      await drizzleContactRepo.removeInTx(tx, asContactId(b));
    });

    // The tie is real, not assumed.
    const stamps = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ id: contacts.contactId, createdAt: contacts.createdAt })
        .from(contacts)
        .where(sql`lower(${contacts.email}) = lower(${address})`),
    );
    expect(stamps).toHaveLength(2);
    expect(stamps[0]!.createdAt.getTime()).toBe(stamps[1]!.createdAt.getTime());

    // Fail closed: with no way to order A and B in time, the objection wins.
    const third = await addContactWith(address);
    const fresh = await drizzleContactRepo.findById(tenant.ctx, asContactId(third));
    if (!fresh.ok) throw new Error('expected the contact');
    expect(fresh.value.marketing.source).toBe('self');
  });

  // Staff review C1: `createWithPrimaryContactInTx` — every `POST /api/members`
  // — bypassed `addInTx` and so bypassed the carry-forward entirely. That is
  // the fail-OPEN direction: a person who objected receives E-Blasts again.
  it('the create-member path carries the objection too (not just addInTx)', async () => {
    const address = `createpath-${randomUUID().slice(0, 8)}@example.test`;
    const first = await addContactWith(address);
    await runInTenant(tenant.ctx, (tx) =>
      drizzleContactRepo.setMarketingOptOutInTx(tx, asContactId(first), {
        kind: 'off',
        actor: 'self',
        byUserId: admin.userId as never,
        at: new Date('2026-09-06T10:00:00Z'),
      }),
    );
    await runInTenant(tenant.ctx, (tx) => drizzleContactRepo.removeInTx(tx, asContactId(first)));

    const newMemberId = randomUUID();
    const newContactId = randomUUID();
    const created = await runInTenant(tenant.ctx, (tx) =>
      drizzleMemberRepo.createWithPrimaryContactInTx(tx, {
        member: {
          tenantId: tenant.ctx.slug,
          memberId: asMemberId(newMemberId),
          memberNumber: nextSeedMemberNumber(),
          companyName: `CarryCo ${newMemberId.slice(0, 6)}`,
          country: 'TH',
          planId,
          planYear: 2026,
          // The repo calls `.toISOString()` on this — a string throws.
          registrationDate: new Date(),
          registrationFeePaid: false,
          isVatRegistered: false,
          status: 'active',
          archivedAt: null,
        },
        primaryContact: {
          tenantId: tenant.ctx.slug,
          contactId: asContactId(newContactId),
          firstName: 'Carry',
          lastName: 'Path',
          email: address,
          phone: null,
          roleTitle: null,
          preferredLanguage: 'en',
          isPrimary: true,
          dateOfBirth: null,
          linkedUserId: null,
          inviteBouncedAt: null,
          art14AttestedAt: null,
          removedAt: null,
        },
      } as never),
    );
    if (!created.ok) throw new Error(`create failed: ${created.error.code}`);

    const born = await drizzleContactRepo.findById(tenant.ctx, asContactId(newContactId));
    if (!born.ok) throw new Error('expected the new primary contact');
    expect(born.value.marketing.source).toBe('self');
    expect(born.value.marketing.optedOutAt).not.toBeNull();
  });
});
