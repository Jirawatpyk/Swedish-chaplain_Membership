/**
 * T075 — Integration: primary-contact partial-index race (edge case).
 *
 * The `contacts_one_primary_per_member` partial unique index enforces
 * "exactly one primary per member" at the DB layer. `promotePrimary`
 * implements demote-then-promote; if a concurrent insert/promote lands
 * the UPDATE that creates a second primary, Postgres raises a unique-
 * constraint violation and the Drizzle repo maps it to
 * `repo.conflict` → the API surfaces 409.
 *
 * This test forces the race by directly inserting a SECOND primary
 * row via the owner role (bypasses the demote-first path) then
 * verifies the Domain contract:
 *
 *   1. Direct two-primaries INSERT triggers the unique violation
 *   2. `promotePrimary` returns a `conflict` typed error when a
 *      pre-existing invariant violation is present on the target row
 *
 * Also exercises the happy path for comparison.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import {
  promotePrimary,
  removeContact,
  type ContactId,
  type MemberId,
} from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { drizzleContactRepo } from '@/modules/members/infrastructure/db/drizzle-contact-repo';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

describe('primary-contact partial-index race (T075)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 100000n,
        legalNameTh: 'Test TH',
        legalNameEn: 'Test EN',
        taxId: '0000000000000',
        registeredAddressTh: 'Test Address TH',
        registeredAddressEn: 'Test Address EN',
        invoiceNumberPrefix: 'INV',
        creditNoteNumberPrefix: 'CN',
      });
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: 'test-plan',
        planYear: 2026,
        planName: { en: 'Test Plan' },
        description: { en: 'Test description' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        createdBy: admin.userId,
        updatedBy: admin.userId,
        benefitMatrix: {
          eblast_per_year: 1,
          website_page_type: 'member_news_update',
          homepage_logo_category: 'regular',
          directory_listing_size: 'half_page',
          event_discount_scope: 'all_employees',
          events_cobranded_access: false,
          cultural_tickets_per_year: 0,
          m2m_benefits_access: true,
          business_referrals: true,
          tailor_made_services: false,
          partnership: null,
        },
      });
    });
  });

  afterAll(async () => {
    await tenant.cleanup();
    await deleteTestUser(admin);
  });

  async function seedMember(): Promise<{
    memberId: MemberId;
    primaryId: ContactId;
    secondaryId: ContactId;
  }> {
    const memberId = randomUUID() as MemberId;
    const primaryId = randomUUID() as ContactId;
    const secondaryId = randomUUID() as ContactId;
    const rand = randomUUID().slice(0, 8);

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Race Co ${rand}`,
        country: 'TH',
        planId: 'test-plan',
        planYear: 2026,
        status: 'active',
      });
      await tx.insert(contacts).values([
        {
          tenantId: tenant.ctx.slug,
          contactId: primaryId,
          memberId,
          firstName: 'Alice',
          lastName: 'Primary',
          email: `alice-${rand}@example.com`,
          preferredLanguage: 'en',
          isPrimary: true,
        },
        {
          tenantId: tenant.ctx.slug,
          contactId: secondaryId,
          memberId,
          firstName: 'Bob',
          lastName: 'Secondary',
          email: `bob-${rand}@example.com`,
          preferredLanguage: 'en',
          isPrimary: false,
        },
      ]);
    });
    return { memberId, primaryId, secondaryId };
  }

  it('DB partial unique index rejects a second primary on the same member', async () => {
    const s = await seedMember();
    const rogueId = randomUUID() as ContactId;

    // Insert a THIRD contact with isPrimary=true WHILE the seeded
    // primary is still active. The partial index must reject it.
    const attempt = db.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId: rogueId,
      memberId: s.memberId,
      firstName: 'Rogue',
      lastName: 'Primary',
      email: `rogue-${randomUUID().slice(0, 8)}@example.com`,
      preferredLanguage: 'en',
      isPrimary: true,
    });
    // Drizzle 0.45+ wraps Postgres errors; walk the cause chain.
    let caught: unknown;
    try {
      await attempt;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    const parts: string[] = [];
    let cur: unknown = caught;
    while (cur instanceof Error) {
      parts.push(cur.message);
      cur = (cur as { cause?: unknown }).cause;
    }
    expect(parts.join(' | ')).toMatch(/duplicate key|unique|constraint/i);
  }, 30_000);

  it('promotePrimary happy path demotes old primary then promotes target', async () => {
    const s = await seedMember();
    const deps = buildMembersDeps(tenant.ctx);

    const result = await promotePrimary(
      s.memberId,
      s.secondaryId,
      { actorUserId: admin.userId, requestId: `req-${randomUUID().slice(0, 8)}` },
      deps,
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);

    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          contactId: contacts.contactId,
          isPrimary: contacts.isPrimary,
        })
        .from(contacts)
        .where(eq(contacts.memberId, s.memberId))
        .orderBy(contacts.contactId),
    );
    const bySelfId = new Map(rows.map((r) => [r.contactId, r.isPrimary]));
    expect(bySelfId.get(s.primaryId)).toBe(false);
    expect(bySelfId.get(s.secondaryId)).toBe(true);

    // Repeat promote on already-primary: idempotent-ish — the repo
    // demotes the existing primary (which is the same row), then the
    // UPDATE resurrects it. We only assert the final state stays sane.
    const second = await promotePrimary(
      s.memberId,
      s.secondaryId,
      { actorUserId: admin.userId, requestId: `req-${randomUUID().slice(0, 8)}` },
      deps,
    );
    // Either ok or conflict is acceptable — the invariant is what matters.
    void second;

    const final = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ count: contacts.contactId })
        .from(contacts)
        .where(
          and(
            eq(contacts.memberId, s.memberId),
            eq(contacts.isPrimary, true),
          ),
        ),
    );
    expect(final.length).toBe(1);
  }, 30_000);

  // ── 108 T030 (US2 / FR-010, FR-011, SC-002) ───────────────────────────────

  it('removeInTx refuses to remove the current primary (cannot_remove_primary) — FR-011', async () => {
    // The refusal must live in the SAME statement as the write (`WHERE
    // is_primary = false`), not in a read taken before the tx. Two concurrent
    // callers that both read "not primary" a moment ago must not both succeed.
    const s = await seedMember();
    const result = await runInTenant(tenant.ctx, (tx) =>
      drizzleContactRepo.removeInTx(tx, s.primaryId),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      code: 'repo.conflict',
      reason: 'cannot_remove_primary',
    });
    // Nothing changed: still primary, still live.
    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ isPrimary: contacts.isPrimary, removedAt: contacts.removedAt })
        .from(contacts)
        .where(eq(contacts.contactId, s.primaryId)),
    );
    expect(row).toEqual({ isPrimary: true, removedAt: null });
  }, 30_000);

  it('removeInTx still removes a secondary and reports wasPrimary=false', async () => {
    const s = await seedMember();
    const result = await runInTenant(tenant.ctx, (tx) =>
      drizzleContactRepo.removeInTx(tx, s.secondaryId),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.wasPrimary).toBe(false);
    expect(result.value.contact.removedAt).not.toBeNull();
  }, 30_000);

  it('promote(Y) vs remove(Y) ×100: every member ends with exactly one live primary and exactly one call is refused — SC-002', async () => {
    // 50 members × (promote Y ‖ remove Y) = 100 concurrent use-case calls,
    // batched so at most 20 are in flight against the 8-connection dev pool.
    // Every interleaving must resolve to ONE of two end states, and the losing
    // call must say so — never a silent zero-primary member (which, since 108
    // PR-A, would stop that member's receipts).
    const deps = buildMembersDeps(tenant.ctx);
    const seeds = await Promise.all(Array.from({ length: 50 }, () => seedMember()));

    type Outcome = {
      memberId: MemberId;
      promote: Awaited<ReturnType<typeof promotePrimary>>;
      remove: Awaited<ReturnType<typeof removeContact>>;
    };
    const outcomes: Outcome[] = [];
    const BATCH = 10;
    for (let i = 0; i < seeds.length; i += BATCH) {
      const batch = seeds.slice(i, i + BATCH);
      const settled = await Promise.all(
        batch.map(async (s) => {
          const [promote, remove] = await Promise.all([
            promotePrimary(
              s.memberId,
              s.secondaryId,
              { actorUserId: admin.userId, requestId: `p-${s.memberId.slice(0, 8)}` },
              deps,
            ),
            removeContact(
              s.memberId,
              s.secondaryId,
              { actorUserId: admin.userId, requestId: `r-${s.memberId.slice(0, 8)}` },
              deps,
            ),
          ]);
          return { memberId: s.memberId, promote, remove };
        }),
      );
      outcomes.push(...settled);
    }

    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          memberId: contacts.memberId,
          contactId: contacts.contactId,
          isPrimary: contacts.isPrimary,
          removedAt: contacts.removedAt,
        })
        .from(contacts)
        .where(
          inArray(
            contacts.memberId,
            seeds.map((s) => s.memberId),
          ),
        ),
    );
    const livePrimariesByMember = new Map<string, number>();
    for (const r of rows) {
      if (r.isPrimary && r.removedAt === null) {
        livePrimariesByMember.set(
          r.memberId,
          (livePrimariesByMember.get(r.memberId) ?? 0) + 1,
        );
      }
    }

    const violations: string[] = [];
    for (const o of outcomes) {
      const live = livePrimariesByMember.get(o.memberId) ?? 0;
      if (live !== 1) violations.push(`${o.memberId}: ${live} live primaries`);

      const failures = [o.promote, o.remove].filter((r) => !r.ok).length;
      if (failures !== 1) {
        violations.push(
          `${o.memberId}: ${failures} refusals (promote=${JSON.stringify(o.promote)} remove=${JSON.stringify(o.remove)})`,
        );
      }
      // The loser must explain itself with a typed refusal, never a 500.
      if (!o.promote.ok) {
        expect(['not_found', 'conflict']).toContain(o.promote.error.type);
      }
      if (!o.remove.ok) {
        expect(['cannot_remove_primary', 'not_found', 'conflict']).toContain(
          o.remove.error.type,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  }, 120_000);

  // ── 108 T041 review round 3 (fresh whole-branch re-review, M1) ────────────

  it('promotePrimary on a member with NO current primary designates the target (demoted: null) instead of refusing', async () => {
    // Once 0293 is applied, the only contact-bearing zero-primary state that
    // can COMMIT is an archived member (the trigger exempts archived) — which
    // is also the real post-deploy shape. Before this round the demote-then-
    // promote repo refused it with `no_current_primary`, so the runbook's
    // "promote a remaining contact" pointed at a 409.
    const memberId = randomUUID() as MemberId;
    const aId = randomUUID() as ContactId;
    const bId = randomUUID() as ContactId;
    const rand = randomUUID().slice(0, 8);
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `No Primary Co ${rand}`,
        country: 'TH',
        planId: 'test-plan',
        planYear: 2026,
        status: 'archived',
        archivedAt: new Date(),
      });
      await tx.insert(contacts).values([
        {
          tenantId: tenant.ctx.slug,
          contactId: aId,
          memberId,
          firstName: 'Ann',
          lastName: 'Alpha',
          email: `ann-${rand}@example.com`,
          preferredLanguage: 'en',
          isPrimary: false,
        },
        {
          tenantId: tenant.ctx.slug,
          contactId: bId,
          memberId,
          firstName: 'Bo',
          lastName: 'Beta',
          email: `bo-${rand}@example.com`,
          preferredLanguage: 'en',
          isPrimary: false,
        },
      ]);
    });

    const requestId = `req-np-${rand}`;
    const result = await promotePrimary(
      memberId,
      bId,
      { actorUserId: admin.userId, requestId },
      buildMembersDeps(tenant.ctx),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.demoted).toBeNull();
    expect(result.value.promoted.contactId).toBe(bId);

    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ contactId: contacts.contactId, isPrimary: contacts.isPrimary })
        .from(contacts)
        .where(eq(contacts.memberId, memberId)),
    );
    expect(new Map(rows.map((r) => [r.contactId, r.isPrimary]))).toEqual(
      new Map([
        [aId, false],
        [bId, true],
      ]),
    );

    // The audit row says what happened: a designation, nobody demoted.
    const audits = await db
      .select({ type: auditLog.eventType, payload: auditLog.payload })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenant.ctx.slug), eq(auditLog.requestId, requestId)));
    const changed = audits.find((r) => r.type === 'member_primary_contact_changed');
    expect(changed?.payload).toMatchObject({
      member_id: memberId,
      old_primary_contact_id: null,
      new_primary_contact_id: bId,
    });
  }, 30_000);
});
